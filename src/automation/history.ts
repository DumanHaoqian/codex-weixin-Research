import crypto from 'node:crypto';
import { z } from 'zod';
import type { AutomationStore, Row, SqlValue } from './store.js';
import type { Owner } from './tasks.js';

export type Page<T> = { items: T[]; nextCursor: string | null };
export type PageInput = { limit?: number; cursor?: string };
export type HistoryKind = 'tasks' | 'runs' | 'notifications' | 'gpu_observations' | 'workflows' | 'objects' | 'artifacts' | 'literature';
const inputSchema = z.object({ limit: z.number().int().min(1).max(100).default(50), cursor: z.string().max(1500).optional() }).strict();
const cursorSchema = z.object({ scope: z.string(), at: z.number().int(), id: z.string().uuid() }).strict();

// These expressions are fixed by the service, never supplied by the HTTP caller.
// Sort by immutable creation/occurrence time: delivery retries must not move rows
// between pages or make older records inaccessible.
export async function historyPage(store: AutomationStore, owner: Owner, kind: HistoryKind, input: PageInput = {}): Promise<Page<Row>> {
  const { limit, cursor } = inputSchema.parse(input);
  const scope = crypto.createHash('sha256').update(JSON.stringify([owner, kind])).digest('hex');
  let boundary: z.infer<typeof cursorSchema> | undefined;
  if (cursor) {
    try {
      boundary = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
      if (boundary.scope !== scope) throw new Error('scope');
    } catch { throw new Error('Invalid pagination cursor'); }
  }
  const researchQueries={
    workflows:{select:'w.*,r.snapshot',from:'research_workflows w JOIN tasks t ON t.id=w.task_id JOIN runs r ON r.id=w.id',at:'r.start_deadline',id:'w.id'},
    objects:{select:'o.*',from:'research_objects o JOIN tasks t ON t.id=o.task_id',at:'o.created_at',id:'o.id'},
    artifacts:{select:'a.*',from:'research_artifacts a JOIN tasks t ON t.id=a.task_id',at:'a.created_at',id:'a.id'},
    literature:{select:'m.event_id AS id,m.task_id,m.version,m.discovered_at,v.metadata,n.state AS notification_state',from:'literature_matches m JOIN tasks t ON t.id=m.task_id JOIN literature_versions v ON v.item_id=m.item_id AND v.version=m.version LEFT JOIN notifications n ON n.event_id=m.event_id',at:'m.discovered_at',id:'m.event_id'}
  };
  const query = kind in researchQueries?researchQueries[kind as keyof typeof researchQueries]:kind === 'tasks'
    ? { select: 't.*', from: 'tasks t', at: 't.created_at', id: 't.id' }
    : kind === 'runs'
      ? { select: 'r.*', from: 'runs r JOIN tasks t ON t.id=r.task_id', at: 'r.start_deadline', id: 'r.id' }
      : kind==='gpu_observations'
        ? {select:'o.*',from:'gpu_observations o JOIN tasks t ON t.id=o.task_id',at:'o.observed_at',id:'o.id'}
        : { select: 'n.*', from: 'notifications n JOIN events e ON e.id=n.event_id JOIN tasks t ON t.id=e.task_id', at: 'e.created_at', id: 'n.id' };
  const params: SqlValue[] = [owner.accountId, owner.senderId];
  let where = 't.account_id=? AND t.sender_id=?';
  if (boundary) {
    where += ` AND (${query.at}<? OR (${query.at}=? AND ${query.id}<?))`;
    params.push(boundary.at, boundary.at, boundary.id);
  }
  params.push(limit + 1);
  const rows = await store.all(`SELECT ${query.select}, ${query.at} AS page_at FROM ${query.from} WHERE ${where} ORDER BY ${query.at} DESC,${query.id} DESC LIMIT ?`, params);
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const nextCursor = rows.length > limit && last
    ? Buffer.from(JSON.stringify({ scope, at: last.page_at, id: last.id })).toString('base64url') : null;
  return { items: items.map(({ page_at: _, ...row }) => row), nextCursor };
}
