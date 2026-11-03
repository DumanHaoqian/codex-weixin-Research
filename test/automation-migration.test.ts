import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { AutomationStore } from '../src/automation/store.js';

test('v2 migration takes a consistent pre-migration snapshot and preserves existing records',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'automation-v3-')),file=path.join(root,'test.sqlite');
  let store=new AutomationStore(file);
  try{
    await store.transaction([
      {sql:"INSERT INTO tasks VALUES ('existing','a','s',1,'paused','{}',NULL,0,0)"},
      {sql:'DROP TABLE gpu_observations'}, {sql:'DROP TABLE gpu_watches'}, {sql:'PRAGMA user_version=2'}
    ]);
    await store.close();store=new AutomationStore(file);
    assert.equal((await store.all('PRAGMA user_version'))[0].user_version,3);
    assert.equal((await store.all('SELECT id FROM tasks'))[0].id,'existing');
    assert.equal((await store.all('SELECT count(*) n FROM gpu_watches'))[0].n,0);
    const backups=fs.readdirSync(path.join(root,'backups'));assert.equal(backups.length,1);
    const backup=new DatabaseSync(path.join(root,'backups',backups[0]),{readOnly:true});
    try{
      assert.equal(backup.prepare('PRAGMA user_version').get()!.user_version,2);
      assert.equal(backup.prepare('SELECT id FROM tasks').get()!.id,'existing');
      assert.equal(backup.prepare("SELECT count(*) n FROM sqlite_master WHERE name='gpu_watches'").get()!.n,0);
    }finally{backup.close();}
  }finally{await store.close();fs.rmSync(root,{recursive:true,force:true});}
});
