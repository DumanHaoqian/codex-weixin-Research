'use strict';
const $=id=>document.getElementById(id);
const state={token:'',accounts:[],allowlist:[],tasks:[],edit:null,busy:false,enabled:false,generation:0,keys:new Map(),intervalAnchor:null};
state.targets=[];state.targetsLoaded=false;
const pages={};
function resetPages(){for(const name of ['tasks','runs','notifications'])pages[name]={cursor:null,next:null,back:[]};}
resetPages();
function pagination(){
  for(const [name,page] of Object.entries(pages)){
    const previous=button('上一页',async()=>{page.cursor=page.back.pop()??null;await refresh();});
    const next=button('下一页',async()=>{page.back.push(page.cursor);page.cursor=page.next;await refresh();});
    previous.disabled=state.busy||!page.back.length;next.disabled=state.busy||!page.next;
    $(`${name}-pages`).replaceChildren(previous,el('span',`第 ${page.back.length+1} 页`,'muted'),next);
  }
}
const labels={active:'计划已启用',paused:'计划已暂停',completed:'计划已耗尽',draft:'草稿',deleted:'已删除',
  watching:'监控中',stopped:'监控已停止',expired:'监控已到期',skipped:'已有监控，跳过重复启动',succeeded:'执行成功',blocked:'受阻',missed:'漏跑',pending:'待投递',failed:'已拒绝/失败',unknown:'结果未知',cancelled:'已取消',api_accepted:'API 已接受 · 送达未确认'};
function el(tag,text,cls){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;}
function message(text,error=false){$('message').textContent=text;$('message').className=error?'error':'';}
function scope(){return new URLSearchParams({accountId:$('account').value,senderId:$('sender').value}).toString();}
async function request(path,method='GET',body,ownerScope=scope()){
  const payload=body===undefined?undefined:JSON.stringify(body);
  const fingerprint=JSON.stringify([ownerScope,path,method,payload]);
  const key=state.keys.get(fingerprint)||crypto.randomUUID();
  if(method!=='GET')state.keys.set(fingerprint,key);
  const response=await fetch(`/api/automation${path}${ownerScope?'?'+ownerScope:''}`,{method,credentials:'same-origin',
    headers:{'Content-Type':'application/json','X-Codex-Weixin-Token':state.token,'Idempotency-Key':key},body:payload});
  if(response.status===401){location.assign('/');throw new Error('请先登录');}
  const value=await response.json();
  if(!response.ok)throw new Error(value.error||`请求失败 ${response.status}`);
  if(method!=='GET')state.keys.delete(fingerprint);
  return value;
}
async function action(fn){
  if(state.busy)return;state.busy=true;
  for(const control of document.querySelectorAll('button,select,input,textarea'))control.disabled=true;
  try{await fn();}catch(error){message(String(error.message||error),true);}
  finally{state.busy=false;for(const control of document.querySelectorAll('button,select,input,textarea'))control.disabled=false;syncFields();}
}
function format(at,zone='Asia/Shanghai'){
  if(at===null||at===undefined)return '—';
  try{return new Intl.DateTimeFormat('zh-CN',{timeZone:zone,dateStyle:'short',timeStyle:'short'}).format(new Date(at));}catch{return String(at);}
}
function syncFields(){
  const kind=$('schedule').value;
  const gpu=$('task-kind').value==='gpu_watch';$('gpu-fields').hidden=!gpu;
  $('once-field').hidden=kind!=='once';$('at').required=kind==='once';
  $('time-field').hidden=!['daily','weekly'].includes(kind);$('week-field').hidden=kind!=='weekly';$('interval-field').hidden=kind!=='interval';
  $('save').disabled=!state.enabled||!$('sender').value||(gpu&&!$('gpu-server').value);
  $('preview').disabled=!state.enabled||!$('sender').value;
  pagination();
}
function reset(){
  state.edit=null;state.intervalAnchor=null;$('task-form').reset();$('form-title').textContent='新建任务';$('save').textContent='保存任务';$('preview-times').textContent='';syncFields();
}
function chooseSenders(){
  resetPages();
  const prior=$('sender').value;
  const account=state.accounts.find(a=>a.accountId===$('account').value);
  const senders=[...new Set([...(account?.pairedSenderIds||[]),...state.allowlist])];
  $('sender').replaceChildren(...senders.map(s=>new Option(s,s)));
  if(senders.includes(prior))$('sender').value=prior;
  reset();
}
async function bootstrap(){
  state.targetsLoaded=false;
  const response=await fetch('/api/bootstrap',{credentials:'same-origin'});
  if(response.status===401){location.assign('/');return;}
  if(!response.ok)throw new Error('无法读取账号配置');
  const value=await response.json();state.token=value.requestToken;state.accounts=value.accounts.filter(a=>a.enabled);state.allowlist=value.config.allowedSenderIds||[];
  const previous=$('account').value;
  $('account').replaceChildren(...state.accounts.map(a=>new Option(a.displayName||a.accountId,a.accountId)));
  if(state.accounts.some(a=>a.accountId===previous))$('account').value=previous;
  chooseSenders();
}
function button(label,fn){const b=el('button',label);b.type='button';b.addEventListener('click',()=>action(fn));return b;}
function edit(task){
  if(!['reminder','gpu_watch'].includes(task.definition.kind)){message('此任务类型尚未开放编辑。',true);return;}
  state.edit=task;$('form-title').textContent='编辑任务';$('save').textContent='保存修改';$('task-kind').value=task.definition.kind;
  const g=task.definition.gpuWatch;
  if(g){$('gpu-server').value=g.server;$('gpu-duration').value=g.durationSeconds/60;$('gpu-period').value=g.sampleSeconds;$('gpu-free').value=g.minFreeBytes/1024**3;$('gpu-used').value=g.maxUsedBytes/1024**2;$('gpu-stable').value=g.stableSamples;}
  $('title').value=task.definition.title;$('prompt').value=task.definition.prompt;
  const s=task.definition.schedule;$('schedule').value=s.kind;$('timezone').value=s.timezone;$('notification').value=task.definition.notification;
  if(s.time)$('time').value=s.time;
  if(s.kind==='once'){
    // Use the saved IANA timezone, not the browser OS timezone.
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:s.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(s.atUtc)).map(p=>[p.type,p.value]));
    $('at').value=`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  }
  if(s.kind==='interval')$('interval').value=s.everySeconds/60;
  for(const checkbox of document.querySelectorAll('[name=weekday]'))checkbox.checked=(s.weekdays||[]).includes(Number(checkbox.value));
  $('preview-times').textContent='';syncFields();$('title').focus();
}
function renderWatches(watches){
  $('gpu-watches').replaceChildren();
  for(const watch of watches){
    const record=el('article',undefined,'record');
    record.append(el('span',labels[watch.state]||watch.state,'badge'),el('p',`任务：${watch.task_id} · 截止：${format(watch.deadline)}`,'muted'));
    try{
      const payload=JSON.parse(watch.payload||'{}');
      const fresh=watch.state==='watching'&&watch.validity==='valid'&&Date.now()<=watch.valid_until;
      const availability={candidate_observed:'观测到满足条件的候选卡',stabilizing:'等待连续确认',busy:'有占用或不满足条件',unavailable:'无法观测'};
      record.append(el('p',watch.observed_at===null?'尚无读数':`${fresh?'有效观测':'历史或不可用读数'} · ${format(watch.observed_at)} · ${availability[payload.availability]||watch.validity}`));
      for(const d of payload.snapshot?.devices||[])record.append(el('p',`${d.name} · ${d.uuid}\n已用 ${(d.usedBytes/1024**3).toFixed(1)} / ${(d.totalBytes/1024**3).toFixed(1)} GiB · 利用率 ${d.utilization}% · 计算进程 ${d.processes.length}`));
      if(payload.error)record.append(el('p','当前无法观测。请检查 MCP 连接、审批和保存的服务器绑定；历史读数不能用来判断当前空闲。'));
    }catch{record.append(el('p','无法读取观测记录'));}
    if(watch.state==='watching')record.append(button('停止监控',async()=>{await request(`/tasks/${watch.task_id}/stop-monitor`,'POST',{});message('监控已停止，服务器进程保持运行。');await refresh();}));
    $('gpu-watches').append(record);
  }
  if(!watches.length)$('gpu-watches').append(el('p','暂无 GPU 监控。创建前需配置只读 MCP 观测服务器。','empty'));
}
function renderTasks(tasks){
  state.tasks=tasks;const visible=tasks.filter(t=>t.state!=='deleted');$('task-count').textContent=`本页 ${visible.length} 项`;
  $('tasks').replaceChildren();
  if(!visible.length){$('tasks').append(el('p','还没有任务。从左侧创建一条提醒。','empty'));return;}
  for(const task of visible){
    const card=el('article',undefined,'task');card.append(el('h3',task.definition.title),el('span',labels[task.state]||task.state,'badge'),
      el('p',task.definition.prompt),el('p',`${task.id} · 修订 ${task.revision}`,'muted'),el('p',`下次：${format(task.nextDue,task.definition.schedule.timezone)} · ${task.definition.schedule.timezone}`,'muted'));
    const controls=el('div',undefined,'actions');
    controls.append(button('编辑',async()=>edit(task)),button('立即运行',async()=>{
      const reply=await request(`/tasks/${task.id}/run`,'POST',{});message(`已保存本次运行 ${reply.run.id}，原计划不变。`);await refresh();
    }));
    const op=task.state==='active'?'pause':'resume';
    controls.append(button(op==='pause'?'暂停':'恢复',async()=>{await request(`/tasks/${task.id}/${op}`,'POST',{});await refresh();}),button('删除',async()=>{
      await request(`/tasks/${task.id}`,'DELETE');if(state.edit?.id===task.id)reset();message('任务已删除，历史记录保留。');await refresh();
    }));card.append(controls);$('tasks').append(card);
  }
}
function renderRecords(runs,notifications){
  $('runs').replaceChildren();$('notifications').replaceChildren();
  for(const run of runs){
    const record=el('article',undefined,'record');record.append(el('span',labels[run.state]||run.state,'badge'),el('p',`${format(run.ended_at)} · ${run.id}`,'muted'));
    try{record.append(el('p',JSON.parse(run.result||'{}').text||''));}catch{}$('runs').append(record);
  }
  for(const notification of notifications){
    const record=el('article',undefined,'record');record.append(el('span',labels[notification.state]||notification.state,'badge'),el('p',notification.content),el('p',notification.id,'muted'));
    if(notification.state!=='cancelled')record.append(button('只重发通知',async()=>{
      await request(`/notifications/${notification.id}/resend`,'POST',{includeUnknown:$('allow-duplicate').checked,resendAccepted:$('allow-duplicate').checked});
      message('已加入重发队列，不会重跑任务。');await refresh();
    }));$('notifications').append(record);
  }
  if(!runs.length)$('runs').append(el('p','暂无执行记录','empty'));
  if(!notifications.length)$('notifications').append(el('p','暂无通知','empty'));
}
async function refresh(){
  const generation=++state.generation,ownerScope=scope();
  const runtime=await request('/status','GET',undefined,'');
  if(generation!==state.generation)return;
  state.enabled=runtime.enabled;
  $('status').textContent=!runtime.enabled?'定时预览未启用。展开下方“当前支持范围与服务设置”查看启用方法。':runtime.error?`调度异常：${runtime.error}`:
    `调度服务${runtime.running?'运行中':'尚未启动'} · 微信投递${runtime.delivery.ready?'已连接':'未配置'} · GPU 观测${runtime.gpuObservation?.configured?'已配置':'未配置'} · 模型执行尚未启用`;
  $('status').classList.toggle('error',Boolean(runtime.error));syncFields();
  if(!runtime.enabled||!$('account').value||!$('sender').value){
    $('tasks').replaceChildren(el('p','请选择已启用账号的授权接收人。','empty'));$('runs').replaceChildren();$('notifications').replaceChildren();renderWatches([]);return;
  }
  if(runtime.gpuObservation?.configured&&!state.targetsLoaded){
    state.targetsLoaded=true;
    try{
      const response=await request('/gpu/targets','GET',undefined,ownerScope);state.targets=response.targets;
      const prior=$('gpu-server').value;$('gpu-server').replaceChildren(...state.targets.map(t=>new Option(t.server,t.server)));
      if(state.targets.some(t=>t.server===prior))$('gpu-server').value=prior;
    }catch{message('GPU MCP 不可用；提醒功能仍可使用。',true);}
    syncFields();
  }
  const [tasks,runs,notifications,watches]=await Promise.all([
    ...['tasks','runs','notifications'].map(name=>request(`/${name}`,'GET',undefined,ownerScope+'&limit=50'+(pages[name].cursor?'&cursor='+encodeURIComponent(pages[name].cursor):''))),
    request('/gpu/watches','GET',undefined,ownerScope)]);
  if(generation!==state.generation||ownerScope!==scope())return;
  for(const [name,value] of [['tasks',tasks],['runs',runs],['notifications',notifications]])pages[name].next=value.nextCursor;
  renderTasks(tasks.tasks);renderRecords(runs.items,notifications.items);renderWatches(watches.items);pagination();
}
async function definition(forSave=false){
  const timezone=$('timezone').value.trim(),kind=$('schedule').value;
  let schedule;
  if(kind==='once')schedule={kind,timezone,...await request('/resolve-time','POST',{local:$('at').value,timezone})};
  if(kind==='daily')schedule={kind,timezone,time:$('time').value};
  if(kind==='weekly')schedule={kind,timezone,time:$('time').value,weekdays:[...document.querySelectorAll('[name=weekday]:checked')].map(c=>Number(c.value))};
  if(kind==='interval'){
    const everySeconds=Number($('interval').value)*60;
    const original=state.edit?.definition.schedule;
    const signature=JSON.stringify([scope(),state.edit?.id,state.edit?.revision,everySeconds,timezone]);
    let anchorUtc=new Date(Date.now()+everySeconds*1000).toISOString();
    if(original?.kind==='interval'&&original.everySeconds===everySeconds)anchorUtc=original.anchorUtc;
    else if(forSave){
      if(state.intervalAnchor?.signature!==signature)state.intervalAnchor={signature,anchorUtc};
      anchorUtc=state.intervalAnchor.anchorUtc;
    }
    schedule={kind,timezone,everySeconds,anchorUtc};
  }
  const result={kind:$('task-kind').value,title:$('title').value,prompt:$('prompt').value,projectId:state.edit?.definition.projectId||null,schedule,notification:$('notification').value};
  if(result.kind==='gpu_watch'){
    const target=state.targets.find(t=>t.server===$('gpu-server').value);if(!target)throw new Error('请先配置可用的观测服务器');
    const saved=state.edit?.definition.gpuWatch;
    result.gpuWatch={server:target.server,bindingHash:saved?.server===target.server?saved.bindingHash:target.bindingHash,
      durationSeconds:Number($('gpu-duration').value)*60,sampleSeconds:Number($('gpu-period').value),minFreeBytes:Math.round(Number($('gpu-free').value)*1024**3),
      maxUsedBytes:Math.round(Number($('gpu-used').value)*1024**2),stableSamples:Number($('gpu-stable').value),gpuUuids:saved?.gpuUuids||[],maxUtilization:saved?.maxUtilization??0};
  }
  return result;
}
document.addEventListener('DOMContentLoaded',()=>{
  $('schedule').addEventListener('change',syncFields);
  $('task-kind').addEventListener('change',syncFields);
  $('gpu-server').addEventListener('change',syncFields);
  $('reset').addEventListener('click',reset);
  $('account').addEventListener('change',()=>{chooseSenders();void refresh().catch(e=>message(e.message,true));});
  $('sender').addEventListener('change',()=>{resetPages();reset();void refresh().catch(e=>message(e.message,true));});
  $('refresh').addEventListener('click',()=>action(async()=>{await bootstrap();await refresh();}));
  $('preview').addEventListener('click',()=>action(async()=>{
    const def=await definition();const reply=await request('/preview','POST',def.schedule);
    $('preview-times').textContent=reply.times.length?`接下来：${reply.times.map(t=>format(t,def.schedule.timezone)).join('；')}`:'没有未来触发时间。';
  }));
  $('task-form').addEventListener('submit',event=>{
    event.preventDefault();void action(async()=>{
      const def=await definition(true);
      const editing=state.edit;
      if(editing)await request(`/tasks/${editing.id}`,'PATCH',{expectedRevision:editing.revision,definition:def});
      else await request('/tasks','POST',{definition:def});
      reset();message(editing?'修改已保存；已启动的监控继续使用原快照。':'任务已保存。');await refresh();
    });
  });
  void action(async()=>{await bootstrap();await refresh();});
  setInterval(()=>{if(!state.busy&&!document.hidden)void refresh().catch(e=>message(e.message,true));},5000);
});
