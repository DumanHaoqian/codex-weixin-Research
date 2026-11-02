import { Worker } from 'node:worker_threads';
import { automationCapabilities } from './capabilities.js';

export type SqlValue = string | number | null;
export type Statement = { sql: string; params?: SqlValue[] };
export type Row = Record<string, SqlValue>;

// A single synchronous SQLite connection runs outside the HTTP/WeChat event loop.
// The SQL interface is internal: never pass client SQL or identifiers to this port.
const workerSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
let db;
try {
  if (workerData.file !== ':memory:') fs.mkdirSync(path.dirname(workerData.file), {recursive:true});
  db = new DatabaseSync(workerData.file);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 2) throw new Error('Unsupported automation schema version: ' + version);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(workerData.schema);
    if (!db.prepare('PRAGMA table_info(notification_attempts)').all().some(c => c.name === 'part_id'))
      db.exec('ALTER TABLE notification_attempts ADD COLUMN part_id TEXT REFERENCES notification_parts(id)');
    db.exec('PRAGMA user_version=2; COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  parentPort.postMessage({ready:true});
} catch (e) { try { db?.close(); } catch {} parentPort.postMessage({fatal:String(e.message)}); parentPort.close(); }
parentPort.on('message', ({id, kind, statements}) => {
  try {
    if (kind === 'close') { db.close(); parentPort.postMessage({id,result:[]}); parentPort.close(); return; }
    let result;
    if (kind === 'all') result = db.prepare(statements[0].sql).all(...(statements[0].params || []));
    else {
      db.exec('BEGIN IMMEDIATE');
      try {
        result = statements.map(s => {
          const r = db.prepare(s.sql).run(...(s.params || []));
          return {changes:Number(r.changes)};
        });
        db.exec('COMMIT');
      } catch(e) { db.exec('ROLLBACK'); throw e; }
    }
    parentPort.postMessage({id,result});
  } catch(e) { parentPort.postMessage({id,error:String(e.message)}); }
});
`;

const schema = `
CREATE TABLE IF NOT EXISTS tasks (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL, sender_id TEXT NOT NULL,
 revision INTEGER NOT NULL, state TEXT NOT NULL, definition TEXT NOT NULL,
 next_due INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS tasks_due ON tasks(state,next_due);
CREATE TABLE IF NOT EXISTS revisions (
 task_id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL,
 definition TEXT NOT NULL, PRIMARY KEY(task_id,revision)
) STRICT;
CREATE TABLE IF NOT EXISTS requests (
 account_id TEXT NOT NULL, sender_id TEXT NOT NULL, request_key TEXT NOT NULL,
 payload_hash TEXT NOT NULL, response TEXT NOT NULL,
 PRIMARY KEY(account_id,sender_id,request_key)
) STRICT;
CREATE TABLE IF NOT EXISTS occurrences (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL,
 due_at INTEGER NOT NULL, source_key TEXT NOT NULL, state TEXT NOT NULL,
 UNIQUE(task_id,revision,source_key)
) STRICT;
CREATE TABLE IF NOT EXISTS runs (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), occurrence_id TEXT NOT NULL REFERENCES occurrences(id),
 revision INTEGER NOT NULL, state TEXT NOT NULL, snapshot TEXT NOT NULL,
 start_deadline INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, result TEXT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS active_task_run ON runs(task_id) WHERE state IN ('queued','running');
CREATE TABLE IF NOT EXISTS operations (
 id TEXT PRIMARY KEY, effect_key TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL REFERENCES tasks(id),
 state TEXT NOT NULL, payload TEXT NOT NULL, result TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS resource_claims (
 id TEXT PRIMARY KEY, server_id TEXT NOT NULL, gpu_uuid TEXT NOT NULL,
 holder_id TEXT NOT NULL, state TEXT NOT NULL, epoch INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS active_gpu_claim ON resource_claims(server_id,gpu_uuid)
 WHERE state IN ('requesting','held','handing_off','job_owned','unknown');
CREATE TABLE IF NOT EXISTS events (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), semantic_key TEXT NOT NULL UNIQUE,
 kind TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS notifications (
 id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
 account_id TEXT NOT NULL, sender_id TEXT NOT NULL, state TEXT NOT NULL,
 content TEXT NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS notification_attempts (
 id TEXT PRIMARY KEY, notification_id TEXT NOT NULL REFERENCES notifications(id),
 state TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, error TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS notification_parts (
 id TEXT PRIMARY KEY, notification_id TEXT NOT NULL REFERENCES notifications(id),
 part_index INTEGER NOT NULL, content TEXT NOT NULL, state TEXT NOT NULL,
 attempt_id TEXT, UNIQUE(notification_id,part_index)
) STRICT;
`;

export class AutomationStore {
  private worker: Worker;
  private serial = 0;
  private pending = new Map<number, { resolve(value: Row[]): void; reject(error: Error): void }>();
  private ready: Promise<void>;
  private failure?: Error;
  private closing?: Promise<void>;

  constructor(file: string) {
    const capability = automationCapabilities().storage;
    if (!capability.ready) throw new Error(capability.reason);
    this.worker = new Worker(workerSource, { eval: true, workerData: { file, schema } });
    this.ready = new Promise((resolve, reject) => {
      this.worker.on('message', (message) => {
        if (message.ready) { resolve(); return; }
        if (message.fatal) { this.fail(new Error(message.fatal)); reject(this.failure); return; }
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result);
      });
      this.worker.on('error', (error) => { this.fail(error); reject(error); });
      this.worker.on('exit', () => {
        const error = new Error('Automation database worker exited');
        this.fail(error); reject(error);
      });
    });
    // Opening may fail before the first consumer awaits a query.
    void this.ready.catch(() => {});
  }

  all(sql: string, params: SqlValue[] = []): Promise<Row[]> {
    return this.request('all', [{ sql, params }]);
  }

  transaction(statements: Statement[]): Promise<Row[]> {
    if (!statements.length) return Promise.resolve([]);
    return this.request('transaction', statements);
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      try { await this.request('close', []); }
      finally { await this.worker.terminate(); }
    })();
    return this.closing;
  }

  private async request(kind: string, statements: Statement[]): Promise<Row[]> {
    await this.ready;
    if (this.failure) throw this.failure;
    if (this.closing && kind !== 'close') throw new Error('Automation database is closing');
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, kind, statements });
    });
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const request of this.pending.values()) request.reject(this.failure);
    this.pending.clear();
  }
}
