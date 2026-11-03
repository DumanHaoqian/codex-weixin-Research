import http from 'node:http';
import crypto from 'node:crypto';
import { boundedResponse } from './literature.js';
import { researchFetch } from './network.js';

// A protocol boundary, not a prompt-based permission rule. The native Codex
// backend may enumerate inherited tools, but the model never receives them and
// no tool-call response can cross back into its executor.
export function textOnlyRequest(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid inference request');
  const body={...value as Record<string,unknown>,tools:[],tool_choice:'none',store:false};
  delete (body as any).previous_response_id;delete (body as any).parallel_tool_calls;
  return body;
}
function inspectItem(item:any):void{
  if(!item||typeof item!=='object')return;
  if(typeof item.type==='string'&&!['message','reasoning','output_text','refusal','summary_text','text','reasoning_text','reasoning_summary_text'].includes(item.type))throw new Error('Non-text model item rejected');
  for(const child of item.content??[])inspectItem(child);
}
export function assertTextOnlyResponse(text:string,eventStream:boolean):void{
  const inspect=(value:any)=>{
    if(/(?:tool|function|computer|code_interpreter|web_search|image_generation).*call/i.test(String(value.type??'')))throw new Error('Tool response rejected');
    if(value.item)inspectItem(value.item);if(value.part)inspectItem(value.part);
    for(const item of value.output??value.response?.output??[])inspectItem(item);
  };
  if(eventStream){
    let count=0;
    for(const line of text.split(/\r?\n/)){if(!line.startsWith('data:'))continue;const data=line.slice(5).trim();if(!data||data==='[DONE]')continue;inspect(JSON.parse(data));count++;}
    if(!count)throw new Error('Empty inference event stream');
  }else inspect(JSON.parse(text));
}

export async function startInferenceFirewall(upstream:string,signal:AbortSignal,fetcher:typeof fetch=researchFetch){
  const url=new URL(upstream);if(url.protocol!=='https:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('Inference upstream must use HTTPS');
  const token=crypto.randomBytes(24).toString('hex');let requests=0,firstError:string|undefined;
  const server=http.createServer(async(request,response)=>{
    try{
      if(request.method!=='POST'){
        // Some native clients probe the Responses websocket path first. Reject
        // that protocol explicitly so they can use the verified HTTP transport.
        response.writeHead(426,{'Allow':'POST'});response.end();return;
      }
      const requestUrl=new URL(request.url??'','http://127.0.0.1');
      if(requestUrl.pathname!==`/${token}/responses`)throw new Error('Unsupported inference POST route '+requestUrl.pathname.replace(token,'route'));
      const chunks:Buffer[]=[];let bytes=0;
      for await(const chunk of request){bytes+=chunk.length;if(bytes>512*1024)throw new Error('Inference input exceeds budget');chunks.push(Buffer.from(chunk));}
      if(requests++>=3)throw new Error('Analysis inference request budget exhausted');
      if(request.headers['content-encoding'])throw new Error('Compressed inference input is unsupported');
      const body=textOnlyRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const headers:Record<string,string>={'Content-Type':'application/json'};
      for(const name of ['authorization','chatgpt-account-id','openai-beta','user-agent','originator','version','session_id','x-codex-turn-metadata'])if(typeof request.headers[name]==='string')headers[name]=request.headers[name];
      const result=await fetcher(url,{method:'POST',headers,body:JSON.stringify(body),redirect:'error',signal});
      if(!result.ok){
        const raw=await boundedResponse(new Response(result.body),32768);let detail='';
        try{const value=JSON.parse(raw),message=value.error?.message??value.detail??value.message;
          if(typeof message==='string'&&/^[A-Za-z0-9 _.,:()'"=\[\]-]{1,180}$/.test(message)&&!/key|token|secret|auth/i.test(message))detail=': '+message;
        }catch{}
        throw new Error('Inference upstream HTTP '+result.status+detail);
      }
      const text=await boundedResponse(result,2*1024*1024),eventStream=(result.headers.get('content-type')?.includes('text/event-stream')??false)||/^\s*(?:event|data):/.test(text);
      assertTextOnlyResponse(text,eventStream);
      response.writeHead(200,{'Content-Type':eventStream?'text/event-stream':'application/json'});response.end(text);
    }catch(error){firstError??=error instanceof Error?error.message.slice(0,200):'protocol_error';response.writeHead(502,{'Content-Type':'application/json'});response.end(JSON.stringify({error:{message:'Scheduled text-only inference rejected or unavailable: '+firstError}}));}
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve());});
  const address=server.address();if(!address||typeof address==='string')throw new Error('Inference firewall failed to bind');
  return {url:`http://127.0.0.1:${address.port}/${token}`,close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
