import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AppServerCodexRunner } from '../src/codex/app-server-runner.js';
import { createGpuTransport } from '../src/automation/gpu-transport.js';
import fs from 'node:fs';

const fixture=fileURLToPath(new URL('./fixtures/fake-codex-observer.mjs',import.meta.url));
test('collector verifies effective read-only session and invokes only MCP without a model turn',async()=>{
  const runner=new AppServerCodexRunner({codexBin:fixture,sandbox:'read-only',approvalPolicy:'never',disableHooks:true,requestTimeoutMs:1000});
  try{
    const session=await runner.openObservationSession(os.tmpdir());
    assert.equal(session,'observation');
    const result=await runner.callObservationTool(session,'servers_list',{}) as any;
    assert.equal(result.content[0].text,'[]');
    await assert.rejects(runner.openObservationSession(path.join(os.tmpdir(),'unverified')),/could not be verified/);
  }finally{await runner.closeAndWait();}
});

test('background MCP retains permission denial and never falls back to SSH or a helper',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'automation-mcp-denied-'));
  const port=createGpuTransport(root,fixture,['g4090']);
  try{
    await assert.rejects(port.targets(),/rejected or unavailable/);
  }finally{await port.close();fs.rmSync(root,{recursive:true,force:true});}
});
