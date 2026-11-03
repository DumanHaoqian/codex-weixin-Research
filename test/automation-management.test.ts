import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AutomationStore } from '../src/automation/store.js';
import { TaskService, type TaskInput } from '../src/automation/tasks.js';
import { AutomationRuntime } from '../src/automation/runtime.js';
import { automationRoute } from '../src/server/automation-routes.js';
import { handleWeixinAutomation } from '../src/automation/weixin-commands.js';

const owner={accountId:'a',senderId:'s'};
const def:TaskInput={title:'check',prompt:'inspect results',kind:'reminder',schedule:{kind:'daily',time:'09:00',timezone:'UTC'}};

test('mutation retries survive restart and do not undo later edits or resumes',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'automation-mutation-'));
  const file=path.join(root,'test.sqlite');let store=new AutomationStore(file);
  let now=1000,allowed=true;
  const service=()=>new TaskService(store,{now:()=>now,authorize:()=>allowed});
  try{
    let tasks=service();const task=await tasks.create(owner,'create',def);
    const changed={...def,prompt:'first edit'};
    const updated=await tasks.update(owner,task.id,1,changed,'edit');
    await tasks.update(owner,task.id,2,{...def,prompt:'second edit'},'edit2');
    assert.equal((await tasks.update(owner,task.id,1,changed,'edit')).revision,updated.revision);
    assert.equal((await tasks.get(owner,task.id)).definition.prompt,'second edit');
    await assert.rejects(tasks.update(owner,task.id,1,def,'edit'),/Idempotency conflict/);
    const paused=await tasks.setState(owner,task.id,'pause','pause');
    now+=1000;const resumed=await tasks.setState(owner,task.id,'resume','resume');
    await store.close();store=new AutomationStore(file);tasks=service();
    assert.deepEqual(await tasks.setState(owner,task.id,'pause','pause'),paused);
    assert.deepEqual(await tasks.get(owner,task.id),resumed);
    await assert.rejects(tasks.setState(owner,task.id,'delete','pause'),/Idempotency conflict/);
    allowed=false;await assert.rejects(tasks.setState(owner,task.id,'pause','pause'),/Access denied/);
  }finally{await store.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('keyset pages reach all older history across equal timestamps and notification updates',async()=>{
  const store=new AutomationStore(':memory:');let now=0;
  const tasks=new TaskService(store,{now:()=>now,authorize:()=>true});
  try{
    const task=await tasks.create(owner,'one',def);
    for(let i=0;i<107;i++)await tasks.runNow(owner,task.id,`run-${i}`);
    await tasks.create({...owner,senderId:'other'},'private',def);
    for(const kind of ['runs','notifications'] as const){
      const seen:string[]=[];let cursor:string|undefined;
      do{
        const page=await tasks.page(owner,kind,{limit:13,cursor});
        seen.push(...page.items.map(item=>String(item.id)));cursor=page.nextCursor??undefined;
        if(kind==='notifications')await store.transaction([{sql:'UPDATE notifications SET updated_at=?',params:[++now]}]);
      }while(cursor);
      assert.equal(seen.length,107);assert.equal(new Set(seen).size,107);
    }
    const first=await tasks.page(owner,'runs',{limit:1});
    await assert.rejects(tasks.page({...owner,senderId:'other'},'runs',{cursor:first.nextCursor!}),/Invalid pagination/);
    await assert.rejects(tasks.page(owner,'notifications',{cursor:first.nextCursor!}),/Invalid pagination/);
    await assert.rejects(tasks.page(owner,'runs',{cursor:'bad'}),/Invalid pagination/);
    await assert.rejects(tasks.page(owner,'runs',{limit:101}));
    assert.equal((await tasks.page(owner,'tasks')).items.length,1);
    const run=await tasks.runNow(owner,task.id,'retry-after-edit');
    await tasks.update(owner,task.id,1,{...def,title:'edited'});
    assert.deepEqual(await tasks.runNow(owner,task.id,'retry-after-edit'),run);
  }finally{await store.close();}
});

test('API requires mutation keys and WeChat edit replay keeps one revision',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'automation-management-api-'));
  const runtime=new AutomationRuntime(root,{now:()=>0,authorize:o=>o.senderId==='s'});
  const url=(route:string)=>new URL(`http://localhost/api/automation${route}?accountId=a&senderId=s`);
  try{
    const task=await runtime.tasks.create(owner,'one',def);
    for(const [method,route,body] of [['PATCH',`/tasks/${task.id}`,{expectedRevision:1,definition:def}],['POST',`/tasks/${task.id}/pause`,{}],['DELETE',`/tasks/${task.id}`,undefined]] as const){
      assert.equal((await automationRoute(method,url(route),body,undefined,runtime)).status,400);
    }
    const message={id:'wx-edit',text:`/tasks edit ${task.id} ${JSON.stringify({...def,prompt:'new'})}`};
    assert.match((await handleWeixinAutomation(runtime,owner,message))!,/修订 2/);
    assert.match((await handleWeixinAutomation(runtime,owner,message))!,/修订 2/);
    assert.equal((await runtime.tasks.get(owner,task.id)).revision,2);
    assert.equal((await automationRoute('GET',new URL(url('/runs')+'&cursor=bad'),undefined,undefined,runtime)).status,400);
  }finally{await runtime.close();fs.rmSync(root,{recursive:true,force:true});}
});
