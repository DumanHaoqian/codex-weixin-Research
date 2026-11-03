import crypto from 'node:crypto';
import { z } from 'zod';
import { nextAfter, scheduleSchema } from './calendar.js';
import { AutomationStore, type Row, type Statement } from './store.js';
import { historyPage, type HistoryKind, type PageInput } from './history.js';
import { gpuWatchSchema, type GpuWatch } from './gpu.js';
import { agentSchema,workflowSchema,jobMonitorSchema,literatureSchema,comparisonSchema } from './research-contracts.js';

export const ownerSchema = z.object({ accountId: z.string().min(1).max(200), senderId: z.string().min(1).max(200) }).strict();
export type Owner = z.infer<typeof ownerSchema>;
export const taskSchema = z.object({
  title: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(32_000),
  kind: z.enum(['reminder','agent_report','research_workflow','job_monitor','gpu_watch','literature_watch','result_compare']),
  projectId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).nullable().default(null),
  schedule: scheduleSchema,
  notification: z.enum(['always','findings_or_failure','muted']).default('always'),
  gpuWatch: gpuWatchSchema.optional(),agent:agentSchema.optional(),workflow:workflowSchema.optional(),jobMonitor:jobMonitorSchema.optional(),literature:literatureSchema.optional(),comparison:comparisonSchema.optional()
}).strict().superRefine((def,context)=>{
  if(def.kind==='gpu_watch'&&!def.gpuWatch)context.addIssue({code:'custom',path:['gpuWatch'],message:'GPU watch configuration required'});
  if(def.kind!=='gpu_watch'&&def.gpuWatch)context.addIssue({code:'custom',path:['gpuWatch'],message:'Only GPU watches accept GPU configuration'});
  for(const [kind,field] of [['agent_report','agent'],['research_workflow','workflow'],['job_monitor','jobMonitor'],['literature_watch','literature'],['result_compare','comparison']] as const){
    if(def.kind!==kind&&def[field])context.addIssue({code:'custom',path:[field],message:`${field} does not match task kind`});
  }
});
export type TaskInput = z.input<typeof taskSchema>;
export type TaskDefinition = z.infer<typeof taskSchema>;
export type Task = { id: string; owner: Owner; revision: number; state: string; definition: TaskDefinition; nextDue: number | null };

export type TaskServiceOptions = {
  now?: () => number;
  authorize: (owner: Owner) => boolean | Promise<boolean>;
  validateActivation?: (definition: TaskDefinition) => void | Promise<void>;
  validateGpuWatch?: (watch: GpuWatch) => void | Promise<void>;
  supportsKind?: (kind:TaskDefinition['kind'])=>boolean;
  validateTask?: (definition:TaskDefinition,owner:Owner)=>Promise<void>;
};

function decode(row: Row): Task {
  return { id: String(row.id), owner: { accountId: String(row.account_id), senderId: String(row.sender_id) },
    revision: Number(row.revision), state: String(row.state), definition: JSON.parse(String(row.definition)),
    nextDue: row.next_due === null ? null : Number(row.next_due) };
}

export class TaskService {
  private chain: Promise<unknown> = Promise.resolve();
  private now: () => number;
  constructor(readonly store: AutomationStore, private options: TaskServiceOptions) { this.now = options.now ?? Date.now; }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn);
    this.chain = result.catch(() => {});
    return result;
  }

  async authorized(owner: Owner): Promise<void> {
    ownerSchema.parse(owner);
    if (!await this.options.authorize(owner)) throw new Error('Access denied');
  }

  private async activation(def: TaskDefinition, now: number, owner:Owner): Promise<number> {
    // Until validated adapters exist, do not activate a research task as a reminder.
    await this.validateKind(def);
    if (def.projectId && !this.options.validateActivation&&!this.options.validateTask) throw new Error('Project binding cannot be verified');
    await this.options.validateActivation?.(def);
    await this.options.validateTask?.(def,owner);
    const next = nextAfter(def.schedule, now);
    if (next === null) throw new Error('Scheduled time is in the past');
    return next;
  }

  private async validateKind(def:TaskDefinition):Promise<void>{
    if(def.kind==='gpu_watch'&&this.options.validateGpuWatch)await this.options.validateGpuWatch(def.gpuWatch!);
    else if(def.kind!=='reminder'&&!this.options.supportsKind?.(def.kind))throw new Error('Capability unavailable: research/agent adapter not yet verified; save as draft');
  }

  private async monitorCapacity(task:Task):Promise<boolean>{
    if(task.definition.kind!=='gpu_watch')return true;
    const count=(await this.store.all(`SELECT count(*) AS n FROM gpu_watches w JOIN tasks t ON t.id=w.task_id
      WHERE t.account_id=? AND w.state='watching'`,[task.owner.accountId]))[0];
    return Number(count.n)<20;
  }

  async list(owner: Owner): Promise<Task[]> {
    await this.authorized(owner);
    return (await this.store.all('SELECT * FROM tasks WHERE account_id=? AND sender_id=? ORDER BY created_at DESC',
      [owner.accountId, owner.senderId])).map(decode);
  }

  async page(owner: Owner, kind: HistoryKind, input: PageInput = {}) {
    await this.authorized(owner);
    return historyPage(this.store, owner, kind, input);
  }

  private async replay<T>(owner: Owner, key: string | undefined, payload: unknown): Promise<{ response?: T; record: (response: T) => Statement[] }> {
    if (key === undefined) return { record: () => [] };
    z.string().min(1).max(200).parse(key);
    const requestKey = `task-mutation:${key}`;
    const hash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const existing = (await this.store.all('SELECT * FROM requests WHERE account_id=? AND sender_id=? AND request_key=?', [owner.accountId, owner.senderId, requestKey]))[0];
    if (existing && existing.payload_hash !== hash) throw new Error('Idempotency conflict');
    return { response: existing ? JSON.parse(String(existing.response)) as T : undefined,
      record: response => [{ sql: 'INSERT INTO requests VALUES (?,?,?,?,?)', params: [owner.accountId, owner.senderId, requestKey, hash, JSON.stringify(response)] }] };
  }

  async get(owner: Owner, id: string): Promise<Task> {
    await this.authorized(owner);
    const row = (await this.store.all('SELECT * FROM tasks WHERE id=? AND account_id=? AND sender_id=?',
      [id, owner.accountId, owner.senderId]))[0];
    if (!row) throw new Error('Task not found');
    return decode(row);
  }

  create(owner: Owner, requestKey: string, input: TaskInput, draft = false, sourceFingerprint?:string): Promise<Task> {
    return this.serialize(async () => {
      await this.authorized(owner);
      z.string().min(1).max(300).parse(requestKey);
      const definition = taskSchema.parse(input);
      // Trusted ingress may fingerprint the original relative-time request instead
      // of its clock-dependent resolution. HTTP clients cannot choose this field.
      const hash = crypto.createHash('sha256').update(JSON.stringify(sourceFingerprint===undefined?{definition,draft}:{sourceFingerprint,draft})).digest('hex');
      const existing = (await this.store.all('SELECT * FROM requests WHERE account_id=? AND sender_id=? AND request_key=?',
        [owner.accountId, owner.senderId, requestKey]))[0];
      if (existing) {
        if (existing.payload_hash !== hash) throw new Error('Idempotency conflict');
        return JSON.parse(String(existing.response)) as Task;
      }
      const now = this.now();
      const nextDue = draft ? null : await this.activation(definition, now,owner);
      if (!draft && (await this.store.all("SELECT id FROM tasks WHERE account_id=? AND state='active'", [owner.accountId])).length >= 20)
        throw new Error('Active task limit exceeded');
      const task: Task = { id: crypto.randomUUID(), owner, revision: 1, state: draft ? 'draft' : 'active', definition, nextDue };
      await this.store.transaction([
        { sql: 'INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?)', params: [task.id,owner.accountId,owner.senderId,1,task.state,JSON.stringify(definition),nextDue,now,now] },
        { sql: 'INSERT INTO revisions VALUES (?,?,?)', params: [task.id,1,JSON.stringify(definition)] },
        { sql: 'INSERT INTO requests VALUES (?,?,?,?,?)', params: [owner.accountId,owner.senderId,requestKey,hash,JSON.stringify(task)] }
      ]);
      return task;
    });
  }

  update(owner: Owner, id: string, revision: number | undefined, input: TaskInput, requestKey?: string): Promise<Task> {
    return this.serialize(async () => {
      await this.authorized(owner);
      const definition = taskSchema.parse(input);
      const replay = await this.replay<Task>(owner,requestKey,{action:'update',id,revision,definition});
      if (replay.response) return replay.response;
      const task = await this.get(owner,id);
      if (revision !== undefined && task.revision !== revision) throw new Error('Revision conflict');
      revision ??= task.revision;
      if (task.state === 'deleted') throw new Error('Task is deleted');
      const now = this.now();
      const next = task.state === 'active' ? await this.activation(definition,now,owner) : null;
      const updated: Task = {...task, definition, revision:revision+1, nextDue:next};
      await this.store.transaction([
        { sql: 'UPDATE tasks SET definition=?,revision=?,next_due=?,updated_at=? WHERE id=?', params: [JSON.stringify(definition),revision+1,next,now,id] },
        { sql: 'INSERT INTO revisions VALUES (?,?,?)', params: [id,revision+1,JSON.stringify(definition)] },
        ...replay.record(updated)
      ]);
      return updated;
    });
  }

  setState(owner: Owner, id: string, action: 'pause'|'resume'|'delete', requestKey?: string): Promise<Task> {
    return this.serialize(async () => {
      await this.authorized(owner);
      const replay = await this.replay<Task>(owner,requestKey,{action,id});
      if (replay.response) return replay.response;
      const task = await this.get(owner,id);
      if (task.state === 'deleted' && action !== 'delete') throw new Error('Task is deleted');
      const state = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'deleted';
      if (state === 'active' && task.state !== 'active' && (await this.store.all("SELECT id FROM tasks WHERE account_id=? AND state='active'", [owner.accountId])).length >= 20)
        throw new Error('Active task limit exceeded');
      const now = this.now();
      const next = state === 'active' ? task.state === 'active' ? task.nextDue : await this.activation(task.definition,now,owner) : null;
      const statements: Statement[] = [{ sql: 'UPDATE tasks SET state=?,next_due=?,updated_at=? WHERE id=?', params: [state,next,now,id] }];
      if (state === 'deleted') statements.push({ sql: "UPDATE notifications SET state='cancelled',updated_at=? WHERE event_id IN (SELECT id FROM events WHERE task_id=?) AND state IN ('pending','failed')", params: [now,id] });
      if (state === 'deleted') statements.push({sql:"UPDATE gpu_watches SET state='stopped',updated_at=? WHERE task_id=? AND state='watching'",params:[now,id]});
      if(state==='deleted'||state==='paused')statements.push({sql:"UPDATE occurrences SET state='cancelled' WHERE id IN (SELECT occurrence_id FROM runs WHERE task_id=? AND state='queued')",params:[id]},
        {sql:"UPDATE runs SET state='cancelled',ended_at=?,result=? WHERE task_id=? AND state='queued'",params:[now,JSON.stringify({text:`Task ${state} before execution`}),id]});
      const updated:Task = {...task,state,nextDue:next};
      await this.store.transaction([...statements,...replay.record(updated)]);
      return updated;
    });
  }

  tick(): Promise<void> {
    return this.serialize(async () => {
      const now = this.now();
      const due = await this.store.all("SELECT * FROM tasks WHERE state='active' AND next_due<=? ORDER BY next_due,id", [now]);
      for (const row of due) {
        const task = decode(row);
        const allowed = await this.options.authorize(task.owner);
        let bindingValid = true;
        try {
          await this.options.validateActivation?.(task.definition);
          // Registration has no remote effect. The observation worker refreshes
          // and validates the saved target before every remote sample; do not
          // make the reminder scheduler wait for GPU/network discovery.
          if(task.definition.kind!=='reminder'&&!(task.definition.kind==='gpu_watch'&&this.options.validateGpuWatch)&&!this.options.supportsKind?.(task.definition.kind))throw new Error('Unsupported task adapter');
        }
        catch { bindingValid = false; }
        const scheduled = task.nextDue!;
        const watching=(await this.store.all("SELECT task_id FROM gpu_watches WHERE task_id=? AND state='watching'",[task.id])).length>0
          ||(await this.store.all("SELECT id FROM runs WHERE task_id=? AND state IN ('queued','running')",[task.id])).length>0;
        const capacity=await this.monitorCapacity(task);
        const state = !allowed || !bindingValid ? 'blocked' : now - scheduled > 300_000 ? 'missed' : watching?'skipped':!capacity?'blocked':['reminder','gpu_watch'].includes(task.definition.kind)?'succeeded':'queued';
        await this.recordRun(task,scheduled,String(scheduled),now,state,allowed,true);
      }
    });
  }

  runNow(owner:Owner,id:string,requestKey:string):Promise<{id:string;state:string}>{return this.serialize(async()=>{
    const task=await this.get(owner,id);
    z.string().min(1).max(200).parse(requestKey);
    const key=`manual:${id}:${requestKey}`;
    const hash=crypto.createHash('sha256').update(id).digest('hex');
    const existing=(await this.store.all('SELECT * FROM requests WHERE account_id=? AND sender_id=? AND request_key=?',[owner.accountId,owner.senderId,key]))[0];
    if(existing){if(existing.payload_hash!==hash)throw new Error('Idempotency conflict');return JSON.parse(String(existing.response));}
    if(task.state==='deleted')throw new Error('Task is deleted');
    await this.validateKind(task.definition);
    if((await this.store.all("SELECT task_id FROM gpu_watches WHERE task_id=? AND state='watching'",[id])).length)throw new Error('Active GPU monitor conflict: stop monitoring before starting another');
    if(!await this.monitorCapacity(task))throw new Error('Active GPU monitor limit exceeded');
    await this.options.validateActivation?.(task.definition);
    await this.options.validateTask?.(task.definition,owner);
    if((await this.store.all("SELECT id FROM runs WHERE task_id=? AND state IN ('queued','running')",[id])).length)throw new Error('Active task run conflict');
    const now=this.now(),run=crypto.randomUUID();
    const result={id:run,state:['reminder','gpu_watch'].includes(task.definition.kind)?'succeeded':'queued'};
    await this.recordRun(task,now,`manual:${requestKey}`,now,result.state,true,false,run,[{
      sql:'INSERT INTO requests VALUES (?,?,?,?,?)',params:[owner.accountId,owner.senderId,key,hash,JSON.stringify(result)]
    }]);
    return result;
  });}

  stopMonitor(owner:Owner,id:string,requestKey:string):Promise<{state:string}>{return this.serialize(async()=>{
    await this.authorized(owner);
    const replay=await this.replay<{state:string}>(owner,requestKey,{action:'stop-monitor',id});
    if(replay.response)return replay.response;
    await this.get(owner,id);
    const watch=(await this.store.all('SELECT state FROM gpu_watches WHERE task_id=?',[id]))[0];
    if(!watch)throw new Error('GPU monitor not found');
    const result={state:watch.state==='watching'?'stopped':String(watch.state)};
    await this.store.transaction([
      {sql:'UPDATE gpu_watches SET state=?,updated_at=? WHERE task_id=?',params:[result.state,this.now(),id]},
      ...replay.record(result)
    ]);
    return result;
  });}

  private async recordRun(task:Task,scheduled:number,source:string,now:number,state:string,notify:boolean,advance:boolean,
    run=crypto.randomUUID(),extra:Statement[]=[]):Promise<void>{
    const occurrence=crypto.randomUUID(),event=crypto.randomUUID();
    const statements:Statement[]=[
      {sql:'INSERT INTO occurrences VALUES (?,?,?,?,?,?)',params:[occurrence,task.id,task.revision,scheduled,source,state]},
      {sql:'INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?)',params:[run,task.id,occurrence,task.revision,state,JSON.stringify(task.definition),scheduled+300_000,state==='queued'?null:now,state==='queued'?null:now,state==='queued'?null:JSON.stringify({text:task.definition.kind==='gpu_watch'?(state==='succeeded'?'已启动 GPU 只读监控；读数与监控状态见观测记录。':`GPU 监控未启动：${state}`):task.definition.prompt,scheduledAt:scheduled,observedAt:now})]}
    ];
    if(state==='succeeded'&&task.definition.kind==='gpu_watch'){
      const watch=task.definition.gpuWatch!;
      statements.push({sql:`INSERT INTO gpu_watches VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET
        revision=excluded.revision,run_id=excluded.run_id,state=excluded.state,next_check=excluded.next_check,
        deadline=excluded.deadline,last_signature=NULL,stable_signature=NULL,stable_count=0,last_observation_id=NULL,updated_at=excluded.updated_at`,
        params:[task.id,task.revision,run,'watching',now,now+watch.durationSeconds*1000,null,null,0,null,now]});
    }
    if(advance){
      const next=nextAfter(task.definition.schedule,now);
      statements.push({sql:'UPDATE tasks SET next_due=?,state=?,updated_at=? WHERE id=?',params:[next,next===null?'completed':'active',now,task.id]});
    }
    if(notify&&state!=='queued'&&task.definition.notification!=='muted'&&!(task.definition.kind==='gpu_watch'&&state==='succeeded')){
      const content=state==='succeeded'?task.definition.prompt:`Task ${task.id}: ${state}`;
      statements.push(
        {sql:'INSERT INTO events VALUES (?,?,?,?,?,?)',params:[event,task.id,`${task.id}:${task.revision}:${source}`,state,JSON.stringify({run,content}),now]},
        {sql:'INSERT INTO notifications VALUES (?,?,?,?,?,?,?)',params:[crypto.randomUUID(),event,task.owner.accountId,task.owner.senderId,'pending',content,now]}
      );
    }
    await this.store.transaction([...statements,...extra]);
  }
}
