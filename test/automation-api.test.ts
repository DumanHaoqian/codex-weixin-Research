import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AutomationRuntime } from '../src/automation/runtime.js';
import { startLocalHttpServer } from '../src/server/http-server.js';
import { resolveStatePaths } from '../src/state/paths.js';
import { defaultConfig, saveConfig } from '../src/state/config.js';

test('automation API inherits CSRF checks and verifies the requested owner',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'automation-api-'));
  let now=1000;
  const runtime=new AutomationRuntime(root,{now:()=>now,authorize:owner=>owner.accountId==='a'&&owner.senderId==='s'});
  const server=await startLocalHttpServer({paths:resolveStatePaths(root),accountManager:{} as never,automation:runtime,port:0});
  try {
    const query='?accountId=a&senderId=s';
    const headers={'Content-Type':'application/json',Origin:server.url,'X-Codex-Weixin-Token':server.requestToken,'Idempotency-Key':'request'};
    const body=JSON.stringify({definition:{title:'Test',prompt:'Check',kind:'reminder',schedule:{kind:'once',atUtc:new Date(2000).toISOString(),timezone:'UTC'}}});
    const denied=await fetch(server.url+'/api/automation/tasks'+query,{method:'POST',headers:{'Content-Type':'application/json'},body});
    assert.equal(denied.status,403);
    const created=await fetch(server.url+'/api/automation/tasks'+query,{method:'POST',headers,body});
    assert.equal(created.status,201);
    const task=(await created.json() as any).task;
    const retry=await fetch(server.url+'/api/automation/tasks'+query,{method:'POST',headers,body});
    assert.equal((await retry.json() as any).task.id,task.id);
    assert.equal((await fetch(server.url+'/api/automation/tasks?accountId=a&senderId=intruder')).status,403);
    now=2000; await runtime.scan();
    const runs=await fetch(server.url+'/api/automation/runs'+query);
    assert.equal((await runs.json() as any).items[0].state,'succeeded');
    const notifications=await fetch(server.url+'/api/automation/notifications'+query);
    assert.equal((await notifications.json() as any).items[0].state,'pending');
    const status=await fetch(server.url+'/api/automation/status');
    assert.equal((await status.json() as any).delivery.ready,false);
  } finally {await server.close();await runtime.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('disabled preview serves status and refuses activation without creating a database',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'automation-disabled-'));
  const server=await startLocalHttpServer({paths:resolveStatePaths(root),accountManager:{} as never,port:0});
  try {
    const status=await fetch(server.url+'/api/automation/status');
    assert.equal((await status.json() as any).enabled,false);
    assert.equal((await fetch(server.url+'/api/automation/tasks?accountId=a&senderId=s')).status,503);
    assert.equal(fs.existsSync(path.join(root,'automation')),false);
    for(const file of ['automation.html','automation.js','automation.css']){
      const asset=await fetch(`${server.url}/${file}`);assert.equal(asset.status,200);
      assert.ok((await asset.text()).length>100);
    }
  } finally {await server.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('remote automation refuses startup without Web authentication',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'automation-auth-'));
  saveConfig(resolveStatePaths(root),defaultConfig(root));
  try {
    assert.throws(()=>execFileSync(process.execPath,['--import',import.meta.resolve('tsx'),
      fileURLToPath(new URL('../src/server/index.ts',import.meta.url)),'--foreground'],{
      cwd:root,timeout:5000,stdio:'pipe',env:{...process.env,CODEX_WEIXIN_STATE_DIR:root,
        CODEX_WEIXIN_AUTOMATION:'1',CODEX_WEIXIN_HOST:'0.0.0.0',CODEX_WEIXIN_OPEN:'0',
        CODEX_WEIXIN_USERNAME:'',CODEX_WEIXIN_PASSWORD:''}
    }),error=>/Remote automation access requires configured Web authentication/.test(String((error as {stderr?:Buffer}).stderr)));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('manual execution and explicit notification resend are idempotent end to end',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'automation-flow-'));let now=0,sends=0;
  const runtime=new AutomationRuntime(root,{now:()=>now,authorize:o=>o.accountId==='a'&&o.senderId==='s',send:async()=>{sends++;return {state:'api_accepted'};}});
  const server=await startLocalHttpServer({paths:resolveStatePaths(root),accountManager:{} as never,automation:runtime,port:0});
  const query='?accountId=a&senderId=s';
  const headers={'Content-Type':'application/json',Origin:server.url,'X-Codex-Weixin-Token':server.requestToken,'Idempotency-Key':'create'};
  try{
    const created=await fetch(`${server.url}/api/automation/tasks${query}`,{method:'POST',headers,body:JSON.stringify({definition:{title:'one',prompt:'check',kind:'reminder',schedule:{kind:'once',atUtc:new Date(1000).toISOString(),timezone:'UTC'}}})});
    const task=(await created.json() as any).task;
    const run=async()=>fetch(`${server.url}/api/automation/tasks/${task.id}/run${query}`,{method:'POST',headers:{...headers,'Idempotency-Key':'manual'},body:'{}'});
    const first=await run(),second=await run();
    assert.equal(first.status,201);assert.equal((await first.json() as any).run.id,(await second.json() as any).run.id);
    assert.equal((await runtime.tasks.get({accountId:'a',senderId:'s'},task.id)).nextDue,1000);
    await runtime.delivery!.flush();assert.equal(sends,1);
    const notification=(await runtime.store.all('SELECT * FROM notifications'))[0];
    const resend=async(body:object)=>fetch(`${server.url}/api/automation/notifications/${notification.id}/resend${query}`,{method:'POST',headers:{...headers,'Idempotency-Key':'retry'},body:JSON.stringify(body)});
    assert.equal((await resend({})).status,409);
    assert.equal((await resend({resendAccepted:true})).status,202);await runtime.delivery!.flush();assert.equal(sends,2);
    assert.equal((await resend({resendAccepted:true})).status,202);await runtime.delivery!.flush();assert.equal(sends,2);
    assert.equal((await runtime.store.all('SELECT count(*) n FROM runs'))[0].n,1);
    now=1000;await runtime.scan();
    assert.equal((await runtime.store.all('SELECT count(*) n FROM runs'))[0].n,2);
  }finally{await server.close();await runtime.close();fs.rmSync(root,{recursive:true,force:true});}
});
