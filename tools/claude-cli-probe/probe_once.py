"""Single-process diagnostic capture. No shell, retry, or containment guarantee."""
import argparse
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def atomic_json(path, value):
    # Temp file is in the same private directory as the destination.
    fd, name = tempfile.mkstemp(prefix='.record-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as out:
            json.dump(value, out, indent=2)
            out.write('\n')
            out.flush()
            os.fsync(out.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def stop_owned(proc, deadline):
    """Use only the Popen object we created. Never search or signal a saved PID."""
    if proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=max(0, min(1, deadline - time.monotonic())))
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=max(0, deadline - time.monotonic()))


def run_once(argv, parent, timeout=180):
    """parent must already be private to this user; Windows ACLs are inherited."""
    if not math.isfinite(timeout) or not 0 < timeout <= 180:
        raise ValueError('timeout must be finite, greater than zero, at most 180')
    if not argv or not all(isinstance(arg, str) for arg in argv):
        raise ValueError('one explicit argument vector is required')
    executable = Path(argv[0])
    if not executable.is_absolute():
        raise ValueError('executable must be an absolute path')
    if os.name == 'nt' and executable.suffix.lower() != '.exe':
        raise ValueError('Windows requires the actual executable, not a cmd/bat wrapper')
    parent = Path(parent).resolve(strict=True)
    if not parent.is_dir():
        raise ValueError('parent must be an existing private directory')
    if os.name == 'posix':
        info = parent.stat()
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('parent must be owned by current user with mode 0700')
    request_id = str(uuid.uuid4())
    run_dir = Path(tempfile.mkdtemp(prefix='probe-' + request_id + '-', dir=parent))
    record = {'request_id': request_id, 'started_at': utc_now(), 'pid': None,
              'status': 'starting', 'timeout_seconds': timeout}
    # Request/start survive even a normal spawn failure. No argv or environment saved.
    atomic_json(run_dir / 'started.json', record)
    proc = None
    started = time.monotonic()
    deadline = started + timeout
    # Reserve part of the total wait budget for terminating/reaping our direct child.
    reserve = min(2, timeout / 4)
    try:
        with (run_dir / 'stdout.txt').open('xb') as stdout, \
             (run_dir / 'stderr.txt').open('xb') as stderr:
            proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=stdout,
                                    stderr=stderr, shell=False, cwd=run_dir)
            record.update(pid=proc.pid, status='running')
            atomic_json(run_dir / 'started.json', record)
            try:
                proc.wait(timeout=max(0, deadline - reserve - time.monotonic()))
                record['status'] = 'exited'
            except subprocess.TimeoutExpired:
                record['status'] = 'timeout'
    except BaseException as exc:
        record.update(status='error', error_type=type(exc).__name__)
    finally:
        if proc is not None:
            try:
                stop_owned(proc, deadline)
            except BaseException as exc:
                record['cleanup_error_type'] = type(exc).__name__
            record['exit_code'] = proc.returncode
            record['direct_child_reaped'] = proc.returncode is not None
        else:
            record.update(exit_code=None, direct_child_reaped=None)
        record.update(finished_at=utc_now(), elapsed_seconds=time.monotonic() - started)
        atomic_json(run_dir / 'result.json', record)
    return run_dir, record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--private-parent', required=True)
    parser.add_argument('--timeout', type=float, default=180)
    parser.add_argument('argv', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    argv = args.argv[1:] if args.argv[:1] == ['--'] else args.argv
    try:
        path, result = run_once(argv, args.private_parent, args.timeout)
    except BaseException as exc:
        # Do not print arguments, environment, auth, or exception text.
        print(json.dumps({'status': 'launcher_error', 'error_type': type(exc).__name__}))
        return 1
    print(json.dumps({'run_directory': str(path), 'request_id': result['request_id'],
                      'status': result['status'], 'exit_code': result['exit_code']}))
    return 0 if result['status'] == 'exited' and result['exit_code'] == 0 else 1


if __name__ == '__main__':
    raise SystemExit(main())
