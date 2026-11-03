import { z } from 'zod';
import type { AutomationRuntime } from './runtime.js';
import type { Owner, Task, TaskInput } from './tasks.js';

const help=['定时任务：',
  '/tasks add 30m 检查实验结果', '/tasks daily 09:00 查看今天计划',
  '/tasks weekly 1,5 18:00 整理周报', '/tasks every 30m 检查结果',
  '/tasks at 2026-12-01T09:00:00+08:00 提醒内容',
  '/tasks show|pause|resume|delete|run <任务ID>',
  '/tasks edit <任务ID> <完整任务JSON>',
  '/tasks notifications', '/tasks resend <通知ID> [unknown|accepted]',
  '目前支持提醒；科研/模型执行尚未启用。时间默认 Asia/Shanghai。'].join('\n');

function describe(task:Task):string{
  const next=task.nextDue===null?'无':new Intl.DateTimeFormat('zh-CN',{timeZone:task.definition.schedule.timezone,dateStyle:'short',timeStyle:'short'}).format(task.nextDue);
  return `${task.definition.title}\nID: ${task.id}\n状态: ${task.state} · 修订 ${task.revision}\n内容: ${task.definition.prompt}\n计划: ${JSON.stringify(task.definition.schedule)}\n下次: ${next} (${task.definition.schedule.timezone})`;
}
function seconds(value:string):number{
  const m=/^(\d+)(s|m|h|d)$/.exec(value);if(!m)throw new Error('时长格式示例：30m、2h、1d');
  const result=Number(m[1])*({s:1,m:60,h:3600,d:86400}[m[2]]!);
  if(!Number.isSafeInteger(result)||result<=0||result>31_536_000)throw new Error('时长超出范围');return result;
}

export async function handleWeixinAutomation(runtime:AutomationRuntime|undefined,owner:Owner,message:{id:string;text:string;attachments?:unknown[]},now=Date.now()):Promise<string|undefined>{
  const text=message.text.trim();
  const natural=/^(?:请)?(\d+)(分钟|小时|天)后提醒我[，,:：\s]*(.+)$/s.exec(text);
  const daily=/^(?:请)?每天\s*((?:[01]?\d|2[0-3]):[0-5]\d)\s*提醒我[，,:：\s]*(.+)$/s.exec(text);
  const isCommand=/^\/tasks(?:\s|$)/.test(text);
  if(!isCommand&&!natural&&!daily){runtime?.wake(owner);return undefined;}
  if(!runtime)return '定时任务预览尚未启用。请在本机服务设置 CODEX_WEIXIN_AUTOMATION=1 后重启。';
  runtime.wake(owner);
  if(message.attachments?.length)return '任务创建暂不接收附件，请用明确的文字内容。';
  try{
    const match=/^\/tasks(?:\s+(\S+))?(?:\s+([\s\S]*))?$/.exec(text);
    let action=match?.[1]??'list',args=match?.[2]??'';
    if(natural){action='add';args=`${natural[1]}${natural[2]==='分钟'?'m':natural[2]==='小时'?'h':'d'} ${natural[3]}`;}
    if(daily){action='daily';args=`${daily[1].padStart(5,'0')} ${daily[2]}`;}
    if(action==='help')return help;
    if(action==='list'){
      const tasks=await runtime.tasks.list(owner);return tasks.filter(t=>t.state!=='deleted').map(describe).join('\n\n')||`还没有任务。\n${help}`;
    }
    if(action==='notifications'){
      await runtime.tasks.list(owner);
      const rows=await runtime.store.all('SELECT id,state,content FROM notifications WHERE account_id=? AND sender_id=? ORDER BY updated_at DESC LIMIT 10',[owner.accountId,owner.senderId]);
      return rows.map(n=>`${n.id} · ${n.state}\n${String(n.content).slice(0,200)}`).join('\n\n')||'暂无通知。API 接受不等于手机已收到。';
    }
    const [id,...rest]=args.split(/\s+/);
    if(action==='resend'){
      if(!runtime.delivery)throw new Error('微信投递通道未配置');
      await runtime.delivery.retry(owner,id,{includeUnknown:rest[0]==='unknown',resendAccepted:rest[0]==='accepted'},message.id);
      runtime.wake(owner);return '通知已进入重发队列；不会重跑任务。未知/已接受消息重发可能重复。';
    }
    if(['show','pause','resume','delete','run','edit'].includes(action)){
      if(!id)throw new Error('请提供完整任务 ID');
      const task=await runtime.tasks.get(owner,id);
      if(action==='show')return describe(task);
      if(action==='run'){
        const run=await runtime.tasks.runNow(owner,id,message.id);runtime.wake(owner);return `本次运行已保存：${run.id}。原计划保持不变。`;
      }
      if(action==='edit')return describe(await runtime.tasks.update(owner,id,undefined,JSON.parse(args.slice(id.length).trim()),message.id));
      return describe(await runtime.tasks.setState(owner,id,action as 'pause'|'resume'|'delete',message.id));
    }
    const timezone='Asia/Shanghai';let definition:TaskInput;
    const prefix={kind:'reminder' as const,title:'微信提醒'};
    if(['add','daily','every','at'].includes(action)){
      const split=/^(\S+)\s+([\s\S]+)$/.exec(args);if(!split)throw new Error(help);
      const [,value,prompt]=split;
      const schedule=action==='daily'?{kind:'daily' as const,time:value,timezone}:action==='every'
        ?{kind:'interval' as const,everySeconds:seconds(value),anchorUtc:new Date(now+seconds(value)*1000).toISOString(),timezone}
        :{kind:'once' as const,atUtc:action==='add'?new Date(now+seconds(value)*1000).toISOString():
          /(?:Z|[+-]\d{2}:\d{2})$/.test(value)?new Date(value).toISOString():(()=>{throw new Error('指定时刻需要 Z 或 +08:00 等明确时区偏移');})(),timezone};
      definition={...prefix,prompt,schedule};
    }else if(action==='weekly'){
      const split=/^(\S+)\s+(\S+)\s+([\s\S]+)$/.exec(args);if(!split)throw new Error(help);
      definition={...prefix,prompt:split[3],schedule:{kind:'weekly',weekdays:split[1].split(',').map(Number),time:split[2],timezone}};
    }else return help;
    const task=await runtime.tasks.create(owner,`wx:${message.id}`,definition,false,text);
    return `已保存提醒：\n${describe(task)}`;
  }catch(error){
    if(error instanceof z.ZodError)return `任务参数无效：${error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; ')}`;
    return `任务操作未完成：${error instanceof Error?error.message:String(error)}`;
  }
}
