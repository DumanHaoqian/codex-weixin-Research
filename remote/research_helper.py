#!/usr/bin/env python3
"""Versioned research supervisor. Install explicitly; never accepts shell code.

Linux only at the executable boundary. Core functions accept injected collectors
for deterministic tests. Real reservation uses the installed CUDA driver.
No password/key/token handling exists in this helper.
"""
import base64
import contextlib
import hashlib
import json
import os
import pathlib
import signal
import subprocess
import sys
import time
import uuid

VERSION = 1
TERMINAL = {"exited", "failed", "released", "expired", "handed_off", "needs_review"}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def load(file):
    with open(file, encoding="utf-8") as stream:
        return json.load(stream)


def atomic(file, value):
    file = pathlib.Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_name(file.name + "." + str(uuid.uuid4()) + ".tmp")
    with open(temporary, "x", encoding="utf-8") as stream:
        os.chmod(temporary, 0o600)
        stream.write(canonical(value))
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, file)
    if os.name == "posix":
        fd = os.open(file.parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


@contextlib.contextmanager
def lock(file, nonblocking=False):
    import fcntl
    file = pathlib.Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    with open(file, "a+b") as stream:
        until = time.monotonic()+10
        while True:
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if nonblocking or time.monotonic() >= until:
                    raise
                time.sleep(0.1)
        try:
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def identity(pid):
    """A PID alone cannot identify a process across reuse or reboot."""
    try:
        boot = pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        stat = pathlib.Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return {"bootId": boot, "pid": pid, "startTicks": stat[19], "pgid": os.getpgid(pid)}
    except (OSError, IndexError):
        return None


def same_process(saved):
    return bool(saved and identity(saved["pid"]) == saved)


def group_alive(saved):
    """A reaped leader does not prove its GPU-using children have exited."""
    if not saved or pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip() != saved['bootId']:
        return False
    for entry in pathlib.Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            fields = (entry/'stat').read_text().rsplit(')', 1)[1].split()
            if fields[0] != 'Z' and int(fields[2]) == saved['pgid'] and int(fields[19]) >= int(saved['startTicks']):
                return True
        except (OSError, ValueError, IndexError):
            continue
    return False


def stop_process(saved, grace=5):
    if not same_process(saved):
        return False
    # Popen(start_new_session=True) makes this process its own group leader.
    if saved["pgid"] != saved["pid"]:
        raise ValueError("unsafe_process_group")
    os.killpg(saved["pgid"], signal.SIGTERM)
    until = time.monotonic() + grace
    while same_process(saved) and time.monotonic() < until:
        time.sleep(0.1)
    if same_process(saved):
        os.killpg(saved["pgid"], signal.SIGKILL)
    return True


def read_bounded(file, limit=65536):
    file = pathlib.Path(file)
    if file.is_symlink() or not file.is_file():
        raise ValueError("missing_or_symlink_artifact")
    if file.stat().st_size > limit:
        raise ValueError("artifact_exceeds_budget")
    return file.read_text(encoding="utf-8")


def child_path(root, relative):
    if not isinstance(relative, str) or not relative or pathlib.PurePosixPath(relative).is_absolute():
        raise ValueError("invalid_relative_artifact")
    target = pathlib.Path(root, relative).resolve()
    if not target.is_relative_to(pathlib.Path(root).resolve()):
        raise ValueError("artifact_outside_root")
    return target


def gpu_snapshot():
    import csv
    gpu = subprocess.run(["nvidia-smi", "--query-gpu=uuid,index,memory.total,memory.used,utilization.gpu", "--format=csv,noheader,nounits"],
                         capture_output=True, text=True, timeout=10, check=True)
    apps = subprocess.run(["nvidia-smi", "--query-compute-apps=gpu_uuid,pid,used_gpu_memory", "--format=csv,noheader,nounits"],
                          capture_output=True, text=True, timeout=10, check=True)
    devices = []
    for row in csv.reader(gpu.stdout.splitlines()):
        gpu_id, index, total, used, utilization = [value.strip() for value in row]
        if not gpu_id.startswith("GPU-"):
            raise ValueError("unsupported_gpu_mapping")
        devices.append({"uuid": gpu_id, "index": int(index), "totalBytes": int(float(total)*1024**2),
                        "usedBytes": int(float(used)*1024**2), "utilization": float(utilization), "pids": []})
    for row in csv.reader(apps.stdout.splitlines()):
        gpu_id, pid, memory = [value.strip() for value in row]
        matches = [device for device in devices if device["uuid"] == gpu_id]
        if len(matches) != 1:
            raise ValueError("gpu_inventory_changed")
        matches[0]["pids"].append(int(pid))
        matches[0].setdefault("processes", []).append({"pid":int(pid),"usedBytes":int(float(memory)*1024**2) if memory not in {"N/A","[N/A]","[Not Supported]"} else None})
    return devices


def select_gpus(snapshot, resource):
    choices = [gpu for gpu in snapshot if (not resource.get("gpuUuids") or gpu["uuid"] in resource["gpuUuids"])
               and gpu["totalBytes"]-gpu["usedBytes"] >= resource["minFreeBytes"]
               and gpu["usedBytes"] <= resource["maxUsedBytes"] and gpu["utilization"] == 0 and not gpu["pids"]]
    choices.sort(key=lambda gpu: gpu["uuid"])
    return [gpu["uuid"] for gpu in choices[:resource["gpuCount"]]] if len(choices) >= resource["gpuCount"] else []


class Helper:
    def __init__(self, root=None, collector=gpu_snapshot):
        self.root = pathlib.Path(root or pathlib.Path.home()/".codex-research")
        self.collector = collector
        if os.name == 'posix':
            policy_file = self.root/'policy.json'
            for item in [self.root, policy_file]:
                if item.is_symlink() or item.stat().st_uid != os.getuid() or item.stat().st_mode & 0o022:
                    raise ValueError('state_or_policy_permissions_unsafe')
            # fcntl coordination belongs on a local filesystem, even when the
            # project and its results live on the shared NAS.
            mounts = []
            for line in pathlib.Path('/proc/mounts').read_text().splitlines():
                fields = line.split()
                if len(fields) >= 3:
                    mount = pathlib.Path(fields[1].replace('\\040', ' '))
                    if self.root.resolve().is_relative_to(mount):
                        mounts.append((len(str(mount)), fields[2]))
            if mounts and max(mounts)[1] in {'nfs', 'nfs4', 'cifs', 'smbfs', 'fuse.sshfs'}:
                raise ValueError('state_requires_local_filesystem')
        self.policy = load(self.root/"policy.json")
        self.boot_id = pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip() if os.name == "posix" else "test"
        machine = pathlib.Path("/etc/machine-id").read_text().strip() if pathlib.Path("/etc/machine-id").exists() else self.boot_id
        self.server_id = hashlib.sha256(machine.encode()).hexdigest()

    def record_file(self, object_id):
        uuid.UUID(object_id)
        return self.root/"objects"/object_id/"manifest.json"

    def validate_recipe(self, recipe):
        root = pathlib.Path(recipe["root"]).resolve()
        if not any(root.is_relative_to(pathlib.Path(item).resolve()) for item in self.policy["allowedRoots"]):
            raise ValueError("recipe_root_not_allowed")
        executable = pathlib.Path(recipe["executable"]).resolve()
        if str(executable) not in self.policy["executables"] or not executable.is_file():
            raise ValueError("recipe_executable_not_allowed")
        if recipe["envRef"] not in self.policy["environments"]:
            raise ValueError("unknown_environment_reference")
        if not root.is_dir() or len(recipe["args"]) > 100 or any(not isinstance(arg, str) or "\0" in arg for arg in recipe["args"]):
            raise ValueError("invalid_recipe")
        return root, executable

    def code_observation(self, recipe):
        root, _ = self.validate_recipe(recipe)
        try:
            head = subprocess.run(["git","-C",str(root),"rev-parse","HEAD"],capture_output=True,text=True,check=True,timeout=5).stdout.strip()
            dirty = bool(subprocess.run(["git","-C",str(root),"status","--porcelain"],capture_output=True,text=True,check=True,timeout=5).stdout.strip())
        except (OSError, subprocess.SubprocessError):
            head, dirty = None, True
        requested = recipe["codeVersion"]
        if requested != "latest_record" and (not requested.startswith("git:") or requested[4:] != head or dirty):
            raise ValueError("pinned_code_version_unverified")
        entrypoints=[]
        for argument in recipe['args']:
            candidate = root/argument
            if not argument.startswith('-') and candidate.is_file() and candidate.resolve().is_relative_to(root) and candidate.stat().st_size <= 1024*1024:
                entrypoints.append({'file':argument,'sha256':hashlib.sha256(candidate.read_bytes()).hexdigest()})
        return {"requested":requested,"gitCommit":head,"dirty":dirty,"entrypoints":entrypoints,"policy":"latest_record" if requested=="latest_record" else "pinned"}

    def response(self, request, state, object_id=None, payload=None):
        result = {"version": VERSION, "operationId": request["operationId"], "payloadHash": request["payloadHash"],
                  "ownerScope": request["ownerScope"], "serverId": self.server_id, "bootId": self.boot_id,
                  "uid": os.getuid() if os.name == "posix" else 0, "remoteNow": int(time.time()*1000), "state": state, "payload": payload or {}}
        if object_id:
            result["objectId"] = object_id
        return result

    def inspect(self, request):
        object_id = request["payload"]["objectId"]
        file = self.record_file(object_id)
        if not file.exists():
            return self.response(request, "not_found", object_id)
        manifest = load(file)
        if manifest["ownerScope"] != request["ownerScope"]:
            raise ValueError("owner_scope_mismatch")
        state = manifest["state"]
        if state in {"running", "held"} and not same_process(manifest.get("process")):
            state = "unknown"  # missing process without an exit record is not success
        result = dict(manifest)
        if state == "running" and manifest.get("kind") == "job" and manifest["spec"].get("selectedGpuUuids"):
            try:
                snapshot = self.collector()
                result["gpuReady"] = all(any(g["uuid"] == gpu and manifest["process"]["pid"] in g["pids"] for g in snapshot)
                                         for gpu in manifest["spec"]["selectedGpuUuids"])
            except Exception:
                result["gpuReady"] = None
        if state == "exited":
            validation = manifest.get("validation", {})
            root = manifest["recipe"]["root"]
            files, errors = {}, []
            for relative in validation.get("requiredFiles", []) + [validation.get("metricsFile", "metrics.json")]:
                try:
                    target = child_path(root, relative)
                    # Reject stale artifacts from an earlier experiment.
                    if target.stat().st_mtime_ns < manifest["startedWallNs"]:
                        raise ValueError("artifact_predates_job")
                    if relative == validation.get("metricsFile", "metrics.json"):
                        text = read_bounded(target, 32768)
                        result["metrics"] = json.loads(text)
                        if result["metrics"].get("jobId") != object_id:
                            raise ValueError("metrics_job_identity_mismatch")
                        files[relative] = {"sha256":hashlib.sha256(text.encode()).hexdigest(),"bytes":len(text.encode()),"readLevel":"complete"}
                    else:
                        if not target.is_file():
                            raise ValueError("required_file_missing")
                        files[relative] = {"bytes":target.stat().st_size,"readLevel":"existence_only"}
                except (OSError, ValueError) as error:
                    errors.append({"file": relative, "reason": str(error)})
            result["artifacts"], result["validationErrors"] = files, errors
            if manifest.get("exitCode") != 0 or errors:
                result["validationState"] = "failed" if manifest.get("exitCode") != 0 else "needs_review"
            else:
                result["validationState"] = "validated"
        log = file.parent/"stdout.log"
        if log.is_file() and not log.is_symlink():
            size = log.stat().st_size
            with open(log, "rb") as stream:
                stream.seek(max(0, size-16384))
                result["logTail"] = stream.read(16384).decode("utf-8", errors="replace")
            result["logBytes"], result["logTruncated"] = size, size > 16384
        return self.response(request, state, object_id, result)

    def handle(self, request):
        if request.get("version") != VERSION:
            raise ValueError("unsupported_protocol")
        uuid.UUID(request["operationId"])
        if len(request["ownerScope"]) != 64:
            raise ValueError("invalid_owner_scope")
        expected = digest({key: request[key] for key in ["action", "target", "ownerScope", "payload"]})
        if request["payloadHash"] != expected:
            raise ValueError("payload_hash_mismatch")
        action, payload = request["action"], request["payload"]
        if action == "preflight":
            import shutil
            import ctypes
            if payload.get('recipe'):
                self.validate_recipe(payload['recipe'])
            try:
                ctypes.CDLL("libcuda.so.1")
                reservation = bool(self.policy.get("reservationPython"))
            except OSError:
                reservation = False
            return self.response(request, "ready", payload={"protocol": VERSION, "tmux": bool(shutil.which("tmux")),
                "helperSha256": hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(), "gpu": self.collector() if payload.get("gpu") else [],
                "reservation": reservation, "maxGpuCount": self.policy.get("maxGpuCount", 1)})
        if action in {"inspect", "reconcile"}:
            if action == "reconcile":
                uuid.UUID(payload['operationId'])
                operation = self.root/"operations"/(payload["operationId"]+".json")
                if not operation.exists():
                    return self.response(request, "not_found")
                saved = load(operation)
                if saved["ownerScope"] != request["ownerScope"] or saved["payloadHash"] != payload["originalHash"]:
                    raise ValueError("operation_identity_mismatch")
                payload["objectId"] = saved["objectId"]
            return self.inspect(request)
        if action == "read":
            root = pathlib.Path(payload["root"]).resolve()
            if not any(root.is_relative_to(pathlib.Path(item).resolve()) for item in self.policy["allowedRoots"]) or len(payload["files"]) > 10:
                raise ValueError("read_outside_grant")
            files = []
            for relative in payload["files"]:
                target = child_path(root, relative)
                if relative == "AGENTS.md" and not target.exists():
                    continue
                files.append({"file":str(target),"text":read_bounded(target),"sha256":hashlib.sha256(target.read_bytes()).hexdigest()})
            return self.response(request, "ready", payload={"files":files})
        if action in {"stop", "release", "handoff"}:
            return self.control(request)
        if action not in {"submit", "reserve"}:
            raise ValueError("unsupported_action")
        self.validate_recipe(payload["recipe"])
        resource = payload["resource"]
        if resource["gpuCount"] > self.policy.get("maxGpuCount", 1):
            raise ValueError("gpu_count_exceeds_policy")
        if action == "reserve":
            if not payload["grant"]["reserve"] or not self.policy.get("reservationPython"):
                raise ValueError("reservation_not_allowed")
            if resource["holderBytes"] <= 0 or resource["holderBytes"] > self.policy["maxHolderBytes"] or resource["holdSeconds"] > self.policy["maxHoldSeconds"]:
                raise ValueError("reservation_exceeds_policy")
        if not payload["grant"]["submit"]:
            raise ValueError("submission_not_granted")
        operation_file = self.root/"operations"/(request["operationId"]+".json")
        with lock(operation_file.with_suffix(".lock")):
            if operation_file.exists():
                old = load(operation_file)
                if old["payloadHash"] != request["payloadHash"] or old["ownerScope"] != request["ownerScope"]:
                    raise ValueError("idempotency_conflict")
                return self.inspect({**request, "payload": {"objectId": old["objectId"]}})
            object_id = payload["objectId"]
            file = self.record_file(object_id)
            if file.exists():
                raise ValueError("object_identity_conflict")
            manifest = {"objectId": object_id, "operationId": request["operationId"], "payloadHash": request["payloadHash"],
                        "ownerScope": request["ownerScope"], "state": "accepted", "kind": "lease" if action == "reserve" else "job", "spec": payload,
                        "recipe": payload["recipe"], "validation": payload["validation"], "createdAt": int(time.time()*1000), "version": 1}
            manifest["codeObservation"] = self.code_observation(payload["recipe"])
            # Persist intent first. A crash after this point is reconciled, never
            # treated as permission to repeat the tmux launch.
            atomic(file, manifest)
            atomic(operation_file, {key: manifest[key] for key in ["objectId", "payloadHash", "ownerScope"]})
            try:
                subprocess.run(["tmux", "new-session", "-d", "-s", "research-"+object_id,
                                sys.executable, str(pathlib.Path(__file__).resolve()), "--supervise", str(self.root), object_id], check=True, timeout=10,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except (subprocess.SubprocessError, OSError):
                manifest["state"] = "unknown"
                atomic(file, manifest)
            return self.response(request, manifest["state"], object_id, {"manifest": str(file)})

    def control(self, request):
        payload = request["payload"]
        file = self.record_file(payload["objectId"])
        with lock(file.with_suffix(".control.lock")):
            manifest = load(file)
            if manifest["ownerScope"] != request["ownerScope"]:
                raise ValueError("owner_scope_mismatch")
            if request["action"] == "stop" and not manifest["spec"]["grant"].get("stop"):
                raise ValueError("job_stop_not_granted")
            if request["action"] in {"release", "handoff"} and manifest["kind"] != "lease":
                raise ValueError("not_a_lease")
            if manifest["state"] in TERMINAL:
                return self.response(request, manifest["state"], manifest["objectId"], manifest)
            pending_file = file.parent/"control.json"
            if pending_file.exists():
                pending = load(pending_file)
                if pending["operationId"] != request["operationId"] or pending["action"] != request["action"]:
                    raise ValueError("control_operation_pending")
                return self.response(request, "accepted", manifest["objectId"], {"cleanupRequested":True})
            if request["action"] == "handoff":
                if manifest["state"] != "held" or int(time.time()*1000) >= manifest["deadline"]:
                    raise ValueError("lease_not_held_or_expired")
                # The supervisor holds the device locks across release/start.
                atomic(file.parent/"control.json", {"action":"handoff", "operationId":request["operationId"], "jobId":payload["jobId"]})
                return self.response(request, "accepted", manifest["objectId"], {"handoffJobId": payload["jobId"]})
            atomic(file.parent/"control.json", {"action":request["action"], "operationId":request["operationId"]})
            return self.response(request, "accepted", manifest["objectId"], {"cleanupRequested":True})

    def supervise(self, object_id):
        file = self.record_file(object_id)
        manifest = load(file)
        spec = manifest["spec"]
        root, executable = self.validate_recipe(spec["recipe"])
        gpus = sorted(spec.get("selectedGpuUuids", []))
        with contextlib.ExitStack() as stack:
            try:
                for gpu in gpus:
                    if not gpu.startswith("GPU-") or any(c not in "0123456789abcdefABCDEF-GPU" for c in gpu):
                        raise ValueError("invalid_gpu_uuid")
                    stack.enter_context(lock(self.root/"locks"/(gpu+".lock"), nonblocking=not bool(manifest.get("handoffFrom"))))
                if gpus:
                    available = select_gpus(self.collector(), {**spec["resource"], "gpuUuids":gpus})
                    if set(available) != set(gpus):
                        raise ValueError("gpu_no_longer_available")
                env = {**os.environ, **self.policy["environments"][spec["recipe"]["envRef"]],
                       "CODEX_RESEARCH_JOB_ID":object_id, "CUDA_VISIBLE_DEVICES":",".join(gpus)}
                manifest["codeObservation"] = self.code_observation(spec["recipe"])
                is_lease = manifest["kind"] == "lease"
                hold_seconds = spec["resource"]["holdSeconds"]
                deadline = min(time.time()+hold_seconds, spec.get("leaseDeadlineMs", int((time.time()+hold_seconds)*1000))/1000)
                manifest["deadline"] = int(deadline*1000) if is_lease else None
                argv = [str(executable), *spec["recipe"]["args"]]
                if is_lease:
                    argv = [self.policy["reservationPython"], str(pathlib.Path(__file__).resolve()), "--hold", str(file), str(max(0,deadline-time.time()))]
                manifest["startedWallNs"] = time.time_ns()
                manifest["startedAt"] = int(time.time()*1000)
                atomic(file, manifest)
                with open(file.parent/"stdout.log", "ab", buffering=0) as output:
                    child = subprocess.Popen(argv, cwd=root, env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
                    saved = identity(child.pid)
                    if not saved:
                        raise ValueError("process_identity_unavailable")
                    manifest["process"] = saved
                    manifest["state"] = "running"
                    atomic(file, manifest)
                    monotonic_deadline = time.monotonic()+max(0,deadline-time.time())
                    runtime_deadline = time.monotonic()+spec.get("maxRuntimeSeconds", 30*86400)
                    while child.poll() is None:
                        control_file = file.parent/"control.json"
                        control = load(control_file) if control_file.exists() else None
                        ready_file = file.parent/"allocation.json"
                        if is_lease and manifest["state"] != "held" and ready_file.exists():
                            ready = load(ready_file)
                            snapshot = self.collector()
                            actual = {g["uuid"] for g in snapshot if child.pid in g["pids"]}
                            if set(gpus).issubset(actual) and ready["process"] == saved:
                                manifest["state"], manifest["allocation"] = "held", ready
                                atomic(file, manifest)
                        expired = is_lease and (time.monotonic()>=monotonic_deadline or time.time()>=deadline)
                        stop_job = not is_lease and spec["grant"].get("stop") and time.monotonic()>=runtime_deadline
                        if control or expired or stop_job:
                            stop_process(saved)
                            child.wait(timeout=10)
                            if is_lease:
                                if group_alive(saved) or any(child.pid in g["pids"] for g in self.collector()):
                                    raise ValueError("release_not_verified")
                                manifest["state"] = "expired" if expired else "released"
                                manifest["releaseVerified"] = True
                                if control and control["action"] == "handoff":
                                    if time.monotonic()>=monotonic_deadline or time.time()>=deadline:
                                        raise ValueError("handoff_expired")
                                    job_id = control["jobId"]
                                    uuid.UUID(job_id)
                                    # Release of memory and start are distinct facts. The
                                    # job supervisor rechecks candidates under these locks.
                                    job = {**manifest, "objectId":job_id, "kind":"job", "state":"accepted", "version":1,
                                           "spec":{**spec,"selectedGpuUuids":gpus}, "handoffFrom":object_id}
                                    job.pop("process", None)
                                    atomic(self.record_file(job_id), job)
                                    manifest["state"], manifest["handoffJobId"] = "unknown", job_id
                                    atomic(file, manifest)
                                    subprocess.run(["tmux","new-session","-d","-s","research-"+job_id,sys.executable,str(pathlib.Path(__file__).resolve()),"--supervise",str(self.root),job_id],check=True,timeout=10)
                                    manifest["state"], manifest["handoffJobId"] = "handed_off", job_id
                            break
                        time.sleep(0.25)
                    if not is_lease:
                        manifest['exitCode'] = child.wait()
                        group_finished = not group_alive(saved)
                        gpu_finished = True
                        if gpus:
                            observed = {g['uuid']: g for g in self.collector()}
                            gpu_finished = all(gpu in observed and not observed[gpu]['pids'] for gpu in gpus)
                        manifest['releaseVerified'] = group_finished and gpu_finished
                        manifest['state'] = 'exited' if group_finished else 'needs_review'
                        if not group_finished:
                            manifest['errorCode'] = 'process_group_still_alive'
                    elif manifest["state"] not in TERMINAL:
                        verified = not same_process(saved) and not any(child.pid in g["pids"] for g in self.collector())
                        manifest["releaseVerified"] = verified
                        manifest["state"] = "expired" if verified and (time.monotonic()>=monotonic_deadline or time.time()>=deadline) else "failed"
                    manifest["endedAt"] = int(time.time()*1000)
                    atomic(file, manifest)
            except Exception as error:
                manifest["state"], manifest["errorCode"] = "needs_review", type(error).__name__+":"+str(error)[:200]
                manifest['releaseVerified'] = not manifest.get('process')
                atomic(file, manifest)


class DriverAllocation:
    """Small explicit CUDA driver allocations; no PyTorch/context-library load.

    Match physical UUIDs rather than treating visible indices as identities.
    GPU process accounting is checked after each bounded allocation chunk.
    """
    def __init__(self, gpu_ids, amount, process_limit, deadline_check=lambda:None, collector=gpu_snapshot):
        import ctypes
        self.ctypes, self.lib, self.contexts, self.blocks = ctypes, ctypes.CDLL("libcuda.so.1"), [], []
        self.collector = collector
        self.lib.cuCtxCreate_v2.argtypes = [ctypes.POINTER(ctypes.c_void_p),ctypes.c_uint,ctypes.c_int]
        self.lib.cuCtxSetCurrent.argtypes = [ctypes.c_void_p]
        self.lib.cuCtxDestroy_v2.argtypes = [ctypes.c_void_p]
        self.lib.cuMemAlloc_v2.argtypes = [ctypes.POINTER(ctypes.c_uint64),ctypes.c_size_t]
        self.lib.cuMemFree_v2.argtypes = [ctypes.c_uint64]
        self.lib.cuMemGetInfo_v2.argtypes = [ctypes.POINTER(ctypes.c_size_t),ctypes.POINTER(ctypes.c_size_t)]
        self.check("cuInit",0)
        count=ctypes.c_int(); self.check("cuDeviceGetCount",ctypes.byref(count))
        devices={}
        for ordinal in range(count.value):
            device=ctypes.c_int();self.check("cuDeviceGet",ctypes.byref(device),ordinal)
            raw=(ctypes.c_ubyte*16)();self.check("cuDeviceGetUuid",ctypes.byref(raw),device)
            devices["GPU-"+str(uuid.UUID(bytes=bytes(raw)))]=device
        try:
            for gpu in gpu_ids:
                deadline_check()
                if gpu not in devices:
                    raise ValueError("unsupported_gpu_uuid")
                context=ctypes.c_void_p();self.check("cuCtxCreate_v2",ctypes.byref(context),0,devices[gpu]);self.contexts.append(context)
                remaining=amount
                while remaining:
                    deadline_check()
                    free,total=ctypes.c_size_t(),ctypes.c_size_t();self.check("cuMemGetInfo_v2",ctypes.byref(free),ctypes.byref(total))
                    used=self.used(gpu)
                    chunk=min(remaining,16*1024**2,process_limit-used-8*1024**2)
                    if chunk<=0 or chunk>free.value-64*1024**2:
                        raise ValueError("allocation_exceeds_process_or_headroom_budget")
                    pointer=ctypes.c_uint64();self.check("cuMemAlloc_v2",ctypes.byref(pointer),chunk);self.blocks.append((context,pointer))
                    if self.used(gpu)>process_limit:
                        raise ValueError("process_memory_budget_exceeded")
                    deadline_check()
                    remaining-=chunk
        except Exception:
            self.close()
            raise

    def check(self,name,*args):
        code=getattr(self.lib,name)(*args)
        if code:
            raise RuntimeError(f"cuda_driver_error:{name}:{code}")

    def used(self,gpu):
        devices=[g for g in self.collector() if g["uuid"]==gpu]
        if len(devices)!=1:
            raise ValueError("gpu_accounting_unavailable")
        processes=[p for p in devices[0].get("processes",[]) if p["pid"]==os.getpid()]
        if any(p["usedBytes"] is None for p in processes):
            raise ValueError("process_memory_accounting_unavailable")
        return sum(p["usedBytes"] for p in processes)

    def close(self):
        for context,pointer in reversed(self.blocks):
            self.lib.cuCtxSetCurrent(context);self.lib.cuMemFree_v2(pointer)
        self.blocks.clear()
        for context in reversed(self.contexts):
            self.lib.cuCtxDestroy_v2(context)
        self.contexts.clear()


def hold(file, seconds, allocator=DriverAllocation):
    """Independent deadline: losing the bridge or supervisor cannot extend TTL."""
    manifest = load(file)
    spec = manifest["spec"]
    amount = spec["resource"]["holderBytes"]
    monotonic_deadline = time.monotonic()+min(seconds, spec["resource"]["holdSeconds"])
    wall_deadline = manifest["deadline"]/1000
    policy=load(pathlib.Path(file).parents[2]/"policy.json")
    allocation=None
    def check_deadline():
        if time.monotonic() >= monotonic_deadline or time.time() >= wall_deadline:
            raise ValueError('holder_deadline_expired')
    try:
        check_deadline()
        allocation=allocator(spec["selectedGpuUuids"],amount,policy.get("maxProcessGpuBytes",amount+64*1024**2),check_deadline)
        check_deadline()
        atomic(pathlib.Path(file).parent/"allocation.json", {"process":identity(os.getpid()),"bytesPerGpu":amount,"gpuUuids":spec["selectedGpuUuids"]})
        while time.monotonic()<monotonic_deadline and time.time()<wall_deadline:
            time.sleep(0.2)
    finally:
        if allocation:
            allocation.close()


def main():
    if os.name != "posix":
        raise SystemExit("Production helper requires Linux")
    if sys.argv[1] == "--supervise":
        Helper(sys.argv[2]).supervise(sys.argv[3])
    elif sys.argv[1] == "--hold":
        hold(sys.argv[2], float(sys.argv[3]))
    else:
        request = json.loads(base64.b64decode(sys.argv[1], validate=True))
        try:
            print(canonical(Helper(sys.argv[2] if len(sys.argv)>2 else None).handle(request)))
        except Exception as error:
            print(canonical({"errorCode":type(error).__name__,"message":str(error)[:200]}))
            raise SystemExit(2)


if __name__ == "__main__":
    main()
