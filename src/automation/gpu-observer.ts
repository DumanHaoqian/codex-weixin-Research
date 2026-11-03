import crypto from 'node:crypto';
import { eligibleGpuUuids, gpuWatchSchema, gpuSnapshotSchema, type GpuObservationPort, type GpuSnapshot } from './gpu.js';
import type { AutomationStore, Row, Statement } from './store.js';
import type { Owner, TaskDefinition } from './tasks.js';

export class GpuObserver {
  private current?:Promise<void>;
  private stopped=false;
  constructor(private store:AutomationStore,readonly port:GpuObservationPort,private authorize:(owner:Owner)=>boolean|Promise<boolean>,private now=Date.now){}

  scan():Promise<void>{
    if(this.stopped)return Promise.resolve();
    this.current??=this.collect().finally(()=>{this.current=undefined;});return this.current;
  }
  private async collect():Promise<void>{
    const due=await this.store.all(`SELECT w.*,t.account_id,t.sender_id,t.state AS task_state,r.snapshot
      FROM gpu_watches w JOIN tasks t ON t.id=w.task_id JOIN runs r ON r.id=w.run_id
      WHERE w.state='watching' AND w.next_check<=? ORDER BY w.next_check,w.task_id LIMIT 100`,[this.now()]);
    const shared=new Map<string,Promise<GpuSnapshot>>();
    for(const row of due){
      if(this.stopped)return;
      const owner={accountId:String(row.account_id),senderId:String(row.sender_id)};
      if(row.task_state==='deleted'||!await this.authorize(owner)){
        await this.store.transaction([{sql:"UPDATE gpu_watches SET state='blocked',updated_at=? WHERE task_id=? AND run_id=?",params:[this.now(),row.task_id,row.run_id]}]);continue;
      }
      if(this.now()>=Number(row.deadline)){await this.finish(row,owner,'expired');continue;}
      const def=JSON.parse(String(row.snapshot)) as TaskDefinition;
      const watch=gpuWatchSchema.parse(def.gpuWatch);
      const key=JSON.stringify([watch.server,watch.bindingHash]);
      let sample=shared.get(key);
      if(!sample){sample=this.port.sample(watch.server,watch.bindingHash);shared.set(key,sample);}
      let snapshot:GpuSnapshot|undefined;
      try{
        snapshot=gpuSnapshotSchema.parse(await sample);
        if(snapshot.server!==watch.server||snapshot.bindingHash!==watch.bindingHash||snapshot.observedAt>this.now()+1000
          ||snapshot.observedAt<snapshot.startedAt||this.now()-snapshot.startedAt>60_000)throw new Error('Stale or mismatched observation');
      }catch{snapshot=undefined;}
      if(this.stopped)return;
      // Access and persisted watch identity can change while MCP is in flight.
      const current=(await this.store.all("SELECT state,run_id,revision FROM gpu_watches WHERE task_id=?",[row.task_id]))[0];
      if(current?.state!=='watching'||current.run_id!==row.run_id)continue;
      if(!await this.authorize(owner)){
        await this.store.transaction([{sql:"UPDATE gpu_watches SET state='blocked',updated_at=? WHERE task_id=? AND run_id=?",params:[this.now(),row.task_id,row.run_id]}]);continue;
      }
      if(this.now()>=Number(row.deadline)){await this.finish(row,owner,'expired');continue;}
      await this.record(row,owner,def,snapshot);
    }
  }

  private async record(row:Row,owner:Owner,def:TaskDefinition,snapshot:GpuSnapshot|undefined):Promise<void>{
    const now=this.now(),watch=gpuWatchSchema.parse(def.gpuWatch),id=crypto.randomUUID();
    const previous=(await this.store.all("SELECT id,observed_at,valid_until,payload FROM gpu_observations WHERE task_id=? AND run_id=? AND validity='valid' ORDER BY observed_at DESC,id DESC LIMIT 1",[row.task_id,row.run_id]))[0];
    const eligible=snapshot?eligibleGpuUuids(snapshot,watch):[];
    // Require the same set of UUIDs over recent consecutive valid samples.
    // Failure or a long gap resets stability; old observations are never free-now.
    const stableSignature=JSON.stringify(eligible);
    const consecutive=snapshot&&row.stable_signature===stableSignature&&previous&&now<=Number(previous.valid_until);
    const stableCount=snapshot?(consecutive?Number(row.stable_count)+1:1):0;
    const ready=snapshot&&eligible.length>0&&stableCount>=watch.stableSamples;
    const signature=!snapshot?'unavailable':ready?`available:${stableSignature}`:eligible.length?'stabilizing':'busy';
    const old=String(row.last_signature??'');
    const changed=signature!==old;
    // Initial busy/stabilizing readings establish a silent baseline. Repeated
    // failures are quiet; recovery and loss of previously eligible cards notify.
    const notify=changed&&(signature==='unavailable'||Boolean(ready)||old==='unavailable'||old.startsWith('available:'));
    const observedAt=snapshot?.observedAt??now,validUntil=snapshot?observedAt+Math.max(30_000,watch.sampleSeconds*2000):now;
    const payload=snapshot?{snapshot,eligibleGpuUuids:eligible,stableSamples:stableCount,requiredStableSamples:watch.stableSamples,
      availability:ready?'candidate_observed':eligible.length?'stabilizing':'busy',exclusivity:'not_guaranteed'}
      :{error:'GPU observation unavailable, rejected, stale or binding changed; previous values are historical only',availability:'unavailable'};
    const statements:Statement[]=[
      {sql:`INSERT INTO gpu_observations SELECT ?,?,?,?,?,?,?,?,?,? FROM gpu_watches w JOIN tasks t ON t.id=w.task_id
        WHERE w.task_id=? AND w.run_id=? AND w.state='watching' AND t.state!='deleted'`,params:[id,row.task_id,row.run_id,watch.server,watch.bindingHash,observedAt,validUntil,snapshot?'valid':'unavailable',JSON.stringify(payload),previous?.id??null,row.task_id,row.run_id]},
      {sql:'UPDATE gpu_watches SET next_check=?,last_signature=?,stable_signature=?,stable_count=?,last_observation_id=?,updated_at=? WHERE task_id=? AND run_id=? AND state=\'watching\' AND EXISTS (SELECT 1 FROM gpu_observations WHERE id=?)',
        params:[Math.min(now+watch.sampleSeconds*1000,Number(row.deadline)),signature,snapshot?stableSignature:null,stableCount,id,now,row.task_id,row.run_id,id]}
    ];
    if(notify){
      const content=`GPU 监控 · ${def.title}\n服务器：${watch.server}\n${!snapshot?'无法观测；不能把历史读数当作当前空闲。':ready?
        `连续 ${stableCount} 次观测到满足条件的候选卡：${eligible.join(', ')}。仅为观测，不保证排他占用。`:
        signature==='busy'?'当前未观测到满足条件的候选卡。':'候选状态发生变化，正在重新确认。'}\n观测时间：${new Date(observedAt).toISOString()}\n记录：${id}`;
      statements.push(...this.event(row,owner,`gpu:${id}`,snapshot?'gpu_changed':'gpu_unavailable',content,now,def.notification!=='muted'));
    }
    await this.store.transaction(statements);
  }

  private event(row:Row,owner:Owner,key:string,kind:string,content:string,now:number,notify=true):Statement[]{
    const event=crypto.randomUUID();return [
      {sql:`INSERT INTO events SELECT ?,?,?,?,?,? FROM gpu_watches w JOIN tasks t ON t.id=w.task_id
        WHERE w.task_id=? AND w.run_id=? AND w.state IN ('watching','expired') AND t.state!='deleted'`,params:[event,row.task_id,key,kind,JSON.stringify({run:row.run_id,content}),now,row.task_id,row.run_id]},
      ...(notify?[{sql:'INSERT INTO notifications SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM events WHERE id=?)',params:[crypto.randomUUID(),event,owner.accountId,owner.senderId,'pending',content,now,event]}]:[])
    ];
  }
  private async finish(row:Row,owner:Owner,state:'expired'|'stopped'):Promise<void>{
    const now=this.now();const def=JSON.parse(String(row.snapshot)) as TaskDefinition;
    const statements:Statement[]=[{sql:'UPDATE gpu_watches SET state=?,updated_at=? WHERE task_id=? AND run_id=? AND state=\'watching\'',params:[state,now,row.task_id,row.run_id]}];
    if(state==='expired')statements.push(...this.event(row,owner,`gpu:${row.run_id}:expired`,'gpu_expired',`GPU 监控已到期：${def.title}。仅停止观测，没有终止任何服务器进程。`,now,def.notification!=='muted'));
    await this.store.transaction(statements);
  }
  async close():Promise<void>{
    this.stopped=true;
    try{await this.port.close();}finally{await this.current?.catch(()=>{});}
  }
}
