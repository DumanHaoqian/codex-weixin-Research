// Protocol fixture only. Never starts Codex, SSH, or another tool process.
import readline from 'node:readline';
const lines=readline.createInterface({input:process.stdin});
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const reply=(id,result)=>send({id,result});
let mode='',pending;
lines.on('line',line=>{
  const m=JSON.parse(line);
  if(m.id===9000){
    if(m.result?.permissions&&Object.keys(m.result.permissions).length===0)
      reply(pending,{isError:true,content:[{type:'text',text:'permission denied'}]});
    else send({id:pending,error:{code:-1,message:'client incorrectly approved'}});
    return;
  }
  if(m.method==='initialize'){reply(m.id,{userAgent:'fixture'});return;}
  if(m.method==='initialized')return;
  if(m.method==='thread/start'){
    mode=m.params.cwd;
    if(m.params.sandbox!=='read-only'||m.params.approvalPolicy!=='never'||m.params.config['features.hooks']!==false||!m.params.ephemeral)
      return send({id:m.id,error:{code:-1,message:'unsafe collector profile'}});
    reply(m.id,{thread:{id:'observation'},approvalPolicy:'never',sandbox:{type:mode.includes('unverified')?'dangerFullAccess':'readOnly'}});return;
  }
  if(m.method==='mcpServer/tool/call'){
    if(m.params.server!=='polyu4090'||m.params.threadId!=='observation'||!['servers_list','ssh_exec'].includes(m.params.tool))
      return send({id:m.id,error:{code:-1,message:'invalid collector call'}});
    if(mode.includes('denied')){
      pending=m.id;send({id:9000,method:'item/permissions/requestApproval',params:{threadId:'observation',permissions:{network:{enabled:true}}}});return;
    }
    reply(m.id,{content:[{type:'text',text:'[]'}]});return;
  }
  send({id:m.id,error:{code:-32601,message:'Models and general commands are forbidden in this fixture'}});
});
