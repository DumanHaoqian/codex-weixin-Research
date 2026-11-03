// Isolated visual/E2E fixture. Never connects to WeChat, Codex or research servers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AutomationRuntime } from '../../dist/automation/runtime.js';
import { AccountManager } from '../../dist/server/account-manager.js';
import { startLocalHttpServer } from '../../dist/server/http-server.js';
import { saveAccount } from '../../dist/weixin/accounts.js';
import { resolveStatePaths,accountStatePaths } from '../../dist/state/paths.js';
import { RuntimeStateStore } from '../../dist/state/runtime-state.js';
import { defaultConfig,saveConfig } from '../../dist/state/config.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'automation-ui-'));
const paths=resolveStatePaths(root);saveConfig(paths,defaultConfig(root));
saveAccount(paths,{accountId:'demo-research',token:'fixture-only',baseUrl:'https://example.invalid',cdnBaseUrl:'https://example.invalid',savedAt:new Date().toISOString(),enabled:true});
const state=new RuntimeStateStore(accountStatePaths(paths,'demo-research'));state.setPairedSenderIds(['demo-user']);
const bindingHash='b'.repeat(64);
const target={server:'demo-gpu',host:'fixture.invalid',port:22,user:'demo',bindingHash};
const objects=new Map(),operations=new Map();
const metrics=(id,value)=>({schemaVersion:1,jobId:id,dataset:'fixture',split:'held-out',codeVersion:'fixture-v1',evaluationProtocol:'fixture-only',metrics:{score:{value,unit:'fraction',direction:'max',definition:'fixture score'}}});
const remote={async targets(){return [target];},async close(){},async invoke(r){
  const receipt=(state,objectId,payload={})=>({version:1,operationId:r.operationId,payloadHash:r.payloadHash,ownerScope:r.ownerScope,serverId:'fixture',bootId:'fixture',uid:1,remoteNow:Date.now(),state,...(objectId?{objectId}:{}),payload});
  if(r.action==='preflight')return receipt('ready',undefined,{tmux:true,reservation:true,gpu:[{uuid:'GPU-fixture',totalBytes:24*1024**3,usedBytes:0,utilization:0,pids:[]}]});
  if(r.action==='submit'||r.action==='reserve'){const id=r.payload.objectId;operations.set(r.operationId,id);objects.set(id,{kind:r.action==='reserve'?'lease':'job',state:r.action==='reserve'?'held':'running',readyAt:Date.now()+7000,deadline:r.payload.leaseDeadlineMs,payload:{allocation:{bytesPerGpu:r.payload.resource.holderBytes,gpuUuids:r.payload.selectedGpuUuids},startedAt:Date.now()}});return receipt('accepted',id);}
  if(r.action==='handoff'){const o=objects.get(r.payload.objectId);o.state='handed_off';o.payload.handoffJobId=r.payload.jobId;objects.set(r.payload.jobId,{kind:'job',state:'running',readyAt:Date.now()+7000,payload:{startedAt:Date.now()}});return receipt('accepted',r.payload.objectId);}
  const id=r.action==='reconcile'?operations.get(r.payload.operationId):r.payload.objectId,o=objects.get(id);if(!o)return receipt('not_found',id);
  if(r.action==='release'){o.state='released';o.payload.releaseVerified=true;}
  if(r.action==='stop'){o.state='exited';o.payload={exitCode:143,validationState:'failed',releaseVerified:true};}
  if(o.kind==='lease'&&o.state==='held'&&Date.now()>=o.deadline){o.state='expired';o.payload.releaseVerified=true;}
  if(o.kind==='job'&&o.state==='running'&&Date.now()>=o.readyAt){o.state='exited';o.payload={exitCode:0,validationState:'validated',releaseVerified:true,metrics:metrics(id,0.9),logTail:'Simulated training finished. Fixture only.',gpuReady:true};}
  return receipt(o.state,id,o.payload);
}};
const automation=new AutomationRuntime(root,{authorize:o=>o.accountId==='demo-research'&&o.senderId==='demo-user',send:async()=>({state:'api_accepted'}),research:{remote,
  analysis:{async analyze(input){return {text:'模拟 Agent 报告：已整理所选材料。此页面使用验收夹具，未调用真实模型或服务器。',findings:true,limitations:['Fixture only'],references:[]};},async close(){}},
  literature:async()=>({items:[{identity:'arxiv:fixture',version:'v1',title:'Research automation acceptance fixture',authors:['Fixture Author'],source:'arxiv',url:'https://arxiv.org/abs/0000.00000',date:new Date().toISOString(),dateType:'last_updated',readingLevel:'metadata',status:'fixture'}],nextCursor:null})
},gpu:{
  async targets(){return [{server:'demo-gpu',host:'fixture.invalid',port:22,user:'demo',bindingHash}];},
  async sample(){return {server:'demo-gpu',bindingHash,startedAt:Date.now(),observedAt:Date.now(),devices:[{uuid:'GPU-fixture',index:0,name:'Simulated research GPU',totalBytes:24*1024**3,usedBytes:0,utilization:0,temperature:40,processes:[]}]};},
  async close(){}
}});
await automation.start();
const manager=new AccountManager({paths});
const server=await startLocalHttpServer({paths,accountManager:manager,automation,port:0});
console.log(server.url+'/automation.html');
let closing;
function close(){closing??=(async()=>{await automation.close();await manager.stopAll();await server.close();
  const rel=path.relative(os.tmpdir(),root);if(rel.startsWith('..')||path.isAbsolute(rel))throw Error('Unexpected fixture root');
  await fs.promises.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});})();return closing;}
process.on('SIGTERM',()=>void close().then(()=>process.exit(0)));
process.on('SIGINT',()=>void close().then(()=>process.exit(0)));
