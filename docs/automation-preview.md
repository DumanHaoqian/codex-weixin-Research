# 定时与科研开发预览

本预览来自 codex/research-automation 分支。当前可使用提醒调度、微信提醒投递、Web 管理和可选的只读 GPU 监控；完整模型任务、训练管理、占卡与文献能力仍在开发，不能把预览视为 requirements v0.2 已全部交付。

## 启动独立预览

需要 Node.js 24 或更新的兼容版本。在仓库根目录安装依赖并构建；建议使用独立状态目录与端口，保留现有微信桥接实例。

PowerShell：

```powershell
npm.cmd install
npm.cmd run build
$env:CODEX_WEIXIN_AUTOMATION = '1'
$env:CODEX_WEIXIN_STATE_DIR = Join-Path $env:LOCALAPPDATA 'codex-weixin-research-preview'
$env:CODEX_WEIXIN_PORT = '8788'
node dist/server/index.js --foreground
```

打开 http://127.0.0.1:8788/，在这个独立实例扫码并授权接收人，然后点击“定时与科研”。直接入口是 http://127.0.0.1:8788/automation.html。只有后台服务运行时本机计划才会执行；关闭网页不会停止，终端 Ctrl+C 会关闭前台服务。

活动 SQLite 不支持放在已知 OneDrive 同步目录或 UNC 路径。配置非本机监听地址时，必须同时设置现有 Web 用户名和密码；默认保持本机地址。

## Web 能力

- 选择已启用账号的授权接收人；创建一次性、每日、每周或固定间隔提醒。
- 明确 IANA 时区，预览未来最多三次触发。一次性当地时刻存在 DST 歧义或根本不存在时，要求选择明确时刻。
- 编辑、暂停、恢复、软删除与立即运行；立即运行不改变原计划。
- 查看运行结果和通知状态；选择“仅保留记录”时不发微信。
- 任务、执行记录和通知每页 50 条，可以翻页查看更早记录；API 支持 `limit`（1–100）与 `cursor`，返回 `nextCursor`。游标只适用于原所有者与原记录类型。
- 失败分片可以恢复；未知/已接受消息默认不重复发送，需要用户明确选择可能重复的重发。

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

后台需要已配置并获准的 `polyu4090` MCP 服务，以及支持 `mcpServer/tool/call` 和可验证只读会话的 Codex app-server。当前仅完成模拟协议与界面验证，尚未在真实后台 MCP/服务器上验收；不保证仅设置环境变量就能连通。MCP 缺失、拒绝审批或协议不支持都会保持不可用，不改为 shell SSH，也不读写服务器凭据。

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

API：`GET /api/automation/gpu/targets`、`/gpu/watches`、`/gpu/observations`（观测历史支持 `limit/cursor`）；`POST /tasks/<id>/stop-monitor` 需要 `Idempotency-Key`。所有入口沿用账号/联系人授权与 Web 防护。快照、状态、变化事件和通知写入独立预览的 SQLite；v1/v2 升级到 v3 前在同目录 `backups/` 保存一致性快照。

模型执行、训练启动/监控、自动占卡/交接和文献追踪仍不可用。候选显卡只是有时间戳的观测，不能据此宣称已排他分配资源。

## 验证与范围

自动测试覆盖 schema v1/v2→v3、一致性备份、部分发送失败、未知结果、进程重启、访问控制、时区、修订、消息重放和 GPU 监控生命周期。test/fixtures/automation-preview-server.mjs 提供独立视觉测试服务，账号、投递和 GPU 均为模拟，不会连接真实微信、Codex 或科研服务器。

阶段状态和测试记录见 [实施清单](plans/research-automation-implementation.md)。真实微信手机送达与后台 MCP/GPU 环境尚需后续受控验证。
