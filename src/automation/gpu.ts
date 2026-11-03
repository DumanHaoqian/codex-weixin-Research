import crypto from 'node:crypto';
import { z } from 'zod';

export const gpuWatchSchema = z.object({
  server: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  bindingHash: z.string().regex(/^[a-f0-9]{64}$/),
  gpuUuids: z.array(z.string().regex(/^GPU-[a-zA-Z0-9-]+$/)).max(64).default([]),
  minFreeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  maxUsedBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(64*1024*1024),
  maxUtilization: z.number().int().min(0).max(100).default(0),
  stableSamples: z.number().int().min(1).max(20).default(2),
  sampleSeconds: z.number().int().min(5).max(3600).default(15),
  durationSeconds: z.number().int().min(15).max(7*86400).default(3600)
}).strict();
export type GpuWatch = z.infer<typeof gpuWatchSchema>;
export type GpuTarget = { server: string; host: string; port: number; user: string; bindingHash: string };
export type GpuDevice = { uuid: string; index: number; name: string; totalBytes: number; usedBytes: number;
  utilization: number; temperature: number; processes: Array<{pid:number;usedBytes:number|null}> };
export type GpuSnapshot = { server: string; bindingHash: string; startedAt: number; observedAt: number; devices: GpuDevice[] };
export const gpuSnapshotSchema=z.object({server:z.string(),bindingHash:z.string().regex(/^[a-f0-9]{64}$/),startedAt:z.number().int(),observedAt:z.number().int(),
  devices:z.array(z.object({uuid:z.string().regex(/^GPU-[a-zA-Z0-9-]+$/),index:z.number().int().nonnegative(),name:z.string().max(300),
    totalBytes:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),usedBytes:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    utilization:z.number().min(0).max(100),temperature:z.number().min(0).max(150),
    processes:z.array(z.object({pid:z.number().int().positive(),usedBytes:z.number().int().nonnegative().nullable()})).max(4096)})).min(1).max(64)
}).superRefine((s,c)=>{
  if(new Set(s.devices.map(d=>d.uuid)).size!==s.devices.length||s.devices.some(d=>d.usedBytes>d.totalBytes))c.addIssue({code:'custom',message:'Invalid GPU inventory'});
});
export interface GpuObservationPort {
  targets(): Promise<GpuTarget[]>;
  sample(server: string, bindingHash: string): Promise<GpuSnapshot>;
  close(): Promise<void>;
}

export const GPU_QUERY = 'nvidia-smi --query-gpu=uuid,index,name,memory.total,memory.used,utilization.gpu,temperature.gpu --format=csv,noheader,nounits';
export const GPU_PROCESS_QUERY = 'nvidia-smi --query-compute-apps=gpu_uuid,pid,used_gpu_memory --format=csv,noheader,nounits';
export type ObservationToolCall = (tool:'servers_list'|'ssh_exec', args:Record<string,unknown>)=>Promise<unknown>;

function toolText(value:unknown):string {
  const result=z.object({isError:z.boolean().optional(),content:z.array(z.object({type:z.string(),text:z.string().optional()}).passthrough()).max(50)}).passthrough().parse(value);
  if(result.isError)throw new Error('MCP observation rejected or unavailable');
  const text=result.content.filter(c=>c.type==='text').map(c=>c.text??'').join('\n');
  if(Buffer.byteLength(text)>1024*1024)throw new Error('Observation response exceeds byte budget');
  return text;
}
function commandOutput(result:unknown,target:GpuTarget):string {
  const parsed=z.object({stdout:z.string(),exitCode:z.number().nullable(),timedOut:z.boolean().optional(),
    server:z.string(),host:z.string(),port:z.number(),user:z.string()}).passthrough().parse(JSON.parse(toolText(result)));
  if(parsed.exitCode!==0||parsed.timedOut)throw new Error('GPU command unavailable');
  if(parsed.server!==target.server||parsed.host!==target.host||parsed.port!==target.port||parsed.user!==target.user)
    throw new Error('GPU response target binding changed');
  return parsed.stdout;
}
// nvidia-smi emits CSV quoting for names containing commas. Invalid/N/A numeric
// readings fail this sample instead of becoming zeros or invented free capacity.
function csv(text:string):string[][] {
  return text.trim().split(/\r?\n/).filter(Boolean).map(line=>{
    const fields:string[]=[];let field='',quoted=false;
    for(let i=0;i<line.length;i++){
      const c=line[i];
      if(c==='"'){if(quoted&&line[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}
      else if(c===','&&!quoted){fields.push(field.trim());field='';}else field+=c;
    }
    if(quoted)throw new Error('Invalid GPU CSV');fields.push(field.trim());return fields;
  });
}
function number(value:string,min=0,max=Number.MAX_SAFE_INTEGER):number {
  if(!/^\d+(?:\.\d+)?$/.test(value))throw new Error('GPU metric unavailable');
  const n=Number(value);if(!Number.isFinite(n)||n<min||n>max)throw new Error('Invalid GPU metric');return n;
}
export function parseGpuSnapshot(gpus:string,processes:string,identity:Omit<GpuSnapshot,'devices'>):GpuSnapshot {
  const devices:GpuDevice[]=csv(gpus).map(fields=>{
    if(fields.length!==7||!/^GPU-[a-zA-Z0-9-]+$/.test(fields[0]))throw new Error('Invalid GPU identity');
    const [uuid,index,name,total,used,utilization,temperature]=fields;
    const totalBytes=Math.round(number(total)*1024*1024),usedBytes=Math.round(number(used)*1024*1024);
    if(usedBytes>totalBytes)throw new Error('Invalid GPU memory');
    return {uuid,index:number(index,0,1024),name,totalBytes,usedBytes,utilization:number(utilization,0,100),temperature:number(temperature,0,150),processes:[]};
  });
  if(!devices.length||devices.length>64||new Set(devices.map(d=>d.uuid)).size!==devices.length)throw new Error('GPU inventory unavailable or duplicated');
  for(const fields of csv(processes)){
    if(fields.length!==3)throw new Error('Invalid GPU process CSV');
    const device=devices.find(d=>d.uuid===fields[0]);if(!device)throw new Error('GPU process inventory changed during sample');
    device.processes.push({pid:number(fields[1],1),usedBytes:/^(?:\[N\/A\]|N\/A|\[Not Supported\])$/i.test(fields[2])?null:Math.round(number(fields[2])*1024*1024)});
  }
  return gpuSnapshotSchema.parse({...identity,devices});
}

// Only these two fixed read-only commands can cross this broker. Neither model
// output nor an HTTP prompt is ever used as a remote shell command.
export class McpGpuObservationPort implements GpuObservationPort {
  private readonly allowed:Set<string>;
  constructor(private call:ObservationToolCall,servers:string[],private shutdown:()=>Promise<void>=async()=>{},private now=Date.now){
    this.allowed=new Set(servers);
    if(!servers.length||servers.some(s=>s==='gateway'||!/^[a-zA-Z0-9_-]{1,64}$/.test(s)))throw new Error('GPU observation requires explicit canonical servers; gateway is deferred');
  }
  async targets():Promise<GpuTarget[]>{
    const registry=z.array(z.object({name:z.string(),host:z.string(),port:z.number().int().min(1).max(65535).default(22),username:z.string().optional(),user:z.string().optional(),enabled:z.boolean().optional()}).passthrough()).max(100).parse(JSON.parse(toolText(await this.call('servers_list',{}))));
    return registry.filter(s=>this.allowed.has(s.name)&&s.enabled!==false).map(s=>{
      const user=s.username??s.user;if(!user)throw new Error('Server login binding unavailable');
      const binding={server:s.name,host:s.host,port:s.port,user};
      return {...binding,bindingHash:crypto.createHash('sha256').update(JSON.stringify(binding)).digest('hex')};
    });
  }
  async sample(server:string,bindingHash:string):Promise<GpuSnapshot>{
    if(!this.allowed.has(server))throw new Error('Server outside observation grant');
    const target=(await this.targets()).find(t=>t.server===server);
    if(!target||target.bindingHash!==bindingHash)throw new Error('Server binding changed; observation blocked');
    const startedAt=this.now();
    const gpu=commandOutput(await this.call('ssh_exec',{server,command:GPU_QUERY,timeout_seconds:15}),target);
    const processes=commandOutput(await this.call('ssh_exec',{server,command:GPU_PROCESS_QUERY,timeout_seconds:15}),target);
    return parseGpuSnapshot(gpu,processes,{server,bindingHash,startedAt,observedAt:this.now()});
  }
  close(){return this.shutdown();}
}

export function eligibleGpuUuids(snapshot:GpuSnapshot,watch:GpuWatch):string[]{
  return snapshot.devices.filter(g=>(!watch.gpuUuids.length||watch.gpuUuids.includes(g.uuid))
    &&g.totalBytes-g.usedBytes>=watch.minFreeBytes&&g.usedBytes<=watch.maxUsedBytes
    &&g.utilization<=watch.maxUtilization&&g.processes.length===0).map(g=>g.uuid).sort();
}
