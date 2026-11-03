import crypto from 'node:crypto';
import { z } from 'zod';
import { hash,receiptSchema,workflowSchema,jobMonitorSchema,type ResearchRemotePort,type RemoteRequest,type RemoteReceipt,type WorkflowSpec,type Target,type RemoteAction } from './research-contracts.js';
import type { AutomationStore,Row,Statement } from './store.js';
import type { Owner,TaskDefinition } from './tasks.js';
import { metricsSchema,ArtifactService } from './results.js';
import type { RunOutput } from './run-service.js';
import { projectNavigation } from './agent.js';

type Workflow={id:string;taskId:string;state:string;phase:string;deadline:number;submissions:number;data:any;owner:Owner;definition:TaskDefinition};
function decode(r:Row):Workflow{return {id:String(r.id),taskId:String(r.task_id),state:String(r.state),phase:String(r.phase),deadline:Number(r.deadline),submissions:Number(r.submissions),data:JSON.parse(String(r.data)),owner:{accountId:String(r.account_id),senderId:String(r.sender_id)},definition:JSON.parse(String(r.snapshot))};}
export function remoteRequest(action:RemoteAction,target:Target,owner:Owner,payload:Record<string,unknown>,operationId:string=crypto.randomUUID()):RemoteRequest{
  const ownerScope=hash(owner);return {version:1,action,target,ownerScope,payload,operationId,payloadHash:hash({action,target,ownerScope,payload})};
}
function verify(request:RemoteRequest,value:unknown):RemoteReceipt{
  const receipt=receiptSchema.parse(value);
  if(receipt.operationId!==request.operationId||receipt.payloadHash!==request.payloadHash||receipt.ownerScope!==request.ownerScope)throw new Error('Remote receipt identity mismatch');
  if(typeof request.payload.objectId==='string'&&receipt.objectId!==request.payload.objectId)throw new Error('Remote object identity mismatch');
  return receipt;
}
export class WorkflowEngine{
  private current?:Promise<void>;private stopped=false;
  private mutations=new Map<string,Promise<unknown>>();
  private async exclusive<T>(id:string,action:()=>Promise<T>):Promise<T>{
    const previous=this.mutations.get(id)??Promise.resolve();
    const pending=previous.catch(()=>{}).then(action);this.mutations.set(id,pending);
    try{return await pending;}finally{if(this.mutations.get(id)===pending)this.mutations.delete(id);}
  }
  constructor(private store:AutomationStore,readonly remote:ResearchRemotePort,private authorize:(owner:Owner)=>boolean|Promise<boolean>,private artifacts:ArtifactService,private now=Date.now,private root?:string){}
  private async invoke(request:RemoteRequest){return verify(request,await this.remote.invoke(request));}
  async preflight(owner:Owner,target:Target,gpu=false,recipe?:unknown){
    const request=remoteRequest('preflight',target,owner,{gpu,...(recipe?{recipe}:{})});const result=await this.invoke(request);
    if(result.state!=='ready'||result.payload.tmux!==true||Math.abs(result.remoteNow-this.now())>30_000)throw new Error('Remote preflight unavailable or clock skew exceeds 30 seconds');
    return result;
  }
  async register(run:Row,definition:TaskDefinition,owner:Owner):Promise<RunOutput>{
    if((await this.store.all("SELECT id FROM research_workflows WHERE task_id=? AND state NOT IN ('succeeded','failed','needs_review','cancelled','expired')",[run.task_id])).length)
      return {state:'skipped',text:'同一任务已有科研流程；未重复提交。'};
    const spec=definition.kind==='job_monitor'?jobMonitorSchema.parse(definition.jobMonitor):workflowSchema.parse(definition.workflow);
    const monitor=definition.kind==='job_monitor';
    const deadline=monitor?this.now()+(spec as z.infer<typeof jobMonitorSchema>).durationSeconds*1000:Date.parse((spec as WorkflowSpec).resource.waitDeadlineUtc);
    if(deadline<=this.now())throw new Error('Resource wait deadline is in the past');
    const data:any={spec,target:spec.target,attempt:1,revision:run.revision,...(monitor?{jobId:(spec as z.infer<typeof jobMonitorSchema>).jobId}:{})};
    await this.store.transaction([{sql:'INSERT INTO research_workflows VALUES (?,?,?,?,?,?,?,?,?)',params:[run.id,run.task_id,monitor?'monitor':'resources',monitor?'monitoring':'waiting',this.now(),deadline,0,JSON.stringify(data),this.now()]}]);
    return {text:'科研流程已登记。远程作业、资源保留与验证结果将独立跟踪。',data:{workflowId:run.id},findings:true};
  }
  scan():Promise<void>{if(this.stopped)return Promise.resolve();this.current??=this.collect().finally(()=>{this.current=undefined;});return this.current;}
  private async collect():Promise<void>{
    const observations=new Map<string,RemoteReceipt>();
    const rows=await this.store.all(`SELECT w.*,t.account_id,t.sender_id,t.state AS task_state,r.snapshot FROM research_workflows w JOIN tasks t ON t.id=w.task_id JOIN runs r ON r.id=w.id
      WHERE w.state IN ('waiting','submitting','reserving','held','handoff','monitoring','unknown','releasing') AND w.next_check<=? ORDER BY w.next_check,w.id LIMIT 20`,[this.now()]);
    for(const candidate of rows){if(this.stopped)return;await this.exclusive(String(candidate.id),async()=>{
      const row=(await this.store.all(`SELECT w.*,t.account_id,t.sender_id,t.state AS task_state,r.snapshot FROM research_workflows w JOIN tasks t ON t.id=w.task_id JOIN runs r ON r.id=w.id WHERE w.id=?`,[candidate.id]))[0];
      if(!row||!['waiting','submitting','reserving','held','handoff','monitoring','unknown','releasing'].includes(String(row.state)))return;
      const w=decode(row);
      if(!await this.authorize(w.owner)||row.task_state==='deleted'){
        // Cleanup only a pure holder; the helper refuses to release handed-off jobs.
        if(w.data.leaseId){try{await this.invoke(remoteRequest('release',w.data.target,w.owner,{objectId:w.data.leaseId}));}catch{}}
        await this.save(w,row.task_state==='deleted'?'cancelled':'blocked','当前所有者不可用或任务已删除；未提交新实验，运行中的实验未被停止。');return;
      }
      try{await this.step(w,observations);}catch(error){
        // Do not invent failure of a live job from a lost observation.
        w.data.lastObservation='unavailable';w.data.lastError=error instanceof Error?error.message.slice(0,400):'observation_failed';w.data.stableCount=0;await this.save(w,w.data.operation?'unknown':w.state,'无法核实科研流程当前状态；保留既有身份，未重新提交。',this.now()+30_000);
      }
    });}
  }
  private async save(w:Workflow,state:string,notice?:string,next=this.now()+((w.data.spec.monitorSeconds??15)*1000)){
    const changed=w.state!==state||notice&&w.data.lastNotice!==notice;w.state=state;
    const statements:Statement[]=[{sql:'UPDATE research_workflows SET phase=?,state=?,next_check=?,submissions=?,data=?,updated_at=? WHERE id=?',params:[w.phase,state,next,w.submissions,JSON.stringify({...w.data,...(notice?{lastNotice:notice}:{})}),this.now(),w.id]}];
    if(changed&&notice){const event=crypto.randomUUID();statements.push({sql:'INSERT INTO events VALUES (?,?,?,?,?,?)',params:[event,w.taskId,`workflow:${w.id}:${event}`,state,JSON.stringify({run:w.id,content:notice}),this.now()]});
      if(w.definition.notification!=='muted')statements.push({sql:'INSERT INTO notifications VALUES (?,?,?,?,?,?,?)',params:[crypto.randomUUID(),event,w.owner.accountId,w.owner.senderId,'pending',`${w.definition.title}\n${notice}\n流程：${w.id}`,this.now()]});}
    await this.store.transaction(statements);if(notice)w.data.lastNotice=notice;
  }
  private async effect(w:Workflow,action:RemoteAction,payload:Record<string,unknown>,effectKey:string){
    if(!await this.authorize(w.owner))throw new Error('Access denied');
    const task=(await this.store.all('SELECT state,revision FROM tasks WHERE id=?',[w.taskId]))[0];if(task?.state==='deleted')throw new Error('Task deleted');
    if(['submit','reserve','handoff'].includes(action)){
      if(task?.revision!==w.data.revision)throw new Error('Task revision changed before remote effect');
      if(w.definition.projectId&&this.root){const p=projectNavigation(this.root).find(p=>p.id===w.definition.projectId);if(!p||p.server!==w.data.target.server||p.remotePath!==w.data.spec.recipe.root)throw new Error('Project binding changed');}
    }
    const existing=(await this.store.all('SELECT * FROM operations WHERE effect_key=?',[effectKey]))[0];
    let request:RemoteRequest;
    if(existing){
      request=JSON.parse(String(existing.payload));
      if(request.payloadHash!==remoteRequest(action,w.data.target,w.owner,payload,request.operationId).payloadHash)throw new Error('Operation payload conflict');
      // Existing intents can have crossed the network before a crash. Reconcile
      // the original identity; never automatically invoke submit/reserve again.
      const receipt=await this.invoke(remoteRequest('reconcile',w.data.target,w.owner,{operationId:request.operationId,originalHash:request.payloadHash}));
      if(receipt.state==='not_found')throw new Error('Original remote outcome remains unknown');
      if(receipt.objectId!==request.payload.objectId)throw new Error('Reconciled operation object identity mismatch');
      return receipt;
    }
    request=remoteRequest(action,w.data.target,w.owner,payload);w.data.operation=request;
    if(['submit','handoff'].includes(action)){
      if(w.submissions>=w.data.spec.grant.maxSubmissions)throw new Error('Submission budget exhausted');w.submissions++;
    }
    await this.store.transaction([{sql:'INSERT INTO operations VALUES (?,?,?,?,?,?)',params:[request.operationId,effectKey,w.taskId,'dispatching',JSON.stringify(request),null]},
      {sql:'UPDATE research_workflows SET data=?,submissions=?,state=?,updated_at=? WHERE id=?',params:[JSON.stringify(w.data),w.submissions,action==='reserve'?'reserving':action==='submit'?'submitting':w.state,this.now(),w.id]}]);
    const receipt=await this.invoke(request);
    await this.store.transaction([{sql:'UPDATE operations SET state=?,result=? WHERE id=?',params:['accepted',JSON.stringify(receipt),request.operationId]}]);
    return receipt;
  }
  private async object(w:Workflow,receipt:RemoteReceipt,kind:'job'|'lease'){
    if(!receipt.objectId)throw new Error('Remote object identity missing');
    if(w.data.serverId&&receipt.serverId!==w.data.serverId)throw new Error('Remote server identity changed');
    w.data.serverId=receipt.serverId;
    const existing=(await this.store.all('SELECT o.server_id,o.kind,t.account_id,t.sender_id FROM research_objects o JOIN tasks t ON t.id=o.task_id WHERE o.id=?',[receipt.objectId]))[0];
    if(existing&&(existing.server_id!==receipt.serverId||existing.kind!==kind||existing.account_id!==w.owner.accountId||existing.sender_id!==w.owner.senderId))throw new Error('Remote object provenance conflicts with an existing record');
    await this.store.transaction([{sql:'INSERT INTO research_objects VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,receipt=excluded.receipt,updated_at=excluded.updated_at',
      params:[receipt.objectId,w.taskId,w.id,w.data.operation?.operationId??receipt.operationId,receipt.serverId,receipt.objectId,kind,receipt.state,JSON.stringify(receipt),null,this.now(),this.now()]}]);
  }
  private async step(w:Workflow,observations:Map<string,RemoteReceipt>):Promise<void>{
    const spec=w.data.spec as WorkflowSpec;
    if(w.data.control){
      const control=w.data.control;delete w.data.control;
      if(control.action==='stop_monitor'){await this.save(w,'paused','监控已停止；未终止实验。');return;}
      if(control.action==='handoff')w.data.handoffRequested=true;
      else if(control.action==='release'||control.action==='stop'){
        const objectId=control.action==='release'?w.data.leaseId:w.data.jobId;
        if(!objectId)throw new Error('No matching remote object');
        if(control.action==='stop'&&!spec.grant?.stop)throw new Error('Job stop not granted');
        await this.effect(w,control.action,{objectId},`${w.id}:control:${control.key}`);
        w.phase=control.action==='release'?'lease':'monitor';await this.save(w,control.action==='release'?'releasing':'monitoring','已请求停止/释放，等待远端核实。',this.now()+5000);return;
      }
    }
    if(['unknown','submitting','reserving'].includes(w.state)&&w.data.operation){
      const operation=w.data.operation as RemoteRequest;
      if(['handoff','release','stop'].includes(operation.action)){
        await this.save(w,w.phase==='lease'?'held':'monitoring','控制请求状态不确定，改为核对原对象；未重复执行。',this.now());return;
      }
      const receipt=await this.invoke(remoteRequest('reconcile',w.data.target,w.owner,{operationId:operation.operationId,originalHash:operation.payloadHash}));
      if(receipt.state==='not_found'){await this.save(w,'unknown','原操作未能核实；不会因 not_found 自动重提。',this.now()+30_000);return;}
      if(receipt.objectId!==operation.payload.objectId)throw new Error('Reconciled object identity mismatch');
      const isLease=operation.action==='reserve';await this.object(w,receipt,isLease?'lease':'job');
      if(isLease){w.data.leaseId=receipt.objectId;w.phase='lease';}else{w.data.jobId=receipt.objectId;w.phase='monitor';}
      await this.save(w,isLease?'held':'monitoring','已核对原操作身份，继续跟踪。',this.now());return;
    }
    if(w.phase==='resources'){
      if(this.now()>=w.deadline){await this.save(w,'expired','资源等待已到期；未启动新的实验。');return;}
      const observationKey=hash({target:w.data.target,gpu:spec.resource.gpuCount>0});let preflight=observations.get(observationKey);
      if(!preflight||this.now()-preflight.remoteNow>15000){preflight=await this.preflight(w.owner,w.data.target,spec.resource.gpuCount>0);observations.set(observationKey,preflight);}
      w.data.serverId=preflight.serverId;
      const gpus=z.array(z.object({uuid:z.string(),totalBytes:z.number(),usedBytes:z.number(),utilization:z.number(),pids:z.array(z.number())}).passthrough()).parse(preflight.payload.gpu??[]);
      const selected=gpus.filter(g=>(!spec.resource.gpuUuids.length||spec.resource.gpuUuids.includes(g.uuid))&&g.totalBytes-g.usedBytes>=Math.max(spec.resource.minFreeBytes,spec.mode==='reserve_then_handoff'?spec.resource.holderBytes+64*1024**2:0)
        &&g.usedBytes<=spec.resource.maxUsedBytes&&g.utilization===0&&g.pids.length===0).map(g=>g.uuid).sort().slice(0,spec.resource.gpuCount);
      const signature=JSON.stringify(selected);
      w.data.stableCount=w.data.signature===signature&&this.now()-Number(w.data.lastSampleAt??0)<=45000?Number(w.data.stableCount??0)+1:1;w.data.signature=signature;w.data.lastSampleAt=this.now();
      if(selected.length!==spec.resource.gpuCount||(spec.mode!=='immediate'&&w.data.stableCount<spec.resource.stableSamples)){
        if(spec.mode==='immediate'){await this.save(w,'failed','立即启动时没有满足条件的资源；未提交实验。');return;}
        await this.save(w,'waiting',undefined,Math.min(w.deadline,this.now()+15000));return;
      }
      if(w.submissions>=spec.grant.maxSubmissions)throw new Error('Submission budget exhausted');
      if(spec.mode==='reserve_then_handoff'&&preflight.payload.reservation!==true){await this.save(w,'blocked','远端显存保留能力尚未通过预检，未占卡。');return;}
      // Acquire all internal claims in one transaction; unknown claims exclude
      // competitors. Server identity, not alias or changing GPU index, is the key.
      try{await this.store.transaction(selected.map(gpu=>({sql:'INSERT INTO resource_claims VALUES (?,?,?,?,?,?)',params:[crypto.randomUUID(),preflight.serverId,gpu,w.id,'requesting',this.now()]})));}
      catch{await this.save(w,'waiting','候选显卡已有本系统资源声明，继续等待。',this.now()+15000);return;}
      const objectId=crypto.randomUUID(),action=spec.mode==='reserve_then_handoff'?'reserve':'submit';
      const payload={...spec,objectId,selectedGpuUuids:selected,leaseDeadlineMs:preflight.remoteNow+spec.resource.holdSeconds*1000};
      // Preserve the exact payload before sending, including the fixed deadline.
      w.data.effectPayload=payload;w.data.selected=selected;
      const receipt=await this.effect(w,action,payload,`${w.id}:${action}:${w.data.attempt}`);await this.object(w,receipt,action==='reserve'?'lease':'job');
      if(action==='reserve'){w.data.leaseId=receipt.objectId;w.phase='lease';await this.save(w,'held','占卡申请已登记；实际显存分配仍待观测确认。',this.now()+5000);}
      else{w.data.jobId=receipt.objectId;w.phase='monitor';await this.save(w,'monitoring','实验提交已登记，正在核对实际进程与结果。',this.now()+5000);}return;
    }
    if(w.phase==='lease'){
      const receipt=await this.invoke(remoteRequest('inspect',w.data.target,w.owner,{objectId:w.data.leaseId}));await this.object(w,receipt,'lease');
      if(receipt.payload.handoffJobId&&['handed_off','unknown','needs_review'].includes(receipt.state)){
        // A persisted child identity survives a crash between tmux launch and
        // the parent acknowledgement. Follow that child; never hand off twice.
        w.data.jobId=z.string().uuid().parse(receipt.payload.handoffJobId);w.phase='monitor';
        await this.store.transaction([{sql:"UPDATE resource_claims SET state='job_owned' WHERE holder_id=? AND state!='released'",params:[w.id]}]);
        await this.save(w,'monitoring','已取得交接实验身份；继续核对原实验，未重复启动。',this.now()+5000);return;
      }
      if(['released','expired','failed','needs_review'].includes(receipt.state)){
        if(receipt.payload.releaseVerified===true)await this.releaseClaims(w);
        await this.save(w,receipt.state==='released'?'succeeded':receipt.state,`资源保留状态：${receipt.state}。未核实释放时保留资源声明。`);return;
      }
      if(receipt.state==='handed_off'){
        const jobId=z.string().uuid().parse(receipt.payload.handoffJobId);w.data.jobId=jobId;w.phase='monitor';
        await this.store.transaction([{sql:"UPDATE resource_claims SET state='job_owned' WHERE holder_id=? AND state!='released'",params:[w.id]}]);
        await this.save(w,'monitoring','保留进程已释放，实验正在独立核实；尚未将交接等同于训练成功。',this.now()+5000);return;
      }
      if(receipt.state==='held'){
        const allocation=z.object({bytesPerGpu:z.number(),gpuUuids:z.array(z.string())}).passthrough().parse(receipt.payload.allocation);
        if(allocation.bytesPerGpu<spec.resource.holderBytes||JSON.stringify([...allocation.gpuUuids].sort())!==JSON.stringify(w.data.selected))throw new Error('Allocation evidence mismatch');
        await this.store.transaction([{sql:"UPDATE resource_claims SET state='held' WHERE holder_id=? AND state='requesting'",params:[w.id]}]);
        if(w.data.handoffRequested||spec.resource.handoff==='automatic'){
          if(this.now()>=Number(w.data.effectPayload.leaseDeadlineMs))throw new Error('Lease expired before handoff');
          const jobId=w.data.handoffJobId??crypto.randomUUID();w.data.handoffJobId=jobId;
          await this.effect(w,'handoff',{objectId:w.data.leaseId,jobId},`${w.id}:handoff:${w.data.attempt}`);
          await this.save(w,'handoff','已请求交接；分别核对显存释放和真实实验身份。',this.now()+5000);return;
        }
        await this.save(w,'held','已观测到指定显存保留；未保证整卡排他。',this.now()+5000);return;
      }
      await this.save(w,w.state,undefined,this.now()+5000);return;
    }
    if(w.phase==='monitor'){
      if(w.definition.kind==='job_monitor'&&this.now()>=w.deadline){await this.save(w,'expired','监控期限已到；未停止实际实验。');return;}
      const receipt=await this.invoke(remoteRequest('inspect',w.data.target,w.owner,{objectId:w.data.jobId}));await this.object(w,receipt,'job');
      if(receipt.state==='exited'){
        const parsed=metricsSchema.safeParse(receipt.payload.metrics);
        const bound=parsed.success&&parsed.data.jobId===receipt.objectId;
        const state=receipt.payload.exitCode!==0?'failed':receipt.payload.validationState==='validated'&&bound?'succeeded':'needs_review';
        if(bound)await this.store.transaction([{sql:'UPDATE research_objects SET metrics=? WHERE id=?',params:[JSON.stringify(parsed.data),receipt.objectId!]}]);
        const evidence=await this.artifacts.write(w.taskId,w.id,'result.json',{state,receipt,metrics:parsed.success?parsed.data:null},this.now());
        if(receipt.payload.releaseVerified===true)await this.releaseClaims(w);
        if(state==='failed'&&w.definition.kind==='research_workflow'&&Number(w.data.attempt)<=spec.retryCount&&w.submissions<spec.grant.maxSubmissions){
          w.data.attempt++;for(const key of ['operation','jobId','leaseId','handoffJobId','handoffRequested'])delete w.data[key];w.phase='resources';await this.save(w,'waiting','实验已知失败；按保存方案与次数限制进行下一次尝试。',this.now()+15000);return;
        }
        await this.save(w,state,`实验进程已退出，验证状态：${state}。证据产物：${evidence.id}；缺失指标不会被报告为科研成功。`);return;
      }
      if(['failed','needs_review'].includes(receipt.state)){if(receipt.payload.releaseVerified===true)await this.releaseClaims(w);await this.save(w,receipt.state,`远端作业需要处理：${receipt.state}；资源声明保留至核实释放。`);return;}
      if(['not_found','unknown'].includes(receipt.state)){await this.save(w,'monitoring','作业身份或状态暂时无法核实；未把进程消失当作成功。',this.now()+30000);return;}
      await this.store.transaction([{sql:"UPDATE resource_claims SET state='job_owned' WHERE holder_id=? AND state='requesting'",params:[w.id]}]);
      let notice=w.data.lastProcessState===receipt.state?undefined:`作业状态：${receipt.state}；日志仅采样末尾，未声称检查全部日志。`;
      const logNotices:string[]=[];
      if(typeof receipt.payload.logBytes==='number'){
        const bytes=receipt.payload.logBytes;
        if(w.data.lastLogBytes===undefined||bytes!==w.data.lastLogBytes){
          w.data.lastProgressAt=this.now();if(w.data.logStalled)logNotices.push('作业日志恢复更新。');w.data.logStalled=false;
        }else if(spec.logStallSeconds&&this.now()-Number(w.data.lastProgressAt)>=spec.logStallSeconds*1000&&!w.data.logStalled){
          w.data.logStalled=true;logNotices.push('日志超过保存的停滞阈值未更新；仍需核查阶段，不据此判定实验失败或停止实验。');
        }
        w.data.lastLogBytes=bytes;
      }
      w.data.logAlertsSeen??={};
      for(const alert of spec.logAlerts??[]){
        const match=alert==='oom'?/out of memory|CUDA_ERROR_OUT_OF_MEMORY/i.test(String(receipt.payload.logTail??'')):/\b(?:loss|grad(?:ient)?|metric)\b[^\n]{0,60}\bnan\b/i.test(String(receipt.payload.logTail??''));
        if(match&&!w.data.logAlertsSeen[alert]){w.data.logAlertsSeen[alert]=true;logNotices.push(`有限日志末尾匹配 ${alert.toUpperCase()} 特征；需核查，未据此自动停止或重训。`);}
      }
      if(logNotices.length)notice=logNotices.join('\n');
      if(spec.maxRuntimeSeconds&&Number(receipt.payload.startedAt)>0&&this.now()-Number(receipt.payload.startedAt)>spec.maxRuntimeSeconds*1000&&!w.data.runtimeNotice){
        w.data.runtimeNotice=true;notice=spec.grant?.stop?'作业超过保存的时长上限；远端监督器按已授权的停止策略处理。':'作业超过保存的时长上限；没有停止授权，实验继续运行，请处理。';
      }
      w.data.lastProcessState=receipt.state;await this.save(w,'monitoring',notice);return;
    }
  }
  private async releaseClaims(w:Workflow){await this.store.transaction([{sql:"UPDATE resource_claims SET state='released' WHERE holder_id=?",params:[w.id]}]);}
  async control(owner:Owner,id:string,action:'handoff'|'release'|'stop'|'stop_monitor'|'resume_monitor',key:string){
    return this.exclusive(id,()=>this.applyControl(owner,id,action,key));
  }
  private async applyControl(owner:Owner,id:string,action:'handoff'|'release'|'stop'|'stop_monitor'|'resume_monitor',key:string){
    if(!await this.authorize(owner))throw new Error('Access denied');z.string().min(1).max(200).parse(key);
    const row=(await this.store.all('SELECT w.*,t.account_id,t.sender_id,r.snapshot FROM research_workflows w JOIN tasks t ON t.id=w.task_id JOIN runs r ON r.id=w.id WHERE w.id=? AND t.account_id=? AND t.sender_id=?',[id,owner.accountId,owner.senderId]))[0];
    if(!row)throw new Error('Workflow not found');const w=decode(row),requestKey=`workflow:${key}`,payloadHash=hash({id,action});
    const previous=(await this.store.all('SELECT * FROM requests WHERE account_id=? AND sender_id=? AND request_key=?',[owner.accountId,owner.senderId,requestKey]))[0];
    if(previous){if(previous.payload_hash!==payloadHash)throw new Error('Idempotency conflict');return JSON.parse(String(previous.response));}
    if(action==='stop'&&!w.data.spec.grant?.stop)throw new Error('Job stop not granted');
    if(action==='handoff'&&(!w.data.leaseId||!['held','reserving'].includes(w.state)))throw new Error('Lease is not held');
    if(action==='release'&&(!w.data.leaseId||w.data.jobId))throw new Error('No releasable pure holder');
    if(action==='resume_monitor'&&w.state!=='paused')throw new Error('Monitor is not paused');
    if(action!=='resume_monitor'&&!['waiting','submitting','reserving','held','handoff','monitoring','unknown','releasing'].includes(w.state))throw new Error('Workflow is not active');
    if(action==='stop_monitor'&&(!w.data.jobId||w.phase!=='monitor'))throw new Error('Only an experiment monitor can be paused; release a pure holder explicitly');
    if(w.data.control)throw new Error('A workflow control is already pending');
    const response={queued:true,workflowId:id,action};
    if(action==='resume_monitor')w.state=w.phase==='lease'?'held':'monitoring';else w.data.control={action,key};
    await this.store.transaction([{sql:'UPDATE research_workflows SET data=?,state=?,next_check=? WHERE id=?',params:[JSON.stringify(w.data),w.state,this.now(),id]},
      {sql:'INSERT INTO requests VALUES (?,?,?,?,?)',params:[owner.accountId,owner.senderId,requestKey,payloadHash,JSON.stringify(response)]}]);return response;
  }
  async close(){this.stopped=true;await this.remote.close();await this.current?.catch(()=>{});await Promise.allSettled(this.mutations.values());}
}
