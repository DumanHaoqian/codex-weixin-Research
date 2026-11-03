import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AutomationStore } from '../src/automation/store.js';
import { automationCapabilities } from '../src/automation/capabilities.js';

test('capabilities fail closed for unverified remote and model profiles', () => {
  assert.equal(automationCapabilities('22.1.0').storage.ready, false);
  assert.equal(automationCapabilities('24.1.0').storage.ready, true);
  assert.equal(automationCapabilities().remote.ready, false);
  assert.equal(automationCapabilities().agent.ready, false);
  assert.equal(automationCapabilities().gpuReserve.ready, false);
});

test('SQLite transaction rollback and reopen preserve acknowledged data', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-db-'));
  let store = new AutomationStore(path.join(root, 'scheduler.sqlite'));
  try {
    await store.transaction([{ sql: "INSERT INTO tasks VALUES ('t','a','s',1,'active','{}',NULL,0,0)" }]);
    await assert.rejects(store.transaction([
      { sql: "UPDATE tasks SET revision=2 WHERE id='t'" },
      { sql: "INSERT INTO tasks VALUES ('t','a','s',1,'active','{}',NULL,0,0)" }
    ]), /UNIQUE/);
    assert.equal((await store.all('SELECT revision FROM tasks'))[0].revision, 1);
    await store.close();
    store = new AutomationStore(path.join(root, 'scheduler.sqlite'));
    assert.equal((await store.all('SELECT id FROM tasks'))[0].id, 't');
    await store.transaction([{ sql: 'PRAGMA user_version=99' }]);
    await store.close();
    store = new AutomationStore(path.join(root, 'scheduler.sqlite'));
    await assert.rejects(store.all('SELECT 1'), /Unsupported automation schema/);
  } finally {
    await store.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unknown claims still exclude competing GPU allocation', async () => {
  const store = new AutomationStore(':memory:');
  try {
    await store.transaction([{ sql: "INSERT INTO resource_claims VALUES ('one','server','uuid','holder','unknown',1)" }]);
    await assert.rejects(store.transaction([{ sql: "INSERT INTO resource_claims VALUES ('two','server','uuid','holder2','held',2)" }]), /UNIQUE/);
    assert.equal((await store.all('SELECT count(*) AS n FROM resource_claims'))[0].n, 1);
  } finally { await store.close(); }
});
