# Research automation implementation ledger

Baseline: requirements v0.2 and SD-SCHED-001. Branch: codex/research-automation.

This ledger records implementation evidence; an implemented slice is not completion of a milestone.

| Stage | Status | Evidence / remaining work |
| --- | --- | --- |
| Design baseline | committed | Approved requirements and system design preserved in Git |
| M0 capability/storage foundation | in progress | Worker SQLite, transactional schema and fail-closed capability report; authorized MCP transport, restricted agent profile and remote expiry still require implementation/verification |
| M1 general scheduling | in progress | Temporal calendar, owner-scoped task service, revisions, creation idempotency, atomic reminder result/outbox, opt-in runtime and authenticated management API implemented. Web/WeChat controls, manual runs and actual delivery remain pending |
| M2 research observation | pending | Job attach, GPU sampler, monitor and semantic events |
| M3 execution/resources | pending | Recipe grants, remote protocol, both GPU modes, TTL and handoff |
| M4 research results/literature | pending | Validation/comparison and provider cursors |
| M5 E2E/release | pending | All 42 acceptance cases and controlled integration evidence |

No production runtime is updated by these source commits. Real server/GPU tests require an identified test target and bounded recipe/resource grant. No credentials or private memories belong in this branch.

Validation: typecheck/build passed for the storage slice; 9 automation tests pass after the scheduling slice (DST gaps/folds, anchored intervals, ownership, retries, revision conflict, duplicate scans, clock rollback, missed/revoked/paused tasks and research capability gating). These do not establish the 42 end-to-end acceptance cases.

Runtime/API slice: typecheck and production build passed; 40 selected tests passed (11 automation tests plus existing HTTP/account/restart coverage). The preview is OFF by default; CODEX_WEIXIN_AUTOMATION=1 starts the reminder scheduler in the source build. API prefix /api/automation reuses existing Host/login/Origin/request-token checks. Task queries require accountId and senderId, validated against the live enabled account directory. Reminder notifications remain pending in the persisted outbox; this slice does not send them to WeChat. Research/agent activation is explicitly unavailable.
