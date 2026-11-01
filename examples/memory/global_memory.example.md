# Global memory

Copy this file to `<state-dir>/memory/global_memory.md` and adapt it to your own instance. Project and skill locations are navigation; their contents are read only when the task needs them.

## 聊天与协作规范

- 先回答当前问题，再说明必要依据和限制。
- 微信正文中的复杂公式和表格使用适合手机阅读的图片。
- 区分已保存、已提交发送和已确认送达。
- 项目目标和进度写进项目记忆，凭据交给本机已有安全机制处理。

## 项目路径

Only explicitly registered projects belong here. A null workspace means the working location has not been selected; it never means the bridge's default cwd. The project's local memory is `projects/<id>/MEMORY.md`, relative to this file's directory.

<!-- codex-projects:start -->
```json
[
  {
    "id": "research-project",
    "name": "Research project",
    "workspace": null,
    "locationStatus": "unconfirmed"
  }
]
```
<!-- codex-projects:end -->

## 技能路径

- Record the absolute path to your own server-login SKILL.md when remote access is configured.
- User skills usually live in `~/.codex/skills`; resolve the actual directory for your machine.
- Read only the skill needed for the task; paths here do not grant new permissions.
