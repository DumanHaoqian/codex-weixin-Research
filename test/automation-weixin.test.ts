import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AutomationRuntime } from '../src/automation/runtime.js';
import { handleWeixinAutomation } from '../src/automation/weixin-commands.js';
import { BridgeService } from '../src/bridge/service.js';
import { AccountManager } from '../src/server/account-manager.js';
import { RuntimeStateStore } from '../src/state/runtime-state.js';
import { accountStatePaths,resolveStatePaths } from '../src/state/paths.js';
import { defaultConfig } from '../src/state/config.js';
import { saveAccount } from '../src/weixin/accounts.js';
import { WeixinApiError } from '../src/weixin/api.js';

const owner={accountId:'account',senderId:'alice'};
test('explicit reminder commands persist once; ordinary discussion does not create tasks',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'automation-command-'));let now=1000;
  const runtime=new AutomationRuntime(root,{now:()=>now,authorize:o=>o.senderId==='alice'});
  const command=(id:string,text:string)=>handleWeixinAutomation(runtime,owner,{id,text},now);
  try{
    assert.equal(await command('ordinary','解释“30分钟后提醒我检查”是什么意思'),undefined);
    assert.match((await command('create','30分钟后提醒我检查结果'))!,/已保存提醒/);
    const task=(await runtime.tasks.list(owner))[0];assert.equal(task.nextDue,1_801_000);
    now=5000;await command('create','30分钟后提醒我检查结果');
    assert.equal((await runtime.tasks.list(owner)).length,1);
    assert.equal((await runtime.tasks.get(owner,task.id)).nextDue,task.nextDue);
    assert.match((await command('create','30分钟后提醒我其他内容'))!,/conflict/);
    await command('pause',`/tasks pause ${task.id}`);
    assert.equal((await runtime.tasks.get(owner,task.id)).state,'paused');
    await command('manual',`/tasks run ${task.id}`);await command('manual',`/tasks run ${task.id}`);
    assert.equal((await runtime.store.all('SELECT count(*) n FROM runs'))[0].n,1);
    assert.equal((await runtime.tasks.get(owner,task.id)).nextDue,null);
    await command('edit',`/tasks edit ${task.id} ${JSON.stringify({...task.definition,prompt:'preserve  double spaces'})}`);
    assert.equal((await runtime.tasks.get(owner,task.id)).definition.prompt,'preserve  double spaces');
    assert.match((await command('bad','/tasks every 1m 太频繁'))!,/参数无效/);
    assert.match((await command('bad-time','/tasks at 2026-12-01T09:00 无时区'))!,/时区偏移/);
    await command('daily','每天9:00提醒我检查');
    const daily=(await runtime.tasks.list(owner)).find(t=>t.definition.schedule.kind==='daily')!;
    assert.equal((daily.definition.schedule as {time:string}).time,'09:00');
  }finally{await runtime.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('bridge calls task handler only after access and stores fresh context first',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'automation-bridge-'));
  const store=new RuntimeStateStore(resolveStatePaths(root));let calls=0;
  const replies:string[]=[];
  const bridge=new BridgeService({config:{...defaultConfig(root),allowedSenderIds:['alice']},stateStore:store,
    runner:{run(){throw new Error('Task commands must not call the model');}} as never,
    weixin:{async sendText(input:{text:string}){replies.push(input.text);}} as never,
    onAutomationMessage:async m=>{calls++;assert.equal(store.getContextToken(m.senderId),'fresh');return '任务已保存';}});
  try{
    await bridge.handleMessage({id:'deny',senderId:'intruder',text:'/tasks',contextToken:'bad',attachments:[],raw:{}});
    assert.equal(calls,0);
    await bridge.handleMessage({id:'allow',senderId:'alice',text:'/tasks',contextToken:'fresh',attachments:[],raw:{}});
    assert.equal(calls,1);assert.equal(replies.at(-1),'任务已保存');
  }finally{await bridge.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('automation sends to original account and sender, distinguishing rejection from uncertain transport',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'automation-sender-'));
  const paths=resolveStatePaths(root);let error:Error|undefined;
  const sent:Array<Record<string,unknown>>=[];
  saveAccount(paths,{accountId:'account',token:'fixture',baseUrl:'https://example.invalid',cdnBaseUrl:'https://example.invalid',savedAt:new Date().toISOString(),enabled:true});
  const store=new RuntimeStateStore(accountStatePaths(paths,'account'));
  store.setPairedSenderIds(['alice']);store.rememberContextToken('alice','context-alice');store.rememberContextToken('bob','context-bob');
  const manager=new AccountManager({paths,clientFactory:()=>({async sendText(input:Record<string,unknown>){sent.push(input);if(error)throw error;}} as never)});
  try{
    assert.equal((await manager.sendAutomationText(owner,'hello')).state,'api_accepted');
    assert.deepEqual(sent[0],{toUserId:'alice',text:'hello',contextToken:'context-alice'});
    assert.equal((await manager.sendAutomationText({...owner,senderId:'bob'},'private')).state,'deferred');
    assert.equal(sent.length,1);
    error=new WeixinApiError('stale','sendmessage',-2);
    assert.equal((await manager.sendAutomationText(owner,'hello')).state,'failed');
    error=new Error('connection reset');assert.equal((await manager.sendAutomationText(owner,'hello')).state,'unknown');
  }finally{await manager.stopAll();fs.rmSync(root,{recursive:true,force:true});}
});
