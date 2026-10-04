"""Developer diagnostic: offline by default; live only with --live and --confirm-live."""
import argparse
import json
import math
import os
from pathlib import Path
import sys

import probe_once
from usage_summary import summarize

FIXTURE = Path(__file__).resolve().parent / 'fixtures' / 'offline-result.json'


def _int_turns(value):
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def build_summary(payload, record, requested_model, expected_response,
                  max_turns, timeout_seconds, launch_attempts):
    """Public summary. Contains no session id, raw text, paths, or PID."""
    usage = summarize(payload, requested_model)
    result = payload.get('result') if isinstance(payload, dict) else None
    num_turns = _int_turns(payload.get('num_turns')) if isinstance(payload, dict) else None
    status = record.get('status')
    exit_code = record.get('exit_code')
    response_exact_match = isinstance(result, str) and result == expected_response
    # Child success alone is insufficient: the requested response must be present.
    diagnostic_success = (status == 'exited' and type(exit_code) is int
                          and exit_code == 0 and response_exact_match)
    return {
        'requested_model': usage['requested_model'],
        'actual_models': usage['actual_models'],
        'resolved': usage['resolved'],
        'status': status,
        'timed_out': status == 'timeout',
        'exit_code': exit_code,
        'response_exact_match': response_exact_match,
        'diagnostic_success': diagnostic_success,
        'elapsed_seconds': record.get('elapsed_seconds'),
        'timeout_seconds': timeout_seconds,
        'launch_attempts': launch_attempts,
        'configured_max_turns': max_turns,
        'returned_num_turns': num_turns,
    }


def offline(fixture=FIXTURE):
    data = json.loads(Path(fixture).read_text(encoding='utf-8'))
    summary = build_summary(data['payload'], data['record'], data['requested_model'],
                             data['expected_response'], data['max_turns'],
                             data['timeout_seconds'], 0)
    summary['mode'] = 'offline_fixture'
    summary['fixture_recorded_launch_attempts'] = data.get('launch_attempts')
    return summary


def validate_live(args):
    cli = Path(args.cli_path)
    if not cli.is_absolute() or not cli.is_file():
        raise ValueError('cli-path must be an absolute existing file')
    if os.name == 'nt' and cli.suffix.lower() != '.exe':
        raise ValueError('cli-path must be an .exe on Windows')
    if os.name == 'posix' and not os.access(cli, os.X_OK):
        raise ValueError('cli-path must be executable')
    if not args.cli_version.strip():
        raise ValueError('cli-version is required')
    if not args.model or args.model != args.model.strip() or args.model.startswith('-') \
            or any(c.isspace() for c in args.model):
        raise ValueError('exactly one model without whitespace is required')
    if not args.prompt or args.prompt.startswith('-'):
        raise ValueError('prompt must be non-empty and not start with "-"')
    if not args.expected_response:
        raise ValueError('expected-response is required')
    parent = Path(args.private_parent)
    if not parent.is_dir():
        raise ValueError('private-parent must be an existing directory')
    if os.name == 'posix':
        info = parent.stat()
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('private-parent must be owned by current user with mode 0700')
    if not 1 <= args.max_turns <= 12:
        raise ValueError('max-turns must be 1..12')
    if not math.isfinite(args.timeout) or not 1 <= args.timeout <= 180:
        raise ValueError('timeout must be 1..180')


def live_argv(args):
    return [args.cli_path, '--safe-mode', '--restricted', '--tools', '',
            '--strict-mcp-config', '--disallowedTools', 'mcp__*',
            '--model', args.model, '--effort', 'low',
            '--max-turns', str(args.max_turns), '--output-format', 'json',
            '--no-session-persistence', '-p', args.prompt]


def live(args):
    validate_live(args)
    run_dir, record = probe_once.run_once(live_argv(args), args.private_parent, args.timeout)
    try:
        payload = json.loads((run_dir / 'stdout.txt').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        payload = None
    summary = build_summary(payload, record, args.model, args.expected_response,
                            args.max_turns, args.timeout, 1)
    summary['mode'] = 'live'
    report = dict(summary)
    report.update(cli_path=args.cli_path, cli_version=args.cli_version,
                  child_pid=record.get('pid'),
                  direct_child_reaped=record.get('direct_child_reaped'))
    # Private file in the helper's private run directory; raw logs stay beside it.
    probe_once.atomic_json(Path(run_dir) / 'report.json', report)
    return summary


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--live', action='store_true')
    p.add_argument('--confirm-live', action='store_true')
    p.add_argument('--cli-path')
    p.add_argument('--cli-version')
    p.add_argument('--model')
    p.add_argument('--prompt')
    p.add_argument('--expected-response')
    p.add_argument('--private-parent')
    p.add_argument('--max-turns', type=int, default=1)
    p.add_argument('--timeout', type=float, default=60)
    return p


def main(argv=None):
    p = parser()
    args = p.parse_args(argv)
    if args.confirm_live and not args.live:
        p.error('--confirm-live is only valid with --live')
    if args.live and not args.confirm_live:
        p.error('live mode requires both --live and --confirm-live')
    try:
        if args.live:
            missing = [n for n in ('cli_path', 'cli_version', 'model', 'prompt',
                                   'expected_response', 'private_parent')
                       if getattr(args, n) is None]
            if missing:
                raise ValueError('missing live arguments')
            summary = live(args)
        else:
            summary = offline()
    except Exception as exc:
        # Never echo exception text, which could carry private values.
        print(json.dumps({'status': 'diagnostic_error', 'error_type': type(exc).__name__}))
        return 1
    print(json.dumps(summary, indent=2))
    return 0 if summary['diagnostic_success'] else 1


if __name__ == '__main__':
    sys.exit(main())