import crypto from 'node:crypto';
import { z } from 'zod';
import { nextAfter, scheduleSchema } from './calendar.js';
import { AutomationStore, type Row, type Statement } from './store.js';

export const ownerSchema = z.object({ accountId: z.string().min(1).max(200), senderId: z.string().min(1).max(200) }).strict();
export type Owner = z.infer<typeof ownerSchema>;
export const taskSchema = z.object({
  title: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(32_000),
  kind: z.enum(['reminder','agent_report','research_workflow','job_monitor','gpu_watch','literature_watch']),
  projectId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).nullable().default(null),
  schedule: scheduleSchema,
  notification: z.enum(['always','findings_or_failure','muted']).default('always')
}).strict();
export type TaskInput = z.input<typeof taskSchema>;
export type TaskDefinition = z.infer<typeof taskSchema>;
export type Task = { id: string; owner: Owner; revision: number; state: string; definition: TaskDefinition; nextDue: number | null };

export type TaskServiceOptions = {
  now?: () => number;
  authorize: (owner: Owner) => boolean | Promise<boolean>;
  validateActivation?: (definition: TaskDefinition) => void | Promise<void>;
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

  private async authorized(owner: Owner): Promise<void> {
    ownerSchema.parse(owner);
    if (!await this.options.authorize(owner)) throw new Error('Access denied');
  }

  private async activation(def: TaskDefinition, now: number): Promise<number> {
    // Until validated adapters exist, do not activate a research task as a reminder.
    if (def.kind !== 'reminder') throw new Error('Capability unavailable: research/agent adapter not yet verified; save as draft');
    if (def.projectId && !this.options.validateActivation) throw new Error('Project binding cannot be verified');
    await this.options.validateActivation?.(def);
    const next = nextAfter(def.schedule, now);
    if (next === null) throw new Error('Scheduled time is in the past');
    return next;
  }

  async list(owner: Owner): Promise<Task[]> {
    await this.authorized(owner);
    return (await this.store.all('SELECT * FROM tasks WHERE account_id=? AND sender_id=? ORDER BY created_at DESC',
      [owner.accountId, owner.senderId])).map(decode);
  }

  async get(owner: Owner, id: string): Promise<Task> {
    await this.authorized(owner);
    const row = (await this.store.all('SELECT * FROM tasks WHERE id=? AND account_id=? AND sender_id=?',
      [id, owner.accountId, owner.senderId]))[0];
    if (!row) throw new Error('Task not found');
    return decode(row);
  }

  create(owner: Owner, requestKey: string, input: TaskInput, draft = false): Promise<Task> {
    return this.serialize(async () => {
      await this.authorized(owner);
      z.string().min(1).max(300).parse(requestKey);
      const definition = taskSchema.parse(input);
      const hash = crypto.createHash('sha256').update(JSON.stringify({ definition, draft })).digest('hex');
      const existing = (await this.store.all('SELECT * FROM requests WHERE account_id=? AND sender_id=? AND request_key=?',
        [owner.accountId, owner.senderId, requestKey]))[0];
      if (existing) {
        if (existing.payload_hash !== hash) throw new Error('Idempotency conflict');
        return JSON.parse(String(existing.response)) as Task;
      }
      const now = this.now();
      const nextDue = draft ? null : await this.activation(definition, now);
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

  update(owner: Owner, id: string, revision: number, input: TaskInput): Promise<Task> {
    return this.serialize(async () => {
      const task = await this.get(owner,id);
      if (task.revision !== revision) throw new Error('Revision conflict');
      if (task.state === 'deleted') throw new Error('Task is deleted');
      const definition = taskSchema.parse(input);
      const now = this.now();
      const next = task.state === 'active' ? await this.activation(definition,now) : null;
      await this.store.transaction([
        { sql: 'UPDATE tasks SET definition=?,revision=?,next_due=?,updated_at=? WHERE id=?', params: [JSON.stringify(definition),revision+1,next,now,id] },
        { sql: 'INSERT INTO revisions VALUES (?,?,?)', params: [id,revision+1,JSON.stringify(definition)] }
      ]);
      return this.get(owner,id);
    });
  }

  setState(owner: Owner, id: string, action: 'pause'|'resume'|'delete'): Promise<Task> {
    return this.serialize(async () => {
      const task = await this.get(owner,id);
      if (task.state === 'deleted') { if (action === 'delete') return task; throw new Error('Task is deleted'); }
      const state = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'deleted';
      if (state === 'active' && task.state === 'active') return task;
      if (state === 'active' && (await this.store.all("SELECT id FROM tasks WHERE account_id=? AND state='active'", [owner.accountId])).length >= 20)
        throw new Error('Active task limit exceeded');
      const now = this.now();
      const next = state === 'active' ? await this.activation(task.definition,now) : null;
      const statements: Statement[] = [{ sql: 'UPDATE tasks SET state=?,next_due=?,updated_at=? WHERE id=?', params: [state,next,now,id] }];
      if (state === 'deleted') statements.push({ sql: "UPDATE notifications SET state='cancelled',updated_at=? WHERE event_id IN (SELECT id FROM events WHERE task_id=?) AND state IN ('pending','failed')", params: [now,id] });
      await this.store.transaction(statements);
      return this.get(owner,id);
    });
  }

  tick(): Promise<void> {
    return this.serialize(async () => {
      const now = this.now();
      const due = await this.store.all("SELECT * FROM tasks WHERE state='active' AND next_due<=? ORDER BY next_due,id", [now]);
      for (const row of due) {
        const task = decode(row);
        const allowed = await this.options.authorize(task.owner);
        const scheduled = task.nextDue!;
        const next = nextAfter(task.definition.schedule, now);
        const state = !allowed ? 'blocked' : now - scheduled > 300_000 ? 'missed' : task.definition.kind !== 'reminder' ? 'blocked' : 'succeeded';
        const occurrence = crypto.randomUUID(), run = crypto.randomUUID(), event = crypto.randomUUID();
        const statements: Statement[] = [
          { sql: 'INSERT INTO occurrences VALUES (?,?,?,?,?,?)', params: [occurrence,task.id,task.revision,scheduled,String(scheduled),state] },
          { sql: 'INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?)', params: [run,task.id,occurrence,task.revision,state,JSON.stringify(task.definition),scheduled+300_000,now,now,JSON.stringify({ text:task.definition.prompt,scheduledAt:scheduled,observedAt:now })] },
          { sql: 'UPDATE tasks SET next_due=?,state=?,updated_at=? WHERE id=?', params: [next,next===null?'completed':'active',now,task.id] }
        ];
        if (allowed && task.definition.notification !== 'muted') {
          const content = state === 'succeeded' ? task.definition.prompt : `Task ${task.id}: ${state}`;
          statements.push(
            { sql: 'INSERT INTO events VALUES (?,?,?,?,?,?)', params: [event,task.id,`${task.id}:${task.revision}:${scheduled}`,state,JSON.stringify({run,content}),now] },
            { sql: 'INSERT INTO notifications VALUES (?,?,?,?,?,?,?)', params: [crypto.randomUUID(),event,task.owner.accountId,task.owner.senderId,'pending',content,now] }
          );
        }
        await this.store.transaction(statements);
      }
    });
  }
}
