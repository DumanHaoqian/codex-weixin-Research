import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {migrateProjectMemory,registerMemoryProject,globalMemoryFile} from '../dist/bridge/memory.js';
const root=path.resolve(process.env.CODEX_WEIXIN_STATE_DIR || path.join(os.homedir(),'.codex-weixin-bridge'));
const [mode,...args]=process.argv.slice(2);
if(!['register','migrate'].includes(mode)||!args.length||args.length%3)throw Error('Usage: node scripts/manage-memory.mjs register|migrate WORKSPACE NAME ID [WORKSPACE NAME ID ...]');
const backup=path.join(root,'server-tools',`memory-central-backup-${new Date().toISOString().replace(/[:.]/g,'-')}`);
fs.mkdirSync(backup,{recursive:true});
for(const file of ['global_memory.md']){const original=path.join(root,'memory',file);if(fs.existsSync(original))fs.copyFileSync(original,path.join(backup,file));}
for(let i=0;i<args.length;i+=3){
  const [cwd,name,id]=args.slice(i,i+3);
  if(!path.isAbsolute(cwd)||!fs.statSync(cwd).isDirectory())throw Error('Workspace must be an existing absolute directory');
  const result=mode==='migrate'?migrateProjectMemory(cwd,name,id,root,backup):registerMemoryProject(cwd,root,name,id);
  console.log(JSON.stringify({name,result}));
}
const globalFile=globalMemoryFile(root);
let global=fs.existsSync(globalFile)?fs.readFileSync(globalFile,'utf8'):'# 全局协作记忆\n';
const rule=`- [项目记忆入口] 项目记忆集中保存在 ${path.join(root,'memory','projects')}；名称、位置与稳定 ID 记录在本文件。项目和技能正文仅在用户任务需要时读取，不根据当前目录猜测项目。`;
if(!global.includes(rule)){global=global.trimEnd()+'\n'+rule+'\n';const temp=globalFile+'.migration.tmp';fs.writeFileSync(temp,global,{flag:'wx'});fs.renameSync(temp,globalFile);}
console.log(`Original files backed up in ${backup}`);
