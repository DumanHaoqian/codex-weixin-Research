import assert from 'node:assert/strict';
import test from 'node:test';
import { nextAfter } from '../src/automation/calendar.js';
import { AutomationStore } from '../src/automation/store.js';
import { TaskService, type TaskInput } from '../src/automation/tasks.js';

const owner = { accountId: 'account', senderId: 'sender' };
const other = { accountId: 'account', senderId: 'other' };
function reminder(at: number): TaskInput {
  return { title: 'Reminder', prompt: 'Check results', kind: 'reminder',
    schedule: { kind: 'once', atUtc: new Date(at).toISOString(), timezone: 'Asia/Shanghai' } };
}

test('calendar skips DST gaps and never fires the second folded hour', () => {
  const zone = 'America/New_York';
  assert.equal(new Date(nextAfter({ kind:'daily',time:'02:30',timezone:zone }, Date.parse('2026-03-08T00:00:00Z'))!).toISOString(), '2026-03-09T06:30:00.000Z');
  assert.equal(new Date(nextAfter({ kind:'daily',time:'01:30',timezone:zone }, Date.parse('2026-11-01T05:00:00Z'))!).toISOString(), '2026-11-01T05:30:00.000Z');
  assert.equal(new Date(nextAfter({ kind:'daily',time:'01:30',timezone:zone }, Date.parse('2026-11-01T05:45:00Z'))!).toISOString(), '2026-11-02T06:30:00.000Z');
});

test('weekly and interval schedules retain timezone and original anchor', () => {
  assert.equal(new Date(nextAfter({kind:'weekly',weekdays:[1],time:'09:00',timezone:'Asia/Shanghai'}, Date.parse('2026-11-01T00:00:00Z'))!).toISOString(), '2026-11-02T01:00:00.000Z');
  assert.equal(nextAfter({kind:'interval',everySeconds:300,anchorUtc:'2026-11-02T00:00:00Z',timezone:'UTC'},Date.parse('2026-11-02T00:08:59Z')),Date.parse('2026-11-02T00:10:00Z'));
  assert.throws(() => nextAfter({kind:'daily',time:'25:00',timezone:'UTC'},0));
  assert.throws(() => nextAfter({kind:'daily',time:'09:00',timezone:'NoSuch/Zone'},0));
});

test('create retries are idempotent, revisions conflict and owners are isolated', async () => {
  const store = new AutomationStore(':memory:');
  const service = new TaskService(store, { now:()=>1000, authorize:()=>true });
  try {
    const [one,two] = await Promise.all([service.create(owner,'message',reminder(2000)),service.create(owner,'message',reminder(2000))]);
    assert.equal(one.id,two.id);
    assert.equal((await service.list(owner)).length,1);
    await assert.rejects(service.create(owner,'message',reminder(3000)),/conflict/);
    await assert.rejects(service.get(other,one.id),/not found/);
    const updated = await service.update(owner,one.id,1,reminder(4000));
    assert.equal(updated.revision,2);
    await assert.rejects(service.update(owner,one.id,1,reminder(5000)),/Revision conflict/);
    await assert.rejects(service.create(owner,'past',reminder(500)),/past/);
  } finally { await store.close(); }
});

test('tick commits a single result and outbox even across duplicate scans and clock rollback', async () => {
  let now = 1000;
  const store = new AutomationStore(':memory:');
  const service = new TaskService(store,{now:()=>now,authorize:()=>true});
  try {
    const task = await service.create(owner,'one',reminder(2000));
    now=2000;
    await Promise.all([service.tick(),service.tick()]);
    now=1000; await service.tick();
    assert.equal((await service.get(owner,task.id)).state,'completed');
    assert.equal((await store.all('SELECT count(*) AS n FROM runs'))[0].n,1);
    assert.equal((await store.all('SELECT state FROM notifications'))[0].state,'pending');
    assert.equal((await store.all('SELECT sender_id FROM notifications'))[0].sender_id,owner.senderId);
  } finally { await store.close(); }
});

test('missed, revoked, paused and deleted tasks never silently execute', async () => {
  let now=1000, authorized=true;
  const store=new AutomationStore(':memory:');
  const service=new TaskService(store,{now:()=>now,authorize:()=>authorized});
  try {
    const paused=await service.create(owner,'paused',reminder(2000));
    await service.setState(owner,paused.id,'pause');
    const revoked=await service.create(owner,'revoked',reminder(2000));
    authorized=false; now=2000; await service.tick();
    assert.equal((await store.all('SELECT state FROM runs WHERE task_id=?',[revoked.id]))[0].state,'blocked');
    assert.equal((await store.all('SELECT count(*) AS n FROM notifications'))[0].n,0);
    authorized=true;
    const late=await service.create(owner,'late',reminder(3000));
    now=400000; await service.tick();
    assert.equal((await store.all('SELECT state FROM runs WHERE task_id=?',[late.id]))[0].state,'missed');
    assert.equal((await store.all('SELECT count(*) AS n FROM runs WHERE task_id=?',[paused.id]))[0].n,0);
    await service.setState(owner,paused.id,'delete');
    await assert.rejects(service.setState(owner,paused.id,'resume'),/deleted/);
  } finally { await store.close(); }
});

test('research tasks can be drafted but cannot activate without implemented capabilities', async () => {
  const store=new AutomationStore(':memory:');
  const service=new TaskService(store,{now:()=>0,authorize:()=>true});
  try {
    const task={...reminder(1000),kind:'research_workflow' as const};
    await assert.rejects(service.create(owner,'active',task),/Capability unavailable/);
    const draft=await service.create(owner,'draft',task,true);
    assert.equal(draft.state,'draft');
    await assert.rejects(service.setState(owner,draft.id,'resume'),/Capability unavailable/);
    assert.equal((await service.get(owner,draft.id)).state,'draft');
  } finally { await store.close(); }
});

test('project validation is rechecked at execution, not only at creation',async()=>{
  let now=0, bindingValid=true;
  const store=new AutomationStore(':memory:');
  const service=new TaskService(store,{now:()=>now,authorize:()=>true,
    validateActivation:()=>{if(!bindingValid)throw new Error('Project changed');}});
  try {
    const task=await service.create(owner,'project',{...reminder(1000),projectId:'research-project'});
    bindingValid=false;now=1000;await service.tick();
    assert.equal((await store.all('SELECT state FROM runs WHERE task_id=?',[task.id]))[0].state,'blocked');
  } finally {await store.close();}
});
