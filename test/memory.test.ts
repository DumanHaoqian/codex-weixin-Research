import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {applyMemoryUpdates,memoryPaths,withMemory,registerMemoryProject,readProjectIndex,projectMemoryFile,migrateProjectMemory,globalMemoryFile,setMemoryProjects} from "../src/bridge/memory.js";
import {buildPrompt,parsePrompt} from "../src/bridge/format.js";
import {HybridCodexRunner} from "../src/codex/runner.js";
const action=(updates:unknown[])=>`已记住。\n\n\`\`\`codex-weixin-memory\n${JSON.stringify({updates})}\n\`\`\``;
function fixture(t:any){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"cwb-memory-"));
  const a=path.join(root,"project-a"), b=path.join(root,"project-b");fs.mkdirSync(a);fs.mkdirSync(b);
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,a,b};
}
test("all project memories live centrally; prompts include only global facts and index metadata",t=>{
  const {root,a,b}=fixture(t);registerMemoryProject(a,root,"A","a");registerMemoryProject(b,root,"B","b");
  applyMemoryUpdates(action([{scope:"global",operation:"remember",text:"偏好中文回复"},{scope:"project",projectId:"a",operation:"remember",text:"PRIVATE-A-2846"}]),a,root);
  applyMemoryUpdates(action([{scope:"project",projectId:"b",operation:"remember",text:"PRIVATE-B-7731"}]),b,root);
  for(const cwd of [a,b]){
    const prompt=withMemory("hi",cwd,root);
    assert.match(prompt,/偏好中文回复/);assert.match(prompt,/project-a/);assert.match(prompt,/project-b/);
    assert.doesNotMatch(prompt,/PRIVATE-A-2846|PRIVATE-B-7731/);
    assert.match(memoryPaths(cwd,root).project!,/memory[\\/]projects[\\/]/);
    assert.equal(fs.existsSync(path.join(cwd,".codex-weixin","MEMORY.md")),false);
  }
});
test("initialization never stats or reads project bodies, even if the current project is unreadable",t=>{
  const {root,a}=fixture(t);registerMemoryProject(a,root,"A","a");
  const project=projectMemoryFile("a",root),calls:string[]=[];
  const originalRead=fs.readFileSync, originalStat=fs.statSync;
  t.mock.method(fs,"readFileSync",function(file:any,...args:any[]){calls.push(String(file));if(String(file)===project)throw Error("must not read");return (originalRead as any)(file,...args);});
  t.mock.method(fs,"statSync",function(file:any,...args:any[]){calls.push(String(file));if(String(file)===project)throw Error("must not stat");return (originalStat as any)(file,...args);});
  assert.match(withMemory("hello",a,root),/Project memory bodies are NOT loaded/);
  assert.equal(calls.includes(project),false);
});
test("selected project ID controls writes even when conversation cwd is a different workspace",t=>{
  const {root,a,b}=fixture(t);registerMemoryProject(a,root,"A","a");registerMemoryProject(b,root,"B","b");
  applyMemoryUpdates(action([{scope:"project",projectId:"a",operation:"remember",text:"[进度] target-A"}]),b,root);
  assert.match(fs.readFileSync(projectMemoryFile("a",root),"utf8"),/target-A/);
  assert.equal(fs.existsSync(projectMemoryFile("b",root)),false);
});
test("updates merge latest content, deduplicate and forget exactly",t=>{
  const {root,a}=fixture(t);registerMemoryProject(a,root,"A","a");
  applyMemoryUpdates(action([{scope:"project",projectId:"a",operation:"remember",text:"fact A"}]),a,root);
  const file=memoryPaths(a,root).project!;fs.appendFileSync(file,"- fact B\n");
  const projectId=readProjectIndex(root)[0].id;
  applyMemoryUpdates(action([{scope:"project",projectId,operation:"remember",text:"fact A"},{scope:"project",projectId,operation:"forget",text:"fact B"},{scope:"project",projectId,operation:"remember",text:"fact C"}]),a,root);
  const text=fs.readFileSync(file,"utf8");assert.equal((text.match(/fact A/g)||[]).length,1);assert.doesNotMatch(text,/fact B/);assert.match(text,/fact C/);
});
test("omitted project ID cannot silently write an existing cwd project",t=>{
  const {root,a}=fixture(t);registerMemoryProject(a,root,"A","a");
  assert.match(applyMemoryUpdates(action([{scope:"project",operation:"remember",text:"wrong target"}]),a,root),/未保存/);
  assert.equal(fs.existsSync(projectMemoryFile("a",root)),false);
});
test("generic cwd never becomes a project automatically",t=>{
  const {root,a}=fixture(t);
  assert.match(applyMemoryUpdates(action([{scope:"project",operation:"remember",text:"do not invent a project"}]),a,root),/未保存/);
  assert.deepEqual(readProjectIndex(root),[]);
});
test("global_memory.md is the only entry; legacy files and skill/project bodies are never loaded",t=>{
  const {root,a}=fixture(t),global=globalMemoryFile(root);
  fs.mkdirSync(path.dirname(global));
  fs.writeFileSync(global,'# Global\n\n## 聊天规范\n- actual-guidance\n\n## 技能路径\n- server-login: /example/skills/server-login/SKILL.md\n');
  fs.writeFileSync(path.join(root,'memory','MEMORY.md'),'- LEGACY-GLOBAL-SENTINEL');
  fs.writeFileSync(path.join(root,'memory','INDEX.md'),'bad old registry with fake project');
  setMemoryProjects([{id:'research-a',name:'research-a',workspace:null,server:'gpu-server',remotePath:'/srv/research/research-a',locationStatus:'verified'}, {id:'medical_image',name:'medical_image',workspace:null}, {id:'personal-website-building',name:'personal-website-building',workspace:null}],root);
  assert.equal(readProjectIndex(root).length,3);
  assert.equal(readProjectIndex(root)[0].remotePath,'/srv/research/research-a');
  const prompt=withMemory('hi',a,root);
  assert.match(prompt,/actual-guidance/);assert.match(prompt,/聊天规范/);assert.match(prompt,/server-login/);assert.match(prompt,/medical_image/);
  assert.doesNotMatch(prompt,/LEGACY-GLOBAL-SENTINEL|fake project/);
  applyMemoryUpdates(action([{scope:'global',operation:'remember',text:'new preference'},{scope:'project',projectId:'medical_image',operation:'remember',text:'[进度] 尚未开始'}]),a,root);
  assert.ok(fs.readFileSync(global,'utf8').indexOf('new preference')<fs.readFileSync(global,'utf8').indexOf('## 项目路径'));
  assert.match(fs.readFileSync(projectMemoryFile('medical_image',root),'utf8'),/尚未开始/);
  assert.match(readProjectIndex(root)[0].remotePath!,/research-a/);
});
test("invalid/unknown project IDs and multiline updates cannot create arbitrary files",t=>{
  const {root,a}=fixture(t);
  for(const update of [{scope:"project",projectId:"../../bad",operation:"remember",text:"bad"},{scope:"project",projectId:"unknown",operation:"remember",text:"bad"},{scope:"global",operation:"remember",text:"a\nb"}])assert.match(applyMemoryUpdates(action([update]),a,root),/未保存/);
  assert.deepEqual(readProjectIndex(root),[]);
});
test("malformed indexes fail closed without overwriting them or injecting project content",t=>{
  const {root,a}=fixture(t);const index=globalMemoryFile(root);fs.mkdirSync(path.dirname(index));fs.writeFileSync(index,"<!-- codex-projects:start -->\nbad index");
  assert.match(withMemory("hi",a,root),/Project index unavailable/);
  assert.match(applyMemoryUpdates(action([{scope:"project",operation:"remember",text:"x"}]),a,root),/未保存/);
  assert.equal(fs.readFileSync(index,"utf8"),"<!-- codex-projects:start -->\nbad index");
});
test("duplicate names remain distinct; duplicate IDs cannot overwrite another project",t=>{
  const {root,a,b}=fixture(t);const pa=registerMemoryProject(a,root,"same"),pb=registerMemoryProject(b,root,"same");assert.notEqual(pa.id,pb.id);
  assert.throws(()=>registerMemoryProject(path.join(root,"C"),root,"C",pa.id),/duplicate/);
});
test("oversized global/project memory does not break chat or overwrite existing content",t=>{
  const {root,a}=fixture(t);registerMemoryProject(a,root,"A","a");
  const paths=memoryPaths(a,root);
  for(const file of [paths.global,paths.project!]){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,"x".repeat(65537));}
  assert.match(withMemory("hi",a,root),/Memory unavailable/);
  assert.match(applyMemoryUpdates(action([{scope:"project",projectId:"a",operation:"remember",text:"oops"}]),a,root),/未保存/);
  assert.equal(fs.statSync(paths.project!).size,65537);
});
test("migration preserves original bytes and backups, replaces legacy with a pointer, and is idempotent",t=>{
  const {root,a}=fixture(t),legacy=path.join(a,".codex-weixin","MEMORY.md"),backup=path.join(root,"backup");
  const original="# A\r\n- goal 2468\r\n";fs.mkdirSync(path.dirname(legacy));fs.writeFileSync(legacy,original);
  const file=migrateProjectMemory(a,"A","a",root,backup);
  assert.equal(fs.readFileSync(file,"utf8"),original);assert.equal(fs.readFileSync(path.join(backup,"a.legacy.md"),"utf8"),original);
  assert.match(fs.readFileSync(legacy,"utf8"),/正式记忆/);assert.equal(migrateProjectMemory(a,"A","a",root,backup),file);
  assert.equal(readProjectIndex(root).length,1);
});
test("migration rejects conflicting central and legacy contents without changing either",t=>{
  const {root,a}=fixture(t),legacy=path.join(a,".codex-weixin","MEMORY.md"),file=projectMemoryFile("a",root);
  fs.mkdirSync(path.dirname(legacy));fs.writeFileSync(legacy,"old");fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,"new");
  assert.throws(()=>migrateProjectMemory(a,"A","a",root,path.join(root,"backup")),/Conflicting/);
  assert.equal(fs.readFileSync(legacy,"utf8"),"old");assert.equal(fs.readFileSync(file,"utf8"),"new");
});
test("history hides memory/index metadata while preserving user text and media",t=>{
  const {root,a}=fixture(t);const original=buildPrompt("分析报告",[{kind:"file",label:"a.pdf",path:"C:/a.pdf"}],"Web");assert.deepEqual(parsePrompt(withMemory(original,a,root)),parsePrompt(original));
});
test("new and resumed threads receive only global/index; new thread does not inherit project memory",async t=>{
  const {root,a}=fixture(t),runner=new HybridCodexRunner({backend:"exec",memoryRoot:root}),prompts:any[]=[];registerMemoryProject(a,root,"A","a");
  (runner as any).exec.run=async(input:any)=>{prompts.push(input);return {threadId:input.threadId??`new-${prompts.length}`,text:prompts.length===1?action([{scope:"project",projectId:"a",operation:"remember",text:"PRIVATE-SENTINEL-2468"}]):"hello"};};
  try{
    assert.equal((await runner.run({cwd:a,prompt:buildPrompt("记住项目编号")})).text,"已记住。");
    await runner.run({cwd:a,prompt:buildPrompt("你好")});await runner.run({cwd:a,prompt:"continue",threadId:"existing"});
    assert.equal(prompts[1].threadId,undefined);assert.equal(prompts[2].threadId,"existing");
    assert.doesNotMatch(prompts[1].prompt,/PRIVATE-SENTINEL-2468/);assert.doesNotMatch(prompts[2].prompt,/PRIVATE-SENTINEL-2468/);
  }finally{runner.close();}
});
test("app-server and exec fallback receive the same global/index context",async t=>{
  const {root,a}=fixture(t);applyMemoryUpdates(action([{scope:"global",operation:"remember",text:"shared sentinel"}]),a,root);
  const runner=new HybridCodexRunner({backend:"auto",memoryRoot:root});let firstPrompt="";
  (runner as any).appServer.run=async(input:any)=>{firstPrompt=input.prompt;throw Error("offline");};(runner as any).appServer.closeAndWait=async()=>true;
  (runner as any).exec.run=async(input:any)=>{assert.equal(input.prompt,firstPrompt);return {threadId:"fallback",text:"OK"};};
  try{assert.equal((await runner.run({cwd:a,prompt:"hi"})).usedExecFallback,true);assert.match(firstPrompt,/shared sentinel/);}finally{runner.close();}
});
