import threading
import time
import unittest
from unittest import mock
from test_bridge import bridge
import test_bridge
from seat_control import ReplayControl, ControlError
import json
import uuid
import pathlib
import subprocess
import sys
import tempfile


class ReplayFenceTests(unittest.TestCase):
    def setUp(self):
        self.control = ReplayControl()
        self.token = str(uuid.uuid4())

    def test_waits_for_a_preexisting_replay_before_granting(self):
        started = threading.Event()
        finished = threading.Event()
        with self.control.replay('seat'):
            def take():
                started.set()
                self.control.control('seat', 'take', self.token, lease_ms=500, drain_ms=1000)
                finished.set()
            thread = threading.Thread(target=take)
            thread.start()
            self.assertTrue(started.wait(1))
            # The condition is acquired after the replay has started, as a new server would do.
            time.sleep(0.02)
            self.assertFalse(finished.is_set())
            with self.assertRaises(ControlError) as rejected:
                with self.control.replay('seat'):
                    self.fail('a second replay started while draining')
            self.assertEqual(rejected.exception.code, 'HUMAN_IN_CONTROL')
        thread.join(1)
        self.assertTrue(finished.is_set())
        with self.assertRaises(ControlError):
            with self.control.replay('seat'):
                self.fail('replay began during human control')

    def test_timeout_does_not_claim_exclusivity(self):
        with self.control.replay('seat'):
            with self.assertRaises(ControlError) as rejected:
                self.control.control('seat', 'take', self.token, lease_ms=100, drain_ms=1)
            self.assertEqual(rejected.exception.code, 'DRAIN_TIMEOUT')
            with self.control.replay('seat'):
                pass

    def test_expiry_and_stale_cleanup_cannot_end_a_new_holder(self):
        self.control.control('seat', 'take', self.token, lease_ms=1, drain_ms=10)
        time.sleep(0.005)
        newer = str(uuid.uuid4())
        self.control.control('seat', 'take', newer, lease_ms=100, drain_ms=10)
        self.control.control('seat', 'release', self.token)
        with self.assertRaises(ControlError) as rejected:
            self.control.control('seat', 'renew', self.token, lease_ms=100)
        self.assertEqual(rejected.exception.code, 'STALE_EPOCH')
        with self.assertRaises(ControlError):
            with self.control.replay('seat'):
                self.fail('stale cleanup released a newer lease')
        self.control.control('seat', 'release', newer)
        with self.control.replay('seat'):
            pass

    def test_runner_failure_releases_replay_admission_and_other_seats_are_independent(self):
        with self.assertRaises(RuntimeError):
            with self.control.replay('seat'):
                raise RuntimeError('runner failed')
        self.control.control('seat', 'take', self.token, lease_ms=100, drain_ms=10)
        with self.control.replay('other'):
            pass


class ControlHttpTests(unittest.TestCase):
    setUp = test_bridge.HttpContractTests.setUp
    tearDown = test_bridge.HttpContractTests.tearDown
    request = test_bridge.HttpContractTests.request
    # Only new route tests; the common server fixture lives on this base class.
    def control_request(self, request):
        return self.request('POST', '/seats/control?botId=bot', json.dumps(request), {'Content-Type': 'application/json'})

    def test_route_refuses_malformed_and_unscoped_requests(self):
        for body in ({}, {'action': 'take', 'token': str(uuid.uuid4()), 'leaseMs': True, 'drainMs': 10}):
            status, _, _ = self.control_request(body)
            self.assertEqual(status, 400)
        status, _, _ = self.request('POST', '/skill/run', json.dumps({'script': 'export default () => 1', 'params': {}}), {'Content-Type': 'application/json'})
        self.assertEqual(status, 503)

    def test_route_fences_the_actual_replay_dispatch(self):
        seat = {'seatId': 'private', 'botId': 'bot', 'display': ':10', 'cdpPort': 9301}
        token = str(uuid.uuid4())
        with mock.patch.object(bridge.SEATS, 'find', return_value=seat), mock.patch.object(bridge, 'REPLAYS', ReplayControl()):
            status, _, _ = self.control_request({'action': 'take', 'token': token, 'leaseMs': 100, 'drainMs': 10})
            self.assertEqual(status, 200)
            with mock.patch.object(bridge, 'execute_skill_request') as run:
                status, _, body = self.request('POST', '/skill/run?botId=bot', json.dumps({'script': 'script', 'params': {}}), {'Content-Type': 'application/json'})
                self.assertEqual(status, 409)
                self.assertEqual(json.loads(body)['code'], 'HUMAN_IN_CONTROL')
                run.assert_not_called()
            status, _, _ = self.control_request({'action': 'release', 'token': token})
            self.assertEqual(status, 200)


class RunnerProcessFenceTests(unittest.TestCase):
    def test_timeout_reaps_desktop_children_before_releasing_replay(self):
        with tempfile.TemporaryDirectory() as directory:
            proof = str(pathlib.Path(directory) / 'late-input')
            child = "import time,pathlib;time.sleep(0.8);pathlib.Path(" + repr(proof) + ").write_text('ran')"
            parent = "import subprocess,sys,time;subprocess.Popen([sys.executable,'-c'," + repr(child) + "]);time.sleep(5)"
            with self.assertRaises(subprocess.TimeoutExpired):
                bridge._run_skill_process([sys.executable, '-c', parent], input=b'', timeout=0.3)
            time.sleep(0.7)
            self.assertFalse(pathlib.Path(proof).exists(), 'a desktop child survived the timed-out runner')
