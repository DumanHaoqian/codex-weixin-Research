import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { AutomationStore } from './store.js';

export const metricsSchema=z.object({schemaVersion:z.literal(1),jobId:z.string().uuid(),dataset:z.string().min(1),split:z.string().min(1),codeVersion:z.string().min(1),
  seed:z.number().int().optional(),evaluationProtocol:z.string().min(1),metrics:z.record(z.string(),z.object({value:z.number().finite(),unit:z.string(),direction:z.enum(['min','max']),definition:z.string().min(1)}).strict())}).strict();
export type Metrics=z.infer<typeof metricsSchema>;
export function compareMetrics(baseline:{id:string;metrics:Metrics},experiments:Array<{id:string;metrics:Metrics}>){
  const rows=experiments.flatMap(experiment=>Object.entries(baseline.metrics.metrics).map(([name,base])=>{
    const current=experiment.metrics.metrics[name];
    const reasons:string[]=[];
    for(const key of ['dataset','split','evaluationProtocol'] as const)if(baseline.metrics[key]!==experiment.metrics[key])reasons.push(`${key} differs`);
    if(!current)reasons.push('metric missing');
    else for(const key of ['unit','direction','definition'] as const)if(base[key]!==current[key])reasons.push(`${key} differs`);
    return {baselineId:baseline.id,experimentId:experiment.id,metric:name,baseline:base.value,value:current?.value??null,
      comparable:reasons.length===0,delta:reasons.length?null:current.value-base.value,
      improvement:reasons.length?null:(base.direction==='max'?1:-1)*(current.value-base.value),unit:base.unit,reasons,
      limitation:'Descriptive comparison only; no statistical significance is established by a single run.'};
  }));
  return {schemaVersion:1,rows,missingFromBaseline:experiments.map(e=>({id:e.id,metrics:Object.keys(e.metrics.metrics).filter(key=>!baseline.metrics.metrics[key])})),
    provenance:[baseline,...experiments].map(e=>({id:e.id,dataset:e.metrics.dataset,split:e.metrics.split,codeVersion:e.metrics.codeVersion,seed:e.metrics.seed,evaluationProtocol:e.metrics.evaluationProtocol}))};
}

export class ArtifactService{
  private root:string;
  constructor(stateRoot:string,private store:AutomationStore){this.root=path.join(stateRoot,'automation','artifacts');}
  async write(taskId:string,runId:string,name:string,value:unknown,now:number){
    if(!/^[a-zA-Z0-9_.-]{1,120}$/.test(name))throw new Error('Invalid artifact name');
    const id=crypto.randomUUID(),relative=path.join(runId,id+'-'+name),file=path.join(this.root,relative);
    const bytes=Buffer.from(typeof value==='string'?value:JSON.stringify(value,null,2));if(bytes.length>1024*1024)throw new Error('Artifact exceeds byte budget');
    await fs.mkdir(path.dirname(file),{recursive:true});
    const temporary=file+'.tmp';const handle=await fs.open(temporary,'wx',0o600);
    try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
    await fs.rename(temporary,file);
    await this.store.transaction([{sql:'INSERT INTO research_artifacts VALUES (?,?,?,?,?,?,?,?,?)',params:[id,taskId,runId,name,name.endsWith('.json')?'application/json':'text/markdown',crypto.createHash('sha256').update(bytes).digest('hex'),bytes.length,relative,now]}]);
    return {id,name,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),size:bytes.length};
  }
  async read(id:string,accountId:string,senderId:string){
    const row=(await this.store.all('SELECT a.* FROM research_artifacts a JOIN tasks t ON t.id=a.task_id WHERE a.id=? AND t.account_id=? AND t.sender_id=?',[id,accountId,senderId]))[0];
    if(!row)throw new Error('Artifact not found');
    const file=path.resolve(this.root,String(row.relative_path)),relative=path.relative(this.root,file);
    if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Invalid artifact path');
    const realRoot=await fs.realpath(this.root),realFile=await fs.realpath(file),realRelative=path.relative(realRoot,realFile);
    if(realRelative.startsWith('..')||path.isAbsolute(realRelative))throw new Error('Invalid artifact path');
    const stat=await fs.lstat(file);if(stat.isSymbolicLink()||stat.size!==row.size||stat.size>1024*1024)throw new Error('Artifact missing or changed');
    const bytes=await fs.readFile(file);if(crypto.createHash('sha256').update(bytes).digest('hex')!==row.sha256)throw new Error('Artifact changed');
    return {id:row.id,name:row.name,mediaType:row.media_type,sha256:row.sha256,text:bytes.toString('utf8')};
  }
}
