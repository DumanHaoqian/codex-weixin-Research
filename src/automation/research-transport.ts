import fs from 'node:fs';
import path from 'node:path';
import { AppServerCodexRunner } from '../codex/app-server-runner.js';
import { McpGpuObservationPort } from './gpu.js';
import { receiptSchema,type ResearchRemotePort,type RemoteRequest } from './research-contracts.js';
import { computeMcpConfig,type ComputeMcp } from './compute-mcp.js';

export type HelperBinding={path:string;sha256:string;stateRoot?:string};
function shellArg(value:string){return "'"+value.replace(/'/g,"'\"'\"'")+"'";}
export function createResearchTransport(root:string,codexBin:string,helpers:Record<string,HelperBinding>,mcp?:ComputeMcp):ResearchRemotePort{
  if(!Object.keys(helpers).length||helpers.gateway)throw new Error('Explicit research helper bindings required; gateway remains deferred');
  for(const binding of Object.values(helpers))if(!binding.path.startsWith('/')||binding.path.includes('\0')||!/^[a-f0-9]{64}$/.test(binding.sha256))throw new Error('Invalid research helper binding');
  const cwd=path.join(root,'automation','remote-context');fs.mkdirSync(cwd,{recursive:true});
  const runner=new AppServerCodexRunner({codexBin,sandbox:'read-only',approvalPolicy:'never',disableHooks:true,ownProcessGroup:true,startupConfig:computeMcpConfig(mcp),requestTimeoutMs:45000});
  let session:Promise<string>|undefined;
  const call=async(tool:'servers_list'|'ssh_exec',args:Record<string,unknown>)=>{
    try{session??=runner.openObservationSession(cwd);return await runner.callObservationTool(await session,tool,args,mcp?.name);}
    catch{session=undefined;throw new Error('Authorized research MCP unavailable');}
  };
  const directory=new McpGpuObservationPort(call,Object.keys(helpers));
  return {
    targets:()=>directory.targets(),
    async invoke(request:RemoteRequest){
      const target=(await directory.targets()).find(t=>t.server===request.target.server);
      if(!target||target.bindingHash!==request.target.bindingHash)throw new Error('Research target binding changed');
      const helper=helpers[target.server];if(!helper)throw new Error('Research helper unavailable');
      const payload=Buffer.from(JSON.stringify(request)).toString('base64');if(payload.length>11000)throw new Error('Research request exceeds byte budget');
      // Verify the installed helper digest before executing its fixed entrypoint.
      // The encoded payload remains data; it is never a shell fragment.
      const bootstrap='import hashlib,pathlib,runpy,sys;p=pathlib.Path(sys.argv[1]);assert hashlib.sha256(p.read_bytes()).hexdigest()==sys.argv[2],"helper_digest_mismatch";sys.argv=[str(p),sys.argv[3]]+([sys.argv[4]] if len(sys.argv)>4 else []);runpy.run_path(str(p),run_name="__main__")';
      const command=`python3 -c ${shellArg(bootstrap)} ${shellArg(helper.path)} ${shellArg(helper.sha256)} ${shellArg(payload)}${helper.stateRoot?' '+shellArg(helper.stateRoot):''}`;
      const result=await call('ssh_exec',{server:target.server,command,timeout_seconds:25}) as any;
      if(result?.isError||!Array.isArray(result?.content))throw new Error('Remote research operation unavailable; reconcile its identity');
      const text=result.content.filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('\n');if(text.length>100000)throw new Error('Remote receipt exceeds budget');
      const envelope=JSON.parse(text);
      if(envelope.server!==target.server||envelope.host!==target.host||envelope.port!==target.port||envelope.user!==target.user)throw new Error('Remote operation target identity is unverified');
      if(envelope.exitCode!==0||envelope.timedOut){
        let code='remote_exit_'+String(envelope.exitCode);try{const diagnostic=JSON.parse(envelope.stdout);if(/^[a-zA-Z0-9_: -]{1,200}$/.test(diagnostic.message))code=diagnostic.message;}catch{}
        throw new Error('Remote operation unverified: '+code);
      }
      return receiptSchema.parse(JSON.parse(envelope.stdout));
    },
    async close(){await runner.terminateAutomation();}
  };
}
