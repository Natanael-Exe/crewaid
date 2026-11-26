#!/usr/bin/env python3
"""The small, desktop-local surface the harness does not provide (PRD §5.2).

The bridge intentionally uses the Python standard library for HTTP. The
image-provided Python modules it reaches for — ``pyatspi`` for accessibility,
``Xlib`` for a seat's geometry pin — are imported lazily at the call that needs
them, so a broken accessibility stack or a missing X binding fails that one
route instead of taking the health, screenshot and seat routes down with it.
"""

from __future__ import annotations

import json
import os
import re
import queue
import subprocess
import tempfile
import threading
import shutil
import signal
import socketserver
import urllib.error
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable

import exec_stream
import screen_key
from processes import (
    DEFAULT_MAX_DURATION_S,
    MAX_MAX_DURATION_S,
    MAX_WAIT_MS,
    MIN_MAX_DURATION_S,
    ProcessError,
    ProcessLimitError,
    ProcessRegistry,
)
from seats import SeatError, SeatRegistry, _seat_env, browser_sandbox
from seat_control import ControlError, ReplayControl

PORT = int(os.environ.get("AGENT_BRIDGE_PORT", "7070"))
DISPLAY = os.environ.get("DISPLAY", ":1")

PROBE_TIMEOUT_S = 3.0
SCREENSHOT_TIMEOUT_S = 10.0
MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024
MAX_SKILL_REQUEST_BYTES = 256 * 1024
SSE_HEARTBEAT_S = 15.0
SSE_QUEUE_SIZE = 256
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

# M3-PK-01: the skill executor shipped into this image. The runner is a Node
# process inside THIS container (D-040: M2 owns the transport, M3 owns
# execution); the timeout is the bridge's bound on one run, and the outcome
# read is bounded like every other body this bridge touches.
SKILL_RUNNER_PATH = "/opt/skill-runtime/runner.mjs"
SKILL_TIMEOUT_S = 600.0
MAX_SKILL_OUTCOME_BYTES = 4 * 1024 * 1024
MAX_SKILL_ERROR_CHARS = 1_000


# D-046 / M5-BE-18: the machine's seats. One registry per container, because a
# seat is a window on this container's one display and nothing outside it can
# hold the lock that makes seat creation attributable.
SEATS = SeatRegistry()
REPLAYS = ReplayControl()
PROCESSES = ProcessRegistry()


class BridgeFailure(RuntimeError):
    """A bounded bridge operation failed without crashing the bridge itself."""


def _run(*argv: str) -> tuple[bool, str]:
    try:
        out = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=PROBE_TIMEOUT_S,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return False, f"{argv[0]} timed out after {PROBE_TIMEOUT_S}s"
    except OSError as exc:
        return False, f"{argv[0]} not runnable: {exc}"
    if out.returncode != 0:
        return False, (out.stderr or out.stdout).strip()[:200]
    return True, out.stdout.strip()


def check_display() -> dict[str, object]:
    """Prove X is up, and report BOTH geometries — they are no longer one.

    `widthPx`/`heightPx` are the screen this machine ADVERTISES: the size every
    seat is created at, the size the `Sandbox` row carries, and the size a
    client synthesises its RFB handshake from. That is the number R8 fixes and
    the only one anything outside the container should compare against.

    `displayWidthPx`/`displayHeightPx` are the X display those seats sit on,
    which is deliberately a little larger (M5-BE-25): a window cannot be the
    full size of its screen — measured, 1280x800 asked for on a 1280x800
    display comes back 1279x799 — so the display carries a margin and a seat
    is created at exactly the advertised size inside it.

    Reporting only the display, as this used to, would tell a caller the
    machine's screen is 1288x808 when nothing streams at that size.
    """
    ok, detail = _run("xdotool", "getdisplaygeometry")
    result: dict[str, object] = {
        "ok": ok,
        "display": DISPLAY,
        "widthPx": int(os.environ.get("SCREEN_WIDTH", "1280")),
        "heightPx": int(os.environ.get("SCREEN_HEIGHT", "800")),
    }
    if ok:
        parts = detail.split()
        if len(parts) == 2 and all(part.isdigit() for part in parts):
            result["displayWidthPx"], result["displayHeightPx"] = int(parts[0]), int(parts[1])
        else:
            result["ok"] = False
            result["detail"] = f"unparseable geometry: {detail!r}"
    else:
        result["detail"] = detail
    return result


def check_browser() -> dict[str, object]:
    """Can this machine serve a browser, and do the ones it IS serving answer?

    This probed `http://127.0.0.1:9222/json/version` until D-060, when the
    machine stopped running a browser of its own — every bot's seat now has one.
    Probing that port now would fail forever and take `/health` with it, so the
    question has to change rather than the answer.

    What replaces it is the same question asked of the browsers that exist. A
    machine with no seats is healthy and browserless, so the check is that one
    COULD start: the binary is there. A machine with seats is healthy only if
    each seat's browser still answers, which is a stronger signal than the old
    probe ever was — it covers every browser a bot is actually using rather than
    one nobody was.
    """
    if shutil.which("google-chrome") is None:
        return {"ok": False, "detail": "google-chrome is not installed"}
    seats = SEATS.list()
    dead: list[str] = []
    for seat in seats:
        port = seat.get("cdpPort")
        if not isinstance(port, int):
            continue
        # A seat holds its CDP port from creation but only listens on it once
        # something has asked for a browser (D-061). Probing a seat that has not
        # is asking whether a browser nobody started is running, and answering
        # "unhealthy" to it would put every machine with an un-browsed bot into
        # 503 — the same trap the machine-browser probe fell into.
        if not seat.get("browserReady"):
            continue
        try:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{port}/json/version", timeout=PROBE_TIMEOUT_S
            ) as response:
                json.loads(response.read())
        except (urllib.error.URLError, OSError, ValueError, TimeoutError) as exc:
            dead.append(f"{seat.get('seatId')}: {type(exc).__name__}")
    running = sum(1 for seat in seats if seat.get("browserReady"))
    # Reported, never a failure: a browser under `--no-sandbox` still works,
    # and an older orchestrator's containers are exactly that (D-145).
    sandbox = browser_sandbox()
    if dead:
        return {"ok": False, "seats": len(seats), "browsers": running,
                "sandbox": sandbox, "detail": "; ".join(dead)}
    return {"ok": True, "seats": len(seats), "browsers": running, "sandbox": sandbox}


def check_atspi() -> dict[str, object]:
    """Ask the session bus for the accessibility bus address."""
    ok, detail = _run(
        "dbus-send",
        "--session",
        "--dest=org.a11y.Bus",
        "--print-reply",
        "/org/a11y/bus",
        "org.a11y.Bus.GetAddress",
    )
    return {"ok": ok, "detail": detail[:200] if detail else ""}


def capture_screenshot(
    run_process: Callable[..., subprocess.CompletedProcess[bytes]] | None = None,
    *,
    environment: dict[str, str] | None = None,
) -> bytes:
    """Capture DISPLAY to a private temporary file and return a validated PNG."""
    runner = run_process or subprocess.run
    descriptor, path = tempfile.mkstemp(prefix="crewaid-screenshot-", suffix=".png")
    os.close(descriptor)
    try:
        try:
            result = runner(
                ["scrot", "--overwrite", path],
                **({"env": environment} if environment is not None else {}),
                capture_output=True,
                timeout=SCREENSHOT_TIMEOUT_S,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise BridgeFailure(f"screenshot timed out after {SCREENSHOT_TIMEOUT_S}s") from exc
        except OSError as exc:
            raise BridgeFailure(f"scrot not runnable: {exc}") from exc

        if result.returncode != 0:
            output = result.stderr or result.stdout
            detail = (
                output.decode(errors="replace") if isinstance(output, bytes) else str(output)
            ).strip()[:200]
            raise BridgeFailure(detail or f"scrot exited with status {result.returncode}")

        try:
            with open(path, "rb") as screenshot:
                data = screenshot.read(MAX_SCREENSHOT_BYTES + 1)
        except OSError as exc:
            raise BridgeFailure(f"could not read screenshot: {exc}") from exc
        if len(data) > MAX_SCREENSHOT_BYTES:
            raise BridgeFailure(f"screenshot exceeds {MAX_SCREENSHOT_BYTES} bytes")
        if not data.startswith(PNG_SIGNATURE):
            raise BridgeFailure("scrot did not produce a PNG")
        return data
    finally:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass


def _safe_atspi_call(source: object, method: str) -> str | None:
    try:
        value = getattr(source, method)()
    except Exception:  # AT-SPI objects can disappear between event and inspection.
        return None
    return str(value)[:500]


def atspi_event_payload(event: object) -> dict[str, object]:
    """Reduce a live pyatspi event to stable JSON-safe fields."""
    source = getattr(event, "source", None)
    payload: dict[str, object] = {
        "type": str(getattr(event, "type", "unknown"))[:500],
        "detail1": int(getattr(event, "detail1", 0)),
        "detail2": int(getattr(event, "detail2", 0)),
        "source": {
            "name": _safe_atspi_call(source, "get_name") if source is not None else None,
            "role": _safe_atspi_call(source, "get_role_name") if source is not None else None,
        },
    }
    any_data = getattr(event, "any_data", None)
    if isinstance(any_data, (str, int, float, bool)) or any_data is None:
        payload["anyData"] = any_data
    else:
        payload["anyData"] = str(any_data)[:1000]
    return payload


class AtspiEventBroker:
    """Register once with pyatspi and fan events out to bounded SSE queues."""

    EVENT_TYPES = (
        "object:active-descendant-changed",
        "object:children-changed",
        "object:property-change",
        "object:selection-changed",
        "object:state-changed",
        "object:text-caret-moved",
        "object:text-changed",
        "window",
    )

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._subscribers: set[queue.Queue[dict[str, object]]] = set()
        self._started = False
        self._start_error: str | None = None

    def subscribe(self) -> queue.Queue[dict[str, object]]:
        self._ensure_started()
        if self._start_error is not None:
            raise BridgeFailure(self._start_error)
        subscriber: queue.Queue[dict[str, object]] = queue.Queue(maxsize=SSE_QUEUE_SIZE)
        with self._lock:
            self._subscribers.add(subscriber)
        return subscriber

    def unsubscribe(self, subscriber: queue.Queue[dict[str, object]]) -> None:
        with self._lock:
            self._subscribers.discard(subscriber)

    def publish(self, event: object) -> None:
        payload = atspi_event_payload(event)
        with self._lock:
            subscribers = tuple(self._subscribers)
        for subscriber in subscribers:
            try:
                subscriber.put_nowait(payload)
            except queue.Full:
                # Accessibility bursts must not grow the bridge without bound.
                try:
                    subscriber.get_nowait()
                except queue.Empty:
                    pass
                try:
                    subscriber.put_nowait(payload)
                except queue.Full:
                    pass

    def _ensure_started(self) -> None:
        with self._lock:
            if self._started:
                return
            self._started = True
            try:
                import pyatspi  # type: ignore[import-not-found]

                pyatspi.Registry.registerEventListener(self.publish, *self.EVENT_TYPES)
                thread = threading.Thread(
                    target=pyatspi.Registry.start,
                    name="crewaid-atspi-events",
                    daemon=True,
                )
                thread.start()
            except Exception as exc:
                self._start_error = f"AT-SPI event stream unavailable: {type(exc).__name__}: {exc}"


AT_SPI_EVENTS = AtspiEventBroker()


def validate_skill_request(value: object) -> dict[str, object]:
    """Validate the M2 wire contract without executing model-generated code."""
    if not isinstance(value, dict):
        raise ValueError("request body must be a JSON object")
    if set(value) != {"script", "params"}:
        raise ValueError("request body must contain exactly 'script' and 'params'")
    script = value["script"]
    params = value["params"]
    if not isinstance(script, str) or not script.strip():
        raise ValueError("script must be a non-empty string")
    if len(script.encode()) > MAX_SKILL_REQUEST_BYTES:
        raise ValueError("script is too large")
    if not isinstance(params, dict):
        raise ValueError("params must be a JSON object")
    return {"script": script, "params": params}


def _bounded_stderr(stderr: bytes | None) -> str:
    if not stderr:
        return "the skill runner exited non-zero"
    text = stderr.decode(errors="replace").strip()
    return text[:MAX_SKILL_ERROR_CHARS] or "the skill runner exited non-zero"


def _run_skill_process(command, *, input, timeout, env=None, **_):
    # A runner timeout must also stop a pending xdotool/desktop child before
    # replay admission is released. Killing Node alone leaves that child alive.
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, env=env, start_new_session=True)
    try:
        stdout, stderr = process.communicate(input, timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        stdout, stderr = process.communicate()
        raise subprocess.TimeoutExpired(command, timeout, output=stdout, stderr=stderr)
    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)


def run_skill(
    script: str,
    params: dict[str, object],
    runner: Callable[..., subprocess.CompletedProcess[bytes]] | None = None,
    *,
    seat: dict[str, object] | None = None,
) -> tuple[HTTPStatus, dict[str, object]]:
    """Execute one validated skill request inside this container (M3-PK-01).

    The runner is a Node process *in this container* — that is the whole point
    of D-040's split: M2 owns this transport, execution belongs to M3, and
    execution never happens in the orchestrator process (§7.3).

    The request rides in on stdin and the outcome comes back through a FILE.
    The script shares the runner process, so anything it prints to stdout would
    otherwise corrupt a stdout-framed protocol; stray output is harmless here.

    Failure mapping: a run that executed — even one whose script threw — is a
    200 whose body is the run's outcome. Only a runner that could not run at
    all (missing binary, non-zero exit, unreadable outcome, timeout) answers
    500, because then there is no outcome to report.
    """
    execute = runner or _run_skill_process
    descriptor, outcome_path = tempfile.mkstemp(prefix="crewaid-skill-outcome-", suffix=".json")
    os.close(descriptor)
    try:
        payload = json.dumps({"script": script, "params": params}).encode()
        try:
            result = execute(
                ["node", SKILL_RUNNER_PATH, outcome_path]
                + ([f"http://127.0.0.1:{seat['cdpPort']}", str(seat.get("botId") or ""),
                    str(seat["seatId"])] if seat else []),
                **({"env": _seat_env(str(seat["display"]))} if seat else {}),
                input=payload,
                capture_output=True,
                timeout=SKILL_TIMEOUT_S,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return (
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {
                    "ok": False,
                    "code": "SKILL_TIMEOUT",
                    "detail": f"the skill did not finish within {SKILL_TIMEOUT_S:.0f}s",
                },
            )
        except OSError as exc:
            return (
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {
                    "ok": False,
                    "code": "SKILL_RUNTIME_FAILED",
                    "detail": f"the skill runner is not runnable: {exc}",
                },
            )
        if result.returncode != 0:
            return (
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {
                    "ok": False,
                    "code": "SKILL_RUNTIME_FAILED",
                    "detail": _bounded_stderr(result.stderr),
                },
            )
        try:
            with open(outcome_path, "rb") as outcome_file:
                raw = outcome_file.read(MAX_SKILL_OUTCOME_BYTES + 1)
        except OSError as exc:
            return (
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {
                    "ok": False,
                    "code": "SKILL_RUNTIME_FAILED",
                    "detail": f"could not read the run outcome: {exc}",
                },
            )
        if len(raw) > MAX_SKILL_OUTCOME_BYTES:
            return (
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {
                    "ok": False,
                    "code": "SKILL_RUNTIME_FAILED",
                    "detail": f"the run outcome exceeds {MAX_SKILL_OUTCOME_BYTES} bytes",
                },
            )
        try:
            outcome = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return (
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {
                    "ok": False,
                    "code": "SKILL_RUNTIME_FAILED",
                    "detail": "the skill runner wrote an unreadable outcome",
                },
            )
        if not isinstance(outcome, dict) or not isinstance(outcome.get("ok"), bool):
            return (
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {
                    "ok": False,
                    "code": "SKILL_RUNTIME_FAILED",
                    "detail": "the skill runner wrote an invalid outcome",
                },
            )
        return HTTPStatus.OK, outcome
    finally:
        try:
            os.unlink(outcome_path)
        except FileNotFoundError:
            pass


def execute_skill_request(
    request: dict[str, object],
    runner: Callable[..., subprocess.CompletedProcess[bytes]] | None = None,
    *,
    seat: dict[str, object] | None = None,
) -> tuple[HTTPStatus, dict[str, object]]:
    """Hand a validated request to the executor, re-asserting the contract shape."""
    script = request["script"]
    params = request["params"]
    if not isinstance(script, str) or not isinstance(params, dict):
        raise ValueError("validate_skill_request returned an invalid request")
    return run_skill(script, params, runner, seat=seat)


class BridgeHandler(BaseHTTPRequestHandler):
    server_version = "crewaid-agent-bridge/0.2"
    protocol_version = "HTTP/1.1"

    def _send_bytes(
        self,
        status: HTTPStatus,
        body: bytes,
        content_type: str,
        headers: dict[str, str] | None = None,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status: HTTPStatus, body: dict[str, object]) -> None:
        self._send_bytes(status, json.dumps(body).encode(), "application/json")

    def _method_not_allowed(self, allow: str) -> None:
        # No rejected request body is consumed. Closing prevents its bytes from
        # being parsed as another request on this HTTP/1.1 connection.
        self.close_connection = True
        self._send_bytes(
            HTTPStatus.METHOD_NOT_ALLOWED,
            json.dumps({"ok": False, "code": "METHOD_NOT_ALLOWED"}).encode(),
            "application/json",
            {"Allow": allow},
        )

    def _send_health(self) -> None:
        checks = {
            "display": check_display(),
            "browser": check_browser(),
            "atspi": check_atspi(),
        }
        healthy = all(check["ok"] for check in checks.values())
        status = HTTPStatus.OK if healthy else HTTPStatus.SERVICE_UNAVAILABLE
        self._send_json(status, {"ok": healthy, "checks": checks})

    def _requested_seat(self) -> dict[str, object] | None:
        query = urllib.parse.urlsplit(self.path).query
        values = urllib.parse.parse_qs(query, keep_blank_values=True)
        if "botId" not in values:
            return None
        wanted = values["botId"]
        if len(wanted) != 1 or not wanted[0]:
            raise SeatError("botId must identify one live seat")
        seat = SEATS.find(wanted[0])
        if seat is None:
            raise SeatError("the requested bot has no live seat")
        return seat

    def _send_screenshot(self) -> None:
        try:
            seat = self._requested_seat()
            png = (
                capture_screenshot(environment=_seat_env(str(seat["display"])))
                if seat else capture_screenshot()
            )
        except (BridgeFailure, SeatError) as exc:
            self._send_json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"ok": False, "code": "SCREENSHOT_FAILED", "detail": str(exc)},
            )
            return
        self._send_bytes(HTTPStatus.OK, png, "image/png")

    def _send_atspi_events(self) -> None:
        try:
            subscriber = AT_SPI_EVENTS.subscribe()
        except BridgeFailure as exc:
            self._send_json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"ok": False, "code": "ATSPI_UNAVAILABLE", "detail": str(exc)},
            )
            return

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        try:
            self.wfile.write(b"retry: 3000\n\n")
            self.wfile.flush()
            while True:
                try:
                    payload = subscriber.get(timeout=SSE_HEARTBEAT_S)
                    encoded = json.dumps(payload, separators=(",", ":")).encode()
                    self.wfile.write(b"event: atspi\ndata: " + encoded + b"\n\n")
                except queue.Empty:
                    self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            AT_SPI_EVENTS.unsubscribe(subscriber)

    def _read_skill_request(self) -> dict[str, object] | None:
        if self.headers.get_content_type() != "application/json":
            self.close_connection = True
            self._send_json(
                HTTPStatus.UNSUPPORTED_MEDIA_TYPE,
                {"ok": False, "code": "UNSUPPORTED_MEDIA_TYPE"},
            )
            return None
        length_text = self.headers.get("Content-Length")
        try:
            length = int(length_text) if length_text is not None else -1
        except ValueError:
            length = -1
        if length < 0:
            self.close_connection = True
            self._send_json(
                HTTPStatus.LENGTH_REQUIRED,
                {"ok": False, "code": "CONTENT_LENGTH_REQUIRED"},
            )
            return None
        if length > MAX_SKILL_REQUEST_BYTES:
            self.close_connection = True
            self._send_json(
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                {"ok": False, "code": "REQUEST_TOO_LARGE"},
            )
            return None
        try:
            value = json.loads(self.rfile.read(length))
            return validate_skill_request(value)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            self._send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "code": "INVALID_SKILL_REQUEST", "detail": str(exc)},
            )
            return None

    def _refuse_browser(self) -> bool:
        """Answer 403 to a request a web page made, and say whether it did.

        Every seat's Chrome runs on this machine, so any page a bot opens can
        reach 127.0.0.1:7070 — and a cross-origin POST with a text/plain body
        needs no preflight, so a page could open, close or take a seat, or
        replace the screen key, without ever reading an answer. A browser
        always names the page's origin on such a request; the bridge's real
        callers (the orchestrator's HTTP client, the Cloudflare control Worker,
        the dock's launcher) never send one. So `Origin` is the refusal.
        """
        if self.headers.get("Origin") is None:
            return False
        self.close_connection = True
        self._send_json(HTTPStatus.FORBIDDEN, {"ok": False, "code": "BROWSER_REQUEST_REFUSED"})
        return True

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's contract
        if self._refuse_browser():
            return
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if path == "/health":
            self._send_health()
        elif path == "/screenshot":
            self._send_screenshot()
        elif path == "/atspi/events":
            self._send_atspi_events()
        elif path == "/seats":
            # `?botId=` answers the allocation question directly rather than
            # making every caller filter a list it did not ask for.
            query = self.path.split("?", 1)[1] if "?" in self.path else ""
            wanted = dict(urllib.parse.parse_qsl(query)).get("botId")
            try:
                if wanted:
                    seat = SEATS.find(wanted)
                    if seat is None:
                        self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "code": "NO_SUCH_SEAT"})
                    else:
                        self._send_json(HTTPStatus.OK, {"ok": True, "seat": seat})
                    return
                self._send_json(HTTPStatus.OK, {"ok": True, "seats": SEATS.list()})
            except (SeatError, OSError) as exc:
                # Failed recovery retains the reservation. Report the refusal
                # instead of dropping the HTTP connection without an answer.
                self._send_json(HTTPStatus.SERVICE_UNAVAILABLE,
                                {"ok": False, "code": "SEAT_UNAVAILABLE", "detail": str(exc)[:300]})
        elif path == "/processes":
            self._list_processes()
        elif path.startswith("/processes/") and path.count("/") == 2:
            self._read_process(path.split("/")[2])
        elif path in {"/skill/run", "/exec"}:
            self._method_not_allowed("POST")
        else:
            self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "detail": f"no route {path}"})

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's contract
        if self._refuse_browser():
            return
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if path == "/skill/run":
            request = self._read_skill_request()
            if request is not None:
                try:
                    seat = self._requested_seat()
                    if seat is None:
                        raise SeatError("skill replay requires botId of a live private seat")
                    with REPLAYS.replay(str(seat["seatId"])):
                        current = self._requested_seat()
                        if current is None or current["seatId"] != seat["seatId"]:
                            raise SeatError("this replay's seat has been replaced")
                        status, body = execute_skill_request(request, seat=seat)
                except ControlError as exc:
                    status, body = HTTPStatus.CONFLICT, {
                        "ok": False, "code": exc.code, "detail": str(exc)}
                except SeatError as exc:
                    status, body = HTTPStatus.SERVICE_UNAVAILABLE, {
                        "ok": False, "code": "SEAT_UNAVAILABLE", "detail": str(exc)}
                self._send_json(status, body)
        elif path == "/exec":
            self._exec()
        elif path == "/seats":
            self._create_seat()
        elif path == "/seats/browser":
            self._start_seat_browser()
        elif path == "/seats/control":
            self._control_seat()
        elif path.startswith("/seats/") and path.endswith("/close"):
            self._close_seat(path.split("/")[2])
        elif path == "/screen/key":
            self._publish_screen_key()
        elif path == "/processes":
            self._start_process()
        elif path == "/processes/stop-run":
            self._stop_run_processes()
        elif path.startswith("/processes/") and path.endswith("/stop") and path.count("/") == 3:
            self._stop_process(path.split("/")[2])
        elif path in {"/health", "/screenshot", "/atspi/events"}:
            self._method_not_allowed("GET")
        else:
            # Drain before answering, for the reason `_close_seat` does: a body
            # nobody read stays in the socket, and the next request on the same
            # keep-alive connection reads it as its request line. A POST to an
            # unknown route is exactly when a client HAS sent one.
            if self._seat_body() is None:
                return
            self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "detail": f"no route {path}"})

    def _control_seat(self) -> None:
        request = self._seat_request()
        if request is None:
            return
        try:
            action = request.get("action")
            token = request.get("token")
            allowed = {"action", "token"}
            if action == "take":
                allowed |= {"leaseMs", "drainMs"}
            elif action == "renew":
                allowed.add("leaseMs")
            elif action != "release":
                raise ValueError("action must be take, renew or release")
            if set(request) != allowed:
                raise ValueError("control request has missing or unknown fields")
            if not isinstance(token, str) or not re.fullmatch(r"[0-9a-f-]{36}", token):
                raise ValueError("token must be an opaque UUID")
            for name in allowed & {"leaseMs", "drainMs"}:
                value = request[name]
                if type(value) is not int or not 0 < value <= 2147483647:
                    raise ValueError(f"{name} must be a positive bounded integer")
            seat = self._requested_seat()
            if seat is None:
                raise SeatError("control requires botId of a live private seat")
            REPLAYS.control(str(seat["seatId"]), action, token,
                            lease_ms=request.get("leaseMs", 0),
                            drain_ms=request.get("drainMs", 0))
            self._send_json(HTTPStatus.OK, {"ok": True})
        except ControlError as exc:
            self._send_json(HTTPStatus.CONFLICT,
                            {"ok": False, "code": exc.code, "detail": str(exc)})
        except (ValueError, SeatError) as exc:
            self._send_json(HTTPStatus.BAD_REQUEST,
                            {"ok": False, "code": "INVALID_CONTROL_REQUEST", "detail": str(exc)})

    def _exec(self) -> None:
        """D-150: a streaming exec on this connection, after an HTTP Upgrade.

        A plain POST is refused rather than answered with a one-shot result:
        the caller needs stdin, byte-exact output and kill, which only the
        upgraded connection carries (`exec_stream`).
        """
        upgrade = self.headers.get("Upgrade", "")
        connection = self.headers.get("Connection", "")
        wants_upgrade = "upgrade" in [part.strip().lower() for part in connection.split(",")]
        if upgrade.strip().lower() != exec_stream.UPGRADE_TOKEN or not wants_upgrade:
            self.close_connection = True
            self._send_bytes(
                HTTPStatus.UPGRADE_REQUIRED,
                json.dumps({"ok": False, "code": "UPGRADE_REQUIRED"}).encode(),
                "application/json",
                {"Upgrade": exec_stream.UPGRADE_TOKEN, "Connection": "Upgrade"},
            )
            return
        # Whatever follows the headers is frames, not an HTTP body, and the
        # connection never returns to HTTP: it closes when the exec does.
        self.close_connection = True
        self.send_response(HTTPStatus.SWITCHING_PROTOCOLS)
        self.send_header("Upgrade", exec_stream.UPGRADE_TOKEN)
        self.send_header("Connection", "Upgrade")
        self.end_headers()
        self.wfile.flush()
        exec_stream.serve(self.rfile, self.wfile)

    def _seat_request(self) -> dict[str, object] | None:
        body = self._seat_body()
        if body is None:
            return None
        if not body:
            return {}
        try:
            value = json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self._send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "code": "INVALID_SEAT_REQUEST", "detail": str(exc)},
            )
            return None
        if not isinstance(value, dict):
            self._send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "code": "INVALID_SEAT_REQUEST", "detail": "expected an object"},
            )
            return None
        return value

    def _seat_body(self) -> bytes | None:
        """A seat route's body, or None once a bad header has been answered.

        The bound and the header handling are `_read_skill_request`'s: a
        `Content-Length` that is not a number is answered rather than raised —
        an unparsed request must not leave the caller with a dropped connection
        and no reply — and a body larger than the bound is refused rather than
        buffered. Unlike that route the body is optional here, which is why an
        absent length reads as zero rather than as an error. The body is always
        drained, including on the route that needs none: bytes left in the
        socket are read as the request line of the next request on the same
        keep-alive connection, and the caller gets `BaseHTTPRequestHandler`'s
        HTML error page for a call that succeeded.
        """
        length_text = self.headers.get("Content-Length")
        try:
            length = int(length_text) if length_text is not None else 0
        except ValueError:
            length = -1
        if length < 0:
            self.close_connection = True
            self._send_json(
                HTTPStatus.LENGTH_REQUIRED,
                {"ok": False, "code": "CONTENT_LENGTH_REQUIRED"},
            )
            return None
        if length > MAX_SKILL_REQUEST_BYTES:
            self.close_connection = True
            self._send_json(
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"ok": False, "code": "REQUEST_TOO_LARGE"}
            )
            return None
        return self.rfile.read(length) if length else b""

    def _start_seat_browser(self) -> None:
        """D-061: start a seat's browser, if it is not already running.

        A seat is a desktop, and its browser costs about two thirds of what the
        seat costs — so it is not started with the desktop, and something has to
        ask. This is that ask, and it is deliberately a route rather than a
        side effect of `GET /seats`: reading which seat a bot has must not start
        a browser, or the recording tee would start one by observing.

        Two addresses name the same ask. The orchestrator and the skill runner
        know the bot; the dock's Chrome icon knows only the DISPLAY plank
        handed it, so it sends that instead — the launcher cannot know a bot id
        that nothing on the seat ever tells it. Exactly one of the two, never
        both, and nothing else.

        Idempotent, and answers the seat either way, so a caller can use it as
        "make sure" rather than "start". The registry serialises it under the
        same lock `create` uses, so two tool calls arriving together cannot each
        launch a Chrome on one profile.
        """
        request = self._seat_request()
        if request is None:
            return
        if set(request) - {"botId", "display", "identityRevision"}:
            self._send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "code": "INVALID_SEAT_REQUEST",
                 "detail": "unknown field(s); send only botId or display"},
            )
            return
        bot_id = request.get("botId")
        display = request.get("display")
        for name, value in (("botId", bot_id), ("display", display)):
            if value is not None and (not isinstance(value, str) or not value):
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"ok": False, "code": "INVALID_SEAT_REQUEST",
                     "detail": f"{name} must be a non-empty string"},
                )
                return
        if (bot_id is None) == (display is None):
            self._send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "code": "INVALID_SEAT_REQUEST",
                 "detail": "send exactly one of botId or display"},
            )
            return
        try:
            revision = request.get("identityRevision")
            if revision is not None and (type(revision) is not int or not 0 <= revision <= 2147483647):
                raise SeatError("invalid identity revision")
            if display is not None and revision is not None:
                raise SeatError("identityRevision requires botId")
            seat = (
                SEATS.ensure_browser_on_display(display)
                if display is not None
                else SEATS.ensure_browser(bot_id, revision)
            )
        except (SeatError, ValueError, TypeError, OSError) as exc:
            self._send_json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"ok": False, "code": "SEAT_UNAVAILABLE", "detail": str(exc)},
            )
            return
        self._send_json(HTTPStatus.OK, {"ok": True, "seat": seat})

    def _create_seat(self) -> None:
        """D-046: give this machine one more screen.

        Every field is optional. The caller owning the geometry is R8's
        requirement, not a convenience: a seat's size is fixed for its lifetime
        and the orchestrator is what knows the size a client already cached —
        so a field that is present is used as given or refused, never quietly
        replaced by a default the caller did not ask for.
        """
        request = self._seat_request()
        if request is None:
            return
        try:
            geometry = validate_seat_request(request)
        except ValueError as exc:
            self._send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "code": "INVALID_SEAT_REQUEST", "detail": str(exc)},
            )
            return
        try:
            seat = SEATS.create(**geometry)  # type: ignore[arg-type]
        except (SeatError, ValueError, TypeError, OSError) as exc:
            # A seat that could not be created must not take the bridge — or
            # the desktop — down with it: the machine still serves every seat
            # it already has.
            self._send_json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"ok": False, "code": "SEAT_UNAVAILABLE", "detail": str(exc)[:300],
                 **({"holderBotId": exc.holder_bot_id}
                    if isinstance(exc, SeatError) and exc.holder_bot_id is not None else {})},
            )
            return
        self._send_json(HTTPStatus.OK, {"ok": True, "seat": seat})

    def _publish_screen_key(self) -> None:
        """D-223: what the screen gateway checks stream tickets with."""
        request = self._seat_request()
        if request is None:
            return
        try:
            key = screen_key.validate_screen_key(request)
        except ValueError as exc:
            self._send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "code": "INVALID_SCREEN_KEY", "detail": str(exc)},
            )
            return
        try:
            screen_key.write_screen_key(key, screen_key.screen_key_path())
        except OSError as exc:
            self._send_json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"ok": False, "code": "SCREEN_KEY_UNWRITABLE", "detail": str(exc)[:300]},
            )
            return
        self._send_json(HTTPStatus.OK, {"ok": True, "expiresViewers": True})

    def _close_seat(self, seat_id: str) -> None:
        request = self._seat_request()
        if request is None:
            return
        try:
            if set(request) - {"identityRevision"}:
                raise SeatError("unknown close request field")
            revision = request.get("identityRevision")
            if revision is not None and (type(revision) is not int or not 0 <= revision <= 2147483647):
                raise SeatError("invalid identity revision")
            with REPLAYS.transition(seat_id):
                closed = SEATS.close(seat_id, revision)
        except ControlError as exc:
            self._send_json(HTTPStatus.CONFLICT, {"ok": False, "code": exc.code, "detail": str(exc)})
            return
        except (SeatError, OSError) as exc:
            self._send_json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"ok": False, "code": "SEAT_CLOSE_FAILED", "detail": str(exc)[:300]},
            )
            return
        if not closed:
            self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "code": "NO_SUCH_SEAT"})
            return
        self._send_json(HTTPStatus.OK, {"ok": True})

    def _query_params(self) -> dict[str, str]:
        query = self.path.split("?", 1)[1] if "?" in self.path else ""
        return dict(urllib.parse.parse_qsl(query))

    def _list_processes(self) -> None:
        bot_id = self._query_params().get("botId", "")
        if not bot_id:
            self._send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "code": "INVALID_PROCESS_REQUEST", "detail": "botId is required"},
            )
            return
        self._send_json(HTTPStatus.OK, {"ok": True, "processes": PROCESSES.list(bot_id)})

    def _read_process(self, process_id: str) -> None:
        params = self._query_params()
        bot_id = params.get("botId", "")
        if not bot_id or not process_id:
            self._send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "code": "INVALID_PROCESS_REQUEST", "detail": "botId and processId are required"},
            )
            return
        try:
            offset = int(params.get("offset", "0"))
            wait_ms = int(params.get("waitMs", "0"))
            if offset < 0 or wait_ms < 0 or wait_ms > MAX_WAIT_MS:
                raise ValueError("offset must be >= 0 and waitMs must be 0..30000")
        except ValueError as exc:
            self._send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "code": "INVALID_PROCESS_REQUEST", "detail": str(exc)},
            )
            return
        result = PROCESSES.read_output(bot_id, process_id, offset=offset, wait_ms=wait_ms)
        if result is None:
            self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "code": "NO_SUCH_PROCESS"})
            return
        self._send_json(HTTPStatus.OK, {"ok": True, "process": result})

    def _start_process(self) -> None:
        request = self._seat_request()
        if request is None:
            return
        try:
            spec = validate_process_start_request(request)
        except ValueError as exc:
            self._send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "code": "INVALID_PROCESS_REQUEST", "detail": str(exc)},
            )
            return
        try:
            started = PROCESSES.start(**spec)  # type: ignore[arg-type]
        except ProcessLimitError as exc:
            self._send_json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"ok": False, "code": exc.code, "detail": str(exc)},
            )
            return
        except (ProcessError, OSError) as exc:
            self._send_json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"ok": False, "code": "PROCESS_START_FAILED", "detail": str(exc)[:300]},
            )
            return
        self._send_json(HTTPStatus.OK, {"ok": True, "process": started})

    def _stop_process(self, process_id: str) -> None:
        request = self._seat_request()
        if request is None:
            return
        unknown = set(request) - {"botId"}
        bot_id = request.get("botId")
        if unknown or not isinstance(bot_id, str) or not bot_id:
            self._send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "code": "INVALID_PROCESS_REQUEST", "detail": "send only non-empty botId"},
            )
            return
        stopped = PROCESSES.stop(bot_id, process_id)
        if stopped is None:
            self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "code": "NO_SUCH_PROCESS"})
            return
        self._send_json(HTTPStatus.OK, {"ok": True, "process": stopped})

    def _stop_run_processes(self) -> None:
        request = self._seat_request()
        if request is None:
            return
        unknown = set(request) - {"botId", "runId"}
        bot_id = request.get("botId")
        run_id = request.get("runId")
        if (
            unknown
            or not isinstance(bot_id, str)
            or not bot_id
            or not isinstance(run_id, str)
            or not run_id
        ):
            self._send_json(
                HTTPStatus.BAD_REQUEST,
                {
                    "ok": False,
                    "code": "INVALID_PROCESS_REQUEST",
                    "detail": "send non-empty botId and runId",
                },
            )
            return
        stopped = PROCESSES.stop_run(bot_id, run_id)
        self._send_json(HTTPStatus.OK, {"ok": True, "stopped": stopped})

    def log_message(self, fmt: str, *args: object) -> None:
        # Per-request stderr drowns the entrypoint supervision log.
        pass


def validate_seat_request(value: dict[str, object]) -> dict[str, object]:
    """A seat's optional geometry, validated without inventing any of it.

    An absent field takes the default the registry already has; a field that is
    present is used as given or refused. The two must stay distinguishable:
    the orchestrator passes the size a client has already cached, so a typo or
    a zero must be an error rather than a seat that silently comes up at
    1024x640 and renegotiates the stream R8 fixes.
    """
    unknown = set(value) - {"botId", "profile", "identityRevision", "url", "width", "height", "left", "top"}
    if unknown:
        raise ValueError(f"unknown field(s): {', '.join(sorted(unknown))}")
    url = value.get("url", "about:blank")
    if not isinstance(url, str) or not url:
        raise ValueError("url must be a non-empty string")
    geometry: dict[str, object] = {"url": url}
    if "identityRevision" in value:
        revision = value["identityRevision"]
        if type(revision) is not int or not 0 <= revision <= 2147483647 or "botId" not in value:
            raise ValueError("identityRevision must be a bounded integer with botId")
        geometry["identity_revision"] = revision
    # M5-BE-23: whose seat this is, and the only place it is recorded. An
    # absent label is legal — a seat can be opened for its own sake — but an
    # empty or non-string one is a caller that meant to say and did not, and
    # it would produce a seat nothing can ever find again.
    if "botId" in value:
        bot_id = value["botId"]
        if not isinstance(bot_id, str) or not bot_id:
            raise ValueError("botId must be a non-empty string")
        geometry["bot_id"] = bot_id
    # M5-BE-27: the NAMED profile this seat opens on, when the bot has been
    # granted a shared identity. Absent means the bot's own (D-056), which is
    # the default the registry already applies — so this field is the one place
    # a seat stops being private, and it is never inferred here. Which names
    # are legal identities is the orchestrator's question, not this one: it
    # holds the grants and the machine's bot ids, and the registry checks only
    # that the name can be a directory.
    if "profile" in value:
        profile = value["profile"]
        if not isinstance(profile, str) or not profile:
            raise ValueError("profile must be a non-empty string")
        geometry["profile"] = profile
    for key in ("width", "height", "left", "top"):
        if key not in value:
            continue
        field = value[key]
        # bool is an int in Python; `true` is never a geometry.
        if isinstance(field, bool) or not isinstance(field, int):
            raise ValueError(f"{key} must be an integer")
        geometry[key] = field
    for key in ("width", "height"):
        if key in geometry and geometry[key] <= 0:
            raise ValueError(f"{key} must be positive")
    return geometry


class BridgeServer(ThreadingHTTPServer):
    """`ThreadingHTTPServer` without the reverse lookup of the host's own name.

    `HTTPServer.server_bind` resolves the hostname through `socket.getfqdn`,
    which raises `UnicodeError: label too long` when the hostname is longer
    than a DNS label's 63 characters. Cloudflare Containers name every
    container with a 64-character hex id, so the stock server could never bind
    there and the entrypoint took the desktop down with it. Nothing here reads
    `server_name`, so the lookup is skipped rather than guarded.
    """

    def server_bind(self) -> None:
        socketserver.TCPServer.server_bind(self)
        self.server_name = "localhost"
        self.server_port = self.server_address[1]


def validate_process_start_request(value: dict[str, object]) -> dict[str, object]:
    unknown = set(value) - {"botId", "command", "cwd", "env", "runId", "maxDurationSec"}
    if unknown:
        raise ValueError(f"unknown field(s): {', '.join(sorted(unknown))}")
    bot_id = value.get("botId")
    if not isinstance(bot_id, str) or not bot_id:
        raise ValueError("botId must be a non-empty string")
    command = value.get("command")
    if not isinstance(command, str) or not command.strip():
        raise ValueError("command must be a non-empty string")
    cwd = value.get("cwd", os.environ.get("HOME", "/home/bot"))
    if not isinstance(cwd, str) or not cwd.startswith("/"):
        raise ValueError("cwd must be an absolute path")
    env = value.get("env")
    if env is not None and (
        not isinstance(env, dict)
        or not all(isinstance(k, str) and isinstance(v, str) for k, v in env.items())
    ):
        raise ValueError("env must map strings to strings")
    run_id = value.get("runId")
    if run_id is not None and (not isinstance(run_id, str) or not run_id):
        raise ValueError("runId must be a non-empty string")
    max_duration = value.get("maxDurationSec", DEFAULT_MAX_DURATION_S)
    if (
        isinstance(max_duration, bool)
        or not isinstance(max_duration, int)
        or not MIN_MAX_DURATION_S <= max_duration <= MAX_MAX_DURATION_S
    ):
        raise ValueError(
            f"maxDurationSec must be an integer between {MIN_MAX_DURATION_S} and {MAX_MAX_DURATION_S}"
        )
    return {
        "bot_id": bot_id,
        "command": command,
        "cwd": cwd,
        "env": env,
        "run_id": run_id,
        "max_duration_s": max_duration,
    }


def main() -> None:
    server = BridgeServer(("0.0.0.0", PORT), BridgeHandler)
    server.daemon_threads = True
    print(f"[agent-bridge] listening on 0.0.0.0:{PORT}", flush=True)
    def shutdown(signum, frame):
        # shutdown must run outside serve_forever's thread.
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        PROCESSES.close_all()
        SEATS.close_all()


if __name__ == "__main__":
    main()
