import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import probe_once as probe


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.parent = Path(self.tmp.name)
        if os.name == 'posix':
            self.parent.chmod(0o700)

    def tearDown(self):
        self.tmp.cleanup()  # Tests remove only their own temporary fixture.

    def run_child(self, source, timeout=5):
        return probe.run_once([sys.executable, '-c', source], self.parent, timeout)

    def test_output_exit_and_evidence_survives_cleanup(self):
        path, result = self.run_child("import sys; print('out'); print('err', file=sys.stderr)")
        self.assertEqual(result['exit_code'], 0)
        self.assertEqual(result['status'], 'exited')
        self.assertEqual((path / 'stdout.txt').read_text().strip(), 'out')
        self.assertEqual((path / 'stderr.txt').read_text().strip(), 'err')
        self.assertEqual(json.loads((path / 'result.json').read_text()), result)
        self.assertTrue((path / 'started.json').is_file())
        self.assertTrue(result['direct_child_reaped'])

    def test_nonzero(self):
        _, result = self.run_child('import sys; sys.exit(7)')
        self.assertEqual(result['exit_code'], 7)
        self.assertEqual(result['status'], 'exited')

    def test_timeout(self):
        path, result = self.run_child("import time; print('ready', flush=True); time.sleep(30)", 1)
        self.assertEqual(result['status'], 'timeout')
        self.assertTrue(result['direct_child_reaped'])
        self.assertTrue((path / 'result.json').exists())
        self.assertEqual((path / 'stdout.txt').read_text().strip(), 'ready')

    def test_persisted_before_first_wait(self):
        real_wait = subprocess.Popen.wait
        def checking_wait(proc, *args, **kwargs):
            path = next(self.parent.glob('probe-*'))
            record = json.loads((path / 'started.json').read_text())
            self.assertEqual(record['pid'], proc.pid)
            self.assertTrue(record['request_id'])
            self.assertTrue(record['started_at'])
            self.assertEqual(record['status'], 'running')
            return real_wait(proc, *args, **kwargs)
        with patch.object(subprocess.Popen, 'wait', checking_wait):
            self.run_child('pass')

    def test_already_exited_not_terminated(self):
        proc = subprocess.Popen([sys.executable, '-c', 'pass'])
        proc.wait(timeout=5)
        with patch.object(proc, 'terminate', side_effect=AssertionError('must not terminate')):
            probe.stop_owned(proc, 0)

    def test_spawn_exception_has_final_json(self):
        with patch.object(probe.subprocess, 'Popen', side_effect=OSError('PRIVATE VALUE')):
            path, result = self.run_child('pass')
        self.assertEqual(result['status'], 'error')
        self.assertIsNone(result['pid'])
        self.assertEqual(result['error_type'], 'OSError')
        self.assertNotIn('PRIVATE VALUE', (path / 'result.json').read_text())

    def test_wait_exception_reaps_owned_child_and_retains_evidence(self):
        real_wait = subprocess.Popen.wait
        calls = 0
        def interrupted(proc, *args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise RuntimeError('PRIVATE VALUE')
            return real_wait(proc, *args, **kwargs)
        with patch.object(subprocess.Popen, 'wait', interrupted):
            path, result = self.run_child('import time; time.sleep(30)')
        self.assertEqual(result['status'], 'error')
        self.assertTrue(result['direct_child_reaped'])
        self.assertTrue((path / 'started.json').exists())
        self.assertNotIn('PRIVATE VALUE', (path / 'result.json').read_text())

    def test_invalid_timeout_never_launches(self):
        with patch.object(probe.subprocess, 'Popen') as spawn:
            for value in [0, -1, 181, float('nan'), float('inf')]:
                with self.assertRaises(ValueError):
                    self.run_child('pass', value)
            spawn.assert_not_called()


if __name__ == '__main__':
    unittest.main()
