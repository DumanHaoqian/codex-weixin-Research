import { z } from 'zod';
import { automationCapabilities } from '../automation/capabilities.js';
import type { AutomationRuntime } from '../automation/runtime.js';
import { ownerSchema, taskSchema } from '../automation/tasks.js';

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
    // TaskService verifies this requested owner against the live account directory;
    // query parameters are never treated as caller authorization.
    if (route==='/tasks' && method==='GET') return {status:200,body:{tasks:await runtime.tasks.list(owner)}};
    if (route==='/tasks' && method==='POST') {
      const input=z.object({definition:taskSchema,draft:z.boolean().default(false)}).strict().parse(body);
      if (!key) return {status:400,body:{error:'Idempotency-Key required'}};
      return {status:201,body:{task:await runtime.tasks.create(owner,key,input.definition,input.draft)}};
    }
    const match=/^\/tasks\/([a-f0-9-]{36})(?:\/(pause|resume))?$/.exec(route);
    if (match) {
      if (method==='GET'&&!match[2]) return {status:200,body:{task:await runtime.tasks.get(owner,match[1])}};
      if (method==='PATCH'&&!match[2]) {
        const input=z.object({expectedRevision:z.number().int().min(1),definition:taskSchema}).strict().parse(body);
        return {status:200,body:{task:await runtime.tasks.update(owner,match[1],input.expectedRevision,input.definition)}};
      }
      if (method==='DELETE'&&!match[2]) return {status:200,body:{task:await runtime.tasks.setState(owner,match[1],'delete')}};
      if (method==='POST'&&match[2]) return {status:200,body:{task:await runtime.tasks.setState(owner,match[1],match[2] as 'pause'|'resume')}};
    }
    if (method==='GET'&&(route==='/runs'||route==='/notifications')) {
      await runtime.tasks.list(owner); // current owner authorization, including empty task lists
      const rows=route==='/runs'
        ? await runtime.store.all('SELECT r.* FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.account_id=? AND t.sender_id=? ORDER BY r.ended_at DESC LIMIT 100',[owner.accountId,owner.senderId])
        : await runtime.store.all('SELECT * FROM notifications WHERE account_id=? AND sender_id=? ORDER BY updated_at DESC LIMIT 100',[owner.accountId,owner.senderId]);
      return {status:200,body:{items:rows}};
    }
    return {status:404,body:{error:'Automation route not found'}};
  } catch(error) {
    if (error instanceof z.ZodError) return {status:400,body:{error:'Invalid automation request',issues:error.issues}};
    const message=error instanceof Error ? error.message : String(error);
    const status=/Access denied/.test(message)?403:/not found/.test(message)?404:/conflict/.test(message)?409:/unavailable|not.*verified/.test(message)?503:/past|deleted|limit|binding/.test(message)?422:500;
    // Internal database/OS errors must not reveal file paths or SQL to clients.
    return {status,body:{error:status===500?'Automation operation failed':message}};
  }
}
