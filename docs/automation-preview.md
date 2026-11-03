# 定时与科研开发预览

本预览来自 codex/research-automation 分支。当前可使用提醒调度、微信提醒投递和 Web 管理；完整模型任务、科研作业、GPU 与文献能力仍在开发，不能把预览视为 requirements v0.2 已全部交付。

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

## 验证与范围

自动测试覆盖 schema v1→v2、部分发送失败、未知结果、进程重启、访问控制、时区、修订和消息重放。test/fixtures/automation-preview-server.mjs 提供独立视觉测试服务，账号和投递均为模拟，不会连接真实微信、Codex 或科研服务器。

阶段状态和测试记录见 [实施清单](plans/research-automation-implementation.md)。真实微信手机送达与后台 MCP/GPU 环境尚需后续受控验证。
