import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodexAnalysisPort } from '../src/automation/codex-analysis.js';

for(const {malicious,mislabeled} of [{malicious:false,mislabeled:false},{malicious:true,mislabeled:false},{malicious:false,mislabeled:true}])test(`native Codex text-only ${malicious?'rejects function calls':mislabeled?'accepts verified SSE with a mislabeled content type':'completes a stateless report'}`,{skip:!process.env.RESEARCH_TEST_CODEX_BIN},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'research-native-test-'));fs.mkdirSync(path.join(root,'codex-home'));
  let calls=0;
  const text=JSON.stringify({text:'Local native probe',findings:false,limitations:['Mock inference'],references:[]});
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);assert.deepEqual(body.tools,[]);assert.equal(body.tool_choice,'none');calls++;
    const item=malicious?{id:'call_probe',type:'function_call',name:'exec_command',call_id:'call_probe',arguments:JSON.stringify({cmd:'echo forbidden'})}
      :{id:'msg_probe',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]};
    const response={id:'resp_probe',object:'response',created_at:Math.floor(Date.now()/1000),status:'completed',model:'gpt-6.1-sol',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
    const events=[{type:'response.created',response:{...response,status:'in_progress',output:[]}},
      {type:'response.output_item.added',output_index:0,item},...(malicious?[]:[{type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:text}]),
      {type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}];
    res.writeHead(200,{'Content-Type':mislabeled?'application/json':'text/event-stream'});res.end(events.map(e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join(''));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address() as any;
  const port=new CodexAnalysisPort(root,process.env.RESEARCH_TEST_CODEX_BIN!,`http://127.0.0.1:${address.port}/responses`,'gpt-6.1-sol',false,{...process.env,CODEX_HOME:path.join(root,'codex-home')});
  try{
    const promise=port.analyze({runId:crypto.randomUUID(),prompt:'Return the probe',context:{fixture:true},profile:'render_report'},AbortSignal.timeout(malicious?7000:15000));
    if(malicious)await assert.rejects(promise);else assert.equal((await promise).text,'Local native probe');
    assert.ok(calls>=1);assert.equal(fs.existsSync(path.join(root,'unexpected-effect')),false);
  }finally{await port.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    const relative=path.relative(os.tmpdir(),root);assert.ok(!relative.startsWith('..')&&!path.isAbsolute(relative));await fs.promises.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
});
