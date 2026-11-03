import fs from 'node:fs';
import path from 'node:path';
import { AppServerCodexRunner } from '../codex/app-server-runner.js';
import { McpGpuObservationPort } from './gpu.js';
import { computeMcpConfig,type ComputeMcp } from './compute-mcp.js';

// Explicit opt-in only. Reuse the configured Codex MCP service and authentication;
// do not open shell SSH or read/copy credentials. No model turn is started here.
export function createGpuTransport(root:string,codexBin:string,servers:string[],mcp?:ComputeMcp):McpGpuObservationPort{
  const cwd=path.join(root,'automation','observation-context');
  fs.mkdirSync(cwd,{recursive:true});
  const runner=new AppServerCodexRunner({codexBin,sandbox:'read-only',approvalPolicy:'never',disableHooks:true,ownProcessGroup:true,startupConfig:computeMcpConfig(mcp),requestTimeoutMs:45_000});
  let session:Promise<string>|undefined;
  return new McpGpuObservationPort(async(tool,args)=>{
    try{
      session??=runner.openObservationSession(cwd);
      return await runner.callObservationTool(await session,tool,args,mcp?.name);
    }catch{
      session=undefined;
      // A denied or unsupported transport stays unavailable; there is no direct
      // helper/SSH fallback and no permission escalation for background polling.
      throw new Error('Authorized MCP GPU observation unavailable');
    }
  },servers,async()=>{await runner.terminateAutomation();});
}
