import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import claude_cli_probe as tool

PRIVATE_ID = '00000000-0000-4000-8000-000000000000'


def run_main(argv):
    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
        try:
            code = tool.main(argv)
        except SystemExit as exc:
            code = exc.code
    return code, out.getvalue()


class OfflineTests(unittest.TestCase):
    def test_default_is_offline_and_never_launches(self):
        with patch.object(tool.probe_once, 'run_once') as run, \
                patch.object(tool.probe_once.subprocess, 'Popen') as popen:
            code, out = run_main([])
        run.assert_not_called()
        popen.assert_not_called()
        self.assertEqual(code, 0)
        summary = json.loads(out)
        self.assertEqual(summary['mode'], 'offline_fixture')
        self.assertEqual(summary['launch_attempts'], 0)
        self.assertEqual(summary['requested_model'], 'sonnet')
        self.assertTrue(summary['resolved'])

    def test_alias_is_not_actual_model_and_actuals_from_model_usage(self):
        summary = tool.offline()
        self.assertNotIn(summary['requested_model'], summary['actual_models'])
        self.assertEqual(summary['actual_models'], ['fictional-model-a', 'fictional-model-b'])
        unresolved = tool.build_summary({'result': 'x', 'model': 'opus'},
                                        {'status': 'exited', 'exit_code': 0},
                                        'opus', 'x', 3, 10, 1)
        self.assertEqual(unresolved['actual_models'], [])
        self.assertFalse(unresolved['resolved'])

    def test_facts_stay_distinct(self):
        s = tool.offline()
        self.assertEqual((s['configured_max_turns'], s['returned_num_turns']), (5, 2))
        self.assertEqual(s['launch_attempts'], 0)
        self.assertEqual(s['fixture_recorded_launch_attempts'], 1)
        self.assertEqual(s['mode'], 'offline_fixture')
        self.assertEqual((s['status'], s['exit_code'], s['timed_out']), ('exited', 0, False))
        self.assertTrue(s['response_exact_match'])
        timeout = tool.build_summary({'result': 'PONG', 'num_turns': 1},
                                     {'status': 'timeout', 'exit_code': -9, 'elapsed_seconds': 9},
                                     'sonnet', 'PONG', 4, 10, 1)
        self.assertTrue(timeout['timed_out'])
        self.assertEqual(timeout['exit_code'], -9)
        self.assertTrue(timeout['response_exact_match'])
        self.assertEqual((timeout['configured_max_turns'], timeout['returned_num_turns']), (4, 1))
        inexact = tool.build_summary({'result': 'PONG '}, {'status': 'exited', 'exit_code': 1},
                                     'sonnet', 'PONG', 4, 10, 1)
        self.assertFalse(inexact['response_exact_match'])
        self.assertIsNone(inexact['returned_num_turns'])

    def test_public_summary_excludes_private_data(self):
        text = json.dumps(tool.offline())
        self.assertNotIn(PRIVATE_ID, text)
        self.assertNotIn('PONG-FICTIONAL', text)
        self.assertNotIn('session', text.lower())


class LiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.parent = Path(self.tmp.name)
        if os.name == 'posix':
            self.parent.chmod(0o700)
        self.addCleanup(self.tmp.cleanup)

    def argv(self, **over):
        values = {'--live': None, '--confirm-live': None, '--cli-path': sys.executable,
                  '--cli-version': 'fictional-1.0', '--model': 'sonnet',
                  '--prompt': 'say PONG', '--expected-response': 'PONG',
                  '--private-parent': str(self.parent), '--max-turns': '3', '--timeout': '30'}
        values.update(over)
        out = []
        for key, value in values.items():
            if value is False:
                continue
            out.append(key)
            if value is not None:
                out.append(value)
        return out

    def fake_run(self, argv, parent, timeout):
        run_dir = Path(parent) / 'probe-fake'
        run_dir.mkdir()
        (run_dir / 'stdout.txt').write_text(json.dumps({
            'result': 'PONG', 'num_turns': 1, 'session_id': PRIVATE_ID,
            'modelUsage': {'fictional-actual': {}}}), encoding='utf-8')
        self.run_dir = run_dir
        return run_dir, {'status': 'exited', 'exit_code': 0, 'pid': 4242,
                         'direct_child_reaped': True, 'elapsed_seconds': 1.5}

    def test_consent_required(self):
        with patch.object(tool.probe_once, 'run_once') as run:
            for argv in (self.argv(**{'--confirm-live': False}),
                         self.argv(**{'--live': False})):
                code, _ = run_main(argv)
                self.assertNotEqual(code, 0)
        run.assert_not_called()

    def test_validation_blocks_launch(self):
        bad = [{'--cli-path': 'relative.exe'}, {'--cli-path': str(self.parent / 'none.exe')},
               {'--cli-version': ' '}, {'--model': 'a b'}, {'--prompt': '--x'},
               {'--private-parent': str(self.parent / 'missing')},
               {'--max-turns': '0'}, {'--max-turns': '13'},
               {'--timeout': '0'}, {'--timeout': '181'}, {'--timeout': 'nan'}]
        with patch.object(tool.probe_once, 'run_once') as run:
            for over in bad:
                argv = self.argv(**over)
                if over.get('--prompt', '').startswith('-'):
                    index = argv.index('--prompt')
                    argv[index:index + 2] = ['--prompt=' + argv[index + 1]]
                code, _ = run_main(argv)
                self.assertEqual(code, 1, over)
        run.assert_not_called()

    def test_live_single_call_argv_and_private_report(self):
        with patch.object(tool.probe_once, 'run_once', side_effect=self.fake_run) as run:
            code, out = run_main(self.argv())
        self.assertEqual(code, 0)
        run.assert_called_once()
        argv = run.call_args[0][0]
        self.assertEqual(argv[0], sys.executable)
        for flag in ('--safe-mode', '--restricted', '--strict-mcp-config',
                     '--no-session-persistence'):
            self.assertIn(flag, argv)
        self.assertEqual(argv[argv.index('--tools') + 1], '')
        self.assertEqual(argv[argv.index('--disallowedTools') + 1], 'mcp__*')
        self.assertEqual(argv[argv.index('--model') + 1], 'sonnet')
        self.assertEqual(argv[argv.index('--effort') + 1], 'low')
        self.assertEqual(argv[argv.index('--max-turns') + 1], '3')
        self.assertEqual(argv[argv.index('--output-format') + 1], 'json')
        self.assertEqual(argv[-1], 'say PONG')
        summary = json.loads(out)
        self.assertEqual(summary['mode'], 'live')
        self.assertEqual(summary['actual_models'], ['fictional-actual'])
        self.assertEqual((summary['configured_max_turns'], summary['returned_num_turns']), (3, 1))
        self.assertNotIn(PRIVATE_ID, out)
        self.assertNotIn('4242', out)
        report = json.loads((self.run_dir / 'report.json').read_text())
        self.assertEqual(report['cli_path'], sys.executable)
        self.assertEqual(report['cli_version'], 'fictional-1.0')
        self.assertEqual(report['child_pid'], 4242)
        self.assertTrue(report['direct_child_reaped'])
        self.assertEqual(report['launch_attempts'], 1)
        self.assertNotIn(PRIVATE_ID, json.dumps(report))


if __name__ == '__main__':
    unittest.main()
