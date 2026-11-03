import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
const project=fileURLToPath(new URL('../',import.meta.url));
const root=path.resolve(process.env.CODEX_WEIXIN_STATE_DIR || path.join(os.homedir(),'.codex-weixin-bridge'));
const target=path.join(root,'app/node_modules/@agent-dev-net/weixin-bridge');
const pkg=JSON.parse(fs.readFileSync(path.join(target,'package.json'),'utf8'));
if(pkg.version!=='0.0.33')throw Error('Review compatibility before deploying to a different bridge version');
const backup=path.join(root,'server-tools',`memory-backup-${new Date().toISOString().replace(/[:.]/g,'-')}`);
const modules=['bridge/memory','bridge/format','codex/runner'];
for(const module of modules)for(const suffix of ['.js','.js.map','.d.ts']) {
  const relative=`dist/${module}${suffix}`;
  if(!fs.existsSync(path.join(project,relative)))throw Error('Run npm run build first');
}
for(const module of modules)for(const suffix of ['.js','.js.map','.d.ts']) {
  const relative=`dist/${module}${suffix}`;
  const destination=path.join(target,relative);
  fs.mkdirSync(path.dirname(destination),{recursive:true});
  if(fs.existsSync(destination)) {fs.mkdirSync(path.dirname(path.join(backup,relative)),{recursive:true});fs.copyFileSync(destination,path.join(backup,relative));}
  fs.copyFileSync(path.join(project,relative),destination);
}
console.log(`Installed memory modules only. Backup: ${backup}. Restart the bridge when idle.`);
