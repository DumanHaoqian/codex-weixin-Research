import crypto from 'node:crypto';
import { z } from 'zod';

const id=z.string().uuid(), digest=z.string().regex(/^[a-f0-9]{64}$/);
export const remoteTargetSchema=z.object({server:z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).refine(v=>v!=='gateway','gateway is deferred'),bindingHash:digest}).strict();
const absolutePosix=z.string().max(1000).refine(v=>v.startsWith('/')&&!v.includes('\0')&&!v.split('/').includes('..'),'Expected an absolute POSIX path');
const relativeFile=z.string().min(1).max(500).refine(v=>!v.startsWith('/')&&!v.includes('\\')&&!v.includes('\0')&&!v.split('/').some(p=>p==='..'||p==='.'||p===''),'Expected a file relative to the recipe root');
export const recipeSchema=z.object({root:absolutePosix,executable:absolutePosix,args:z.array(z.string().max(4000).refine(v=>!v.includes('\0'))).max(100),
  codeVersion:z.string().min(1).max(200),envRef:z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).default('default')}).strict();
export const validationSchema=z.object({metricsFile:relativeFile.default('metrics.json'),requiredFiles:z.array(relativeFile).max(20).default([])}).strict();
export const workflowSchema=z.object({target:remoteTargetSchema,recipe:recipeSchema,
  mode:z.enum(['immediate','launch_when_ready','reserve_then_handoff']),
  grant:z.object({submit:z.literal(true),stop:z.boolean().default(false),reserve:z.boolean().default(false),maxSubmissions:z.number().int().min(1).max(5).default(1)}).strict(),
  resource:z.object({gpuCount:z.number().int().min(0).max(8).default(0),gpuUuids:z.array(z.string().regex(/^GPU-[a-zA-Z0-9-]+$/)).max(64).default([]),
    minFreeBytes:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),maxUsedBytes:z.number().int().nonnegative().default(64*1024**2),
    holderBytes:z.number().int().nonnegative().default(0),holdSeconds:z.number().int().min(15).max(86400).default(1800),
    stableSamples:z.number().int().min(1).max(20).default(2),waitDeadlineUtc:z.string().datetime(),handoff:z.enum(['manual','automatic']).default('manual')}).strict(),
  validation:validationSchema.default({metricsFile:'metrics.json',requiredFiles:[]}),monitorSeconds:z.number().int().min(5).max(86400).default(900),
  maxRuntimeSeconds:z.number().int().min(1).max(30*86400).optional(),retryCount:z.number().int().min(0).max(4).default(0),
  logStallSeconds:z.number().int().min(5).max(30*86400).optional(),logAlerts:z.array(z.enum(['oom','nan'])).max(2).default([])
}).strict().superRefine((v,c)=>{
  if(v.retryCount+1>v.grant.maxSubmissions)c.addIssue({code:'custom',message:'Retry count exceeds submission grant'});
  if(v.mode!=='immediate'&&v.resource.gpuCount===0)c.addIssue({code:'custom',message:'Resource waiting requires a GPU count'});
  if(v.mode==='reserve_then_handoff'&&(!v.grant.reserve||v.resource.holderBytes<=0))c.addIssue({code:'custom',message:'Reservation requires an explicit grant and positive holder bytes'});
});
export const jobMonitorSchema=z.object({target:remoteTargetSchema,jobId:id,monitorSeconds:z.number().int().min(5).max(86400).default(900),durationSeconds:z.number().int().min(15).max(30*86400).default(7*86400),logStallSeconds:z.number().int().min(5).max(30*86400).optional(),logAlerts:z.array(z.enum(['oom','nan'])).max(2).default([])}).strict();
export const agentSchema=z.object({profile:z.enum(['render_report','analyze_evidence','parse_task','screen_literature']).default('render_report'),
  projectBindingHash:digest.optional(),
  remoteTarget:remoteTargetSchema.optional(),
  model:z.string().min(1).max(100).optional(),effort:z.enum(['low','medium','high','xhigh']).optional(),timeoutSeconds:z.number().int().min(5).max(900).default(900),
  files:z.array(relativeFile).max(10).default([])}).strict();
export const literatureSchema=z.object({query:z.string().trim().min(2).max(500),sources:z.array(z.enum(['crossref','arxiv'])).min(1).max(2),
  lookbackDays:z.number().int().min(1).max(365).default(14),pageBudget:z.number().int().min(1).max(10).default(3),itemsPerPage:z.number().int().min(1).max(100).default(20)}).strict();
export const comparisonSchema=z.object({jobIds:z.array(id).min(2).max(20).refine(v=>new Set(v).size===v.length,'Select distinct jobs'),baselineId:id}).strict().refine(v=>v.jobIds.includes(v.baselineId),'Baseline must be one of the selected jobs');
export type WorkflowSpec=z.infer<typeof workflowSchema>;
export type Target=z.infer<typeof remoteTargetSchema>;
export type Recipe=z.infer<typeof recipeSchema>;
export type RemoteAction='preflight'|'submit'|'inspect'|'reserve'|'release'|'handoff'|'stop'|'reconcile'|'read';
export type RemoteRequest={version:1;action:RemoteAction;operationId:string;ownerScope:string;target:Target;payload:Record<string,unknown>;payloadHash:string};
export const receiptSchema=z.object({version:z.literal(1),operationId:id,payloadHash:digest,ownerScope:digest,serverId:z.string().min(1),bootId:z.string().min(1),uid:z.number().int(),remoteNow:z.number(),
  state:z.enum(['ready','not_found','accepted','running','exited','held','handed_off','released','expired','failed','unknown','needs_review']),
  objectId:id.optional(),payload:z.record(z.string(),z.unknown()).default({})}).strict();
export type RemoteReceipt=z.infer<typeof receiptSchema>;
export interface ResearchRemotePort{invoke(request:RemoteRequest):Promise<RemoteReceipt>;targets?():Promise<Array<Target&{host:string;port:number;user:string}>>;close():Promise<void>}
export function canonical(value:unknown):string{
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
  return JSON.stringify(value);
}
export function hash(value:unknown):string{return crypto.createHash('sha256').update(canonical(value)).digest('hex');}
