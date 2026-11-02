# Research automation implementation ledger

Baseline: requirements v0.2 and SD-SCHED-001. Branch: codex/research-automation.

This ledger records implementation evidence; an implemented slice is not completion of a milestone.

| Stage | Status | Evidence / remaining work |
| --- | --- | --- |
| Design baseline | committed | Approved requirements and system design preserved in Git |
| M0 capability/storage foundation | in progress | Worker SQLite, transactional schema and fail-closed capability report; authorized MCP transport, restricted agent profile and remote expiry still require implementation/verification |
| M1 general scheduling | in progress | Calendar, task service, creation idempotency, result/outbox, opt-in runtime/API and multipart WeChat delivery implemented. Web/WeChat controls, inbound wake wiring and manual runs still in progress |
| M2 research observation | pending | Job attach, GPU sampler, monitor and semantic events |
| M3 execution/resources | pending | Recipe grants, remote protocol, both GPU modes, TTL and handoff |
| M4 research results/literature | pending | Validation/comparison and provider cursors |
| M5 E2E/release | pending | All 42 acceptance cases and controlled integration evidence |

No production runtime is updated by these source commits. Real server/GPU tests require an identified test target and bounded recipe/resource grant. No credentials or private memories belong in this branch.

Validation: typecheck/build passed for the storage slice; 9 automation tests pass after the scheduling slice (DST gaps/folds, anchored intervals, ownership, retries, revision conflict, duplicate scans, clock rollback, missed/revoked/paused tasks and research capability gating). These do not establish the 42 end-to-end acceptance cases.

Runtime/API slice: typecheck and production build passed; 40 selected tests passed (11 automation tests plus existing HTTP/account/restart coverage). The preview is OFF by default; CODEX_WEIXIN_AUTOMATION=1 starts the reminder scheduler in the source build. API prefix /api/automation reuses existing Host/login/Origin/request-token checks. Task queries require accountId and senderId, validated against the live enabled account directory. Reminder notifications remain pending in the persisted outbox; this slice does not send them to WeChat. Research/agent activation is explicitly unavailable.

Baseline comparison: an independent worktree at 50114c5 passed 237/242 tests; implementation at 8c4e3be passed 248/253 with the same five failures, using --test-concurrency=1. Failures concern macOS CLI PATH, overlapping Windows shutdown, default workspace startup, Homebrew npm lookup and source-mode update installation. Parallel runs also intermittently hit restart-fixture cleanup EPERM: the detached entry writes its result before Windows releases its working directory. The fixture now uses bounded asynchronous cleanup retries. Do not report the full suite as passing.

Additional hardening revalidates project bindings at execution and rejects remote automation startup without Web authentication. The current chat exposes no polyu4090 tools, so no real background MCP/server/GPU validation has been performed; M0 remains incomplete.

Latest targeted validation: all 42 selected tests passed, including 13 automation tests and existing HTTP/account/restart coverage, after the bounded Windows fixture cleanup correction. Typecheck and build passed. This count is a test count, not completion of the 42 product acceptance scenarios.

Delivery slice: schema v2 transactionally adds notification parts and attempt linkage while preserving v1 records. Each accepted part is retained; rejected parts can resume, in-flight crash/ambiguous transport become unknown without automatic replay. Missing context waits for a fresh original-sender wake. AccountManager uses the original account, current access and current context; never lastActiveSenderId. Typecheck and 32 selected tests passed (18 automation plus account coverage). Actual phone receipt has not been verified; api_accepted is not delivered. Earlier notes about delivery being unimplemented describe prior commits only.
