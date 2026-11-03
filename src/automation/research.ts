import type { AutomationStore,Row } from './store.js';
import type { TaskDefinition,Owner } from './tasks.js';
import type { AnalysisPort } from './agent.js';
import { buildAnalysisContext,projectNavigation } from './agent.js';
import { ArtifactService,metricsSchema,compareMetrics } from './results.js';
import { LiteratureService,type LiteratureFetcher } from './literature.js';
import { WorkflowEngine,remoteRequest } from './workflows.js';
import { RunWorker,type RunOutput } from './run-service.js';
import { agentSchema,workflowSchema,literatureSchema,jobMonitorSchema,comparisonSchema,type ResearchRemotePort } from './research-contracts.js';

export type ResearchOptions={analysis?:AnalysisPort;remote?:ResearchRemotePort;literature?:LiteratureFetcher;enableLiterature?:boolean};
export class ResearchService{
  readonly artifacts:ArtifactService;readonly workflows?:WorkflowEngine;readonly worker:RunWorker;readonly literature?:LiteratureService;
  private error?:string;
  constructor(private root:string,private store:AutomationStore,private authorize:(owner:Owner)=>boolean|Promise<boolean>,readonly options:ResearchOptions,private now=Date.now){
    this.artifacts=new ArtifactService(root,store);
    if(options.remote)this.workflows=new WorkflowEngine(store,options.remote,authorize,this.artifacts,now,root);
    if(options.enableLiterature||options.literature)this.literature=new LiteratureService(store,options.literature,now);
    this.worker=new RunWorker(store,authorize,(run,definition,owner,signal)=>this.execute(run,definition,owner,signal),now);
  }
  supports=(kind:TaskDefinition['kind'])=>kind==='agent_report'?Boolean(this.options.analysis):['research_workflow','job_monitor'].includes(kind)?Boolean(this.workflows):kind==='literature_watch'?Boolean(this.literature):kind==='result_compare';
  async validate(def:TaskDefinition,owner:Owner){
    if(def.projectId&&!projectNavigation(this.root).some(p=>p.id===def.projectId))throw new Error('Project binding unavailable');
    if(def.kind==='agent_report'){
      agentSchema.parse(def.agent);
      if(def.projectId){const p=projectNavigation(this.root).find(p=>p.id===def.projectId);if(!p||p.bindingHash!==def.agent?.projectBindingHash)throw new Error('Project binding unavailable or changed');}
    }
    if(def.kind==='research_workflow'){
      const spec=workflowSchema.parse(def.workflow);if(Date.parse(spec.resource.waitDeadlineUtc)<=this.now())throw new Error('Wait deadline is in the past');
      if(def.projectId){const project=projectNavigation(this.root).find(p=>p.id===def.projectId)!;if(project.server!==spec.target.server||project.remotePath!==spec.recipe.root)throw new Error('Recipe does not match the selected project binding');}
      const result=await this.workflows!.preflight(owner,spec.target,spec.resource.gpuCount>0,spec.recipe);
      if(spec.mode==='reserve_then_handoff'&&result.payload.reservation!==true)throw new Error('Remote reservation capability unavailable');
    }
    if(def.kind==='job_monitor')jobMonitorSchema.parse(def.jobMonitor);
    if(def.kind==='literature_watch')literatureSchema.parse(def.literature);
    if(def.kind==='result_compare')comparisonSchema.parse(def.comparison);
  }
  status(){return {analysis:{configured:Boolean(this.options.analysis),profile:'stateless-tools-none'},remote:{configured:Boolean(this.workflows)},literature:{configured:Boolean(this.literature)},comparison:{configured:true},error:this.error};}
  projects(){return projectNavigation(this.root);}
  async start(){await this.worker.recover();}
  scan():void{
    void this.worker.scan().catch(()=>{this.error='Research run worker failed';});
    void this.workflows?.scan().catch(()=>{this.error='Research workflow observation failed';});
  }
  private async execute(run:Row,def:TaskDefinition,owner:Owner,signal:AbortSignal):Promise<RunOutput>{
    const guard=async()=>{signal.throwIfAborted();if(!await this.authorize(owner))throw new Error('Access denied');
      const row=(await this.store.all('SELECT state,revision FROM tasks WHERE id=?',[run.task_id]))[0];if(!row||row.state==='deleted'||row.revision!==run.revision)throw new Error('Task binding or revision changed');};
    await guard();await this.validate(def,owner);await guard();
    if(def.kind==='agent_report'){
      const context=await buildAnalysisContext(this.root,def,this.workflows?async(server,root,files)=>{
        const project=projectNavigation(this.root).find(p=>p.id===def.projectId)!;
        const target=def.agent?.remoteTarget;
        if(!target||target.server!==project.server)throw new Error('Selected remote project requires an explicit server binding');
        return (await this.options.remote!.invoke(remoteRequest('read',target,owner,{root,files}))).payload;
      }:undefined);
      const contextArtifact=await this.artifacts.write(String(run.task_id),String(run.id),'context.json',context,this.now());
      const result=await this.options.analysis!.analyze({runId:String(run.id),prompt:def.prompt,context,profile:def.agent!.profile,model:def.agent!.model,effort:def.agent!.effort},signal);
      await guard();const report=await this.artifacts.write(String(run.task_id),String(run.id),'report.json',result,this.now());
      // Structured report text and fenced memory blocks never enter the task or
      // memory mutation ingress. This is data, even for parse_task profiles.
      return {text:result.text,findings:result.findings,data:{report,contextArtifact,limitations:result.limitations,references:result.references}};
    }
    if(def.kind==='research_workflow'||def.kind==='job_monitor')return this.workflows!.register(run,def,owner);
    if(def.kind==='literature_watch')return this.literature!.run(run,owner,def.literature!,signal,guard);
    if(def.kind==='result_compare'){
      const spec=def.comparison!,experiments=[];
      for(const id of spec.jobIds){const row=(await this.store.all('SELECT o.metrics FROM research_objects o JOIN tasks t ON t.id=o.task_id WHERE o.id=? AND t.account_id=? AND t.sender_id=?',[id,owner.accountId,owner.senderId]))[0];
        if(!row?.metrics)throw new Error('Selected result is missing or not owned');experiments.push({id,metrics:metricsSchema.parse(JSON.parse(String(row.metrics)))});}
      const baseline=experiments.find(e=>e.id===spec.baselineId)!;const comparison=compareMetrics(baseline,experiments.filter(e=>e.id!==baseline.id));
      const artifact=await this.artifacts.write(String(run.task_id),String(run.id),'comparison.json',comparison,this.now());
      const text=['| 实验 | 指标 | baseline | 值 | 差值 | 可比性 |','|---|---|---:|---:|---:|---|',...comparison.rows.map(r=>`| ${r.experimentId} | ${r.metric} | ${r.baseline} | ${r.value??'缺失'} | ${r.delta??'—'} | ${r.comparable?'可比':r.reasons.join(', ')} |`),'','仅作描述性比较，不据单次结果声称统计显著。'].join('\n');
      await this.artifacts.write(String(run.task_id),String(run.id),'comparison.md',text,this.now());return {text,findings:true,data:{artifact,comparison}};
    }
    throw new Error('Unsupported research task');
  }
  async close(){await this.worker.close();await this.workflows?.close();await this.options.analysis?.close();}
}
