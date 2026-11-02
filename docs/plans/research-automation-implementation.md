# Research automation implementation ledger

Baseline: requirements v0.2 and SD-SCHED-001. Branch: codex/research-automation.

This ledger records implementation evidence; an implemented slice is not completion of a milestone.

| Stage | Status | Evidence / remaining work |
| --- | --- | --- |
| Design baseline | committed | Approved requirements and system design preserved in Git |
| M0 capability/storage foundation | in progress | Worker SQLite, transactional schema and fail-closed capability report; authorized MCP transport, restricted agent profile and remote expiry still require implementation/verification |
| M1 general scheduling | pending | Calendar, application service, runtime, owner-aware API/Web/WeChat and outbox |
| M2 research observation | pending | Job attach, GPU sampler, monitor and semantic events |
| M3 execution/resources | pending | Recipe grants, remote protocol, both GPU modes, TTL and handoff |
| M4 research results/literature | pending | Validation/comparison and provider cursors |
| M5 E2E/release | pending | All 42 acceptance cases and controlled integration evidence |

No production runtime is updated by these source commits. Real server/GPU tests require an identified test target and bounded recipe/resource grant. No credentials or private memories belong in this branch.
