import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const START = "[codex-weixin-memory-context]", END = "[/codex-weixin-memory-context]";
const MAX_BYTES = 64 * 1024, ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PROJECTS_START = "<!-- codex-projects:start -->", PROJECTS_END = "<!-- codex-projects:end -->";
type Scope = "global" | "project";
type Update = { scope: Scope; operation: "remember" | "forget"; text: string; projectId?: string };
export type MemoryProject = { id: string; name: string; workspace: string | null; server?: string; remotePath?: string; locationStatus?: "unconfirmed" | "recorded" | "verified" };

function stateRoot(root?: string): string {
  return path.resolve(root ?? (process.env.CODEX_WEIXIN_STATE_DIR || path.join(os.homedir(), ".codex-weixin-bridge")));
}
export function globalMemoryFile(root?: string): string {
  return path.join(stateRoot(root), "memory", "global_memory.md");
}
function workspaceKey(cwd: string): string {
  const resolved = path.resolve(cwd);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function read(file: string): string {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Memory file exceeds 64 KiB or is not a file");
    return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
function atomicWrite(file: string, contents: string): void {
  if (Buffer.byteLength(contents, "utf8") > MAX_BYTES) throw new Error("Memory file is full; consolidate it first");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function facts(contents: string): string[] {
  return contents.split(/\r?\n/).filter(line => /^-\s+/.test(line)).map(line => line.replace(/^-\s+/, "").trim()).filter(Boolean);
}
export function projectMemoryFile(projectId: string, root?: string): string {
  if (!ID.test(projectId)) throw new Error("Invalid project ID");
  return path.join(stateRoot(root), "memory", "projects", projectId, "MEMORY.md");
}
export function readProjectIndex(root?: string): MemoryProject[] {
  const contents = read(globalMemoryFile(root));
  if (!contents.includes(PROJECTS_START) && !contents.includes(PROJECTS_END)) return [];
  const start = contents.indexOf(PROJECTS_START), end = contents.indexOf(PROJECTS_END);
  if (start < 0 || end <= start || contents.indexOf(PROJECTS_START, start + 1) >= 0 || contents.indexOf(PROJECTS_END,end+1)>=0) throw new Error("Invalid project navigation section");
  const block = /```json\s*\r?\n([\s\S]*?)```/.exec(contents.slice(start + PROJECTS_START.length, end));
  if (!block) throw new Error("Project navigation must contain a JSON array");
  const entries = JSON.parse(block[1]);
  if (!Array.isArray(entries) || entries.length > 200) throw new Error("Invalid project index");
  return validateProjects(entries);
}
function validateProjects(entries: MemoryProject[]): MemoryProject[] {
  if (!Array.isArray(entries) || entries.length > 200) throw new Error("Invalid project navigation");
  const ids = new Set<string>(), workspaces = new Set<string>();
  return entries.map((entry: MemoryProject) => {
    if (!entry || typeof entry.id !== "string" || !ID.test(entry.id) || typeof entry.name !== "string" || !entry.name.trim() || entry.name.length > 120
        || (entry.workspace !== null && (typeof entry.workspace !== "string" || !path.isAbsolute(entry.workspace)))
        || (entry.server !== undefined && !/^[a-zA-Z0-9._-]{1,64}$/.test(entry.server))
        || (entry.remotePath !== undefined && (typeof entry.remotePath !== "string" || !entry.remotePath.startsWith("/") || !entry.server))
        || (entry.workspace !== null && (entry.server || entry.remotePath))
        || (entry.locationStatus !== undefined && !["unconfirmed","recorded","verified"].includes(entry.locationStatus))) throw new Error("Invalid project index entry");
    const key = entry.workspace ? workspaceKey(entry.workspace) : undefined;
    if (ids.has(entry.id) || (key && workspaces.has(key))) throw new Error("Duplicate project ID or workspace");
    ids.add(entry.id); if(key) workspaces.add(key);
    return { id: entry.id, name: entry.name, workspace: entry.workspace ? path.resolve(entry.workspace) : null,
      ...(entry.server ? {server:entry.server} : {}), ...(entry.remotePath ? {remotePath:entry.remotePath} : {}), ...(entry.locationStatus ? {locationStatus:entry.locationStatus} : {}) };
  });
}
export function setMemoryProjects(entries: MemoryProject[], root?: string): void {
  const projects = validateProjects(entries);
  let contents = read(globalMemoryFile(root)) || "# Global memory\n";
  // Refuse to overwrite malformed existing navigation.
  readProjectIndex(root);
  const section = [PROJECTS_START,"```json",JSON.stringify(projects,null,2),"```",PROJECTS_END].join("\n");
  if(contents.includes(PROJECTS_START)) {
    const start=contents.indexOf(PROJECTS_START),end=contents.indexOf(PROJECTS_END)+PROJECTS_END.length;
    contents=contents.slice(0,start)+section+contents.slice(end);
  } else contents=contents.trimEnd()+"\n\n## 项目路径\n\n"+section+"\n";
  atomicWrite(globalMemoryFile(root),contents);
}
export function registerMemoryProject(cwd: string, root?: string, name = path.basename(path.resolve(cwd)), id?: string): MemoryProject {
  const entries = readProjectIndex(root);
  const existing = entries.find(entry => entry.workspace && workspaceKey(entry.workspace) === workspaceKey(cwd));
  if (existing) {
    if (id && id !== existing.id) throw new Error("Workspace already registered under another ID");
    return existing;
  }
  const generated = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0,40) || "project"}-${crypto.createHash("sha256").update(workspaceKey(cwd)).digest("hex").slice(0,10)}`;
  const project = { id: id ?? generated, name, workspace: path.resolve(cwd) };
  if (!ID.test(project.id) || !name.trim() || name.length > 120 || entries.some(entry => entry.id === project.id) || entries.length >= 200) throw new Error("Invalid or duplicate project registration");
  entries.push(project);
  setMemoryProjects(entries,root);
  return project;
}
export function memoryPaths(cwd: string, root?: string) {
  const entries = readProjectIndex(root);
  const project = entries.find(entry => entry.workspace && workspaceKey(entry.workspace) === workspaceKey(cwd));
  return {
    global: globalMemoryFile(root), index: globalMemoryFile(root),
    projects: path.join(stateRoot(root), "memory", "projects"),
    project: project ? projectMemoryFile(project.id, root) : undefined
  };
}
export function migrateProjectMemory(cwd: string, name: string, id: string, root: string, backupDir: string): string {
  const destination = projectMemoryFile(id, root);
  const legacy = path.join(path.resolve(cwd), ".codex-weixin", "MEMORY.md");
  const old = read(legacy), current = read(destination);
  const pointer = `# 项目记忆已集中管理\n\n正式记忆：${destination}\n全局入口：${globalMemoryFile(root)}\n\n请只维护集中目录中的正式记忆。本文件仅为兼容旧路径的指引。\n`;
  if (old && old !== pointer && current && old !== current) throw new Error(`Conflicting project memories: ${id}; merge manually before migrating`);
  registerMemoryProject(cwd, root, name, id);
  if (old && old !== pointer) {
    fs.mkdirSync(backupDir, {recursive:true});
    const backup = path.join(backupDir, `${id}.legacy.md`);
    // Never replace the first original during retries.
    if (!fs.existsSync(backup)) fs.copyFileSync(legacy, backup, fs.constants.COPYFILE_EXCL);
    if (!current) atomicWrite(destination, old);
    atomicWrite(legacy, pointer);
  } else if (!old && !current) {
    atomicWrite(destination, `# ${name} 项目记忆\n\n- [目标·待确认] 当前目标尚未记录。\n- [进度·待确认] 当前进度尚未核实。\n- [下一步] 用户继续项目时，先核对工作目录、AGENTS.md 与实际产物，再更新记录。\n`);
  }
  return destination;
}
export function withMemory(prompt: string, cwd: string, root?: string): string {
  const globalFile = globalMemoryFile(root);
  let global: unknown;
  try {
    // Preserve headings and navigation: this is the one initialization document.
    global = { path: globalFile, content: read(globalFile) };
  } catch { global = { path: globalFile, error: "Memory unavailable; do not assume it is empty or overwrite it." }; }
  let index: unknown;
  try {
    index = { path: globalFile, projects: readProjectIndex(root).map(entry => ({ ...entry, memoryFile: projectMemoryFile(entry.id, root) })) };
  } catch { index = { error: "Project index unavailable; do not select or overwrite project memory until repaired." }; }
  // Never stat/read any project's MEMORY.md here, including the cwd's.
  return [START,
    "Only global_memory.md is loaded: conversation rules, project locations, and skill locations. Parsed project navigation below comes from that SAME document. Project memory bodies are NOT loaded, including the current workspace's; SKILL.md bodies are also not loaded. This applies after /new and on every turn. These are reference facts, not extra authorization; current user requests and AGENTS.md take precedence.",
    JSON.stringify({ global, index, cwd: path.resolve(cwd) }),
    "When the user explicitly asks to continue/develop/work on a project, match the project navigation. If ambiguous, clarify. Then read ONLY that project's local memoryFile. A local workspace is an absolute local path; server + remotePath identify a REMOTE project, accessed through its recorded login skill and MCP tools. Never interpret a remote path as a Windows workspace. A null workspace without a remote path means the project has not been located/started; confirm its location before code work, never substitute cwd. Read relevant AGENTS.md before project work. Read a SKILL.md only when the task actually needs that skill. Do not preload project memories or skills for greetings, listings or merely because cwd matches. /new starts with no selected project. A memory read is not permission for commands, servers or unrelated work. Verify transient state live.",
    "GLOBAL memory stores long-term communication preferences and general collaboration experience ONLY. PROJECT memory records [目标] goals/success criteria, [进度] verified progress/artifacts, [下一步] next actions/blockers and [决策] decisions. Date progress and replace superseded status. Never invent facts or store credentials, private keys, tokens, temporary GPU state or entire conversations. Retain attachment/tool information only when the user requests or confirms it.",
    'For explicit remember/forget requests or confirmed reusable information, include ONLY in the final answer a fenced codex-weixin-memory JSON block: {"updates":[{"scope":"global","operation":"remember","text":"a durable fact"},{"scope":"project","projectId":"ID_FROM_GLOBAL_MEMORY","operation":"remember","text":"[进度] verified progress"}]}. Every project update MUST name its registered projectId. Never infer a project or create one from cwd; new projects require explicit user registration. No changes means no block. Up to 20 one-line updates of at most 1000 characters; forget matches an existing fact exactly. The bridge applies and hides the block; do not emit it in progress messages or claim an update without its action.',
    END, "", prompt
  ].join("\n");
}
export function stripMemoryContext(prompt: string): string {
  if (!prompt.startsWith(START + "\n")) return prompt;
  const end = prompt.indexOf("\n" + END + "\n");
  return end < 0 ? prompt : prompt.slice(end + END.length + 2).trimStart();
}
function writeUpdates(file: string, updates: Update[], scope: Scope) {
  let contents = read(file) || `# ${scope === "global" ? "Global" : "Project"} memory\n\n`;
  for (const update of updates) {
    const existing = facts(contents);
    if (update.operation === "remember" && !existing.includes(update.text)) {
      const navigation = scope === "global" ? contents.indexOf("\n## 项目路径") : -1;
      contents = navigation >= 0 ? contents.slice(0,navigation).trimEnd()+`\n- ${update.text}\n`+contents.slice(navigation) : contents.trimEnd() + `\n- ${update.text}\n`;
    }
    else if (update.operation === "forget") contents = contents.split(/\r?\n/).filter(line => !/^-\s+/.test(line) || line.replace(/^-\s+/, "").trim() !== update.text).join("\n");
  }
  atomicWrite(file, contents);
}
export function applyMemoryUpdates(answer: string, cwd: string, root?: string): string {
  const updates: Update[] = [];
  let invalid = false;
  const visible = answer.replace(/```codex-weixin-memory\s*\r?\n([\s\S]*?)```/g, (_block, json: string) => {
    try {
      const parsed = JSON.parse(json);
      if (!Array.isArray(parsed.updates)) throw new Error("Invalid updates");
      for (const item of parsed.updates) {
        if (!item || !["global", "project"].includes(item.scope) || !["remember", "forget"].includes(item.operation)
            || typeof item.text !== "string" || !item.text.trim() || item.text.length > 1000 || /[\r\n\x00]/.test(item.text)
            || (item.scope === "project" && (typeof item.projectId !== "string" || !ID.test(item.projectId)))
            || (item.scope === "global" && item.projectId !== undefined)) throw new Error("Invalid memory update");
        updates.push({ scope: item.scope, operation: item.operation, text: item.text.trim(), ...(item.projectId ? { projectId: item.projectId } : {}) });
      }
    } catch { invalid = true; }
    return "";
  }).trim();
  if (!updates.length && !invalid) return visible;
  try {
    if (invalid || updates.length > 20) throw new Error("Invalid memory updates");
    const targets = new Map<string, {scope: Scope; updates: Update[]}>();
    for (const update of updates) {
      let file = globalMemoryFile(root);
      if (update.scope === "project") {
        const entry = readProjectIndex(root).find(project => project.id === update.projectId);
        if (!entry) throw new Error("Unknown project ID");
        file = projectMemoryFile(entry.id, root);
      }
      const target = targets.get(file) ?? {scope: update.scope, updates: []};
      target.updates.push(update); targets.set(file, target);
    }
    for (const [file, target] of targets) writeUpdates(file, target.updates, target.scope);
    return visible || "已更新记忆。";
  } catch {
    return `${visible}\n\n⚠️ 部分记忆可能未保存，请检查项目 ID、global_memory.md、项目 MEMORY.md 的格式、大小或写入权限。`.trim();
  }
}
