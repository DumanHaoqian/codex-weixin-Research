'use strict';
window.ResearchUI=(()=>{
  const $=id=>document.getElementById(id),lines=id=>$(id).value.split(/\r?\n/).filter(v=>v.trim()),num=id=>Number($(id).value);
  let projects=[],targets=[],loaded=false,api;
  const pages=Object.fromEntries(['workflows','objects','artifacts','literature'].map(name=>[name,{cursor:null,next:null,back:[]}]))
  const fieldsets={agent_report:'agent-fields',research_workflow:'workflow-fields',job_monitor:'job-monitor-fields',result_compare:'comparison-fields',literature_watch:'literature-fields'};
  function sync(kind){
    for(const [type,id] of Object.entries(fieldsets)){$(id).hidden=type!==kind;$(id).disabled=type!==kind;}
    $('remote-target-fields').hidden=!['research_workflow','job_monitor'].includes(kind)&&!(kind==='agent_report'&&projects.find(p=>p.id===$('research-project').value)?.server);
    $('reservation-fields').hidden=kind!=='research_workflow'||$('workflow-mode').value!=='reserve_then_handoff';
    for(const input of $('reservation-fields').querySelectorAll('input'))input.disabled=$('reservation-fields').hidden;
    $('grant-submit').required=kind==='research_workflow';$('grant-reserve').required=kind==='research_workflow'&&$('workflow-mode').value==='reserve_then_handoff';
    for(const [name,page] of Object.entries(pages)){
      const buttons=$('research-'+name+'-pages').querySelectorAll('button');if(buttons.length===2){buttons[0].disabled=!page.back.length;buttons[1].disabled=!page.next;}
    }
  }
  async function load(runtime){
    if(loaded)return;loaded=true;const ownerScope=api.scope();
    let navigation;try{navigation=(await api.request('/research/projects','GET',undefined,ownerScope)).projects;}catch{navigation=[];if(ownerScope===api.scope())api.message('项目导航暂不可用；通用提醒与历史记录仍可查看。',true);}
    if(ownerScope!==api.scope())return;projects=navigation;
    const prior=$('research-project').value;$('research-project').replaceChildren(new Option('通用任务',''),...projects.map(p=>new Option(p.name,p.id)));$('research-project').value=prior;
    if(runtime.research?.remote?.configured){
      try{const directory=(await api.request('/research/targets','GET',undefined,ownerScope)).targets;if(ownerScope!==api.scope())return;targets=directory;
        const old=$('research-target').value;$('research-target').replaceChildren(...targets.map(t=>new Option(t.server,t.server)));if(targets.some(t=>t.server===old))$('research-target').value=old;
      }catch{api.message('科研服务器连接暂不可用；已保存的任务和结果仍可查看。',true);}
    }
    api.sync();
  }
  function edit(def){
    $('research-project').value=def.projectId??'';
    if(def.agent){$('agent-model').value=def.agent.model??'';$('agent-files').value=def.agent.files.join('\n');}
    const target=def.workflow?.target??def.jobMonitor?.target??def.agent?.remoteTarget;if(target)$('research-target').value=target.server;
    const w=def.workflow;
    if(w){$('recipe-root').value=w.recipe.root;$('recipe-executable').value=w.recipe.executable;$('recipe-args').value=w.recipe.args.join('\n');$('recipe-version').value=w.recipe.codeVersion;$('recipe-env').value=w.recipe.envRef;
      $('workflow-mode').value=w.mode;$('job-gpus').value=w.resource.gpuCount;$('job-free').value=w.resource.minFreeBytes/1024**3;$('holder-gib').value=w.resource.holderBytes/1024**3;$('hold-minutes').value=w.resource.holdSeconds/60;
      const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:def.schedule.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(w.resource.waitDeadlineUtc)).map(p=>[p.type,p.value]));
      $('job-wait').value=`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
      $('handoff-auto').checked=w.resource.handoff==='automatic';$('grant-reserve').checked=w.grant.reserve;$('grant-submit').checked=w.grant.submit;$('grant-stop').checked=w.grant.stop;
      $('metrics-file').value=w.validation.metricsFile;$('required-files').value=w.validation.requiredFiles.join('\n');$('job-monitor-seconds').value=w.monitorSeconds;
      $('job-runtime-seconds').value=w.maxRuntimeSeconds??'';$('job-retries').value=w.retryCount;$('job-submit-budget').value=w.grant.maxSubmissions;
    }
    if(def.jobMonitor){$('attach-job-id').value=def.jobMonitor.jobId;$('attach-period').value=def.jobMonitor.monitorSeconds;$('attach-days').value=def.jobMonitor.durationSeconds/86400;}
    if(def.comparison){$('compare-jobs').value=def.comparison.jobIds.join('\n');$('baseline-job').value=def.comparison.baselineId;}
    if(def.literature){$('paper-query').value=def.literature.query;$('paper-days').value=def.literature.lookbackDays;$('source-crossref').checked=def.literature.sources.includes('crossref');$('source-arxiv').checked=def.literature.sources.includes('arxiv');}
  }
  async function definition(def,original){
    const project=projects.find(p=>p.id===$('research-project').value);def.projectId=project?.id??null;
    const t=targets.find(t=>t.server===$('research-target').value);
    const old=original?.workflow?.target??original?.jobMonitor?.target??original?.agent?.remoteTarget;
    const target=t?{server:t.server,bindingHash:old?.server===t.server?old.bindingHash:t.bindingHash}:undefined;
    if(def.kind==='agent_report'){
      const {projectBindingHash,remoteTarget,model,...kept}=original?.agent??{};
      def.agent={...kept,profile:kept.profile??'render_report',files:lines('agent-files'),...(project?{projectBindingHash:original?.projectId===project.id?projectBindingHash??project.bindingHash:project.bindingHash}:{}),
        ...(project?.server?{remoteTarget:target}:{}),...($('agent-model').value.trim()?{model:$('agent-model').value.trim()}:{})};
    }
    if(def.kind==='research_workflow'){
      if(!target)throw new Error('请选择已配置的科研服务器');
      if(!$('grant-submit').checked)throw new Error('需要明确授权此固定方案');
      const until=await api.request('/resolve-time','POST',{local:$('job-wait').value,timezone:def.schedule.timezone});
      const mode=$('workflow-mode').value;
      if(mode==='reserve_then_handoff'&&!$('grant-reserve').checked)throw new Error('需要明确授权显存保留范围与期限');
      def.workflow={target,mode,recipe:{root:$('recipe-root').value.trim(),executable:$('recipe-executable').value.trim(),args:lines('recipe-args'),codeVersion:$('recipe-version').value.trim(),envRef:$('recipe-env').value.trim()},
        grant:{submit:true,reserve:$('grant-reserve').checked,stop:$('grant-stop').checked,maxSubmissions:num('job-submit-budget')},
        resource:{gpuCount:num('job-gpus'),gpuUuids:original?.workflow?.resource.gpuUuids??[],minFreeBytes:Math.round(num('job-free')*1024**3),maxUsedBytes:original?.workflow?.resource.maxUsedBytes??64*1024**2,
          stableSamples:original?.workflow?.resource.stableSamples??2,waitDeadlineUtc:until.atUtc,holderBytes:Math.round(num('holder-gib')*1024**3),holdSeconds:num('hold-minutes')*60,handoff:$('handoff-auto').checked?'automatic':'manual'},
        validation:{metricsFile:$('metrics-file').value.trim(),requiredFiles:lines('required-files')},monitorSeconds:num('job-monitor-seconds'),retryCount:num('job-retries'),
        ...(original?.workflow?.logStallSeconds?{logStallSeconds:original.workflow.logStallSeconds}:{}),logAlerts:original?.workflow?.logAlerts??[],
        ...($('job-runtime-seconds').value?{maxRuntimeSeconds:num('job-runtime-seconds')}:{})};
    }
    if(def.kind==='job_monitor'){if(!target)throw new Error('请选择科研服务器');def.jobMonitor={...(original?.jobMonitor??{}),target,jobId:$('attach-job-id').value.trim(),monitorSeconds:num('attach-period'),durationSeconds:num('attach-days')*86400};}
    if(def.kind==='result_compare')def.comparison={jobIds:lines('compare-jobs'),baselineId:$('baseline-job').value.trim()};
    if(def.kind==='literature_watch')def.literature={query:$('paper-query').value.trim(),sources:['crossref','arxiv'].filter(s=>$('source-'+s).checked),lookbackDays:num('paper-days'),pageBudget:original?.literature?.pageBudget??3,itemsPerPage:original?.literature?.itemsPerPage??20};
    return def;
  }
  async function render(){
    const scope=api.scope();
    const routes=['workflows','objects','artifacts','literature'];
    const [workflows,objects,artifacts,papers]=await Promise.all(routes.map(name=>api.request('/research/'+name,'GET',undefined,scope+'&limit=50'+(pages[name].cursor?'&cursor='+encodeURIComponent(pages[name].cursor):''))));
    if(scope!==api.scope())return;
    const make=api.el,button=api.button,labels={waiting:'等待资源',submitting:'提交待核实',reserving:'申请保留中',held:'显存保留中',handoff:'交接待核实',monitoring:'观察作业',unknown:'结果未知',succeeded:'验证通过',failed:'失败',needs_review:'需要核查',expired:'已到期',paused:'监控已暂停',cancelled:'已取消',blocked:'受阻'};
    for(const [i,name] of routes.entries()){
      const page=pages[name];page.next=[workflows,objects,artifacts,papers][i].nextCursor;
      const previous=button('上一页',async()=>{page.cursor=page.back.pop()??null;await api.refresh();}),next=button('下一页',async()=>{page.back.push(page.cursor);page.cursor=page.next;await api.refresh();});
      previous.disabled=!page.back.length;next.disabled=!page.next;
      $('research-'+name+'-pages').replaceChildren(previous,make('span',`第 ${page.back.length+1} 页`,'muted'),next);
    }
    $('research-workflows').replaceChildren();
    for(const w of workflows.items){const d=JSON.parse(w.data),def=JSON.parse(w.snapshot),card=make('article',undefined,'record');
      card.append(make('strong',labels[w.state]??w.state),make('p',`${w.id} · ${d.target.server}`),make('p',`作业：${d.jobId??'无'} · 保留：${d.leaseId??'无'}`),make('p',d.lastNotice??''));
      if(d.lastError)card.append(make('p','最近诊断：'+d.lastError,'error'));
      const controls=make('div',undefined,'actions');
      const add=(text,action)=>controls.append(button(text,async()=>{await api.request(`/research/workflows/${w.id}/${action}`,'POST',{});api.message('已记录控制请求，将核对原对象状态。');await api.refresh();}));
      if(w.state==='held'){add('交接固定实验','handoff');if(!d.jobId)add('释放本次保留','release');}
      if(d.jobId&&w.phase==='monitor'&&['monitoring','unknown'].includes(w.state))add('停止监控','stop_monitor');
      if(w.state==='paused')add('恢复监控','resume_monitor');
      if(d.jobId&&def.workflow?.grant.stop&&w.state==='monitoring')add('停止本实验','stop');
      card.append(controls);$('research-workflows').append(card);
    }
    $('research-objects').replaceChildren();
    for(const o of objects.items){const receipt=JSON.parse(o.receipt),card=make('article',undefined,'record');card.append(make('p',`${o.kind==='lease'?'资源保留':'实验'} ${o.id} · ${o.state}`));
      if(receipt.payload.gpuReady!==undefined)card.append(make('p',`GPU 就绪观测：${receipt.payload.gpuReady===true?'已观测到':receipt.payload.gpuReady===false?'尚未观测到':'无法核实'}`));
      if(receipt.payload.logTail){const details=make('details'),summary=make('summary','日志末尾（有限采样）');details.append(summary,make('pre',receipt.payload.logTail));card.append(details);}
      $('research-objects').append(card);
    }
    $('research-artifacts').replaceChildren(make('h3','报告与证据'));
    for(const a of artifacts.items){const card=make('article',undefined,'record');card.append(make('p',`${a.name} · ${a.id}`),button('下载',async()=>{
      const result=await api.request('/artifacts/'+a.id);const url=URL.createObjectURL(new Blob([result.text],{type:result.mediaType})),link=document.createElement('a');link.href=url;link.download=result.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }));$('research-artifacts').append(card);}
    $('research-papers').replaceChildren(make('h3','文献发现与更新'));
    for(const item of papers.items){const p=JSON.parse(item.metadata),card=make('article',undefined,'record');card.append(make('strong',p.title),make('p',p.authors.join(', ')),make('p',`${p.dateType}: ${p.date} · ${p.readingLevel==='abstract'?'已读摘要':'仅元数据'} · 通知 ${item.notification_state??'未要求'}`));
      try{const url=new URL(p.url);if(url.protocol==='https:'&&['arxiv.org','doi.org'].includes(url.hostname)){const link=make('a','原始来源');link.href=url.href;link.target='_blank';link.rel='noreferrer';card.append(link);}}catch{}
      $('research-papers').append(card);
    }
    if(!workflows.items.length)$('research-workflows').append(make('p','暂无科研流程。','empty'));
    if(!artifacts.items.length)$('research-artifacts').append(make('p','暂无报告。','empty'));
    if(!papers.items.length)$('research-papers').append(make('p','暂无文献记录。','empty'));
  }
  return {init(value){api=value;$('workflow-mode').addEventListener('change',()=>api.sync());$('research-project').addEventListener('change',()=>{const p=projects.find(p=>p.id===$('research-project').value);if(p?.remotePath)$('recipe-root').value=p.remotePath;if(p?.server)$('research-target').value=p.server;api.sync();});},
    sync,load,edit,definition,render,resetLoad(){loaded=false;for(const page of Object.values(pages)){page.cursor=null;page.next=null;page.back=[];}}};
})();
