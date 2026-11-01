# 全局记忆入口与项目记忆

本地源码分支：`codex/persistent-memory`，上游基础版本 v0.0.33。

## 文件组织

```text
~/.codex-weixin-bridge/memory/
├─ global_memory.md
├─ projects/
│  ├─ research-a/MEMORY.md
│  ├─ research_b/MEMORY.md
│  └─ website/MEMORY.md
└─ sources/
   ├─ collaboration-notes.txt
   └─ skills-index.md
```

`global_memory.md` 是唯一的初始化入口，按顺序记录聊天协作规范、项目位置、技能路径。项目导航就在该文件的 `codex-projects:start/end` 标记区内，用 JSON 数组保存，避免同时维护独立 INDEX.md。`withMemory` 解析该区得到结构化导航，正文、导航来自同一文件。

项目条目包含 `id`、`name`、`workspace`；本地 workspace 必须是绝对路径，尚未指定或远程项目用 null。远程项目额外记录 `server` 和 POSIX `remotePath`；`locationStatus` 可区分 unconfirmed、recorded、verified。项目记忆文件统一按 ID 派生，ID 支持小写字母、数字、横线和下划线。

项目由用户明确登记，目录名称本身不构成项目。以上目录树仅为结构示例，不是内置项目清单。尚未确定的工作位置保持 null，不能用当前默认目录填充。可直接复制 examples/memory 下的通用模板开始配置。

## 按需读取

- 每轮及 `/new` 首轮只读取 `global_memory.md`。保留 Markdown 标题与正文，单文件上限 64 KiB；不会因尾部导航而丢弃前面的聊天规范。
- 初始化不读取或 stat 项目 MEMORY.md，不读取 SKILL.md，不读取来源文档与技能目录正文。技能路径只是入口。
- 用户明确切入项目后，agent 才用文件工具读取对应项目记忆。远程仓库通过全局入口指向的 server-login 技能和 MCP 访问；未指定路径的项目需先确定位置，不能假定 cwd。
- 记忆不会自动切换工作目录、扩大 allowedWorkspaces 或授予执行权限。旧线程原有上下文保留；新建会话执行新的初始化规则。

## 保存与管理

```codex-weixin-memory
{"updates":[{"scope":"global","operation":"remember","text":"通用沟通约定"},{"scope":"project","projectId":"research_b","operation":"remember","text":"[进度] 已确认的项目进度"}]}
```

每次项目保存都必须提供已登记的 projectId。**已取消根据 cwd 自动建立项目**。全局新约定插入聊天规范区，项目导航区保持完整；项目更新不会因会话位于其他 cwd 而写错项目。forget 精确匹配单行事实，重复保存去重，写入采用最新内容和原子替换。多个目标文件分别提交，失败时会提示可能部分保存。原始动作块从最终回复中移除。

新增项目须有用户明确要求。可以编辑全局入口中的导航 JSON，或用 `setMemoryProjects` API；本地项目也可通过 `node scripts/manage-memory.mjs register WORKSPACE NAME ID` 登记。管理工具中的默认 ID 只用于明确的管理命令，不会被会话自动调用。

项目记忆维护目标、当前进度、下一步、关键决策及产物依据；未知内容不编造。全局约定不存具体研究进度或凭据。

## 开发与部署

```powershell
npm ci
npm run typecheck
node --test --import tsx test/memory.test.ts test/format.test.ts test/codex-app-server.test.ts
npm run build
node scripts/install-memory.mjs
```

安装器只更新 memory、format、runner 构建模块并备份，不覆盖微信 API 修复和账号配置；会话空闲后重启加载。上游 npm 更新可能覆盖本地功能，升级前须移植并验证。错误的旧项目记录及旧入口另行归档在 server-tools/memory-layout-backup-*，未删除。

服务器登录技能位于 `~/.codex/skills/server-login/SKILL.md`，由使用者在本机按实际连接工具配置。技能目录列出本机实际存在的路径，缓存版本是否在当前会话启用仍以可用技能和工具为准。

## 验证

类型检查和构建通过；30 项记忆与会话定向测试全部通过，涵盖唯一入口、远程/未开始项目、下划线 ID、忽略旧目录、禁止 cwd 自动建项目、按需读取、定向写回、迁移和会话回退。微信 API 与媒体回归测试 32 项通过。完整 242 项中 237 项通过，5 项与上游基线失败一致，涉及 Windows 上的 macOS 路径、SIGTERM、HOME 与源码安装场景。

源码同时保留当前本机版本的微信 iLink 请求头、run_id、超时和业务错误码处理；日志只表示 API 已接受，不能替代用户的送达确认。

`node scripts/test-memory-live.mjs` 用隔离记忆和真实 Codex 验证问候只读取全局、明确切入项目后读取正文、跨 cwd 按 ID 保存、新会话不带入项目正文。该测试会使用模型额度，不发微信消息。默认调用 PATH 中的 codex；可用 CODEX_BIN 环境变量指定 Codex CLI 或本机包装器。
