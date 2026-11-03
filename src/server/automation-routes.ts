import { z } from 'zod';
import { automationCapabilities } from '../automation/capabilities.js';
import type { AutomationRuntime } from '../automation/runtime.js';
import { ownerSchema, taskSchema } from '../automation/tasks.js';
import { nextAfter, resolveWallTime, scheduleSchema } from '../automation/calendar.js';

export type AutomationReply={status:number;body:unknown};

// Invoked only after the common HTTP host/login/origin/request-token checks.
export async function automationRoute(method:string,url:URL,body:unknown,key:string|undefined,runtime?:AutomationRuntime):Promise<AutomationReply> {
  const route=url.pathname.slice('/api/automation'.length);
  if (method==='GET' && (route==='/status'||route==='/capabilities')) return {status:200,body:runtime?.status()??{
    enabled:false,capabilities:automationCapabilities(),reason:'Set CODEX_WEIXIN_AUTOMATION=1 to enable the scheduling preview'
  }};
  if (!runtime) return {status:503,body:{error:'automation_disabled'}};
  try {
    const owner=ownerSchema.parse({accountId:url.searchParams.get('accountId'),senderId:url.searchParams.get('senderId')});
    const page = () => z.object({limit:z.coerce.number().int().min(1).max(100).optional(),cursor:z.string().max(1500).optional()}).parse({
      limit:url.searchParams.get('limit')??undefined,cursor:url.searchParams.get('cursor')??undefined
    });
    if(method==='GET'&&route.startsWith('/gpu/')){
      await runtime.tasks.authorized(owner);
      if(route==='/gpu/targets')return runtime.gpu?{status:200,body:{targets:await runtime.gpu.port.targets()}}:{status:503,body:{error:'GPU observation MCP transport unavailable'}};
      if(route==='/gpu/observations')return {status:200,body:await runtime.tasks.page(owner,'gpu_observations',page())};
      if(route==='/gpu/watches'){
        const items=await runtime.store.all(`SELECT w.*,o.validity,o.observed_at,o.valid_until,o.payload
          FROM gpu_watches w JOIN tasks t ON t.id=w.task_id LEFT JOIN gpu_observations o ON o.id=w.last_observation_id
          WHERE t.account_id=? AND t.sender_id=? ORDER BY w.updated_at DESC LIMIT 100`,[owner.accountId,owner.senderId]);
        return {status:200,body:{items,now:Date.now()}};
      }
    }
    if(method==='POST'&&(route==='/resolve-time'||route==='/preview')){
      await runtime.tasks.authorized(owner);
      if(route==='/resolve-time'){
        const input=z.object({local:z.string().max(40),timezone:z.string().max(100)}).strict().parse(body);
        try{return {status:200,body:{atUtc:resolveWallTime(input.local,input.timezone)}};}
        catch{return {status:422,body:{error:'当地时间不存在、存在歧义或时区无效，请选择明确时刻。'}};}
      }
      const schedule=scheduleSchema.parse(body);let cursor=Date.now();const times=[];
      for(let i=0;i<3;i++){const next=nextAfter(schedule,cursor);if(next===null)break;times.push(new Date(next).toISOString());cursor=next;}
      return {status:200,body:{times}};
    }
    // TaskService verifies this requested owner against the live account directory;
    // query parameters are never treated as caller authorization.
    if (route==='/tasks' && method==='GET') {
      const result=await runtime.tasks.page(owner,'tasks',page());
      return {status:200,body:{tasks:result.items.map(row=>({id:row.id,owner,revision:row.revision,state:row.state,definition:JSON.parse(String(row.definition)),nextDue:row.next_due})),nextCursor:result.nextCursor}};
    }
    if (route==='/tasks' && method==='POST') {
      const input=z.object({definition:taskSchema,draft:z.boolean().default(false)}).strict().parse(body);
      if (!key) return {status:400,body:{error:'Idempotency-Key required'}};
      return {status:201,body:{task:await runtime.tasks.create(owner,key,input.definition,input.draft)}};
    }
    const resend=/^\/notifications\/([a-f0-9-]{36})\/resend$/.exec(route);
    if(method==='POST'&&resend){
      if(!runtime.delivery)return {status:503,body:{error:'Delivery port unavailable'}};
      if(!key)return {status:400,body:{error:'Idempotency-Key required'}};
      const options=z.object({includeUnknown:z.boolean().optional(),resendAccepted:z.boolean().optional()}).strict().parse(body??{});
      await runtime.delivery.retry(owner,resend[1],options,key);runtime.wake(owner);
      return {status:202,body:{queued:true}};
    }
    const match=/^\/tasks\/([a-f0-9-]{36})(?:\/(pause|resume|run|stop-monitor))?$/.exec(route);
    if (match) {
      if (method==='GET'&&!match[2]) return {status:200,body:{task:await runtime.tasks.get(owner,match[1])}};
      if (method==='PATCH'&&!match[2]) {
        if(!key)return {status:400,body:{error:'Idempotency-Key required'}};
        const input=z.object({expectedRevision:z.number().int().min(1),definition:taskSchema}).strict().parse(body);
        return {status:200,body:{task:await runtime.tasks.update(owner,match[1],input.expectedRevision,input.definition,key)}};
      }
      if (method==='DELETE'&&!match[2]) {
        if(!key)return {status:400,body:{error:'Idempotency-Key required'}};
        return {status:200,body:{task:await runtime.tasks.setState(owner,match[1],'delete',key)}};
      }
      if(method==='POST'&&match[2]==='run'){
        if(!key)return {status:400,body:{error:'Idempotency-Key required'}};
        const run=await runtime.tasks.runNow(owner,match[1],key);runtime.wake(owner);
        return {status:201,body:{run}};
      }
      if(method==='POST'&&match[2]==='stop-monitor'){
        if(!key)return {status:400,body:{error:'Idempotency-Key required'}};
        return {status:200,body:await runtime.tasks.stopMonitor(owner,match[1],key)};
      }
      if (method==='POST'&&match[2]) {
        if(!key)return {status:400,body:{error:'Idempotency-Key required'}};
        return {status:200,body:{task:await runtime.tasks.setState(owner,match[1],match[2] as 'pause'|'resume',key)}};
      }
    }
    if (method==='GET'&&(route==='/runs'||route==='/notifications')) {
      return {status:200,body:await runtime.tasks.page(owner,route==='/runs'?'runs':'notifications',page())};
    }
    return {status:404,body:{error:'Automation route not found'}};
  } catch(error) {
    if (error instanceof z.ZodError) return {status:400,body:{error:'Invalid automation request',issues:error.issues}};
    const message=error instanceof Error ? error.message : String(error);
    const status=/Invalid pagination/.test(message)?400:/Access denied/.test(message)?403:/not found/.test(message)?404:/conflict|explicit|cancelled/.test(message)?409:/unavailable|not.*verified/.test(message)?503:/past|deleted|limit|binding/.test(message)?422:500;
    // Internal database/OS errors must not reveal file paths or SQL to clients.
    return {status,body:{error:status===500?'Automation operation failed':message}};
  }
}
