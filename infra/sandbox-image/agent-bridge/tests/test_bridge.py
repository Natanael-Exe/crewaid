#!/usr/bin/env python3

import importlib.util
import json
import pathlib
import subprocess
import sys
import threading
import types
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from unittest import mock

BRIDGE_DIR = pathlib.Path(__file__).resolve().parents[1]
BRIDGE_PATH = BRIDGE_DIR / "bridge.py"
# `spec_from_file_location` loads bridge.py out of its own context, so its
# sibling modules — `seats`, since M5-BE-18 — are not importable the way they
# are when Python runs it as a script and puts its directory on the path. The
# container gets that for free; this harness has to say it.
if str(BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(BRIDGE_DIR))
SPEC = importlib.util.spec_from_file_location("crewaid_agent_bridge", BRIDGE_PATH)
assert SPEC is not None and SPEC.loader is not None
bridge = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = bridge
SPEC.loader.exec_module(bridge)

PNG = bridge.PNG_SIGNATURE + b"test-png"


class BridgeServerTests(unittest.TestCase):
    def test_binds_and_serves_when_the_hostname_is_not_a_valid_dns_name(self):
        # A 64-character hostname (Cloudflare Containers) makes getfqdn raise.
        with mock.patch("socket.getfqdn", side_effect=UnicodeError("label too long")):
            server = bridge.BridgeServer(("127.0.0.1", 0), bridge.BridgeHandler)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            connection = HTTPConnection("127.0.0.1", server.server_port, timeout=2)
            connection.request("GET", "/seats")
            self.assertEqual(connection.getresponse().status, 200)
            connection.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_the_stock_server_is_what_fails_there(self):
        # Keeps the case above honest: without the override the bind raises.
        with mock.patch("socket.getfqdn", side_effect=UnicodeError("label too long")):
            with self.assertRaises(UnicodeError):
                ThreadingHTTPServer(("127.0.0.1", 0), bridge.BridgeHandler)


class ScreenshotTests(unittest.TestCase):
    def test_returns_a_png_and_removes_the_temporary_file(self):
        captured_path = None

        def fake_scrot(argv, **_kwargs):
            nonlocal captured_path
            captured_path = pathlib.Path(argv[-1])
            captured_path.write_bytes(PNG)
            return subprocess.CompletedProcess(argv, 0, b"", b"")

        self.assertEqual(bridge.capture_screenshot(fake_scrot), PNG)
        self.assertIsNotNone(captured_path)
        self.assertFalse(captured_path.exists())

    def test_rejects_output_that_is_not_a_png(self):
        def fake_scrot(argv, **_kwargs):
            pathlib.Path(argv[-1]).write_bytes(b"not an image")
            return subprocess.CompletedProcess(argv, 0, b"", b"")

        with self.assertRaisesRegex(bridge.BridgeFailure, "did not produce a PNG"):
            bridge.capture_screenshot(fake_scrot)


class SkillContractTests(unittest.TestCase):
    def test_accepts_only_a_script_and_object_params(self):
        request = {"script": "export default async function run() {}", "params": {"name": "Ada"}}
        self.assertEqual(bridge.validate_skill_request(request), request)

        invalid = (
            [],
            {"script": "", "params": {}},
            {"script": "export default 1", "params": []},
            {"script": "export default 1", "params": {}, "path": "/tmp/x"},
        )
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                bridge.validate_skill_request(value)


class SkillExecutionTests(unittest.TestCase):
    """M3-PK-01: a valid request executes inside the container via the Node runner."""

    @staticmethod
    def runner(outcome=None, stdout=b"", stderr=b"", returncode=0, captured=None):
        def fake(cmd, **kwargs):
            if captured is not None:
                captured.append((cmd, kwargs))
            if outcome is not None:
                pathlib.Path(cmd[2]).write_text(json.dumps(outcome))
            return subprocess.CompletedProcess(cmd, returncode, stdout, stderr)

        return fake

    def test_executes_via_node_and_returns_the_outcome(self):
        outcome = {"ok": True, "result": {"sum": 42}, "logs": ["added"], "durationMs": 12}
        captured = []
        status, body = bridge.run_skill(
            "export default async () => 1",
            {"a": 1},
            self.runner(outcome=outcome, captured=captured),
        )
        self.assertEqual(status, 200)
        self.assertEqual(body, outcome)
        (cmd, kwargs), = captured
        self.assertEqual(cmd[:2], ["node", bridge.SKILL_RUNNER_PATH])
        self.assertEqual(
            json.loads(kwargs["input"]),
            {"script": "export default async () => 1", "params": {"a": 1}},
        )
        self.assertEqual(kwargs["timeout"], bridge.SKILL_TIMEOUT_S)
        self.assertFalse(pathlib.Path(cmd[2]).exists(), "the outcome file must be cleaned up")

    def test_private_seat_binding_is_in_argv_and_not_skill_params(self):
        captured = []
        seat = {"seatId": "private-seat", "botId": "authorized-bot", "display": ":11", "cdpPort": 9302}
        status, _ = bridge.run_skill(
            "script", {"botId": "another-bot", "cdpEndpoint": "https://outside.invalid"},
            self.runner(outcome={"ok": True}, captured=captured), seat=seat,
        )
        self.assertEqual(status, 200)
        (cmd, kwargs), = captured
        self.assertEqual(cmd[3:], ["http://127.0.0.1:9302", "authorized-bot", "private-seat"])
        self.assertEqual(kwargs["env"]["DISPLAY"], ":11")

    def test_a_script_failure_is_still_a_200_carrying_the_outcome(self):
        outcome = {
            "ok": False,
            "code": "SKILL_EXECUTION_FAILED",
            "detail": "Error: boom",
            "logs": [],
            "durationMs": 3,
        }
        status, body = bridge.run_skill("script", {}, self.runner(outcome=outcome))
        self.assertEqual(status, 200)
        self.assertEqual(body, outcome)

    def test_stray_stdout_from_the_script_does_not_corrupt_the_outcome(self):
        outcome = {"ok": True, "result": None, "logs": [], "durationMs": 1}
        status, body = bridge.run_skill(
            "script", {}, self.runner(outcome=outcome, stdout=b"console.log noise\n")
        )
        self.assertEqual(status, 200)
        self.assertEqual(body, outcome)

    def test_a_missing_runner_is_an_explicit_500(self):
        def explode(_cmd, **_kwargs):
            raise FileNotFoundError("node: not found")

        status, body = bridge.run_skill("script", {}, explode)
        self.assertEqual(status, 500)
        self.assertEqual(body["code"], "SKILL_RUNTIME_FAILED")
        self.assertIn("not runnable", body["detail"])

    def test_a_runner_timeout_is_bounded_and_named(self):
        def timeout(cmd, **_kwargs):
            raise subprocess.TimeoutExpired(cmd, bridge.SKILL_TIMEOUT_S)

        status, body = bridge.run_skill("script", {}, timeout)
        self.assertEqual(status, 500)
        self.assertEqual(body["code"], "SKILL_TIMEOUT")

    def test_a_crashed_runner_reports_bounded_stderr(self):
        status, body = bridge.run_skill(
            "script",
            {},
            self.runner(returncode=1, stderr=b"x" * (bridge.MAX_SKILL_ERROR_CHARS + 50)),
        )
        self.assertEqual(status, 500)
        self.assertEqual(body["code"], "SKILL_RUNTIME_FAILED")
        self.assertEqual(len(body["detail"]), bridge.MAX_SKILL_ERROR_CHARS)

    def test_an_unreadable_outcome_is_reported_not_guessed(self):
        def garbage(cmd, **_kwargs):
            pathlib.Path(cmd[2]).write_text("not json")
            return subprocess.CompletedProcess(cmd, 0, b"", b"")

        status, body = bridge.run_skill("script", {}, garbage)
        self.assertEqual(status, 500)
        self.assertEqual(body["code"], "SKILL_RUNTIME_FAILED")

    def test_an_outcome_without_ok_is_rejected(self):
        def wrong_shape(cmd, **_kwargs):
            pathlib.Path(cmd[2]).write_text(json.dumps({"result": 1}))
            return subprocess.CompletedProcess(cmd, 0, b"", b"")

        status, body = bridge.run_skill("script", {}, wrong_shape)
        self.assertEqual(status, 500)
        self.assertEqual(body["code"], "SKILL_RUNTIME_FAILED")

    def test_the_outcome_file_is_removed_even_when_the_runner_fails(self):
        captured = []
        bridge.run_skill(
            "script", {}, self.runner(returncode=1, stderr=b"boom", captured=captured)
        )
        (cmd, _kwargs), = captured
        self.assertFalse(pathlib.Path(cmd[2]).exists())


class AtspiBrokerTests(unittest.TestCase):
    def test_serializes_and_fans_out_events(self):
        class Source:
            def get_name(self):
                return "Terminal"

            def get_role_name(self):
                return "frame"

        event = types.SimpleNamespace(
            type="window:activate", detail1=1, detail2=2, any_data="ready", source=Source()
        )
        registry_started = threading.Event()

        class Registry:
            @staticmethod
            def registerEventListener(callback, *event_types):
                self.assertEqual(callback.__self__.__class__, bridge.AtspiEventBroker)
                self.assertIn("window", event_types)

            @staticmethod
            def start():
                registry_started.set()

        broker = bridge.AtspiEventBroker()
        with mock.patch.dict(sys.modules, {"pyatspi": types.SimpleNamespace(Registry=Registry)}):
            subscriber = broker.subscribe()
        self.assertTrue(registry_started.wait(1))
        broker.publish(event)
        self.assertEqual(
            subscriber.get_nowait(),
            {
                "type": "window:activate",
                "detail1": 1,
                "detail2": 2,
                "source": {"name": "Terminal", "role": "frame"},
                "anyData": "ready",
            },
        )
        broker.unsubscribe(subscriber)


class HttpContractTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), bridge.BridgeHandler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, method, path, body=None, headers=None):
        connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=2)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def test_screenshot_is_returned_as_uncached_png(self):
        with mock.patch.object(bridge, "capture_screenshot", return_value=PNG):
            status, headers, body = self.request("GET", "/screenshot")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "image/png")
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(body, PNG)

    def test_screenshot_failure_is_an_explicit_503(self):
        with mock.patch.object(
            bridge, "capture_screenshot", side_effect=bridge.BridgeFailure("X is unavailable")
        ):
            status, _headers, body = self.request("GET", "/screenshot")
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(body)["code"], "SCREENSHOT_FAILED")

    def test_valid_skill_request_executes_through_the_in_container_runner(self):
        outcome = {"ok": True, "result": 1, "logs": [], "durationMs": 1}

        def fake_runner(cmd, **_kwargs):
            pathlib.Path(cmd[2]).write_text(json.dumps(outcome))
            return subprocess.CompletedProcess(cmd, 0, b"", b"")

        body = json.dumps({"script": "export default async () => 1", "params": {}})
        seat = {"seatId": "http-test", "botId": "bot", "display": ":10", "cdpPort": 9301}
        with mock.patch.object(bridge, "_run_skill_process", fake_runner), mock.patch.object(bridge.SEATS, "find", return_value=seat):
            status, _headers, encoded = self.request(
                "POST", "/skill/run?botId=bot", body, {"Content-Type": "application/json"}
            )
        # M3-PK-01: a valid request now runs — the 503 placeholder is gone, and
        # the run's outcome is the body.
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(encoded), outcome)

    def test_malformed_skill_request_is_rejected_before_the_runtime_boundary(self):
        body = json.dumps({"script": "", "params": []})
        status, _headers, encoded = self.request(
            "POST", "/skill/run", body, {"Content-Type": "application/json"}
        )
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(encoded)["code"], "INVALID_SKILL_REQUEST")

    def test_skill_request_requires_json_and_enforces_the_body_limit(self):
        status, _headers, encoded = self.request(
            "POST", "/skill/run", "script", {"Content-Type": "text/plain"}
        )
        self.assertEqual(status, 415)
        self.assertEqual(json.loads(encoded)["code"], "UNSUPPORTED_MEDIA_TYPE")

        status, _headers, encoded = self.request(
            "POST",
            "/skill/run",
            b"x",
            {"Content-Type": "application/json", "Content-Length": str(bridge.MAX_SKILL_REQUEST_BYTES + 1)},
        )
        self.assertEqual(status, 413)
        self.assertEqual(json.loads(encoded)["code"], "REQUEST_TOO_LARGE")

    def test_routes_reject_the_wrong_method(self):
        status, headers, _body = self.request("POST", "/screenshot", b"")
        self.assertEqual(status, 405)
        self.assertEqual(headers["Allow"], "GET")

    def test_a_request_a_web_page_made_is_refused_on_every_route(self):
        # A page in a seat's Chrome can send a no-preflight POST to loopback.
        # The browser names its origin; nothing behind it may run.
        key = json.dumps({"publicKey": "A" * 43, "session": "s"})
        with mock.patch.object(bridge.screen_key, "write_screen_key") as write, \
                mock.patch.object(bridge.SEATS, "create") as create, \
                mock.patch.object(bridge, "capture_screenshot", return_value=PNG) as capture:
            for method, path, body in (
                ("POST", "/screen/key", key),
                ("POST", "/seats", ""),
                ("POST", "/seats/seat-1/close", ""),
                ("POST", "/exec", ""),
                ("GET", "/screenshot", None),
                ("GET", "/seats", None),
            ):
                status, _headers, encoded = self.request(
                    method, path, body, {"Origin": "https://attacker.example", "Content-Type": "text/plain"}
                )
                self.assertEqual(status, 403, path)
                self.assertEqual(json.loads(encoded)["code"], "BROWSER_REQUEST_REFUSED")
        write.assert_not_called()
        create.assert_not_called()
        capture.assert_not_called()

    def test_the_same_request_without_an_origin_is_served(self):
        # Presence: the refusal above is about the header, not the route.
        with mock.patch.object(bridge, "capture_screenshot", return_value=PNG):
            status, _headers, body = self.request("GET", "/screenshot")
        self.assertEqual(status, 200)
        self.assertEqual(body, PNG)


if __name__ == "__main__":
    unittest.main()


class _LiveProcess:
    """A process that is running, for tests about bookkeeping rather than desktops.

    D-060's seats reap themselves when a process dies, so a seat assembled by
    hand needs processes that answer `poll() is None` — otherwise `find` is
    right to throw it away and every bookkeeping assertion below tests the
    reaper instead of the thing it meant to.
    """

    def poll(self):
        return None


def _live_seat(seats, *, seat_id: str, bot_id, port: int):
    """A seat as the registry would hold it, minus the desktop."""
    offset = port - seats.SEAT_RFB_PORT_BASE
    process = _LiveProcess()
    return seats.Seat(
        seat_id=seat_id,
        bot_id=bot_id,
        profile=bot_id or "Default",
        display=f":{seats.SEAT_DISPLAY_BASE + offset}",
        rfb_port=port,
        cdp_port=seats.SEAT_CDP_PORT_BASE + offset,
        width=1024,
        height=640,
        _xvfb=process,
        _bus=process,
        _wm=process,
        _dock=process,
        _chrome=process,
        _relay=process,
        _vnc=process,
    )


class SeatRegistryTests(unittest.TestCase):
    """M5-BE-18 — the parts of a seat that do not need a desktop.

    Everything about windows, hints and RFB is measured against a real
    container by `seat-docker.integration.test.ts`; what is here is the
    bookkeeping that decides which port a seat gets and what happens when a
    machine runs out.
    """

    def setUp(self) -> None:
        import seats

        self.seats = seats
        self.registry = seats.SeatRegistry()

    def test_starts_empty(self) -> None:
        self.assertEqual(self.registry.list(), [])

    def test_hands_out_the_lowest_free_port(self) -> None:
        base = self.seats.SEAT_RFB_PORT_BASE
        # One index picks the display, the RFB port and the CDP port together
        # (D-060), so the slot is what is allocated and the ports follow it.
        self.assertEqual(base + self.registry._free_slot(), base)
        self.registry._seats["a"] = self._seat("a", base)
        self.assertEqual(base + self.registry._free_slot(), base + 1)
        # A closed seat gives its port back: a machine that cycled seats all
        # day would otherwise exhaust the range without ever holding more than
        # one at a time.
        self.registry._seats.pop("a")
        self.assertEqual(base + self.registry._free_slot(), base)

    def test_refuses_a_seat_when_every_port_is_taken(self) -> None:
        base = self.seats.SEAT_RFB_PORT_BASE
        for offset in range(self.seats.SEAT_COUNT):
            self.registry._seats[str(offset)] = self._seat(str(offset), base + offset)
        with self.assertRaises(self.seats.SeatError) as raised:
            self.registry._free_slot()
        # The message has to name the bound: an operator reading it is deciding
        # whether to raise the range or start a second computer.
        self.assertIn(str(self.seats.SEAT_COUNT), str(raised.exception))

    def test_closing_a_seat_that_is_not_there_says_so(self) -> None:
        # The caller's retry must not be able to close a seat that has since
        # been reallocated the same port.
        self.assertFalse(self.registry.close("no-such-seat"))

    def _seat(self, seat_id: str, port: int):
        return _live_seat(self.seats, seat_id=seat_id, bot_id=None, port=port)


class SeatRouteTests(unittest.TestCase):
    """The HTTP surface, without a desktop behind it."""

    def test_a_failed_seat_does_not_take_the_bridge_down(self) -> None:
        # A machine that cannot open another window still serves every seat it
        # already has, so the route answers 503 rather than raising.
        import seats

        with mock.patch.object(
            bridge.SEATS, "create", side_effect=seats.SeatError("no window appeared")
        ):
            status, body = _post_json("/seats", {"width": 800, "height": 600})
        self.assertEqual(status, 503)
        self.assertEqual(body["code"], "SEAT_UNAVAILABLE")

    def test_a_geometry_that_is_not_positive_is_refused_before_the_desktop(self) -> None:
        # R8 fixes a seat's size for its lifetime, so a seat that came up at a
        # default the caller did not ask for is worse than no seat: the client
        # has already cached the size it asked for.
        with mock.patch.object(bridge.SEATS, "create") as create:
            status, body = _post_json("/seats", {"width": 0, "height": 600})
        self.assertEqual(status, 400)
        self.assertEqual(body["code"], "INVALID_SEAT_REQUEST")
        create.assert_not_called()

    def test_an_unknown_field_is_refused_rather_than_ignored(self) -> None:
        with mock.patch.object(bridge.SEATS, "create") as create:
            status, body = _post_json("/seats", {"widht": 800})
        self.assertEqual(status, 400)
        self.assertIn("widht", body["detail"])
        create.assert_not_called()

    def test_a_content_length_that_is_not_a_number_is_answered(self) -> None:
        # The alternative is an exception inside the handler, which closes the
        # connection with no reply at all — a caller cannot tell that from a
        # bridge that died.
        def call(port: int):
            conn = HTTPConnection("127.0.0.1", port, timeout=10)
            conn.request("POST", "/seats", None, {"Content-Length": "eight"})
            response = conn.getresponse()
            body = json.loads(response.read())
            conn.close()
            return response.status, body

        status, body = _serve(call)
        self.assertEqual(status, 411)
        self.assertEqual(body["code"], "CONTENT_LENGTH_REQUIRED")

    def test_rejects_a_body_that_is_not_an_object(self) -> None:
        status, body = _post_json("/seats", [1, 2, 3])
        self.assertEqual(status, 400)
        self.assertEqual(body["code"], "INVALID_SEAT_REQUEST")

    def test_lists_seats(self) -> None:
        with mock.patch.object(bridge.SEATS, "list", return_value=[{"seatId": "abc"}]):
            status, body = _get_json("/seats")
        self.assertEqual(status, 200)
        self.assertEqual(body["seats"], [{"seatId": "abc"}])


class SeatContractTests(unittest.TestCase):
    """The geometry boundary: absent takes the default, present is as given or refused."""

    def test_an_absent_field_takes_the_registry_default(self) -> None:
        # No key at all is what tells `SeatRegistry.create` to use its own
        # default; `{"width": 0}` must not mean the same thing.
        self.assertEqual(bridge.validate_seat_request({}), {"url": "about:blank"})
        self.assertEqual(
            bridge.validate_seat_request({"width": 800}),
            {"url": "about:blank", "width": 800},
        )

    def test_geometry_is_passed_through_untouched(self) -> None:
        request = {
            "url": "https://example.test/",
            "width": 1024,
            "height": 640,
            "left": 4,
            "top": 8,
        }
        self.assertEqual(bridge.validate_seat_request(request), request)

    def test_rejects_geometry_the_caller_did_not_mean(self) -> None:
        invalid = (
            {"width": 0},
            {"height": 0},
            {"width": -1},
            {"width": "800"},
            {"height": 600.5},
            {"width": True},
            {"url": ""},
            {"url": 7},
            {"widht": 800},
        )
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                bridge.validate_seat_request(value)


def _serve(callback):
    server = ThreadingHTTPServer(("127.0.0.1", 0), bridge.BridgeHandler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        return callback(server.server_address[1])
    finally:
        server.shutdown()
        server.server_close()


def _post_json(path: str, payload: object):
    def call(port: int):
        conn = HTTPConnection("127.0.0.1", port, timeout=10)
        conn.request(
            "POST", path, json.dumps(payload), {"content-type": "application/json"}
        )
        response = conn.getresponse()
        body = json.loads(response.read())
        conn.close()
        return response.status, body

    return _serve(call)


def _get_json(path: str):
    def call(port: int):
        conn = HTTPConnection("127.0.0.1", port, timeout=10)
        conn.request("GET", path)
        response = conn.getresponse()
        body = json.loads(response.read())
        conn.close()
        return response.status, body

    return _serve(call)


class SeatLabelTests(unittest.TestCase):
    """M5-BE-23 — the machine is the only place a seat is recorded.

    There is no row for a seat anywhere, so the bot id has to travel with it
    or a restarted orchestrator cannot tell which of these windows is whose.
    """

    def setUp(self) -> None:
        import seats

        self.seats = seats
        self.registry = seats.SeatRegistry()

    def _seat(self, seat_id: str, bot_id, port: int):
        return _live_seat(self.seats, seat_id=seat_id, bot_id=bot_id, port=port)

    def test_a_seat_carries_its_bot(self) -> None:
        self.registry._seats["a"] = self._seat("a", "bot-1", 5901)
        self.assertEqual(self.registry.list()[0]["botId"], "bot-1")

    def test_finds_a_seat_by_bot(self) -> None:
        self.registry._seats["a"] = self._seat("a", "bot-1", 5901)
        self.registry._seats["b"] = self._seat("b", "bot-2", 5902)
        self.assertEqual(self.registry.find("bot-2")["seatId"], "b")
        self.assertIsNone(self.registry.find("bot-3"))

    def test_an_unlabelled_seat_is_never_anyones(self) -> None:
        # A seat opened for its own sake must not be handed to the first bot
        # that asks: it would get a window someone else is looking at.
        self.registry._seats["a"] = self._seat("a", None, 5901)
        self.assertIsNone(self.registry.find("bot-1"))

    def test_creating_twice_for_one_bot_returns_the_same_seat(self) -> None:
        # The machine's own guarantee, under the same lock that serializes
        # creation: two turns starting together cannot open two windows.
        self.registry._seats["a"] = self._seat("a", "bot-1", 5901)
        again = self.registry.create(bot_id="bot-1", width=800, height=600)
        self.assertEqual(again["seatId"], "a")
        # And it keeps the size it was created with — R8 is a one-way door.
        self.assertEqual(again["width"], 1024)
        self.assertEqual(len(self.registry.list()), 1)


class SeatLabelValidationTests(unittest.TestCase):
    def test_accepts_an_absent_label(self) -> None:
        self.assertNotIn("bot_id", bridge.validate_seat_request({}))

    def test_refuses_a_label_that_cannot_identify_anything(self) -> None:
        for bad in ("", 7, None, True):
            with self.assertRaises(ValueError, msg=repr(bad)):
                bridge.validate_seat_request({"botId": bad})

    def test_passes_a_good_label_through(self) -> None:
        self.assertEqual(bridge.validate_seat_request({"botId": "bot-1"})["bot_id"], "bot-1")


class SeatProfileTests(unittest.TestCase):
    """M5-BE-27 — a seat may be opened on a NAMED profile, not just the bot's.

    The absence of the field is half the contract: an omitted profile means
    the bot's own (D-056), so a request that always carried one would move
    every bot onto a shared cookie jar and still look like it worked.
    """

    def setUp(self) -> None:
        import seats

        self.seats = seats
        self.registry = seats.SeatRegistry()

    def test_an_absent_profile_stays_absent(self) -> None:
        self.assertNotIn("profile", bridge.validate_seat_request({"botId": "bot-1"}))

    def test_passes_a_named_profile_through(self) -> None:
        request = {"botId": "bot-1", "profile": "company-google"}
        self.assertEqual(bridge.validate_seat_request(request)["profile"], "company-google")

    def test_refuses_a_profile_that_is_not_a_name(self) -> None:
        for bad in ("", 7, None, True):
            with self.assertRaises(ValueError, msg=repr(bad)):
                bridge.validate_seat_request({"profile": bad})

    def test_resolves_the_bots_own_profile_when_none_is_named(self) -> None:
        self.assertEqual(self.seats.resolve_profile("bot-1", None), "bot-1")

    def test_a_named_profile_wins_over_the_bots_own(self) -> None:
        self.assertEqual(self.seats.resolve_profile("bot-1", "company-google"), "company-google")

    def test_refuses_a_profile_that_could_leave_the_user_data_dir(self) -> None:
        # The name reaches `--profile-directory=` and is a path segment under
        # the machine's one `--user-data-dir`. A traversal here is a browser
        # pointed at another directory entirely, so it is refused before
        # Chrome ever sees it.
        for bad in ("..", "../Default", "company/google", "company.google", "x" * 65):
            with self.subTest(bad=bad), self.assertRaises(self.seats.SeatError):
                self.seats.resolve_profile("bot-1", bad)

    def test_refuses_the_machines_own_profile_as_an_identity(self) -> None:
        # `Default` is the entrypoint launch window's. Handing it out as a
        # shared identity would put a bot in the machine's own browser state.
        with self.assertRaises(self.seats.SeatError):
            self.seats.resolve_profile("bot-1", "Default")

    def test_refuses_a_second_profile_for_a_bot_that_already_has_a_seat(self) -> None:
        # A seat's profile is fixed at creation: its browser holds one
        # `--user-data-dir` and Chrome cannot move it (D-060). Answering with
        # the seat the bot has would hand back a desktop on the WRONG identity
        # and look like the switch worked.
        self.registry._seats["a"] = _live_seat(
            self.seats, seat_id="a", bot_id="bot-1", port=self.seats.SEAT_RFB_PORT_BASE
        )
        with self.assertRaises(self.seats.SeatError) as raised:
            self.registry.create(bot_id="bot-1", profile="company-google")
        self.assertIn("company-google", str(raised.exception))
        # And asking again for the profile it HAS is still idempotent.
        again = self.registry.create(bot_id="bot-1", profile="bot-1")
        self.assertEqual(again["seatId"], "a")

    def test_answers_a_query_for_one_bot(self) -> None:
        with mock.patch.object(bridge.SEATS, "find", return_value={"seatId": "a"}) as find:
            status, body = _get_json("/seats?botId=bot-1")
        find.assert_called_once_with("bot-1")
        self.assertEqual(status, 200)
        self.assertEqual(body["seat"], {"seatId": "a"})

    def test_says_so_when_the_bot_has_no_seat(self) -> None:
        # A 404 rather than an empty list: the caller's next move is to create
        # one, and "no seats matched" and "no seats at all" are different.
        with mock.patch.object(bridge.SEATS, "find", return_value=None):
            status, body = _get_json("/seats?botId=bot-1")
        self.assertEqual(status, 404)
        self.assertEqual(body["code"], "NO_SUCH_SEAT")
