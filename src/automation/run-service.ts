import crypto from 'node:crypto';
import type { AutomationStore, Row, Statement } from './store.js';
import type { Owner, TaskDefinition } from './tasks.js';

export type RunOutput={state?:string;text:string;findings?:boolean;data?:unknown};
export async function finishRun(store:AutomationStore,run:Row,owner:Owner,result:RunOutput,now:number):Promise<void>{
  const definition=JSON.parse(String(run.snapshot)) as TaskDefinition,state=result.state??'succeeded';
  const event=crypto.randomUUID(),notify=definition.notification!=='muted'&&(definition.notification==='always'||state!=='succeeded'||result.findings);
  const content=`${definition.title}\n${result.text}`.slice(0,30000);
  const statements:Statement[]=[
    {sql:'UPDATE occurrences SET state=? WHERE id=? AND EXISTS (SELECT 1 FROM runs WHERE id=? AND state IN (\'running\',\'queued\'))',params:[state,run.occurrence_id,run.id]},
    {sql:`INSERT INTO events SELECT ?,?,?,?,?,? FROM runs WHERE id=? AND state IN ('queued','running')`,params:[event,run.task_id,`run:${run.id}:finished`,state,JSON.stringify({run:run.id,content}),now,run.id]},
    ...(notify?[{sql:'INSERT INTO notifications SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM events WHERE id=?)',params:[crypto.randomUUID(),event,owner.accountId,owner.senderId,'pending',content,now,event]}]:[]),
    {sql:"UPDATE runs SET state=?,ended_at=?,result=? WHERE id=? AND state IN ('queued','running')",params:[state,now,JSON.stringify(result),run.id]}
  ];
  await store.transaction(statements);
}

export type RunHandler=(run:Row,definition:TaskDefinition,owner:Owner,signal:AbortSignal)=>Promise<RunOutput>;
export class RunWorker{
  private current?:Promise<void>;private stopped=false;private active=new Map<string,AbortController>();
  constructor(private store:AutomationStore,private authorize:(owner:Owner)=>boolean|Promise<boolean>,private handle:RunHandler,private now=Date.now){}
  async recover():Promise<void>{
    const rows=await this.store.all("SELECT r.*,t.account_id,t.sender_id FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.state='running'");
    for(const row of rows)await finishRun(this.store,row,{accountId:String(row.account_id),senderId:String(row.sender_id)},
      {state:'interrupted_unknown',text:'上一控制回合在进程退出时中断；没有自动重放。远程作业按独立工作流核对。'},this.now());
  }
  scan():Promise<void>{if(this.stopped)return Promise.resolve();this.current??=this.consume().finally(()=>{this.current=undefined;});return this.current;}
  private async consume():Promise<void>{
    const rows=await this.store.all(`SELECT r.*,t.account_id,t.sender_id,t.state AS task_state,t.revision AS current_revision,o.source_key
      FROM runs r JOIN tasks t ON t.id=r.task_id JOIN occurrences o ON o.id=r.occurrence_id WHERE r.state='queued' ORDER BY r.start_deadline,r.id LIMIT 1`);
    for(const run of rows){
      const owner={accountId:String(run.account_id),senderId:String(run.sender_id)};
      let blocked=!await this.authorize(owner)||run.current_revision!==run.revision||run.task_state==='deleted'
        ||run.task_state==='paused'&&!String(run.source_key).startsWith('manual:');
      if(blocked||this.now()>Number(run.start_deadline)){
        await finishRun(this.store,run,owner,{state:blocked?'blocked':'missed',text:blocked?'任务授权、修订或状态已变化。':'超过本次启动宽限。'},this.now());continue;
      }
      const changed=await this.store.transaction([{sql:"UPDATE runs SET state='running',started_at=? WHERE id=? AND state='queued'",params:[this.now(),run.id]}]);
      if(!changed[0].changes)continue;
      const controller=new AbortController();this.active.set(String(run.id),controller);
      const definition=JSON.parse(String(run.snapshot)) as TaskDefinition;
      const timer=setTimeout(()=>controller.abort(new Error('Control run timed out')),(definition.agent?.timeoutSeconds??900)*1000);
      try{
        const result=await this.handle(run,definition,owner,controller.signal);
        if(controller.signal.aborted)throw controller.signal.reason;
        if(!await this.authorize(owner))result.state='blocked';
        await finishRun(this.store,run,owner,result,this.now());
      }catch(error){
        await finishRun(this.store,run,owner,{state:controller.signal.aborted?'cancelled':'failed',text:controller.signal.aborted?'本轮已停止；远程实验和资源保留状态须单独查询。':'执行未完成。请查看运行诊断；没有自动重放外部操作。',data:{diagnostic:error instanceof Error?error.message.slice(0,400):'execution_failed'}},this.now());
      }finally{clearTimeout(timer);this.active.delete(String(run.id));}
    }
  }
  cancel(id:string):void{this.active.get(id)?.abort(new Error('Run cancelled'));}
  async close():Promise<void>{this.stopped=true;for(const c of this.active.values())c.abort(new Error('Runtime shutting down'));await this.current;}
}
