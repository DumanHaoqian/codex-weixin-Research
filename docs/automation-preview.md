# 定时与科研开发预览

本预览代码已从 `codex/research-automation` 合并到 `main`，同时包含持久记忆功能。现已实现提醒、定时 Agent、固定训练方案与监控、两种 GPU 资源方式、结果对比和文献追踪，并提供 Web/微信入口。能力是否可用仍取决于模型、MCP、远端 helper/策略和网络配置。这里记录开发版能力及实测边界，不代表所有真实 GPU/手机环境都完成验收。

## 启动独立预览

需要 Node.js 24 或更新的兼容版本。在仓库根目录安装依赖并构建；建议使用独立状态目录与端口，保留现有微信桥接实例。

PowerShell：

```powershell
npm.cmd install
npm.cmd run build
$env:CODEX_WEIXIN_AUTOMATION = '1'
$env:CODEX_WEIXIN_STATE_DIR = Join-Path $env:LOCALAPPDATA 'codex-weixin-research-preview'
$env:CODEX_WEIXIN_PORT = '8788'
$env:CODEX_WEIXIN_LITERATURE = '1'
node dist/server/index.js --foreground
```

打开 http://127.0.0.1:8788/，在这个独立实例扫码并授权接收人，然后点击“定时与科研”。直接入口是 http://127.0.0.1:8788/automation.html。只有后台服务运行时本机计划才会执行；关闭网页不会停止，终端 Ctrl+C 会关闭前台服务。

活动 SQLite 不支持放在已知 OneDrive 同步目录或 UNC 路径。配置非本机监听地址时，必须同时设置现有 Web 用户名和密码；默认保持本机地址。

需要沿用本机已配置的 HTTP 代理时，在启动预览的同一个终端设置以下变量。确认端口与自己的客户端一致；不要将登录密钥写进命令或仓库。

```powershell
$env:HTTP_PROXY = 'http://127.0.0.1:10808'
$env:HTTPS_PROXY = $env:HTTP_PROXY
$env:NO_PROXY = 'localhost,127.0.0.1,::1'
```

2026-11-04 的真实 Codex 验收在沿用本机此代理后通过。仅 Windows 系统代理开启并不代表 Node.js 的 HTTP 请求已经继承它。

## Web 能力

- 选择已启用账号的授权接收人；创建一次性、每日、每周或固定间隔提醒。
- 明确 IANA 时区，预览未来最多三次触发。一次性当地时刻存在 DST 歧义或根本不存在时，要求选择明确时刻。
- 编辑、暂停、恢复、软删除与立即运行；立即运行不改变原计划。
- 查看运行结果和通知状态；选择“仅保留记录”时不发微信。
- 任务、执行记录和通知每页 50 条，可以翻页查看更早记录；API 支持 `limit`（1–100）与 `cursor`，返回 `nextCursor`。游标只适用于原所有者与原记录类型。
- 失败分片可以恢复；未知/已接受消息默认不重复发送，需要用户明确选择可能重复的重发。
- 创建定时 Agent、训练/等卡/保留与交接、已有 helper 作业监控、实验对比和文献追踪。
- 查看独立科研流程、远端对象、有限日志末尾、结构化报告与文献记录；这些记录也支持所有者隔离的游标分页。
- 分开停止本轮模型执行、停止作业监控、按原授权停止实验、释放本次纯显存保留。

普通时间触发超过五分钟不补跑；电脑离线期间无法观测微信是否送达。调度与通知记录位于独立状态目录的 automation/scheduler.sqlite。

## 微信入口

可直接发送明确提醒，例如：

```text
30分钟后提醒我检查结果
每天9:00提醒我查看今天计划
```

目前是有限语法解析，不声称任意自然语言都支持。其他普通聊天仍按原方式交给 Codex；明确提醒在预览未启用时会告知不可用，不由模型假装已经安排。

```text
/tasks help
/tasks
/tasks add 30m 检查结果
/tasks daily 09:00 查看今天计划
/tasks weekly 1,5 18:00 整理周报
/tasks every 30m 检查结果
/tasks at 2026-12-01T09:00:00+08:00 检查结果
/tasks show <完整任务ID>
/tasks pause <完整任务ID>
/tasks resume <完整任务ID>
/tasks delete <完整任务ID>
/tasks run <完整任务ID>
/tasks edit <完整任务ID> <完整任务JSON>
/tasks create <完整任务JSON>
/tasks agent 30m 整理提供的材料并注明缺失证据
/tasks agent-daily 09:00 生成今日研究计划
/tasks papers 09:00 all:"medical imaging"
/jobs
/jobs show <流程ID>
/jobs handoff <流程ID>
/jobs release <流程ID>
/jobs stop <流程ID>
/jobs stop-monitor <流程ID>
/jobs resume-monitor <流程ID>
/results
/results artifact <产物ID>
/papers
/tasks notifications
/tasks resend <通知ID>
/tasks resend <通知ID> unknown
/tasks resend <通知ID> accepted
```

时长单位支持 s/m/h/d；固定间隔至少五分钟。微信简写时间计划默认 Asia/Shanghai，完整时区可在 Web 中编辑。精确 at 时刻必须带 Z 或显式偏移。

## 通知语义

- 每个分片分别记录；已接受分片不会因后续失败被自动整体重发。
- 没有 context token 时等待原授权联系人发新消息，避免不停请求。明确拒绝后也等待恢复条件。
- HTTP 中断、丢失响应或发送中崩溃标记 unknown，不自动猜测成功或重试。
- api_accepted 只是微信接口接受；本项目没有手机送达回执，不能据此保证手机已收到。
- 重发只处理保存结果，不再运行任务。创建、立即运行与通知重发使用请求身份去重。
- 编辑、暂停、恢复和删除也持久保存请求身份。HTTP 修改接口须带 `Idempotency-Key`；同一请求重试返回原回执，不覆盖之后的新修改。微信使用原消息身份去重，重复编辑不会增加修订。

## 只读 GPU 监控

后台需要已配置并获准的 `compute-server-management` MCP 服务，以及支持 `mcpServer/tool/call` 和可验证只读会话的 Codex app-server。存在本状态目录的 `server-tools/ssh-mcp.mjs` 时，显式启用服务器功能会在独立后台进程内连接该既有服务，不修改用户级 Codex 配置。独立状态目录也需要自行配置/提供这个既有服务；不会复制凭据。2026-11-04 已通过真实后台 MCP 读取 g8a6000。MCP 缺失、拒绝审批或协议不支持都会保持不可用，不改为 shell SSH，也不读写服务器凭据。

在启动**独立预览**的同一个 PowerShell 中显式指定允许观测的 canonical alias，例如：

```powershell
$env:CODEX_WEIXIN_AUTOMATION_GPU_SERVERS = 'g4090,g8a6000'
```

重启独立预览后，Web 的“任务类型”可选择“GPU 占用监控”。服务器目录来自 MCP `servers_list`，任务固定保存服务器/端口/登录用户绑定摘要；绑定改变后旧任务不能自动转移到新目标。`gateway` 继续保留未启用状态。

微信入口：

```text
/tasks gpu g8a6000 1h 观察候选空闲显卡
/gpu
/gpu history
/gpu stop <任务ID>
```

`/tasks gpu` 从收到原消息一秒后开始有期限的监控，重放消息不会延长期限或新建任务。Web 可安排未来开始时间和周期；已经存在本任务的监控时会跳过重复启动。

- 默认采样 15 秒，最小 5 秒；同一轮、同一服务器绑定只采样一次，多个任务共享读数，不调用模型。
- 默认连续两次满足条件才报告候选卡：利用率为零、已用显存不超过 64 MiB、没有计算进程，并满足配置的最低空闲显存与 UUID 筛选。进程存在或显存被占用时不能凭 0% 判空闲。默认策略可按任务配置。
- UUID 是设备身份，索引仅作显示。当前查询同时保存显存、利用率、温度和计算进程；它不是全部图形进程审计。N/A、解析失败、采样过旧、绑定变化或连接拒绝均不能产生“空闲”结果。
- 每账号最多 20 个活动监控。每次监控默认 1 小时、最多 7 天，到期结束观测并通知；它不会保留显存或锁定整卡。
- 首次繁忙读数建立静默基线；之后仅在候选变化、故障、恢复和到期时通知。重复故障与无变化轮次不刷屏。没有微信 context 时沿用通知等待/恢复机制。
- 暂停时间计划不停止已经开始的监控；“停止监控”只停止采样，周期计划仍可在下次触发时再开始。删除任务同时停止其当前监控；以上操作均不会杀训练进程。
- 编辑计划只影响以后开始的监控，已有监控沿用其运行快照。重启恢复原身份和截止时间；过旧样本不会继续累计连续空闲次数。

API：`GET /api/automation/gpu/targets`、`/gpu/watches`、`/gpu/observations`（观测历史支持 `limit/cursor`）；`POST /tasks/<id>/stop-monitor` 需要 `Idempotency-Key`。所有入口沿用账号/联系人授权与 Web 防护。快照、状态、变化事件和通知写入独立预览的 SQLite；现行 schema v4，从 v1/v2/v3 升级前在同目录 `backups/` 保存一致性快照。

候选显卡只是有时间戳的观测，不能据此宣称已排他分配资源。

## 定时 Agent

默认复用原生 Codex 的现有登录状态，每次创建新的临时分析会话。后台验证 `read-only` / `never`，关闭 hooks、MCP、apps、shell、浏览器与记忆更新；额外的本地推理防火墙强制请求 `tools: []` 并拒绝任何工具调用响应。任务只生成经过 schema 校验的报告，不把模型返回的提案或 memory block 当成执行命令。

上下文读取 `memory/global_memory.md` 和显式选中项目的记忆、AGENTS.md、指定资料（单文件 64 KiB、总上下文 512 KiB）。只读取其他项目的导航，不读其正文。远端项目还需要明确的服务器绑定与 helper 读取策略。材料和报告分别保存为不可变、带 SHA256 的产物。

可选原生推理端点配置：`CODEX_WEIXIN_CODEX_INFERENCE_UPSTREAM`（固定 HTTPS Responses URL）、`CODEX_WEIXIN_ANALYSIS_MODEL`。自定义原生 provider 不会被自动猜测或切换。

也可显式选择无工具的 API 分析端口：`CODEX_WEIXIN_ANALYSIS_URL`、`CODEX_WEIXIN_ANALYSIS_MODEL`、`CODEX_WEIXIN_ANALYSIS_KEY`。密钥只从进程环境读取，不写入任务或报告。两种适配器不自动互相回退。

## 训练、等待资源、保留与交接

先按 [远端安装说明](../remote/README.md) 安装并固定 helper 的 SHA256，配置本地磁盘上的策略，再在预览启动进程中指定允许的服务器：

```powershell
$env:CODEX_WEIXIN_RESEARCH_HELPERS = '{"g8a6000":{"path":"/absolute/path/research_helper.py","sha256":"替换为64位SHA256","stateRoot":"/local/disk/codex-research"}}'
```

策略限制目录、解释器、环境引用、GPU 数量、保留显存和时长。缺少 helper、摘要不一致、服务器绑定变化或预检失败时拒绝启动。`gateway` 保持未启用。

- 固定方案包含绝对目录/程序、参数数组、代码版本、环境引用、指标文件、必需产物和明确的提交授权。`latest_record` 记录实测 Git/脚本证据；`git:<完整SHA>` 要求指定提交且工作树干净，不会自行 checkout。
- `immediate` 只尝试当前满足条件的资源；`launch_when_ready` 连续观测后复查再启动；`reserve_then_handoff` 先分配指定显存，再按保存方案手动/自动交接。
- 服务器监督器在独立 tmux 中运行；作业记录 boot ID、PID/start ticks、进程组、UUID 映射、日志位置和退出状态。关闭网页/桥接不会停止已提交训练。
- 纯保留用 CUDA driver 分块分配，检查进程显存预算；单独的 wall/monotonic 期限即使失去本机连接仍生效。释放只能针对自己的纯 lease，交接后的实验不再按 lease 到期清理。
- 提交意图在网络调用前持久化；断线/崩溃恢复核对原操作身份，不能确认时保留 unknown，不自动重新提交。GPU 声明按服务器身份+UUID 排斥内部竞争，真实启动前仍检查其他进程。
- 默认不自动重训；显式重试只处理已知失败，并受总提交预算约束。时长超限只有原方案授予停止权限时才停止，否则通知处理。
- 可在完整任务 JSON 设置 `logStallSeconds` 与 `logAlerts: ["oom", "nan"]`；只有显式阈值才触发停滞提醒，日志匹配属于待核查证据，不自动判死或杀进程。同一异常去重，日志恢复会单独记录。
- `job_monitor` 目前附加本 helper 管理、同一所有者的作业 UUID。任意已有 PID/tmux 作业的导入、Slurm 和自动生成新实验方案不在这个适配器内。

退出码 0 仍须指标 schema、作业 ID、必要产物和新鲜度通过；缺失/冲突是 `needs_review`。只读有限日志末尾，不声称看过全部日志；大型 checkpoint 默认只核验存在与路径。无法验证释放时保留内部资源声明，不能凭本机时间将未知资源当作空闲。

## 结果对比与文献

结果对比从同一所有者已保存的作业指标读取。指标契约见 [示例](../remote/metrics.example.json)：训练程序从 `CODEX_RESEARCH_JOB_ID` 读取作业身份，并在配置目录写入 metrics.json。比较核对 dataset、split、evaluationProtocol、单位、方向和定义；不兼容时不给提升数值。输出带来源的 JSON/Markdown，仅作描述性比较，不把单次实验称为统计显著。

`CODEX_WEIXIN_LITERATURE=1` 启用 Crossref/arXiv。保存固定检索式、索引/更新窗口、游标、稳定标识和版本；每轮页数/字节/请求时间有限制，部分覆盖会明确标记。Crossref 的短期游标过旧时重开同一窗口并按已存身份去重；非常宽的检索式可能持续达到页预算，需收窄查询或增加预算，不能视为全库抓取完成。来源失败保留进度；发现记录与微信通知状态分别保存。Crossref 仅元数据，arXiv 可有摘要，都不会据此声称阅读全文。

科研 API：`GET /research/projects|targets|workflows|objects|artifacts|literature`、`GET /artifacts/<id>`、`POST /research/workflows/<id>/handoff|release|stop|stop_monitor|resume_monitor`、`POST /runs/<id>/cancel`，均位于 `/api/automation` 下。修改必须携带请求身份；列表游标绑定所有者和记录类型。

## 验证与范围

自动测试覆盖 schema v1/v2/v3→v4、模型工具隔离、队列取消、科研重启核对、租约与交接、证据验证、文献恢复、分页及既有调度/投递。`test/fixtures/automation-preview-server.mjs` 的账号、投递、模型、GPU 和文献均为模拟，不会连接真实微信或科研服务器。

阶段状态和测试记录见 [当前交付记录](plans/full-feature-completion.md)。真实 g8a6000 验收已通过两个 8 秒 CPU 小程序的 tmux 启动、监控、指标校验和结果对比；真实 Codex 推理及两个公开文献来源也通过。GPU 等待在无空闲卡时正确到期，没有占用已有进程的卡；真实显存保留/交接正向验收仍待空闲卡。手机实际收件仍没有新验收证据，API 接受不等于送达。源码推送不会替换正在运行的微信桥接。
