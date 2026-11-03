import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AutomationRuntime } from '../src/automation/runtime.js';
import { McpGpuObservationPort, GPU_QUERY, GPU_PROCESS_QUERY, parseGpuSnapshot, eligibleGpuUuids, gpuWatchSchema, type GpuSnapshot } from '../src/automation/gpu.js';
import { automationRoute } from '../src/server/automation-routes.js';
import { handleWeixinAutomation } from '../src/automation/weixin-commands.js';

const owner={accountId:'a',senderId:'s'},binding='b'.repeat(64),MiB=1024**2;
const config={server:'g4090',bindingHash:binding,sampleSeconds:5,stableSamples:2,durationSeconds:300};
function snapshot(now:number,used=0,processes:Array<{pid:number;usedBytes:number|null}>=[]):GpuSnapshot{return {
  server:'g4090',bindingHash:binding,startedAt:now,observedAt:now,
  devices:[{uuid:'GPU-abc',index:0,name:'RTX test',totalBytes:24*1024**3,usedBytes:used,utilization:0,temperature:40,processes}]
};}
function setup(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'automation-gpu-'));
  let now=0,calls=0,used=1024*MiB,processes:Array<{pid:number;usedBytes:number|null}>=[],failure=false,allowed=true;
  const runtime=new AutomationRuntime(root,{now:()=>now,authorize:o=>allowed&&o.accountId==='a'&&o.senderId==='s',gpu:{
    async targets(){return [{server:'g4090',host:'test.invalid',port:22,user:'fixture',bindingHash:binding}];},
    async sample(){calls++;if(failure)throw new Error('denied');return snapshot(now,used,processes);},async close(){}
  }});
  return {root,runtime,get calls(){return calls;},set now(n:number){now=n;},set used(n:number){used=n;},set processes(p:typeof processes){processes=p;},set failure(b:boolean){failure=b;},set allowed(b:boolean){allowed=b;},
    async create(key:string){return runtime.tasks.create(owner,key,{title:key,prompt:'watch only',kind:'gpu_watch',gpuWatch:config,notification:'findings_or_failure',schedule:{kind:'once',atUtc:new Date(1000).toISOString(),timezone:'UTC'}});},
    async round(n:number){now=n;await runtime.tasks.tick();await runtime.gpu!.scan();},
    async close(){await runtime.close();fs.rmSync(root,{recursive:true,force:true});}};
}

test('GPU CSV retains process/memory occupancy at 0% and rejects unsupported readings',()=>{
  const identity={server:'g4090',bindingHash:binding,startedAt:1,observedAt:2};
  const parsed=parseGpuSnapshot('GPU-abc, 0, "NVIDIA, test", 24000, 2048, 0, 42','GPU-abc, 123, [N/A]',identity);
  assert.equal(parsed.devices[0].usedBytes,2048*MiB);assert.equal(parsed.devices[0].processes[0].usedBytes,null);
  assert.deepEqual(eligibleGpuUuids(parsed,gpuWatchSchema.parse(config)),[]);
  assert.deepEqual(eligibleGpuUuids(snapshot(0,0,[{pid:123,usedBytes:0}]),gpuWatchSchema.parse(config)),[]);
  assert.deepEqual(eligibleGpuUuids(snapshot(0),gpuWatchSchema.parse(config)),['GPU-abc']);
  assert.throws(()=>parseGpuSnapshot('GPU-abc, 0, test, 24000, N/A, 0, 42','',identity));
  assert.throws(()=>parseGpuSnapshot('GPU-abc, 0, test, 24000, 0, 0, 42','GPU-other, 123, 40',identity));
});

test('MCP broker refreshes canonical targets, pins bindings and sends only fixed read-only commands',async()=>{
  const calls:Array<[string,Record<string,unknown>]> = [];let host='server.invalid';
  const content=(value:unknown)=>({content:[{type:'text',text:JSON.stringify(value)}]});
  const port=new McpGpuObservationPort(async(tool,args)=>{
    calls.push([tool,args]);
    if(tool==='servers_list')return content([{name:'g4090',host,port:22,username:'user'},{name:'gateway',host:'jump.invalid',username:'user'}]);
    return content({server:'g4090',host,port:22,user:'user',stdout:args.command===GPU_QUERY?'GPU-abc, 0, test, 24000, 0, 0, 40':'',exitCode:0,timedOut:false});
  },['g4090'],undefined,()=>1000);
  const target=(await port.targets())[0];assert.equal(target.server,'g4090');
  const expected=crypto.createHash('sha256').update(JSON.stringify({server:'g4090',host,port:22,user:'user'})).digest('hex');
  assert.equal(target.bindingHash,expected);
  await port.sample(target.server,target.bindingHash);
  assert.deepEqual(calls.filter(([name])=>name==='ssh_exec').map(([,a])=>a),[
    {server:'g4090',command:GPU_QUERY,timeout_seconds:15},{server:'g4090',command:GPU_PROCESS_QUERY,timeout_seconds:15}
  ]);
  host='changed.invalid';await assert.rejects(port.sample(target.server,target.bindingHash),/binding changed/);
  assert.equal(calls.filter(([name])=>name==='ssh_exec').length,2);
  await assert.rejects(port.sample('other',target.bindingHash),/outside/);
  assert.throws(()=>new McpGpuObservationPort(async()=>null,['gateway']),/deferred/);
  const denied=new McpGpuObservationPort(async()=>({isError:true,content:[{type:'text',text:'approval denied'}]}),['g4090']);
  await assert.rejects(denied.targets(),/rejected or unavailable/);
});

test('shared sampling persists changes, silence, failure recovery and bounded expiration',async()=>{
  const f=setup();
  try{
    await f.create('watch-one');await f.create('watch-two');
    await f.round(1000);assert.equal(f.calls,1);
    assert.equal((await f.runtime.store.all('SELECT count(*) n FROM notifications'))[0].n,0);
    f.used=0;await f.round(6000);assert.equal(f.calls,2);
    await f.round(11000);
    assert.equal((await f.runtime.store.all('SELECT count(*) n FROM notifications'))[0].n,2);
    await f.round(16000);assert.equal((await f.runtime.store.all('SELECT count(*) n FROM notifications'))[0].n,2);
    f.processes=[{pid:99,usedBytes:0}];await f.round(21000);
    assert.equal((await f.runtime.store.all('SELECT count(*) n FROM notifications'))[0].n,4);
    f.failure=true;await f.round(26000);await f.round(31000);
    assert.equal((await f.runtime.store.all('SELECT count(*) n FROM notifications'))[0].n,6);
    const last=(await f.runtime.store.all('SELECT payload,validity FROM gpu_observations ORDER BY observed_at DESC LIMIT 1'))[0];
    assert.equal(last.validity,'unavailable');assert.equal(JSON.parse(String(last.payload)).snapshot,undefined);
    f.failure=false;await f.round(36000);
    assert.equal((await f.runtime.store.all('SELECT count(*) n FROM notifications'))[0].n,8);
    await f.round(301000);const before=f.calls;
    assert.deepEqual((await f.runtime.store.all('SELECT DISTINCT state FROM gpu_watches')).map(r=>r.state),['expired']);
    await f.round(306000);assert.equal(f.calls,before);
    assert.equal((await f.runtime.store.all('SELECT count(*) n FROM notifications'))[0].n,10);
  }finally{await f.close();}
});

test('monitor restart reuses identity, recent stability and change deduplication',async()=>{
  const f=setup();let restarted:AutomationRuntime|undefined;
  try{
    f.used=0;const task=await f.create('watch');await f.round(1000);
    const run=(await f.runtime.store.all('SELECT run_id FROM gpu_watches'))[0].run_id;
    await f.runtime.close();let calls=0,now=6000;
    restarted=new AutomationRuntime(f.root,{now:()=>now,authorize:()=>true,gpu:{async targets(){return [];},async sample(){calls++;return snapshot(now);},async close(){}}});
    await restarted.gpu!.scan();assert.equal(calls,1);
    assert.equal((await restarted.store.all('SELECT run_id FROM gpu_watches'))[0].run_id,run);
    assert.equal((await restarted.store.all('SELECT count(*) n FROM runs'))[0].n,1);
    assert.equal((await restarted.store.all('SELECT count(*) n FROM notifications'))[0].n,1);
    now=11000;await restarted.gpu!.scan();assert.equal((await restarted.store.all('SELECT count(*) n FROM notifications'))[0].n,1);
    await restarted.tasks.stopMonitor(owner,task.id,'stop');now=16000;await restarted.gpu!.scan();assert.equal(calls,2);
  }finally{await restarted?.close();await f.close();}
});

test('stop, delete, owner revocation and in-flight results cannot revive a monitor',async()=>{
  const f=setup();
  try{
    const task=await f.create('watch');await f.round(1000);
    await f.runtime.tasks.setState(owner,task.id,'pause','pause');
    await f.round(6000);assert.equal(f.calls,2); // pausing schedule is not stopping a monitor
    await f.runtime.tasks.stopMonitor(owner,task.id,'stop');await f.round(11000);assert.equal(f.calls,2);
    await f.runtime.tasks.runNow(owner,task.id,'new-monitor');f.allowed=false;await f.round(16000);
    assert.equal(f.calls,2);assert.equal((await f.runtime.store.all('SELECT state FROM gpu_watches'))[0].state,'blocked');
    f.allowed=true;await f.runtime.tasks.runNow(owner,task.id,'third');
    let release!:(value:GpuSnapshot)=>void;
    f.runtime.gpu!.port.sample=()=>new Promise(resolve=>{release=resolve;});
    const scan=f.runtime.gpu!.scan();
    while(!release)await new Promise(resolve=>setImmediate(resolve));
    await f.runtime.tasks.setState(owner,task.id,'delete','delete');
    release(snapshot(16000));await scan;
    assert.equal((await f.runtime.store.all('SELECT state FROM gpu_watches'))[0].state,'stopped');
    assert.equal((await f.runtime.store.all('SELECT count(*) n FROM gpu_observations'))[0].n,2);
  }finally{await f.close();}
});

test('GPU HTTP and WeChat entry points enforce ownership and distinct stop semantics',async()=>{
  const f=setup();
  const url=(route:string,who='s')=>new URL(`http://localhost/api/automation${route}?accountId=a&senderId=${who}`);
  try{
    const response=await handleWeixinAutomation(f.runtime,owner,{id:'wx-gpu',text:'/tasks gpu g4090 1h watch'},0);
    assert.match(response!,/已保存 GPU 监控/);
    await f.round(1000);const task=(await f.runtime.tasks.list(owner))[0];
    assert.equal((await automationRoute('GET',url('/gpu/watches','intruder'),undefined,undefined,f.runtime)).status,403);
    assert.equal((await automationRoute('GET',url('/gpu/targets'),undefined,undefined,f.runtime)).status,200);
    const observations=await automationRoute('GET',url('/gpu/observations'),undefined,undefined,f.runtime);
    assert.equal((observations.body as any).items.length,1);
    assert.equal((await automationRoute('POST',url(`/tasks/${task.id}/stop-monitor`),{},undefined,f.runtime)).status,400);
    assert.match((await handleWeixinAutomation(f.runtime,owner,{id:'stop',text:`/gpu stop ${task.id}`}))!,/没有终止服务器进程/);
    assert.match((await handleWeixinAutomation(f.runtime,owner,{id:'stop',text:`/gpu stop ${task.id}`}))!,/stopped/);
  }finally{await f.close();}
});

test('a stale gap and failed samples reset availability confirmation; repeated scans do not resample',async()=>{
  const f=setup();
  try{
    f.used=0;await f.create('watch');await f.round(1000);
    await f.round(1000);assert.equal(f.calls,1);
    await f.round(41000); // old valid sample has expired; this is a new first sample
    assert.equal((await f.runtime.store.all('SELECT stable_count FROM gpu_watches'))[0].stable_count,1);
    assert.equal((await f.runtime.store.all('SELECT count(*) n FROM notifications'))[0].n,0);
    f.failure=true;await f.round(46000);
    assert.equal((await f.runtime.store.all('SELECT stable_count FROM gpu_watches'))[0].stable_count,0);
    f.failure=false;await f.round(51000);
    assert.equal((await f.runtime.store.all('SELECT stable_count FROM gpu_watches'))[0].stable_count,1);
    await f.round(56000);
    assert.match(String((await f.runtime.store.all('SELECT last_signature FROM gpu_watches'))[0].last_signature),/^available:/);
  }finally{await f.close();}
});

test('active monitor limits survive exhausted time plans and manual starts',async()=>{
  const f=setup();
  try{
    for(let i=0;i<20;i++){
      const task=await f.create(`watch-${i}`);
      await f.runtime.tasks.setState(owner,task.id,'pause');
      await f.runtime.tasks.runNow(owner,task.id,`manual-${i}`);
    }
    const extra=await f.create('extra');
    await assert.rejects(f.runtime.tasks.runNow(owner,extra.id,'extra'),/limit/);
    await f.round(1000);
    assert.equal((await f.runtime.store.all('SELECT state FROM runs WHERE task_id=?',[extra.id]))[0].state,'blocked');
    assert.equal((await f.runtime.store.all("SELECT count(*) n FROM gpu_watches WHERE state='watching'"))[0].n,20);
  }finally{await f.close();}
});

test('muted monitors retain semantic events without enqueueing WeChat notifications',async()=>{
  const f=setup();
  try{
    f.used=0;const task=await f.create('muted');
    await f.runtime.tasks.update(owner,task.id,1,{...task.definition,notification:'muted'});
    await f.round(1000);await f.round(6000);await f.round(301000);
    assert.deepEqual((await f.runtime.store.all('SELECT kind FROM events ORDER BY created_at')).map(r=>r.kind),['gpu_changed','gpu_expired']);
    assert.equal((await f.runtime.store.all('SELECT count(*) n FROM notifications'))[0].n,0);
  }finally{await f.close();}
});

test('a stop committed immediately before the sample transaction discards its fact and event atomically',async()=>{
  const f=setup();const original=f.runtime.store.transaction.bind(f.runtime.store);
  try{
    f.used=0;const task=await f.create('race');await f.round(1000);
    let interleave=true;
    f.runtime.store.transaction=async statements=>{
      if(interleave&&statements.some(s=>s.sql.startsWith('INSERT INTO gpu_observations'))){
        interleave=false;await f.runtime.tasks.stopMonitor(owner,task.id,'race-stop');
      }
      return original(statements);
    };
    await f.round(6000);
    assert.equal((await f.runtime.store.all('SELECT count(*) n FROM gpu_observations'))[0].n,1);
    assert.equal((await f.runtime.store.all('SELECT count(*) n FROM events'))[0].n,0);
    assert.equal((await f.runtime.store.all('SELECT state FROM gpu_watches'))[0].state,'stopped');
  }finally{f.runtime.store.transaction=original;await f.close();}
});
