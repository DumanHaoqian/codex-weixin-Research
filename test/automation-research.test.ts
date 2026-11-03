import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import { AutomationRuntime } from '../src/automation/runtime.js';
import { setMemoryProjects,globalMemoryFile,projectMemoryFile } from '../src/bridge/memory.js';
import { projectNavigation,ResponsesAnalysisPort,buildAnalysisContext } from '../src/automation/agent.js';
import { compareMetrics,type Metrics } from '../src/automation/results.js';
import { type ResearchRemotePort,type RemoteRequest,type RemoteReceipt,hash } from '../src/automation/research-contracts.js';
import { type Paper,parseArxiv,parseCrossref } from '../src/automation/literature.js';
import { taskSchema,type TaskInput } from '../src/automation/tasks.js';
import { automationRoute } from '../src/server/automation-routes.js';
import { textOnlyRequest,assertTextOnlyResponse } from '../src/automation/inference-firewall.js';
import { handleWeixinAutomation } from '../src/automation/weixin-commands.js';

const owner={accountId:'a',senderId:'s'},target={server:'test',bindingHash:'b'.repeat(64)};
function metrics(jobId:string,value=0.8):Metrics{return {schemaVersion:1,jobId,dataset:'dataset',split:'test-v1',codeVersion:'recorded',seed:1,evaluationProtocol:'held-out',metrics:{accuracy:{value,unit:'fraction',direction:'max',definition:'correct / n'}}};}
const once={kind:'once' as const,atUtc:new Date(1000).toISOString(),timezone:'UTC'};
function workflow(mode:'immediate'|'launch_when_ready'|'reserve_then_handoff'='immediate'):TaskInput{return {kind:'research_workflow',title:'Experiment',prompt:'fixed recipe only',schedule:once,
  workflow:{target,recipe:{root:'/project',executable:'/python',args:['train.py'],codeVersion:'latest_record'},mode,grant:{submit:true,reserve:mode==='reserve_then_handoff',stop:false},
    resource:{gpuCount:1,minFreeBytes:1024,maxUsedBytes:64*1024**2,holderBytes:1024,holdSeconds:30,stableSamples:2,waitDeadlineUtc:new Date(200000).toISOString(),handoff:'automatic'},monitorSeconds:5}};}
class FakeRemote implements ResearchRemotePort{
  now=0;submits=0;reserves=0;handoffs=0;loseSubmit=false;objects=new Map<string,any>();operations=new Map<string,string>();
  async invoke(r:RemoteRequest):Promise<RemoteReceipt>{
    const receipt=(state:RemoteReceipt['state'],objectId?:string,payload:Record<string,unknown>={}):RemoteReceipt=>({version:1,operationId:r.operationId,payloadHash:r.payloadHash,ownerScope:r.ownerScope,serverId:'machine',bootId:'boot',uid:1000,remoteNow:this.now,state,...(objectId?{objectId}:{}),payload});
    if(r.action==='preflight')return receipt('ready',undefined,{tmux:true,reservation:true,gpu:[{uuid:'GPU-abc',index:0,totalBytes:24*1024**3,usedBytes:0,utilization:0,pids:[]}]});
    if(r.action==='submit'||r.action==='reserve'){
      const id=String(r.payload.objectId);this.operations.set(r.operationId,id);this.objects.set(id,{kind:r.action==='reserve'?'lease':'job',state:r.action==='reserve'?'held':'running',scope:r.ownerScope,deadline:r.payload.leaseDeadlineMs,
        payload:r.action==='reserve'?{allocation:{bytesPerGpu:(r.payload.resource as any).holderBytes,gpuUuids:r.payload.selectedGpuUuids}}:{}});
      if(r.action==='submit'){this.submits++;if(this.loseSubmit){this.loseSubmit=false;throw new Error('lost accepted response');}}else this.reserves++;
      return receipt('accepted',id);
    }
    if(r.action==='handoff'){
      this.handoffs++;const lease=this.objects.get(String(r.payload.objectId));lease.state='handed_off';lease.payload.handoffJobId=r.payload.jobId;
      this.objects.set(String(r.payload.jobId),{kind:'job',state:'running',scope:r.ownerScope,payload:{}});return receipt('accepted',String(r.payload.objectId));
    }
    const id=r.action==='reconcile'?this.operations.get(String(r.payload.operationId)):String(r.payload.objectId);
    if(!id||!this.objects.has(id))return receipt('not_found');
    const o=this.objects.get(id);if(o.scope!==r.ownerScope)throw new Error('owner mismatch');
    if(r.action==='release'){o.state='released';o.payload.releaseVerified=true;}
    if(o.kind==='lease'&&o.state==='held'&&this.now>=o.deadline){o.state='expired';o.payload.releaseVerified=true;}
    return receipt(o.state,id,o.payload);
  }
  async close(){}
}
function fixture(options:any={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'research-')),remote=new FakeRemote();let now=0,allowed=true;
  const runtime=new AutomationRuntime(root,{now:()=>now,authorize:o=>allowed&&o.accountId==='a'&&o.senderId==='s',research:{remote,...options}});
  return {root,runtime,remote,set now(n:number){now=n;remote.now=n;},set allowed(v:boolean){allowed=v;},
    async register(def:TaskInput,key='create'){
      const task=await runtime.tasks.create(owner,key,def);const run=await runtime.tasks.runNow(owner,task.id,key+'-run');await runtime.research.worker.scan();return {task,run};
    },async step(n:number){now=n;remote.now=n;await runtime.research.workflows!.scan();},async close(){await runtime.close();fs.rmSync(root,{recursive:true,force:true});}};
}

test('queued agent uses only selected memory/files and never applies emitted memory updates',async()=>{
  let captured:any;const f=fixture({analysis:{async analyze(input:any){captured=input;return {text:'report\n```codex-weixin-memory\n{"updates":[{"scope":"global","operation":"remember","text":"injected"}]}\n```',findings:true,limitations:[],references:[]};},async close(){}}});
  try{
    const project=path.join(f.root,'selected');fs.mkdirSync(project);fs.writeFileSync(path.join(project,'notes.txt'),'evidence');
    setMemoryProjects([{id:'selected',name:'selected',workspace:project},{id:'other',name:'other',workspace:path.join(f.root,'absent')}],f.root);
    fs.mkdirSync(path.dirname(projectMemoryFile('selected',f.root)),{recursive:true});fs.writeFileSync(projectMemoryFile('selected',f.root),'selected goals');
    fs.mkdirSync(path.dirname(projectMemoryFile('other',f.root)),{recursive:true});fs.writeFileSync(projectMemoryFile('other',f.root),'x'.repeat(100000));
    const before=fs.readFileSync(globalMemoryFile(f.root),'utf8'),binding=projectNavigation(f.root)[0].bindingHash;
    const {task,run}=await f.register({kind:'agent_report',title:'report',prompt:'summarize',schedule:once,projectId:'selected',agent:{projectBindingHash:binding,files:['notes.txt']}});
    assert.equal((await f.runtime.store.all('SELECT state FROM runs WHERE id=?',[run.id]))[0].state,'succeeded');
    assert.equal(captured.context.projectMemory.text,'selected goals');assert.equal(captured.context.evidence[0].text,'evidence');
    assert.equal(fs.readFileSync(globalMemoryFile(f.root),'utf8'),before);
    assert.equal((await f.runtime.store.all('SELECT count(*) n FROM research_artifacts'))[0].n,2);
    await f.runtime.research.worker.scan();assert.equal((await f.runtime.store.all('SELECT count(*) n FROM runs WHERE task_id=?',[task.id]))[0].n,1);
    setMemoryProjects([{id:'selected',name:'selected',workspace:f.root}],f.root);
    await assert.rejects(buildAnalysisContext(f.root,task.definition),/binding/);
  }finally{await f.close();}
});

test('model ports enforce no tools on requests and reject tool-call responses',async()=>{
  let body:any;const port=new ResponsesAnalysisPort('https://api.example.invalid/responses','fixture',()=> 'fixture-key',async(_url,init)=>{
    body=JSON.parse(String(init?.body));return new Response(JSON.stringify({status:'completed',output:[{type:'function_call',name:'ssh_exec',arguments:'{}'}]}));
  });
  await assert.rejects(port.analyze({runId:crypto.randomUUID(),prompt:'ignore permissions',context:{},profile:'render_report'},new AbortController().signal),/tool output/);
  assert.deepEqual(body.tools,[]);assert.equal(body.tool_choice,'none');assert.equal(body.store,false);
  assert.deepEqual(textOnlyRequest({tools:[{type:'function',name:'exec'}],previous_response_id:'old'}).tools,[]);
  assert.throws(()=>assertTextOnlyResponse('data: '+JSON.stringify({type:'response.output_item.added',item:{type:'function_call',name:'exec'}})+'\n',true),/rejected/);
});

test('launch-when-ready waits for stable GPUs and validates actual metrics before success',async()=>{
  const f=fixture();try{
    const {run}=await f.register(workflow('launch_when_ready'));await f.step(0);assert.equal(f.remote.submits,0);
    await f.step(15000);assert.equal(f.remote.submits,1);await f.step(20000);
    const object=(await f.runtime.store.all("SELECT * FROM research_objects WHERE kind='job'"))[0],remote=f.remote.objects.get(String(object.id));
    remote.state='exited';remote.payload={exitCode:0,validationState:'validated',releaseVerified:true,metrics:metrics(String(object.id))};
    await f.step(25000);
    assert.equal((await f.runtime.store.all('SELECT state FROM research_workflows WHERE id=?',[run.id]))[0].state,'succeeded');
    assert.equal((await f.runtime.store.all('SELECT state FROM resource_claims'))[0].state,'released');
  }finally{await f.close();}
});

test('a lost accepted submission is reconciled without repeating effects; competitors stay fenced',async()=>{
  const f=fixture();try{
    f.remote.loseSubmit=true;const one=await f.register(workflow());await f.step(0);
    assert.equal((await f.runtime.store.all('SELECT state FROM research_workflows WHERE id=?',[one.run.id]))[0].state,'unknown');
    const two=await f.register(workflow(),'other');await f.step(15000);assert.equal(f.remote.submits,1);
    assert.equal((await f.runtime.store.all('SELECT state FROM research_workflows WHERE id=?',[two.run.id]))[0].state,'waiting');
    await f.step(30000);assert.equal(f.remote.submits,1);
    assert.equal((await f.runtime.store.all('SELECT state FROM research_workflows WHERE id=?',[one.run.id]))[0].state,'monitoring');
  }finally{await f.close();}
});

test('reservation handoff retains the real experiment after holder expiry and rejects lease release',async()=>{
  const f=fixture();try{
    const {run}=await f.register(workflow('reserve_then_handoff'));await f.step(0);await f.step(15000);assert.equal(f.remote.reserves,1);
    await f.step(20000);assert.equal(f.remote.handoffs,1);await f.step(25000);
    const row=(await f.runtime.store.all('SELECT * FROM research_workflows WHERE id=?',[run.id]))[0],data=JSON.parse(String(row.data));
    assert.ok(data.jobId);assert.equal(row.state,'monitoring');
    await assert.rejects(f.runtime.research.workflows!.control(owner,run.id,'release','release'),/pure holder/);
    await f.step(50000);assert.equal(f.remote.objects.get(data.jobId).state,'running');assert.equal(f.remote.handoffs,1);
    await assert.rejects(f.runtime.research.workflows!.control(owner,run.id,'stop','stop'),/not granted/);
  }finally{await f.close();}
});

test('exit zero without validated metrics remains needs_review, never scientific success',async()=>{
  const f=fixture();try{
    const {run}=await f.register(workflow());await f.step(0);
    const object=(await f.runtime.store.all('SELECT id FROM research_objects'))[0];f.remote.objects.get(String(object.id)).state='exited';f.remote.objects.get(String(object.id)).payload={exitCode:0,validationState:'needs_review'};
    await f.step(5000);assert.equal((await f.runtime.store.all('SELECT state FROM research_workflows WHERE id=?',[run.id]))[0].state,'needs_review');
  }finally{await f.close();}
});

test('comparison limits conclusions on incompatible evidence and artifact access is owner scoped',async()=>{
  const a={id:crypto.randomUUID(),metrics:metrics(crypto.randomUUID())},b={id:crypto.randomUUID(),metrics:{...metrics(crypto.randomUUID(),0.9),split:'other'}};
  const result=compareMetrics(a,[b]);assert.equal(result.rows[0].delta,null);assert.deepEqual(result.rows[0].reasons,['split differs']);
  const f=fixture();try{
    const {task,run}=await f.register(workflow());const artifact=await f.runtime.research.artifacts.write(task.id,run.id,'proof.json',result,0);
    await assert.rejects(f.runtime.research.artifacts.read(artifact.id,'a','intruder'),/not found/);
    assert.ok((await f.runtime.research.artifacts.read(artifact.id,'a','s')).text.includes('split differs'));
    const url=new URL(`http://localhost/api/automation/artifacts/${artifact.id}?accountId=a&senderId=intruder`);
    assert.equal((await automationRoute('GET',url,undefined,undefined,f.runtime)).status,403);
  }finally{await f.close();}
});

test('literature keeps failed cursors, resumes partial pages and separates discovery from delivery',async()=>{
  const paper:Paper={identity:'doi:10.1234/test',version:hash('v1'),title:'Paper',authors:['Author'],source:'crossref',url:'https://doi.org/10.1234/test',date:'2026-11-04',dateType:'indexed',readingLevel:'metadata',status:'active'};
  const cursors:Array<string|null>=[];let sourceFailure=true;
  const f=fixture({literature:async(source:string,_query:string,_start:number,_end:number,cursor:string|null)=>{
    if(source==='arxiv'&&sourceFailure)throw new Error('unavailable');cursors.push(cursor);return {items:[paper],nextCursor:cursor===null?'page2':null};
  }});
  try{
    const task=await f.runtime.tasks.create(owner,'literature',{kind:'literature_watch',title:'papers',prompt:'track only',schedule:once,literature:{query:'test',sources:['crossref','arxiv'],pageBudget:1}});
    await f.runtime.tasks.runNow(owner,task.id,'first');await f.runtime.research.worker.scan();
    assert.equal((await f.runtime.store.all('SELECT count(*) n FROM literature_matches'))[0].n,1);
    assert.equal((await f.runtime.store.all('SELECT complete FROM literature_cursors WHERE source=\'arxiv\''))[0].complete,0);
    sourceFailure=false;await f.runtime.tasks.runNow(owner,task.id,'second');await f.runtime.research.worker.scan();
    assert.ok(cursors.includes('page2'));assert.equal((await f.runtime.store.all('SELECT count(*) n FROM literature_matches'))[0].n,1);
    assert.equal((await f.runtime.store.all("SELECT count(*) n FROM notifications WHERE state='api_accepted'"))[0].n,0);
  }finally{await f.close();}
});

test('provider parsers reject unsafe XML and preserve reading level and stable identities',()=>{
  assert.throws(()=>parseArxiv('<!DOCTYPE feed [<!ENTITY x "boom">]><feed/>',0,1),/Unsafe/);
  const parsed=parseArxiv('<feed xmlns="http://www.w3.org/2005/Atom"><opensearch:totalResults xmlns:opensearch="http://a">1</opensearch:totalResults><entry><id>http://arxiv.org/abs/2601.12345v2</id><title>Example</title><updated>2026-11-04T00:00:00Z</updated><published>2026-01-01T00:00:00Z</published><author><name>A</name></author><summary>abstract</summary></entry></feed>',0,1);
  assert.equal(parsed.items[0].identity,'arxiv:2601.12345');assert.equal(parsed.items[0].readingLevel,'abstract');assert.equal(parsed.nextCursor,null);
  const cross=parseCrossref(JSON.stringify({message:{items:[{DOI:'10.1234/X',title:['Example'],indexed:{'date-time':'2026-11-04'},author:[{family:'A'}]}]}}),20);
  assert.equal(cross.items[0].identity,'doi:10.1234/x');assert.equal(cross.items[0].readingLevel,'metadata');
});

test('concurrent workflow controls retain the first intent and idempotent replay; terminal controls are rejected',async()=>{
  const f=fixture();try{
    const {run}=await f.register(workflow());await f.step(0);
    const control=f.runtime.research.workflows!;
    const responses=await Promise.allSettled([control.control(owner,run.id,'stop_monitor','one'),control.control(owner,run.id,'stop_monitor','two')]);
    assert.equal(responses.filter(r=>r.status==='fulfilled').length,1);
    assert.deepEqual(await control.control(owner,run.id,'stop_monitor','one'),{queued:true,workflowId:run.id,action:'stop_monitor'});
    await f.step(5000);assert.equal((await f.runtime.store.all('SELECT state FROM research_workflows WHERE id=?',[run.id]))[0].state,'paused');
    await assert.rejects(control.control(owner,run.id,'stop_monitor','three'),/not active/);
    await control.control(owner,run.id,'resume_monitor','resume');await f.step(10000);
    assert.equal(f.remote.submits,1);
  }finally{await f.close();}
});

test('a lease releases on TTL without handoff and stale GPU samples cannot satisfy stability',async()=>{
  const f=fixture();try{
    const input=workflow('reserve_then_handoff');input.workflow!.resource.handoff='manual';
    const {run}=await f.register(input);await f.step(0);await f.step(60000);assert.equal(f.remote.reserves,0);
    await f.step(75000);assert.equal(f.remote.reserves,1);await f.step(80000);assert.equal(f.remote.handoffs,0);
    await f.step(110000);assert.equal((await f.runtime.store.all('SELECT state FROM research_workflows WHERE id=?',[run.id]))[0].state,'expired');
    assert.equal((await f.runtime.store.all('SELECT state FROM resource_claims'))[0].state,'released');
  }finally{await f.close();}
});

test('an ambiguous handoff with a persisted child identity follows that child without repeating submission',async()=>{
  const f=fixture();try{
    const {run}=await f.register(workflow('reserve_then_handoff'));await f.step(0);await f.step(15000);await f.step(20000);
    const lease=[...f.remote.objects.values()].find(o=>o.kind==='lease');lease.state='unknown';
    await f.step(25000);const row=(await f.runtime.store.all('SELECT state,data FROM research_workflows WHERE id=?',[run.id]))[0];
    assert.equal(row.state,'monitoring');assert.ok(JSON.parse(String(row.data)).jobId);assert.equal(f.remote.handoffs,1);
  }finally{await f.close();}
});

test('cancelled analysis cannot publish a late report; WeChat exposes research commands and ownership',async()=>{
  let started!:()=>void,unblock!:(value:any)=>void;
  const began=new Promise<void>(resolve=>{started=resolve;});
  const f=fixture({analysis:{async analyze(){started();return new Promise(resolve=>{unblock=resolve;});},async close(){}}});
  try{
    const response=await handleWeixinAutomation(f.runtime,owner,{id:'agent-message',text:'/tasks agent 30m report'},0);
    assert.match(response!,/已保存定时 Agent/);
    const task=(await f.runtime.tasks.list(owner))[0],run=await f.runtime.tasks.runNow(owner,task.id,'cancel-run');
    const scan=f.runtime.research.worker.scan();await began;
    const reply=await automationRoute('POST',new URL(`http://localhost/api/automation/runs/${run.id}/cancel?accountId=a&senderId=s`),{},'cancel-once',f.runtime);
    assert.equal(reply.status,200);unblock({text:'late',findings:true,limitations:[],references:[]});await scan;
    assert.equal((await f.runtime.store.all('SELECT state FROM runs WHERE id=?',[run.id]))[0].state,'cancelled');
    assert.equal((await f.runtime.store.all("SELECT count(*) n FROM research_artifacts WHERE name='report.json'"))[0].n,0);
    assert.equal(await handleWeixinAutomation(f.runtime,owner,{id:'jobs',text:'/jobs'},0),'暂无科研流程。');
    assert.match((await handleWeixinAutomation(f.runtime,{accountId:'a',senderId:'intruder'},{id:'private',text:'/results'},0))!,/Access denied/);
  }finally{await f.close();}
});
