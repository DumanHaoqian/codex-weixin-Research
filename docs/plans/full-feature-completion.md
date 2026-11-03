# Remaining research automation delivery

Requested 2026-11-04: implement scheduled analysis, remote experiment submission/monitoring, both GPU modes with handoff, result comparison and literature tracking in this development run. Keep phased pushes.

Implementation and acceptance are separate. The user authorized g8a6000, an isolated directory under `/mnt_nas1/haoqian/Data/codex-research-acceptance`, at most one currently empty GPU, 256 MiB total GPU process memory, 60 seconds of reservation, and an approximately ten-second fixture. Existing keys/credentials remain in the configured MCP helper. Production bridge settings/runtime were not replaced.

| Slice | Code / deterministic integration | Live acceptance |
| --- | --- | --- |
| Durable execution queue and cancellation | implemented; owner/revision/deadline, late-result cancellation, restart tests | exercised through live independent runtime and browser fixture |
| Tool-isolated scheduled analysis and selected-project context | implemented; tool response rejection, context binding, three native CLI protocol tests | existing Codex login produced a real schema-valid report through the text-only firewall; local proxy required |
| Versioned remote supervisor, recipes and job monitor | implemented; tmux, operation receipts, PID/start/boot/group identity, bounded logs, explicit anomalies | two real eight-second CPU fixtures on g8a6000 validated; all seven Python tests passed on Linux |
| GPU launch-when-ready / bounded hold / handoff / release | implemented; stable UUID selection, claims, shared snapshots, process-memory caps, independent TTL, control serialization and ambiguous handoff recovery | all observed cards occupied; bounded wait expired with zero leases/jobs and no GPU allocation. Positive physical holder/handoff remains unverified on a real idle card; fake lifecycle/native-independent deadline tests passed |
| Evidence validation, comparable metrics and report artifacts | implemented; identity/freshness/schema checks, incompatibility reasons, SHA256/owner-scoped downloads and pagination | real CPU receipts/metrics compared; browser-generated report downloaded |
| Incremental Crossref/arXiv discovery and notifications | implemented; bounded windows/pages, stale-cursor reopening, stable version matches, separate outbox | both public providers returned real metadata; simulated failure/resume/version/delivery tests passed; phone receipt not asserted |
| Web/WeChat controls, regression and packaging | implemented; all seven task kinds, dedicated workflow/object/report/paper views and explicit controls | browser create/preview/run/report, literature, held/manual handoff/validated completion/reload/download verified against isolated fixture; see final checks below |

## Phased commits

1. `e228fa9`: durable research backend, isolated analysis, remote helper/protocol, comparison, literature, API/WeChat and initial tests.
2. `517ac49`: Web controls, workflow/report/paper pagination, native stream/proxy compatibility, shared resource sampling, anomaly/restart/control tests.
3. Final documentation/acceptance commit: verified cleanup after deletion/revocation, conservative post-exit GPU evidence, deployment policy/metric examples, final regression and product boundaries (the commit containing this document's final update).

All phases push to `research/codex/research-automation`, never main or the upstream repository. Release automation still owns package versions and release history.

## Reproducible verification

Run in the repository with Node.js 24:

```powershell
npm.cmd run typecheck
npm.cmd run build
$env:RESEARCH_TEST_CODEX_BIN = (Get-Command codex).Source
node --import tsx --test test/automation-*.test.ts
python -m unittest discover -s test -p remote_helper_test.py -v
npm.cmd test
npm.cmd audit
npm.cmd pack --dry-run --ignore-scripts --json
```

The three native protocol tests use an isolated CODEX_HOME and a local mock upstream; they do not use real model credits or research servers. Without `RESEARCH_TEST_CODEX_BIN` they skip explicitly. Python's fcntl concurrency test is Linux-only: Windows reports six pass/one skip; all seven ran successfully on g8a6000.

Real private acceptance receipts remain only in ignored local `output/live-research-acceptance.json`, `output/live-research-acceptance-previous.json` and `output/live-inference-literature.json`, not Git. They contain owned remote job identities, full receipts, immutable metric evidence and comparison; the previous-server-run receipt also preserves the no-allocation waiting outcome. The inference receipt records the real report and provider metadata. The screenshot `output/automation-research-preview.png` is an isolated simulated interface, not a real WeChat delivery or GPU allocation proof.

Final verification: typecheck and build passed; all 58 automation tests passed as part of a 300-test regression (295 pass, the same five baseline failures, zero skips with the native CLI explicitly enabled). The known failures remain macOS CLI PATH selection, overlapping Windows stop/SIGTERM, default workspace startup, Homebrew npm lookup and source-mode updater behavior. They were already isolated on the earlier branch baseline; this task does not claim a green full suite. Python helper: seven pass on Linux, six pass/one native-fcntl skip on Windows. `npm audit` reports zero vulnerabilities. Package dry-run contains 210 entries, including Web assets, the remote helper, and policy/metric examples. The source fixture and its browser tabs are stopped/closed after verification.

## Acceptance findings and boundaries

- Real preflight exposed a Python symlink/canonical allowlist mismatch before a successful launch. Executables in the deployed policy now use their resolved paths; recipe checks also run before effect intent creation. The rejected acceptance attempt had no remote objects or operations and was retained as diagnostic evidence.
- The existing MCP service was not automatically inherited by a new native process. The dedicated background child now explicitly connects the existing service, without modifying user-wide configuration, reading credentials, using shell SSH, or enabling gateway.
- The native text-only path needs explicit HTTP(S)_PROXY/NO_PROXY in this environment. It safely rejects websocket probes/tool outputs and handles verified SSE even if an upstream mislabels its content type.
- Crossref filters require second-precision date strings without milliseconds/Z. Live requests to both providers pass after that correction. Broad queries can remain partial under the page budget; metadata/abstract access is not full-text review.
- Physical GPU positive acceptance could not run inside the empty-device constraint. No existing processes were stopped or displaced, no holder was launched, and the waiting workflow expired normally. A simulation is not evidence of an actual CUDA allocation or release on this driver.
- Phone receipt is still unverified; notifications report `api_accepted`, not delivered. This task did not send real test messages to the user's contacts.
- `job_monitor` attaches helper-owned UUIDs. Arbitrary legacy PID/tmux adoption, Slurm, arbitrary natural-language task parsing, automated memory mutation, and inventing new experiment recipes are not part of these adapters. Fixed authorized recipes and explicit commands remain the execution ingress.
- This finishes the requested five feature implementations on the development branch. It is not a claim that all 42 broad v0.2 product scenarios passed on physical infrastructure, nor a production deployment.
