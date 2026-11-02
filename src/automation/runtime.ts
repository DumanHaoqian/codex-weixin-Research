import path from 'node:path';
import { automationCapabilities } from './capabilities.js';
import { AutomationStore } from './store.js';
import { TaskService, type TaskServiceOptions } from './tasks.js';
import { NotificationWorker, type DeliveryPort } from './delivery.js';
import type { Owner } from './tasks.js';

export class AutomationRuntime {
  readonly store: AutomationStore;
  readonly tasks: TaskService;
  readonly delivery?: NotificationWorker;
  private timer?: NodeJS.Timeout;
  private current?: Promise<void>;
  private error?: string;
  private stopped = false;

  constructor(stateRoot: string, options: TaskServiceOptions & {send?:DeliveryPort}) {
    const root = path.resolve(stateRoot);
    // Active WAL databases must not live on UNC/network or known sync roots.
    const syncRoots = [process.env.OneDrive, process.env.OneDriveCommercial, process.env.OneDriveConsumer].filter(Boolean) as string[];
    if (/^[\\/]{2}/.test(root) || syncRoots.some(sync => {
      const rel = path.relative(path.resolve(sync), root);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    })) throw new Error('Automation database requires a local, non-synchronized state directory');
    this.store = new AutomationStore(path.join(root,'automation','scheduler.sqlite'));
    this.tasks = new TaskService(this.store,options);
    if(options.send)this.delivery=new NotificationWorker(this.store,options.authorize,options.send,options.now);
  }

  status() {
    return { enabled:true, running:Boolean(this.timer), error:this.error, capabilities:automationCapabilities(),
      delivery:{ready:Boolean(this.delivery),reason:this.delivery?undefined:'WeChat delivery port is not configured'} };
  }

  async start(): Promise<void> {
    if (this.timer) return;
    if (this.stopped) throw new Error('Automation runtime is closed');
    await this.store.all('SELECT 1');
    await this.scan();
    this.timer=setInterval(()=>{ void this.scan(); },15_000);
    this.timer.unref();
  }

  scan(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.current ??= this.tasks.tick().then(()=>this.delivery?.flush()).then(()=>{this.error=undefined;}).catch(error=>{
      this.error=error instanceof Error ? error.message : String(error);
    }).finally(()=>{this.current=undefined;});
    return this.current;
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped=true;
    clearInterval(this.timer); this.timer=undefined;
    await this.current;
    await this.delivery?.drain();
    await this.store.close();
  }

  wake(owner:Owner):void{
    if(!this.stopped)void this.delivery?.wake(owner).catch(error=>{this.error=String(error);});
  }
}
