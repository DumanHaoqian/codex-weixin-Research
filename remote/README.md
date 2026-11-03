# Research helper deployment

Linux, Python 3.9+, tmux, and a local state disk are required. GPU observation
requires nvidia-smi; physical reservation additionally requires libcuda.so.1.
No PyTorch installation is needed. Keep server credentials in the existing MCP
credential helper. This program never reads credentials or runs a login command.

1. Copy `research_helper.py` (also packaged in `dist/remote/`) to an explicitly
   allowed server directory using the existing authorized MCP service.
2. Create a private **local disk** state directory, for example
   `/tmp/codex-research-<unique-id>` for acceptance, or a persistent local directory
   for production. Do not place locks/state on the project NAS. Set mode 700 and
   keep policy.json owner-controlled, mode 600.
3. Adapt `policy.example.json`. Executable entries must be canonical resolved
   paths, e.g. `str(pathlib.Path(sys.executable).resolve())` for that environment.
   Allow only the relevant project roots; environment references contain explicit
   non-secret environment additions, not shell fragments.
4. Compute SHA256 of the installed helper and configure
   `CODEX_WEIXIN_RESEARCH_HELPERS` in the bridge startup environment. Every request
   verifies this digest before executing the fixed helper entrypoint. Install a
   new version beside a running version and migrate deliberately; do not replace
   code under active supervisors.
5. Make an explicit bounded task via the Web form or `/tasks create <JSON>`.
   Activation and submission preflight validate the recipe, tmux, clock skew and
   current target binding. No normal chat/model report can grant submission or
   reservation authority.

The helper is not a privileged scheduler or hostile-user sandbox. It runs under
the configured research login user and accepts fixed recipes authorized by that
user. Internal UUID locks coordinate this bridge's tasks; they cannot provide an
exclusive allocation against other users or scripts on a shared GPU server.

Jobs and leases have separate manifests beneath `objects/<UUID>/`, operation
receipts beneath `operations/`, bounded log tails, and process identities including
boot ID, PID, start ticks and PGID. Unknown outcomes require reconciliation;
neither bridge nor helper retries a potentially accepted tmux launch. A surviving
child process group prevents a false verified-release conclusion.

Training must write the configured metrics file, using `CODEX_RESEARCH_JOB_ID` as
its jobId and the schema in `metrics.example.json`. Existing artifacts from an
older job or another jobId do not establish success. Large checkpoints can be
listed as required files without downloading their contents.

Pure holders have an independent monotonic/wall deadline and a total per-process
GPU-memory policy cap. CUDA allocation overhead counts toward this cap. If the
driver's process accounting is unavailable or evidence disagrees, reservation
does not qualify as confirmed. A handed-off experiment is a separate job; releasing
the parent lease must never kill that job.

Run `python -m unittest discover -s test -p remote_helper_test.py -v` on Linux
before installation. This includes native fcntl concurrency; the equivalent
Windows test skips that one Linux-only case. Live GPU tests still require an
explicit target, empty device, resource cap, and deadline.
