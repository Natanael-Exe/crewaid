"""Reservations, stale transitions and singleton proof before login transfer."""
from pathlib import Path
import os
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import seats
from seat_control import ControlError, ReplayControl
from test_bridge import bridge, _live_seat, _get_json


class IdentityHandoffTests(unittest.TestCase):
    def test_failed_read_recovery_returns_refusal_without_dropping_connection(self):
        with mock.patch.object(bridge.SEATS, 'find', side_effect=seats.SeatError('exit uncertain')):
            status, body = _get_json('/seats?botId=bot-a')
        self.assertEqual(status, 503)
        self.assertEqual(body['code'], 'SEAT_UNAVAILABLE')
        self.assertIn('exit uncertain', body['detail'])

    def test_uncertain_shutdown_retains_holder_and_allows_retry(self):
        registry = seats.SeatRegistry()
        seat = _live_seat(seats, seat_id='old', bot_id='bot-a', port=5901)
        seat.profile = 'company'
        registry._seats['old'] = seat
        with mock.patch.object(registry, '_teardown', side_effect=seats.SeatError('exit uncertain')):
            with self.assertRaises(seats.SeatError):
                registry.close('old')
        self.assertIs(registry._seats['old'], seat)
        with self.assertRaisesRegex(seats.SeatError, 'IDENTITY_IN_USE'):
            registry.create(bot_id='bot-b', profile='company')
        with mock.patch.object(registry, '_teardown'):
            self.assertTrue(registry.close('old'))
        self.assertEqual(registry.list(), [])

    def test_close_all_preserves_failed_holder_but_stops_other_seats(self):
        registry = seats.SeatRegistry()
        for key in ('a', 'b'):
            registry._seats[key] = _live_seat(seats, seat_id=key, bot_id=key, port=5901)
        def teardown(seat):
            if seat.seat_id == 'a':
                raise seats.SeatError('uncertain')
        with mock.patch.object(registry, '_teardown', side_effect=teardown):
            with self.assertRaises(seats.SeatError):
                registry.close_all()
        self.assertEqual(list(registry._seats), ['a'])

    def test_failed_start_with_failed_cleanup_keeps_its_slot_reserved(self):
        registry = seats.SeatRegistry()
        with mock.patch.object(registry, '_start', side_effect=RuntimeError('start failed')), \
             mock.patch.object(registry, '_teardown', side_effect=seats.SeatError('stop failed')), \
             mock.patch.object(seats, '_check_capacity'):
            with self.assertRaisesRegex(seats.SeatError, 'stop failed'):
                registry.create(bot_id='bot-a', profile='company')
        self.assertEqual(len(registry.list()), 1)
        self.assertEqual(registry._free_slot(), 1)

    def test_stale_close_and_create_cannot_reuse_an_older_selection(self):
        registry = seats.SeatRegistry()
        old = _live_seat(seats, seat_id='old', bot_id='bot-a', port=5901)
        old.identity_revision = 2
        registry._seats['old'] = old
        registry._selection_revisions['bot-a'] = 2
        with mock.patch.object(registry, '_teardown') as stop:
            with self.assertRaisesRegex(seats.SeatError, 'STALE_IDENTITY'):
                registry.close('old', 1)
            stop.assert_not_called()
            registry.close('old', 3)
        with self.assertRaisesRegex(seats.SeatError, 'STALE_IDENTITY'):
            registry.create(bot_id='bot-a', identity_revision=2)

    def test_shutdown_permission_error_does_not_mean_exit(self):
        process = mock.Mock()
        process.poll.return_value = None
        process.terminate.side_effect = PermissionError('not permitted')
        with self.assertRaisesRegex(seats.SeatError, 'exit could not be confirmed'):
            seats._stop(process)

    def test_shutdown_that_survives_kill_does_not_mean_exit(self):
        process = mock.Mock()
        process.poll.return_value = None
        process.wait.side_effect = subprocess.TimeoutExpired('fixture', 5)
        with self.assertRaises(seats.SeatError):
            seats._stop(process)
        process.kill.assert_called_once()

    def test_live_or_unverifiable_singleton_is_never_removed(self):
        for target in (f'{socket.gethostname()}-{os.getpid()}', 'malformed'):
            with tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                (directory / 'SingletonLock').symlink_to(target)
                (directory / 'SingletonCookie').write_text('keep')
                with self.assertRaisesRegex(seats.SeatError, 'IDENTITY_IN_USE'):
                    seats._clear_singleton(directory)
                self.assertTrue((directory / 'SingletonLock').is_symlink())
                self.assertTrue((directory / 'SingletonCookie').exists())

    def test_dead_or_old_container_singleton_can_be_removed(self):
        for host in (socket.gethostname(), 'old-container'):
            with tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                (directory / 'SingletonLock').symlink_to(f'{host}-999999999')
                with mock.patch.object(os, 'kill', side_effect=ProcessLookupError()):
                    seats._clear_singleton(directory)
                self.assertFalse((directory / 'SingletonLock').is_symlink())

    def test_unknown_singleton_process_is_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / 'SingletonLock').symlink_to(f'{socket.gethostname()}-123')
            with mock.patch.object(os, 'kill', side_effect=PermissionError()):
                with self.assertRaisesRegex(seats.SeatError, 'IDENTITY_IN_USE'):
                    seats._clear_singleton(directory)
            self.assertTrue((directory / 'SingletonLock').is_symlink())

    def test_replay_timeout_preserves_admission_and_does_not_close(self):
        fence = ReplayControl()
        with fence.replay('seat'):
            with self.assertRaises(ControlError) as error:
                with fence.transition('seat', drain_ms=1):
                    self.fail('teardown began with an active replay')
            self.assertEqual(error.exception.code, 'DRAIN_TIMEOUT')
        with fence.replay('seat'):
            pass

    def test_last_replay_does_not_forget_a_pending_close_fence(self):
        fence = ReplayControl()
        teardown = threading.Event()
        finish = threading.Event()
        replay = fence.replay('seat')
        replay.__enter__()
        def close():
            with fence.transition('seat'):
                teardown.set()
                finish.wait(2)
        worker = threading.Thread(target=close)
        worker.start()
        # Access under the authority's own condition: no scheduling sleep is proof.
        with fence._changed:
            self.assertTrue(fence._changed.wait_for(lambda: fence._seat('seat').closing, timeout=2))
        replay.__exit__(None, None, None)
        self.assertTrue(teardown.wait(2))
        try:
            with self.assertRaises(ControlError):
                with fence.replay('seat'):
                    self.fail('closing state was forgotten')
            with self.assertRaises(ControlError):
                fence.control('seat', 'take', 'token', lease_ms=100, drain_ms=10)
        finally:
            finish.set()
            worker.join(2)
        self.assertFalse(worker.is_alive())
        with fence.replay('seat'):
            pass
