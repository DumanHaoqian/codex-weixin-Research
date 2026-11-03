import fs from 'node:fs';
import path from 'node:path';
export type ComputeMcp={name:string;command:string;args:string[]};
export function computeMcpConfig(value?:ComputeMcp):Record<string,unknown>{
  if(!value)return {};
  if(!/^[a-zA-Z0-9_-]+$/.test(value.name))throw new Error('Unsupported MCP configuration key');
  const prefix=`mcp_servers.${value.name}`;
  return {[prefix+'.command']:value.command,[prefix+'.args']:value.args,[prefix+'.enabled']:true};
}
// Reconnect the existing service in a private child when server use is enabled.
// Credentials remain inside that MCP; user-wide Codex config is untouched.
export function existingComputeMcp(stateRoot:string):ComputeMcp|undefined{
  const script=path.join(stateRoot,'server-tools','ssh-mcp.mjs');
  return fs.existsSync(script)?{name:'compute-server-management',command:process.execPath,args:[script]}:undefined;
}
