import path from 'node:path';
import { automationCapabilities } from './capabilities.js';
import { AutomationStore } from './store.js';
import { TaskService, type TaskServiceOptions } from './tasks.js';
import { NotificationWorker, type DeliveryPort } from './delivery.js';
import type { Owner } from './tasks.js';
import { GpuObserver } from './gpu-observer.js';
import type { GpuObservationPort } from './gpu.js';
import { ResearchService,type ResearchOptions } from './research.js';

export class AutomationRuntime {
  readonly store: AutomationStore;
  readonly tasks: TaskService;
  readonly delivery?: NotificationWorker;
  readonly gpu?: GpuObserver;
  readonly research:ResearchService;
  private timer?: NodeJS.Timeout;
  private current?: Promise<void>;
  private error?: string;
  private observationError?:string;
  private stopped = false;

  constructor(stateRoot: string, options: TaskServiceOptions & {send?:DeliveryPort;gpu?:GpuObservationPort;research?:ResearchOptions}) {
    const root = path.resolve(stateRoot);
    // Active WAL databases must not live on UNC/network or known sync roots.
    const syncRoots = [process.env.OneDrive, process.env.OneDriveCommercial, process.env.OneDriveConsumer].filter(Boolean) as string[];
    if (/^[\\/]{2}/.test(root) || syncRoots.some(sync => {
      const rel = path.relative(path.resolve(sync), root);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    })) throw new Error('Automation database requires a local, non-synchronized state directory');
    this.store = new AutomationStore(path.join(root,'automation','scheduler.sqlite'));
    this.research=new ResearchService(root,this.store,options.authorize,options.research??{},options.now);
    this.tasks = new TaskService(this.store,{...options,supportsKind:this.research.supports,validateTask:(def,owner)=>this.research.validate(def,owner),validateGpuWatch:options.gpu?async watch=>{
      const target=(await options.gpu!.targets()).find(t=>t.server===watch.server);
      if(!target||target.bindingHash!==watch.bindingHash)throw new Error('GPU target binding unavailable or changed');
    }:undefined});
    if(options.send)this.delivery=new NotificationWorker(this.store,options.authorize,options.send,options.now);
    if(options.gpu)this.gpu=new GpuObserver(this.store,options.gpu,options.authorize,options.now);
  }

  status() {
    const capabilities=automationCapabilities(),research=this.research.status();
    if(research.analysis.configured)capabilities.agent={ready:true,reason:'Text-only transport configured; each execution still validates its context and response'};
    if(research.remote.configured){capabilities.remote={ready:true,reason:'MCP helper transport configured; target and recipe require live preflight'};capabilities.gpuReserve={ready:true,reason:'Bounded lease implementation configured; policy and live allocation evidence required per run'};}
    return { enabled:true, running:Boolean(this.timer), error:this.error, capabilities,research,
      delivery:{ready:Boolean(this.delivery),reason:this.delivery?undefined:'WeChat delivery port is not configured'},
      gpuObservation:{configured:Boolean(this.gpu),error:this.observationError,reason:this.gpu?'Read-only MCP collector; no job submission or GPU reservation':'Authorized read-only MCP collector is not configured'} };
  }

  async start(): Promise<void> {
    if (this.timer) return;
    if (this.stopped) throw new Error('Automation runtime is closed');
    await this.store.all('SELECT 1');
    await this.research.start();
    await this.scan();
    this.timer=setInterval(()=>{ void this.scan(); },5_000);
    this.timer.unref();
  }

  scan(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.current ??= this.tasks.tick().then(()=>{
      void this.gpu?.scan().then(()=>{this.observationError=undefined;}).catch(()=>{this.observationError='GPU observation scan failed';});
      this.research.scan();
      return this.delivery?.flush();
    }).then(()=>{this.error=undefined;}).catch(error=>{
      this.error=error instanceof Error ? error.message : String(error);
    }).finally(()=>{this.current=undefined;});
    return this.current;
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped=true;
    clearInterval(this.timer); this.timer=undefined;
    await this.current;
    try{
      await this.research.close();
      await this.gpu?.close();
      await this.delivery?.drain();
    }finally{await this.store.close();}
  }

  wake(owner:Owner):void{
    if(!this.stopped)void this.delivery?.wake(owner).catch(error=>{this.error=String(error);});
  }
}
