import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AutomationStore } from '../src/automation/store.js';
import { TaskService } from '../src/automation/tasks.js';
import { NotificationWorker, type DeliveryOutcome } from '../src/automation/delivery.js';

const owner={accountId:'account',senderId:'sender'};
async function fixture(prompt='Read results'){
  const store=new AutomationStore(':memory:');let now=0;
  const tasks=new TaskService(store,{now:()=>now,authorize:()=>true});
  const task=await tasks.create(owner,'message',{title:'Reminder',kind:'reminder',prompt,
    schedule:{kind:'once',atUtc:new Date(1000).toISOString(),timezone:'UTC'}});
  now=1000;await tasks.tick();
  const notification=(await store.all('SELECT * FROM notifications'))[0];
  return {store,tasks,task,id:String(notification.id)};
}

test('partial failure retries only rejected parts, with original owner and no rerun',async()=>{
  const {store,id}=await fixture('🙂'.repeat(1100));
  const messages:string[]=[];let fail=true;
  const worker=new NotificationWorker(store,()=>true,async(target,text)=>{
    assert.deepEqual(target,owner);messages.push(text);
    if(messages.length===2&&fail)return {state:'failed',code:'stale'};
    return {state:'api_accepted'};
  });
  try{
    await worker.flush();
    assert.equal((await store.all('SELECT state FROM notifications'))[0].state,'failed');
    fail=false;await worker.wake(owner);
    assert.equal(messages.length,3);
    assert.equal(messages[1],messages[2]);
    assert.notEqual(messages[0],messages[2]);
    assert.equal((await store.all('SELECT state FROM notifications'))[0].state,'api_accepted');
    assert.equal((await store.all('SELECT count(*) n FROM runs'))[0].n,1);
    await assert.rejects(worker.retry(owner,id),/resendAccepted/);
    await worker.retry(owner,id,{resendAccepted:true});await worker.flush();
    assert.equal(messages.length,5);
  }finally{await store.close();}
});

test('missing context waits without repeated attempts; fresh original inbound wakes it',async()=>{
  const {store}=await fixture();let calls=0,ready=false;
  const worker=new NotificationWorker(store,()=>true,async()=>{calls++;return {state:ready?'api_accepted':'deferred'};});
  try{
    await worker.flush();await worker.flush();assert.equal(calls,1);
    ready=true;await worker.wake({accountId:'other',senderId:'sender'});assert.equal(calls,1);
    await worker.wake(owner);assert.equal(calls,2);
    assert.equal((await store.all('SELECT state FROM notifications'))[0].state,'api_accepted');
  }finally{await store.close();}
});

test('unknown delivery is never automatically replayed, even after fresh inbound',async()=>{
  const {store,id}=await fixture();let calls=0;
  const worker=new NotificationWorker(store,()=>true,async()=>{calls++;throw new Error('connection lost after server acceptance');});
  try{
    await worker.flush();await worker.flush();await worker.wake(owner);assert.equal(calls,1);
    assert.equal((await store.all('SELECT state FROM notifications'))[0].state,'unknown');
    await assert.rejects(worker.retry(owner,id),/includeUnknown/);
    await worker.retry(owner,id,{includeUnknown:true},'retry');await worker.flush();assert.equal(calls,2);
    await worker.retry(owner,id,{includeUnknown:true},'retry');await worker.flush();assert.equal(calls,2);
    await assert.rejects(worker.retry(owner,id,{resendAccepted:true},'retry'),/conflict/);
  }finally{await store.close();}
});

test('crash in flight recovers to unknown; deleted and revoked owners are not sent',async()=>{
  const {store,tasks,task,id}=await fixture();let calls=0;
  const sender=async():Promise<DeliveryOutcome>=>{calls++;return {state:'api_accepted'};};
  try{
    await store.transaction([{sql:'INSERT INTO notification_parts VALUES (?,?,?,?,?,?)',params:['part',id,0,'text','in_flight','attempt']}]);
    const recovered=new NotificationWorker(store,()=>true,sender);
    await recovered.flush();assert.equal(calls,0);
    assert.equal((await store.all('SELECT state FROM notifications'))[0].state,'unknown');
    await recovered.retry(owner,id,{includeUnknown:true});
    await new NotificationWorker(store,()=>false,sender).flush();assert.equal(calls,0);
    await tasks.setState(owner,task.id,'delete');await recovered.flush();assert.equal(calls,0);
  }finally{await store.close();}
});

test('v1 migration preserves tasks and adds delivery parts transactionally',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'automation-migration-'));
  const file=path.join(root,'store.sqlite');let store=new AutomationStore(file);
  try{
    await store.transaction([
      {sql:'DROP TABLE notification_parts'},
      {sql:'ALTER TABLE notification_attempts DROP COLUMN part_id'},
      {sql:'PRAGMA user_version=1'},
      {sql:"INSERT INTO tasks VALUES ('task','account','sender',1,'paused','{}',NULL,0,0)"}
    ]);
    await store.close();store=new AutomationStore(file);
    assert.equal((await store.all('PRAGMA user_version'))[0].user_version,4);
    assert.equal((await store.all('SELECT id FROM tasks'))[0].id,'task');
    assert.equal((await store.all('PRAGMA table_info(notification_attempts)')).some(c=>c.name==='part_id'),true);
  }finally{await store.close();fs.rmSync(root,{recursive:true,force:true});}
});
