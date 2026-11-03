// Isolated visual/E2E fixture. Never connects to WeChat, Codex or research servers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
const automation=new AutomationRuntime(root,{authorize:o=>o.accountId==='demo-research'&&o.senderId==='demo-user',send:async()=>({state:'api_accepted'}),gpu:{
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
