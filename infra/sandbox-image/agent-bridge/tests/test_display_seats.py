"""Display-seat regressions at the process and bridge boundaries."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import seats
from test_bridge import bridge, _live_seat, _post_json, _get_json, PNG


class DisplaySeatTests(unittest.TestCase):
    def test_screen_failure_restarts_only_vnc_and_keeps_browser(self):
        registry = seats.SeatRegistry()
        seat = _live_seat(seats, seat_id='a', bot_id='bot-a', port=5901)
        browser = seat._chrome
        display = seat._xvfb
        seat._vnc = mock.Mock(poll=mock.Mock(return_value=1))
        registry._seats['a'] = seat
        def restarted(target):
            target._vnc = mock.Mock(poll=mock.Mock(return_value=None))
        with mock.patch.object(registry, '_start_vnc', side_effect=restarted) as restart, \
             mock.patch.object(registry, '_teardown') as teardown:
            self.assertIsNotNone(registry.find('bot-a'))
            self.assertIsNotNone(registry.find('bot-a'))
            restart.assert_called_once_with(seat)
            teardown.assert_not_called()
        self.assertIs(seat._chrome, browser)
        self.assertIs(seat._xvfb, display)

    def test_failed_screen_restart_does_not_reap_a_live_desktop(self):
        registry = seats.SeatRegistry()
        seat = _live_seat(seats, seat_id='a', bot_id='bot-a', port=5901)
        seat._vnc = mock.Mock(poll=mock.Mock(return_value=1))
        registry._seats['a'] = seat
        with mock.patch.object(registry, '_start_vnc', side_effect=seats.SeatError('unavailable')), \
             mock.patch.object(registry, '_teardown') as teardown:
            with self.assertRaisesRegex(seats.SeatError, 'unavailable'):
                registry.find('bot-a')
            teardown.assert_not_called()
        self.assertIs(registry._seats['a'], seat)

    def test_start_paints_the_image_owned_wallpaper_on_the_new_display(self):
        seat = _live_seat(seats, seat_id='a', bot_id='bot-a', port=5901)
        seat.display = ':10'
        with tempfile.TemporaryDirectory() as directory, \
             mock.patch.object(seats, 'AGENT_DIRS_ROOT', Path(directory) / 'agents'), \
             mock.patch.object(seats.Path, 'unlink'), \
             mock.patch.object(seats, '_spawn', return_value=mock.Mock()), \
             mock.patch.object(seats, '_await'), \
             mock.patch.object(seats, '_ran_ok', return_value=True) as run, \
             mock.patch.object(seats.shutil, 'which', return_value='/usr/bin/plank'):
            seats.SeatRegistry()._start(seat)
            self.assertTrue((Path(directory) / 'agents' / 'bot-a').is_dir())
        run.assert_called_once_with(
            ['feh', '--no-fehbg', '--bg-fill', str(seats.WALLPAPER_PATH)], ':10'
        )

    def test_dead_identity_holder_is_stopped_before_reallocation(self):
        registry = seats.SeatRegistry()
        old = _live_seat(seats, seat_id='old', bot_id='bot-a', port=5901)
        old.profile = 'company-google'
        old._xvfb = mock.Mock(poll=mock.Mock(return_value=1))
        registry._seats['old'] = old
        order = []
        with mock.patch.object(registry, '_teardown', side_effect=lambda seat: order.append('stop')), \
             mock.patch.object(registry, '_start', side_effect=lambda *args: order.append('start')), \
             mock.patch.object(seats, '_check_capacity'):
            new = registry.create(bot_id='bot-b', profile='company-google')
        self.assertEqual(order, ['stop', 'start'])
        self.assertEqual(new['rfbPort'], 5901)
        self.assertEqual(len(registry.list()), 1)

    def test_start_relays_chrome_and_checks_the_relay_before_returning(self):
        seat = _live_seat(seats, seat_id='a', bot_id='bot-a', port=5901)
        spawned = []
        probes = []
        def spawn(argv, display):
            spawned.append(argv)
            return mock.Mock(poll=mock.Mock(return_value=None))
        with tempfile.TemporaryDirectory() as directory, \
             mock.patch.object(seats, 'SEAT_PROFILE_ROOT', Path(directory)), \
             mock.patch.object(seats.Path, 'unlink'), \
             mock.patch.object(seats, '_spawn', side_effect=spawn), \
             mock.patch.object(seats, '_ran_ok', return_value=True), \
             mock.patch.object(seats, '_cdp_ready', side_effect=lambda port: probes.append(port) or True), \
             mock.patch.object(seats, '_rfb_ready', return_value=True), \
             mock.patch.object(seats, '_await', side_effect=lambda what, timeout, probe: probe()):
            # D-061: the relay belongs to the BROWSER, which is started on
            # demand rather than with the desktop.
            seats.SeatRegistry()._start_browser(seat)
        chrome = next(argv for argv in spawned if argv[0] == 'google-chrome')
        private_port = seat.cdp_port + seats.SEAT_COUNT
        self.assertIn(f'--remote-debugging-port={private_port}', chrome)
        self.assertIn(['socat', f'TCP4-LISTEN:{seat.cdp_port},bind=0.0.0.0,reuseaddr,fork',
                       f'TCP4:127.0.0.1:{private_port}'], spawned)
        self.assertEqual(probes, [private_port, seat.cdp_port])

    def test_browser_generation_survives_registry_restart_and_clock_rollback(self):
        seat = _live_seat(seats, seat_id='a', bot_id='bot-a', port=5901)
        with tempfile.TemporaryDirectory() as directory, \
             mock.patch.object(seats.time, 'time_ns', return_value=1000000):
            path = Path(directory)
            first = seats.SeatRegistry()
            first._reserve_browser_generation(seat, path)
            self.assertEqual(seat.as_json()['browserGeneration'], 1000)
            first._reserve_browser_generation(seat, path)
            self.assertEqual(seat.browser_generation, 1001)
            with mock.patch.object(seats.time, 'time_ns', return_value=1):
                seats.SeatRegistry()._reserve_browser_generation(seat, path)
            self.assertEqual(seat.browser_generation, 1002)
            self.assertEqual((path / '.crewaid-browser-generation').read_text(), '1002')

    def test_corrupt_or_exhausted_generation_refuses_launch(self):
        seat = _live_seat(seats, seat_id='a', bot_id='bot-a', port=5901)
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / '.crewaid-browser-generation'
            for value in ['broken', '-1', '9007199254740991']:
                marker.write_text(value)
                with self.assertRaises(seats.SeatError):
                    seats.SeatRegistry()._reserve_browser_generation(seat, Path(directory))

    def test_close_flushes_chrome_before_stopping_the_display(self):
        seat = _live_seat(seats, seat_id='a', bot_id='bot-a', port=5901)
        seat._chrome = mock.Mock(poll=mock.Mock(return_value=None))
        order = []
        with mock.patch.object(seats.subprocess, 'run', side_effect=lambda *args, **kw: order.append('flush')), \
             mock.patch.object(seats, '_stop', side_effect=lambda process: order.append('stop')):
            seats.SeatRegistry()._teardown(seat)
        self.assertEqual(order[0], 'flush')
        seat._chrome.wait.assert_called_once_with(timeout=5)

    def test_screenshot_selects_the_requested_display(self):
        seat = {'seatId': 'test-private-b', 'display': ':11', 'cdpPort': 9302}
        # Binary route: assert the subprocess environment without parsing PNG as JSON.
        with mock.patch.object(bridge.SEATS, 'find', return_value=seat), \
             mock.patch.object(bridge, 'capture_screenshot', return_value=PNG) as capture:
            from test_bridge import _serve
            from http.client import HTTPConnection
            def request(port):
                connection = HTTPConnection('127.0.0.1', port)
                connection.request('GET', '/screenshot?botId=bot-b')
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(response.read(), PNG)
                connection.close()
            _serve(request)
        self.assertEqual(capture.call_args.kwargs['environment']['DISPLAY'], ':11')

    def test_missing_seat_never_falls_back_to_machine_display(self):
        with mock.patch.object(bridge.SEATS, 'find', return_value=None), \
             mock.patch.object(bridge, 'capture_screenshot') as capture:
            status, _ = _get_json('/screenshot?botId=missing')
        self.assertEqual(status, 503)
        capture.assert_not_called()

    def test_skill_uses_the_seat_display_and_browser(self):
        seat = {'seatId': 'test-private-b', 'display': ':11', 'cdpPort': 9302}
        def execute(argv, **kwargs):
            self.assertEqual(kwargs['env']['DISPLAY'], ':11')
            self.assertIn('seat11.bus', kwargs['env']['DBUS_SESSION_BUS_ADDRESS'])
            self.assertEqual(argv[3], 'http://127.0.0.1:9302')
            Path(argv[2]).write_text('{"ok":true}')
            return subprocess.CompletedProcess(argv, 0)
        status, result = bridge.run_skill('export default () => 1', {}, execute, seat=seat)
        self.assertEqual(status, 200)
        self.assertTrue(result['ok'])

    def test_skill_route_resolves_bot_without_changing_the_script_body(self):
        seat = {'seatId': 'test-private-b', 'display': ':11', 'cdpPort': 9302}
        with mock.patch.object(bridge.SEATS, 'find', return_value=seat), \
             mock.patch.object(bridge, 'execute_skill_request', return_value=(200, {'ok': True})) as execute:
            status, _ = _post_json('/skill/run?botId=bot-b', {'script': 'x', 'params': {}})
        self.assertEqual(status, 200)
        self.assertEqual(execute.call_args.kwargs['seat'], seat)


class MachineBrowserRemovedTests(unittest.TestCase):
    """D-060 follow-up — the machine runs no browser, and `/health` survives it.

    The machine's own Chrome cost 141 tasks against §5.1's 512-task ceiling for
    a browser no bot worked in once a seat became a display, which is what made
    a second bot's screen fail with "insufficient pids headroom". Removing it is
    the point; these are the two ways removing it could go wrong instead.
    """

    def test_a_machine_with_no_seats_is_healthy_and_browserless(self):
        # The failure this guards is total: `/health` fails if ANY check fails,
        # so a probe of the browser that no longer exists would have marked
        # every container permanently UNHEALTHY and taken the lifecycle with it.
        # The binary is the image's; this suite runs off-image, so it is faked
        # the way every other image-provided dependency here is.
        with mock.patch.object(bridge.shutil, 'which', return_value='/usr/bin/google-chrome'), \
             mock.patch.object(bridge.SEATS, 'list', return_value=[]):
            result = bridge.check_browser()
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['seats'], 0)

    def test_a_seat_whose_browser_died_is_unhealthy_and_named(self):
        # And the signal is not merely preserved, it is sharper than the one it
        # replaces: the old probe watched a browser nobody used, this watches
        # every browser a bot is actually working in.
        # `browserReady` is what makes this a DEAD browser rather than one that
        # was never started (D-061) — the second is ordinary and healthy.
        dead = {'seatId': 'seat-dead', 'cdpPort': 9, 'botId': 'bot-a', 'browserReady': True}
        with mock.patch.object(bridge.shutil, 'which', return_value='/usr/bin/google-chrome'), \
             mock.patch.object(bridge.SEATS, 'list', return_value=[dead]):
            result = bridge.check_browser()
        self.assertFalse(result['ok'], result)
        self.assertIn('seat-dead', str(result['detail']))

    def test_the_entrypoint_starts_no_browser_and_no_machine_relay(self):
        # The saving is only real if nothing starts one again. Asserted against
        # the script rather than a comment, because a re-added `supervise
        # google-chrome` is exactly the regression that would look harmless.
        entrypoint = (Path(__file__).resolve().parents[2] / 'entrypoint.sh').read_text()
        self.assertNotIn('supervise google-chrome', entrypoint)
        self.assertNotIn('supervise cdp-relay', entrypoint)
        # The seat's own relay is the bridge's, and it must still exist there.
        self.assertIn('socat', (Path(__file__).resolve().parents[1] / 'seats.py').read_text())


    def test_a_seat_that_has_not_browsed_yet_is_healthy(self):
        # The trap this guards is the one the machine-browser probe fell into:
        # asking whether a browser nobody started is running, and answering
        # "unhealthy". Under D-061 most seats are in this state most of the
        # time, so getting it wrong would 503 nearly every machine.
        idle = {'seatId': 'seat-idle', 'cdpPort': 9, 'botId': 'bot-a', 'browserReady': False}
        with mock.patch.object(bridge.shutil, 'which', return_value='/usr/bin/google-chrome'), \
             mock.patch.object(bridge.SEATS, 'list', return_value=[idle]):
            result = bridge.check_browser()
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['seats'], 1)
        self.assertEqual(result['browsers'], 0)


class LazyBrowserTests(unittest.TestCase):
    def registry(self):
        registry = seats.SeatRegistry()
        seat = _live_seat(seats, seat_id='a', bot_id='bot-a', port=5901)
        seat._chrome = seat._relay = None
        registry._seats['a'] = seat
        return registry, seat

    def test_idle_desktop_is_live_and_browser_start_is_idempotent(self):
        registry, seat = self.registry()
        self.assertTrue(seat.alive())
        self.assertFalse(registry.find('bot-a')['browserReady'])
        def start(value):
            value._chrome = mock.Mock(poll=mock.Mock(return_value=None))
            value._relay = mock.Mock(poll=mock.Mock(return_value=None))
        with mock.patch.object(seats, '_check_capacity') as capacity, \
             mock.patch.object(seats, '_cdp_ready', return_value=True), \
             mock.patch.object(registry, '_start_browser', side_effect=start) as launch:
            self.assertTrue(registry.ensure_browser('bot-a')['browserReady'])
            registry.ensure_browser('bot-a')
        launch.assert_called_once()
        capacity.assert_called_once_with(pid_reserve=seats.BROWSER_PID_RESERVE,
                                        memory_reserve=seats.BROWSER_MEMORY_RESERVE, what='browser')

    def test_live_pid_with_closed_cdp_is_restarted_before_reporting_ready(self):
        registry, seat = self.registry()
        seat._chrome = mock.Mock(poll=mock.Mock(return_value=None))
        seat._relay = mock.Mock(poll=mock.Mock(return_value=None))
        old_chrome = seat._chrome
        with mock.patch.object(seats, '_check_capacity'), \
             mock.patch.object(seats, '_stop') as stop, \
             mock.patch.object(seats, '_cdp_ready', return_value=False), \
             mock.patch.object(registry, '_start_browser') as launch:
            registry.ensure_browser('bot-a')
        stop.assert_any_call(old_chrome)
        launch.assert_called_once_with(seat)

    def test_cdp_probe_handles_a_refused_or_closed_listener(self):
        for error in [ConnectionRefusedError(), ConnectionResetError()]:
            with mock.patch.object(seats.urllib.request, 'urlopen', side_effect=error):
                self.assertFalse(seats._cdp_ready(9301))

    def test_capacity_refusal_keeps_desktop_and_does_not_launch(self):
        registry, seat = self.registry()
        with mock.patch.object(seats, '_check_capacity', side_effect=seats.SeatError('full')), \
             mock.patch.object(registry, '_start_browser') as launch:
            with self.assertRaisesRegex(seats.SeatError, 'full'):
                registry.ensure_browser('bot-a')
        launch.assert_not_called()
        self.assertTrue(seat.alive())
        self.assertIsNotNone(registry.find('bot-a'))

    def test_failed_launch_cleans_browser_only_and_can_retry(self):
        registry, seat = self.registry()
        def fail(value):
            value._chrome = mock.Mock(poll=mock.Mock(return_value=None))
            raise seats.SeatError('startup failed')
        with mock.patch.object(seats, '_check_capacity'), \
             mock.patch.object(seats, '_stop') as stop, \
             mock.patch.object(registry, '_start_browser', side_effect=fail):
            with self.assertRaisesRegex(seats.SeatError, 'startup failed'):
                registry.ensure_browser('bot-a')
        self.assertIsNone(seat._chrome)
        self.assertTrue(seat.alive())
        self.assertNotIn(mock.call(seat._vnc), stop.call_args_list)

    def test_dead_relay_is_stopped_before_browser_restart_without_reaping_display(self):
        registry, seat = self.registry()
        seat._chrome = mock.Mock(poll=mock.Mock(return_value=None))
        seat._relay = mock.Mock(poll=mock.Mock(return_value=1))
        old_chrome = seat._chrome
        self.assertIsNotNone(registry.find('bot-a'))
        with mock.patch.object(seats, '_check_capacity'), \
             mock.patch.object(seats, '_stop') as stop, \
             mock.patch.object(registry, '_start_browser') as launch:
            registry.ensure_browser('bot-a')
        stop.assert_any_call(old_chrome)
        launch.assert_called_once_with(seat)
        self.assertTrue(seat.alive())

    def test_browser_route_validates_and_reports_capacity(self):
        status, _ = _post_json('/seats/browser', {'botId': ''})
        self.assertEqual(status, 400)
        with mock.patch.object(bridge.SEATS, 'ensure_browser', side_effect=seats.SeatError('full')):
            status, body = _post_json('/seats/browser', {'botId': 'bot-a'})
        self.assertEqual(status, 503)
        self.assertEqual(body['detail'], 'full')


class DockIconBrowserTests(unittest.TestCase):
    """The dock's Chrome icon is a browser start addressed by DISPLAY.

    The icon's launcher knows the DISPLAY plank handed it and nothing else —
    no bot id ever reaches a docked application — so the route takes the
    display as an alternative address, and the image has to point the desktop
    entry at the launcher or the icon keeps running a bare `google-chrome`
    that `cap_drop: ALL` kills before a window appears.
    """

    def registry(self):
        registry = seats.SeatRegistry()
        seat = _live_seat(seats, seat_id='a', bot_id='bot-a', port=5901)
        seat._chrome = seat._relay = None
        registry._seats['a'] = seat
        return registry, seat

    def test_display_lookup_starts_the_seat_on_that_display_only(self):
        registry, seat = self.registry()
        def start(value):
            value._chrome = mock.Mock(poll=mock.Mock(return_value=None))
            value._relay = mock.Mock(poll=mock.Mock(return_value=None))
        with mock.patch.object(seats, '_check_capacity'), \
             mock.patch.object(registry, '_start_browser', side_effect=start) as launch:
            self.assertTrue(registry.ensure_browser_on_display(':10')['browserReady'])
            with self.assertRaisesRegex(seats.SeatError, 'no seat on display :11'):
                registry.ensure_browser_on_display(':11')
        launch.assert_called_once_with(seat)

    def test_a_dead_desktop_found_by_display_is_reaped_not_answered(self):
        registry, seat = self.registry()
        seat._xvfb = mock.Mock(poll=mock.Mock(return_value=1))
        with mock.patch.object(seats, '_stop'), \
             mock.patch.object(registry, '_start_browser') as launch:
            with self.assertRaisesRegex(seats.SeatError, 'no live desktop'):
                registry.ensure_browser_on_display(':10')
        launch.assert_not_called()
        self.assertNotIn('a', registry._seats)

    def test_browser_route_accepts_a_display_and_rejects_bad_addressing(self):
        ready = {'seatId': 'a', 'browserReady': True}
        with mock.patch.object(bridge.SEATS, 'ensure_browser_on_display',
                               return_value=ready) as by_display:
            status, body = _post_json('/seats/browser', {'display': ':10'})
        self.assertEqual(status, 200)
        self.assertTrue(body['seat']['browserReady'])
        by_display.assert_called_once_with(':10')
        # Both addresses is ambiguous and neither is no ask at all; a
        # non-string or empty one is a caller that meant to say and did not.
        for payload in ({'display': ':10', 'botId': 'bot-a'}, {},
                        {'display': 5}, {'display': ''}, {'junk': 1}):
            with self.subTest(payload=payload):
                status, _ = _post_json('/seats/browser', payload)
                self.assertEqual(status, 400)
        with mock.patch.object(bridge.SEATS, 'ensure_browser_on_display',
                               side_effect=seats.SeatError('no seat on display :9')):
            status, body = _post_json('/seats/browser', {'display': ':9'})
        self.assertEqual(status, 503)
        self.assertEqual(body['detail'], 'no seat on display :9')

    def test_the_image_points_the_dock_icon_at_the_bridge_launcher(self):
        # A re-added `Exec=/usr/bin/google-chrome-stable` is exactly the
        # regression that would look harmless and bring the dead icon back,
        # so the wiring is asserted against the Dockerfile the same way the
        # machine-browser removal is asserted against the entrypoint above —
        # and against the launcher, because a script that did not POST to the
        # bridge would make the rewire a fast path to the same crash.
        image = Path(__file__).resolve().parents[2]
        dockerfile = (image / 'Dockerfile').read_text()
        launcher = (image / 'open-seat-browser').read_text()
        self.assertIn('Exec=/opt/crewaid/open-seat-browser', dockerfile)
        self.assertIn('/seats/browser', launcher)
        self.assertIn('display', launcher)

    def test_the_image_installs_the_sky_wallpaper_and_its_renderer(self):
        image = Path(__file__).resolve().parents[2]
        dockerfile = (image / 'Dockerfile').read_text()
        self.assertIn(' feh ', dockerfile)
        self.assertIn('COPY infra/sandbox-image/assets/crewaid-sky-wallpaper.png', dockerfile)
        self.assertTrue((image / 'assets' / 'crewaid-sky-wallpaper.png').is_file())


class BrowserSandboxTests(unittest.TestCase):
    """D-145: Chrome keeps its own sandbox wherever the container allows it."""

    def setUp(self):
        seats._browser_sandbox = None
        self.addCleanup(setattr, seats, '_browser_sandbox', None)

    def chrome_argv(self, sandbox):
        seat = _live_seat(seats, seat_id='a', bot_id='bot-a', port=5901)
        spawned = []
        def spawn(argv, display):
            spawned.append(argv)
            return mock.Mock(poll=mock.Mock(return_value=None))
        with tempfile.TemporaryDirectory() as directory, \
             mock.patch.object(seats, 'SEAT_PROFILE_ROOT', Path(directory)), \
             mock.patch.object(seats.Path, 'unlink'), \
             mock.patch.object(seats, '_spawn', side_effect=spawn), \
             mock.patch.object(seats, 'browser_sandbox', return_value=sandbox), \
             mock.patch.object(seats, '_cdp_ready', return_value=True), \
             mock.patch.object(seats, '_await', side_effect=lambda what, timeout, probe: probe()):
            seats.SeatRegistry()._start_browser(seat)
        return next(argv for argv in spawned if argv[0] == 'google-chrome')

    def test_chrome_keeps_its_sandbox_where_the_container_allows_it(self):
        self.assertNotIn('--no-sandbox', self.chrome_argv(sandbox=True))

    def test_chrome_still_starts_where_the_container_does_not(self):
        # An older orchestrator starts containers under Docker's default
        # profile, where a sandboxed Chrome dies before its first window.
        self.assertIn('--no-sandbox', self.chrome_argv(sandbox=False))

    def test_the_probe_makes_chromes_own_calls_once(self):
        ran = []
        def run(argv, **kwargs):
            ran.append(argv)
            return subprocess.CompletedProcess(argv, 0, b'', b'')
        with mock.patch.object(seats.subprocess, 'run', side_effect=run):
            self.assertTrue(seats.browser_sandbox())
            self.assertTrue(seats.browser_sandbox())
        self.assertEqual(ran, [['unshare', '--user', '--map-root-user', 'chroot', '/', 'true']])

    def test_a_refused_or_missing_probe_means_no_sandbox_and_says_why(self):
        refused = subprocess.CompletedProcess([], 1, b'', b'unshare failed: Operation not permitted')
        for outcome in (mock.Mock(return_value=refused), mock.Mock(side_effect=FileNotFoundError('unshare'))):
            seats._browser_sandbox = None
            with mock.patch.object(seats.subprocess, 'run', outcome), \
                 mock.patch('builtins.print') as log:
                self.assertFalse(seats.browser_sandbox())
            self.assertIn('--no-sandbox', log.call_args.args[0])

    def test_health_reports_the_sandbox_without_failing_on_it(self):
        with mock.patch.object(bridge.shutil, 'which', return_value='/usr/bin/google-chrome'), \
             mock.patch.object(bridge.SEATS, 'list', return_value=[]), \
             mock.patch.object(bridge, 'browser_sandbox', return_value=False):
            result = bridge.check_browser()
        self.assertTrue(result['ok'], result)
        self.assertFalse(result['sandbox'])
