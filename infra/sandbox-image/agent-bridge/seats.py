#!/usr/bin/env python3
"""D-060 — a seat is a display: Xvfb, a window manager, a dock and a browser.

A seat used to be a Chrome *window* on the machine's one display, captured with
``x11vnc -id <winid>``. M5-AR-01 measured that and chose it, and using it found
the three failures D-060 records: minimising the window froze the screen with no
way back, anything that was not that window was invisible to its own operator,
and a destroyed window left a seat advertising a dead RFB port that nothing
could invalidate.

So a seat is now ``:N`` — its own X display, its own window manager, its own
dock and its own browser — captured whole by ``x11vnc -display :N``. D-046's
machine is untouched: one container per user, one filesystem, handoff still a
``cd``, isolation still per user. What changes is that each bot gets a desktop
on that machine rather than a window on its display.

── WHY EACH SEAT NEEDS ITS OWN ``--user-data-dir`` ─────────────────────────────

Chrome's singleton is keyed on ``--user-data-dir``. A second ``google-chrome``
with the machine's own directory does not start a browser — it hands the request
to the running one, which is bound to one X display, so the window appears on
somebody else's screen. Measured: launching with ``DISPLAY=:2`` and the shared
directory exited 0 and put its window on ``:1``.

That is the whole reason a per-bot display looked impossible, and it is only
true while every bot shares one directory. Give each seat its own and two
browsers run side by side on two displays in one container — measured, 13
processes on one ``user-data-dir`` and 14 on another with ``:1`` unchanged. So a
seat's ``profile`` is no longer a ``--profile-directory`` inside one user-data-dir
(D-056); it names a directory under ``SEAT_PROFILE_ROOT`` that is a
``--user-data-dir`` in its own right.

An identity (D-057, as amended by D-060) is the same kind of directory under the
same root, named by the operator instead of by a bot id. A bot granted one
launches its browser against that directory rather than its own — nothing is
copied, which is the half of D-057 worth keeping. Chrome's singleton then makes
a grant exclusive for free: a second bot's launch would delegate into the first
bot's display instead of opening its own, so the operator would watch one bot
and drive another. ``create`` refuses that by name rather than letting Chrome
make it silent.

── WHAT THIS FILE NO LONGER HAS TO DO ──────────────────────────────────────────

The window seat had to *find* the window Chrome's singleton opened for it: a
marker page with a unique title, a poll over CDP targets, a poll over X window
titles, a settle loop, and an ICCCM ``min == max`` pin so nothing could
renegotiate the framebuffer afterwards. All of it existed to identify and
constrain one window among many on a shared display. A display has none of those
problems — it is created at a fixed size, it holds only what this bot put on it,
and R8 holds more strongly than the pin managed, because ``Xvfb`` has no way to
resize a screen at all. That machinery is gone, and so is the CDP client that
served it: a seat's browser is launched, not located.
"""

from __future__ import annotations

import os
import re
import shutil
import signal
import socket
import subprocess
import threading
import tempfile
import time
import http.client
import urllib.request
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from profiles import marker

# The machine's own display. It holds the launch browser and nothing a bot works
# in; a seat never touches it.
MACHINE_DISPLAY = os.environ.get("DISPLAY", ":1")

# One index picks a seat's display, its RFB port and its CDP port together, so
# there is one number to allocate and no way for the three to disagree. The
# count is the published-port ceiling: a container publishes its ports when it
# is created and `setPorts` is deliberately not implemented, so this is fixed
# for a machine's life and widening it means replacing the machine. Resource
# admission below can refuse a seat well before the ports run out.
SEAT_DISPLAY_BASE = int(os.environ.get("SEAT_DISPLAY_BASE", "10"))
SEAT_RFB_PORT_BASE = int(os.environ.get("SEAT_RFB_PORT_BASE", "5901"))
SEAT_CDP_PORT_BASE = int(os.environ.get("SEAT_CDP_PORT_BASE", "9301"))
SEAT_COUNT = int(os.environ.get("SEAT_RFB_PORT_COUNT", "16"))

# A seat's size IS the screen the product advertises (M5-BE-25): a client
# synthesises its RFB handshake from the `Sandbox` row rather than reading the
# stream, so a seat of any other size gives it a misaligned picture and offset
# input. Unlike the window seat, the display needs no margin — the old one
# existed because a window cannot be the full size of its screen, and a seat is
# now the screen.
DEFAULT_SEAT_WIDTH = int(os.environ.get("SEAT_WIDTH", os.environ.get("SCREEN_WIDTH", "1280")))
DEFAULT_SEAT_HEIGHT = int(os.environ.get("SEAT_HEIGHT", os.environ.get("SCREEN_HEIGHT", "800")))
SCREEN_DEPTH = int(os.environ.get("SCREEN_DEPTH", "24"))

# Each seat's `--user-data-dir` lives here, one directory per name. NOT under
# the machine's own `.chrome`: that belongs to the launch browser, and Chrome
# would read a seat's directory as one of its profiles.
SEAT_PROFILE_ROOT = Path(os.environ.get("SEAT_PROFILE_ROOT", "/home/bot/.seats"))

# The machine's own `--user-data-dir`, which is never a seat's.
MACHINE_USER_DATA_DIR = os.environ.get("CHROME_USER_DATA_DIR", "/home/bot/.chrome")

# Retirement tombstones stay where D-056 put them — `<home>/.crewaid-deleted-profiles`
# — rather than moving under the seat root. `profiles.py reap` runs from the
# entrypoint against that path and `workspace-paths.ts` lists it as machine-owned;
# relocating it here would retire profiles somewhere nothing else looks.
MACHINE_HOME = Path(MACHINE_USER_DATA_DIR).parent

# WORKSPACE §19's per-bot area: `<home>/agents/<botId>`. Everything a bot writes
# without saying where goes here — `fs_write` resolves a relative path against it
# and `record_screen_stop` puts its videos under it — so its absence is not a
# missing convenience. A bot that found no directory of its own put its work in
# the TEAM's shared area instead, where the next bot to write overwrote it.
#
# Created with the seat rather than with the bot because a bot exists in
# Postgres long before any machine does (D-041), and this is a path on a
# machine's volume: the seat is the first moment both facts are true.
AGENT_DIRS_ROOT = MACHINE_HOME / "agents"

# Image-owned and shared by every seat. `feh` paints it onto the X root pixmap
# and exits; the pixmap stays with the display, so a wallpaper costs no
# long-running process or per-seat lifecycle bookkeeping.
WALLPAPER_PATH = Path(
    os.environ.get("SEAT_WALLPAPER_PATH", "/opt/crewaid/wallpapers/crewaid-sky-wallpaper.png")
)

# Chrome's own default profile name, kept reserved for the same reason it was
# under D-056: it is the launch browser's, and a seat opening on it would put a
# bot inside the machine's own session.
DEFAULT_PROFILE = "Default"

X_TIMEOUT_S = 5.0
DISPLAY_READY_TIMEOUT_S = 15.0
WM_READY_TIMEOUT_S = 15.0
# Sized for a bot's FIRST seat, which is the first time Chrome has opened that
# directory at all and is markedly slower than a later start on one it has used.
CDP_READY_TIMEOUT_S = 40.0

# A directory name is a path segment, so it has to be one. Bot ids are cuids and
# always pass; the check is here because the name arrives over HTTP and `../` in
# it would point a browser at another directory entirely.
_SAFE_PROFILE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# cgroup pids counts threads, not just processes, and the two things a seat can
# cost are very different sizes — which is the whole point of D-061, so they get
# two reserves rather than one worst case.
#
# Measured on a 512-task machine: the desktop half of a seat (X server, session
# bus, window manager, dock, VNC) is ~52 tasks; its browser is ~136 more. One
# reserve sized for both meant a machine admitted two seats and refused a third
# it had ample room for.
SEAT_PID_RESERVE = 90
BROWSER_PID_RESERVE = 190
SEAT_MEMORY_RESERVE = 256 * 1024**2
BROWSER_MEMORY_RESERVE = 384 * 1024**2


class SeatError(RuntimeError):
    """A seat operation failed without taking the bridge down with it."""
    def __init__(self, detail: str, holder_bot_id: str | None = None):
        super().__init__(detail)
        self.holder_bot_id = holder_bot_id


def _check_capacity(
    root: Path = Path("/sys/fs/cgroup"),
    *,
    pid_reserve: int = SEAT_PID_RESERVE,
    memory_reserve: int = SEAT_MEMORY_RESERVE,
    what: str = "seat",
) -> None:
    """Refuse something this machine cannot carry, before anything is started.

    Reads the container's own cgroup rather than the host's totals: §5.1 caps
    this container, and the host having memory free says nothing about whether
    this machine may use it.

    Parameterised since D-061, because a seat and its browser are separately
    admitted and cost very different amounts. Without the browser's own check,
    starting one on a full machine is not refused — Chrome simply cannot fork,
    and the caller waits out the whole CDP timeout to be told the browser "did
    not come up", which is true and useless. Measured: 40 s to say so.
    """
    for resource, reserve in (("pids", pid_reserve), ("memory", memory_reserve)):
        try:
            maximum = (root / f"{resource}.max").read_text().strip()
            if maximum == "max":
                continue
            current = int((root / f"{resource}.current").read_text().strip())
            if int(maximum) - current < reserve:
                raise SeatError(
                    f"insufficient {resource} headroom for another {what}; "
                    "close unused seats or use another computer"
                )
        except FileNotFoundError:
            # Non-cgroup hosts run the unit suite; the image uses cgroup v2.
            continue


@dataclass
class Seat:
    """One bot's desktop, and every process that makes it one."""

    seat_id: str
    # M5-BE-23: whose seat this is.
    #
    # The machine is the only place a seat is recorded — there is no row for
    # one, deliberately: a seat outlives an orchestrator restart, and a mirror
    # in the database would be a second source of truth that can disagree with
    # the display actually running. So the label travels with the seat, or
    # nothing can ask "which of these is mine" after a restart.
    bot_id: str | None
    # D-060: the `--user-data-dir` this seat's browser runs on, by name under
    # SEAT_PROFILE_ROOT. The bot's own id by default; a granted identity's name
    # when the operator has granted one.
    profile: str
    display: str
    rfb_port: int
    cdp_port: int
    width: int
    height: int
    # The page this seat was asked for. Remembered rather than opened, because
    # the browser that would open it does not start until something needs CDP
    # (D-061) — and a seat created for a URL must still land on it then.
    url: str = "about:blank"
    # Zero before the lazy browser launch; bridge-issued on every real launch.
    browser_generation: int = 0
    identity_revision: int = 0
    # Started in this order, stopped in reverse. Held so `close` stops what it
    # actually started rather than pattern-matching a process table.
    _xvfb: subprocess.Popen | None = field(default=None, repr=False)
    _bus: subprocess.Popen | None = field(default=None, repr=False)
    _wm: subprocess.Popen | None = field(default=None, repr=False)
    _dock: subprocess.Popen | None = field(default=None, repr=False)
    _chrome: subprocess.Popen | None = field(default=None, repr=False)
    _relay: subprocess.Popen | None = field(default=None, repr=False)
    _vnc: subprocess.Popen | None = field(default=None, repr=False)

    def as_json(self) -> dict[str, object]:
        # `left`/`top` stay in the payload at 0/0. They are no longer a claim
        # about where a window sits — a seat IS the screen, so its origin is the
        # screen's — and they are kept rather than dropped because §4.3's client
        # reads them, and D-060 does not widen a ratified shape in order to
        # narrow it.
        return {
            "seatId": self.seat_id,
            "botId": self.bot_id,
            "profile": self.profile,
            "identityRevision": self.identity_revision,
            "display": self.display,
            # The seat's OWN session bus, so a caller that runs a command on
            # this seat can put it in the same session as the desktop rather
            # than the machine's. `_seat_env` sets the same value for the
            # seat's own processes; a bot's `shell` runs through docker exec
            # and inherits the IMAGE's environment instead, which is the
            # machine's bus — the difference is invisible until the command is
            # a desktop one (D-Bus singletons then see the wrong session).
            "dbusAddress": f"unix:path={_bus_socket(self.display)}",
            "rfbPort": self.rfb_port,
            # Reserved for this seat whether or not a browser is listening on
            # it yet (D-061). `browserReady` is what says which — a caller that
            # needs CDP asks for the browser first rather than dialling and
            # discovering.
            "cdpPort": self.cdp_port,
            "browserReady": self.browser_running(),
            "browserGeneration": self.browser_generation,
            "width": self.width,
            "height": self.height,
            "left": 0,
            "top": 0,
        }

    def parts(self) -> list[tuple[str, subprocess.Popen | None]]:
        """A seat's processes, named, in start order. Teardown walks it back."""
        return [
            ("Xvfb", self._xvfb),
            ("session bus", self._bus),
            ("window manager", self._wm),
            ("dock", self._dock),
            ("chrome", self._chrome),
            ("CDP relay", self._relay),
            ("x11vnc", self._vnc),
        ]

    def desktop_alive(self) -> bool:
        """The display/session survives a browser or screen transport failure."""
        return all(
            process is not None and process.poll() is None
            for name, process in self.parts()
            if name in {"Xvfb", "session bus", "window manager"}
        )

    def alive(self) -> bool:
        return self.desktop_alive() and self._vnc is not None and self._vnc.poll() is None

    def browser_running(self) -> bool:
        return all(p is not None and p.poll() is None for p in (self._chrome, self._relay))


def _seat_env(display: str) -> dict[str, str]:
    """The environment every process on one seat shares.

    A seat gets its OWN session bus, not the machine's. Measured: `plank` is a
    D-Bus singleton — started on a second display against the machine's bus it
    sees the existing instance and exits 0 without a window, so the seat comes
    up with no dock and therefore no restore control, which is the one thing
    D-060 set out to give it back. The same collision is waiting for every
    other xfce component a seat might grow.
    """
    return {
        **os.environ,
        "DISPLAY": display,
        "DBUS_SESSION_BUS_ADDRESS": f"unix:path={_bus_socket(display)}",
    }


def _bus_socket(display: str) -> str:
    runtime = os.environ.get("XDG_RUNTIME_DIR", "/tmp/runtime-bot")
    return f"{runtime}/seat{display.lstrip(':')}.bus"


def _spawn(argv: list[str], display: str) -> subprocess.Popen:
    """Start one of a seat's processes on its display and its own bus.

    Output goes nowhere on purpose: these are long-lived desktop components
    whose chatter is not diagnostic, and a pipe nobody drains is a process that
    blocks once its buffer fills.
    """
    process = subprocess.Popen(  # noqa: S603 - fixed argv, no shell
        argv,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=_seat_env(display),
        start_new_session=True,
    )
    process._crewaid_group = process.pid
    return process


def _await(what: str, timeout_s: float, probe) -> None:
    """Poll until `probe()` is true, or say what never came up.

    Waiting on the thing itself rather than sleeping a guessed interval, for the
    reason the entrypoint learned on the machine's own display: a seat that
    reports ready before its browser answers CDP is a seat whose first browser
    tool call fails.
    """
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            if probe():
                return
        except Exception:  # noqa: BLE001 - a probe that throws is a probe that is not ready yet
            pass
        time.sleep(0.2)
    raise SeatError(f"{what} did not come up within {timeout_s:.0f}s")


def _ran_ok(argv: list[str], display: str) -> bool:
    out = subprocess.run(  # noqa: S603 - fixed argv, no shell
        argv,
        env=_seat_env(display),
        capture_output=True,
        timeout=X_TIMEOUT_S,
        check=False,
    )
    return out.returncode == 0


_browser_sandbox: bool | None = None
_browser_sandbox_lock = threading.Lock()


def browser_sandbox() -> bool:
    """Whether Chrome can build its own sandbox in this container (D-145).

    Chrome confines each renderer in new user, PID and network namespaces and
    chroots it into an empty directory. The orchestrator's seccomp profile
    allows exactly that; Docker's default, which an older orchestrator still
    starts containers under, does not, and there Chrome's zygote dies at
    startup rather than degrading. So the question is asked of the container
    instead of assumed from the image: once, because a running container's
    seccomp profile cannot change, and with the same two calls Chrome makes.

    A machine that says no still gets a browser, under `--no-sandbox` as before
    D-145, and says so in the log and in `/health` so it is not mistaken for
    one that is sandboxed.
    """
    global _browser_sandbox
    with _browser_sandbox_lock:
        if _browser_sandbox is None:
            try:
                probe = subprocess.run(  # noqa: S603 - fixed argv, no shell
                    ["unshare", "--user", "--map-root-user", "chroot", "/", "true"],
                    capture_output=True,
                    timeout=X_TIMEOUT_S,
                    check=False,
                )
                _browser_sandbox = probe.returncode == 0
                reason = probe.stderr.decode(errors="replace").strip()
            except (OSError, subprocess.TimeoutExpired) as exc:
                _browser_sandbox = False
                reason = f"{type(exc).__name__}: {exc}"
            if not _browser_sandbox:
                print(
                    "[agent-bridge] Chrome's sandbox is unavailable in this container "
                    f"({reason or 'no detail'}); browsers start with --no-sandbox",
                    flush=True,
                )
        return _browser_sandbox


def _rfb_ready(port: int) -> bool:
    """Whether this seat's x11vnc is accepting connections yet.

    `Popen` returns as soon as the process is spawned, not when it has bound
    its port — so without this a seat is announced with an `rfbPort` that is
    still seconds away from listening, and a §4.3 subscribe that arrives in
    that window dials a closed port and reports "RFB upstream closed
    unexpectedly" to the operator. Measured: the orchestrator connected 6 ms
    after `seat.created` and lost the race.
    """
    with socket.create_connection(("127.0.0.1", port), timeout=1) as connection:
        banner = b""
        while len(banner) < 12:
            chunk = connection.recv(12 - len(banner))
            if not chunk:
                return False
            banner += chunk
        return banner.startswith(b"RFB ")


def _cdp_ready(port: int) -> bool:
    try:
        with urllib.request.urlopen(  # noqa: S310 - fixed loopback URL
            f"http://127.0.0.1:{port}/json/version", timeout=2
        ) as response:
            return response.status == 200
    except (OSError, ValueError, http.client.HTTPException):
        return False


def _group_alive(group: int) -> bool:
    # A zombie holds no profile or port. Ignore it while the container init reaps.
    for stat in Path("/proc").glob("[0-9]*/stat"):
        try:
            fields = stat.read_text().rsplit(")", 1)[1].split()
            if fields[0] != "Z" and int(fields[2]) == group:
                return True
        except FileNotFoundError:
            continue
    return False


def _stop(process: subprocess.Popen | None) -> None:
    """Confirm exit before a slot/profile reservation can be forgotten."""
    if process is None:
        return
    group = getattr(process, "_crewaid_group", None)
    grouped = type(group) is int
    alive = process.poll() is None
    if not alive and (not grouped or not _group_alive(group)):
        return
    try:
        if alive:
            if grouped:
                os.killpg(group, signal.SIGTERM)
            else:
                process.terminate()
        deadline = time.monotonic() + 5
        while grouped and _group_alive(group) and time.monotonic() < deadline:
            time.sleep(0.02)
        if grouped and _group_alive(group):
            # A dead leader's numeric group could have been reused. Refuse to
            # kill an unowned replacement; retaining the reservation is safe.
            if not alive:
                raise SeatError("process group survived an exited leader; restart the computer")
            os.killpg(group, signal.SIGKILL)
        elif not grouped:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
        process.wait(timeout=5)
        if process.poll() is None or (grouped and _group_alive(group)):
            raise SeatError("process did not exit; its profile and seat remain reserved")
    except ProcessLookupError:
        if process.poll() is None or (grouped and _group_alive(group)):
            raise SeatError("process exit could not be confirmed")
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise SeatError("process exit could not be confirmed; its seat remains reserved") from exc


def _clear_singleton(directory: Path) -> None:
    """Clear only a demonstrably dead or old-container Chrome singleton."""
    lock = directory / "SingletonLock"
    if lock.is_symlink():
        try:
            host, raw_pid = os.readlink(lock).rsplit("-", 1)
            pid = int(raw_pid)
            if pid <= 0:
                raise ValueError("invalid pid")
            if host == socket.gethostname():
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    pass
                else:
                    raise SeatError("IDENTITY_IN_USE: this profile has a live unowned Chrome lock; restart the computer")
        except (ValueError, OSError) as exc:
            raise SeatError("IDENTITY_IN_USE: this profile's Chrome lock cannot be verified") from exc
    elif lock.exists():
        raise SeatError("IDENTITY_IN_USE: this profile's Chrome lock cannot be verified")
    for name in ("SingletonLock", "SingletonCookie", "SingletonSocket"):
        (directory / name).unlink(missing_ok=True)


def _ensure_agent_dir(bot_id: str | None) -> None:
    """Create the bot's own area, if the seat belongs to a bot at all.

    Named and validated exactly like the seat directory beside it: the id is a
    single path segment, so a caller cannot reach outside `agents/` with one.
    A seat opened on a named identity rather than a bot has no bot id, and
    there is nothing of its own to create — the identity's browser profile is
    the thing it holds, and that is `_start_browser`'s.

    `exist_ok` without a mode check: a bot may have chmod'd its own area, and
    re-imposing 0700 on every seat creation would undo that on each restart.
    """
    if bot_id is None:
        return
    if not _SAFE_PROFILE.fullmatch(bot_id):
        raise SeatError(
            f"{bot_id!r} cannot name an agent directory; "
            "expected letters, digits, underscore or hyphen"
        )
    AGENT_DIRS_ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    (AGENT_DIRS_ROOT / bot_id).mkdir(mode=0o700, exist_ok=True)


def profile_for(bot_id: str | None) -> str:
    """The seat directory a bot runs on when it has been granted no identity."""
    if bot_id is None:
        return DEFAULT_PROFILE
    if not _SAFE_PROFILE.fullmatch(bot_id):
        raise SeatError(
            f"{bot_id!r} cannot name a seat directory; "
            "expected letters, digits, underscore or hyphen"
        )
    if bot_id == DEFAULT_PROFILE or marker(MACHINE_HOME, bot_id).exists():
        raise SeatError("this bot profile is reserved or retired")
    return bot_id


def resolve_profile(bot_id: str | None, profile: str | None) -> str:
    """The seat directory to open on: a named identity, or the bot's own.

    The name is a single path segment under SEAT_PROFILE_ROOT and is validated
    as one, so no caller can reach outside the root with it. Which names are
    legal identities is the orchestrator's question, not this one: it holds the
    grants and the machine's bot ids, and the registry checks only the shape.
    """
    if profile is None:
        return profile_for(bot_id)
    if not _SAFE_PROFILE.fullmatch(profile):
        raise SeatError(
            f"{profile!r} cannot name a seat directory; "
            "expected letters, digits, underscore or hyphen"
        )
    if profile == DEFAULT_PROFILE or profile == Path(MACHINE_USER_DATA_DIR).name:
        raise SeatError("this profile is reserved for the machine's own browser")
    if marker(MACHINE_HOME, profile).exists():
        raise SeatError("this profile is reserved or retired")
    return profile


class SeatRegistry:
    """The machine's seats, and the lock that makes creation attributable."""

    def __init__(self) -> None:
        self._seats: dict[str, Seat] = {}
        self._browser_generation = 0
        self._selection_revisions: dict[str, int] = {}
        # Serialize admission, slot allocation and startup: each pending seat
        # consumes resources before it becomes one.
        self._lock = threading.Lock()

    def list(self) -> list[dict[str, object]]:
        with self._lock:
            return [seat.as_json() for seat in self._seats.values()]

    def _free_slot(self) -> int:
        taken = {seat.rfb_port - SEAT_RFB_PORT_BASE for seat in self._seats.values()}
        for offset in range(SEAT_COUNT):
            if offset not in taken:
                return offset
        raise SeatError(
            f"every seat slot is in use ({SEAT_COUNT}); "
            "a machine holds a bounded number of seats"
        )

    def _reap(self, seat: Seat) -> None:
        """Drop a seat whose desktop has died, stopping whatever survived it."""
        self._teardown(seat)
        self._seats.pop(seat.seat_id, None)

    def find(self, bot_id: str) -> dict[str, object] | None:
        """This bot's seat, if the machine has a LIVE one.

        The read half of allocation. An orchestrator that restarted asks this
        before creating anything, which is what makes seat creation idempotent
        without a row to remember it by. A seat whose desktop has died is reaped
        here rather than answered with: handing back a dead seat is the failure
        D-060 records, and hiding it from `create` alone would leave `find` still
        advertising a port nothing is listening on.
        """
        with self._lock:
            for seat in list(self._seats.values()):
                if seat.bot_id != bot_id:
                    continue
                if self._ensure_screen(seat):
                    return seat.as_json()
                self._reap(seat)
        return None

    def create(
        self,
        *,
        bot_id: str | None = None,
        profile: str | None = None,
        identity_revision: int = 0,
        url: str = "about:blank",
        width: int = DEFAULT_SEAT_WIDTH,
        height: int = DEFAULT_SEAT_HEIGHT,
        left: int = 0,
        top: int = 0,
    ) -> dict[str, object]:
        # `left`/`top` are accepted and ignored: they positioned a window on a
        # shared display, and a seat is now the display. Refusing them would
        # break a caller that is still sending the ratified shape for no gain.
        del left, top
        with self._lock:
            wanted = resolve_profile(bot_id, profile)
            self._check_revision(bot_id, identity_revision)

            # Idempotent under the same lock that serializes creation, so two
            # turns starting at once for one bot cannot each build a desktop.
            if bot_id is not None:
                for seat in list(self._seats.values()):
                    if seat.bot_id != bot_id:
                        continue
                    if not self._ensure_screen(seat):
                        self._reap(seat)
                        break
                    # A seat's profile is fixed at creation: its browser holds
                    # one `--user-data-dir` and Chrome cannot move it. Answering
                    # with the seat this bot has would hand the caller a desktop
                    # on the WRONG identity and look like it worked (M5-BE-27).
                    if seat.profile != wanted or seat.identity_revision != identity_revision:
                        raise SeatError(
                            f"bot {bot_id} already has a seat on profile "
                            f"{seat.profile!r}; close it before opening one on "
                            f"{wanted!r}"
                        )
                    return seat.as_json()

            # An identity is exclusive, and this is where that is enforced.
            # Two browsers cannot share one `--user-data-dir`: the second would
            # delegate into the first seat's display rather than opening its
            # own, so the operator would watch one bot and drive another. Chrome
            # makes that failure silent; naming it here makes it a sentence the
            # model can act on (D-060).
            for seat in list(self._seats.values()):
                if not self._ensure_screen(seat):
                    self._reap(seat)
                    continue
                if seat.profile == wanted:
                    holder = seat.bot_id or "another seat"
                    raise SeatError(
                        f"IDENTITY_IN_USE: identity {wanted!r} is in use by {holder}; "
                        "open that bot screen, hand control back, and choose Release shared login",
                        holder_bot_id=seat.bot_id,
                    )

            _check_capacity()
            offset = self._free_slot()
            seat = Seat(
                seat_id=uuid.uuid4().hex[:12],
                bot_id=bot_id,
                profile=wanted,
                identity_revision=identity_revision,
                display=f":{SEAT_DISPLAY_BASE + offset}",
                rfb_port=SEAT_RFB_PORT_BASE + offset,
                cdp_port=SEAT_CDP_PORT_BASE + offset,
                width=width,
                height=height,
                url=url,
            )
            self._seats[seat.seat_id] = seat
            try:
                self._start(seat)
            except BaseException:
                # A seat that fails halfway must leave nothing running: the
                # machine is shared, the slot is about to be handed to the next
                # caller, and only the caller sees the error.
                self._teardown(seat)
                self._seats.pop(seat.seat_id, None)
                raise
            self._seats[seat.seat_id] = seat
            return seat.as_json()

    def _start(self, seat: Seat) -> None:
        """Bring one seat's desktop up, in dependency order."""
        display = seat.display
        _ensure_agent_dir(seat.bot_id)
        # Only an unallocated slot reaches here. Container restart can leave
        # X lock files whose old PID now belongs to an unrelated new process.
        number = display.lstrip(":")
        Path(f"/tmp/.X{number}-lock").unlink(missing_ok=True)
        Path(f"/tmp/.X11-unix/X{number}").unlink(missing_ok=True)
        seat._xvfb = _spawn(
            [
                "Xvfb",
                display,
                "-screen",
                "0",
                f"{seat.width}x{seat.height}x{SCREEN_DEPTH}",
                "-nolisten",
                "tcp",
            ],
            display,
        )
        _await(
            f"X display {display}",
            DISPLAY_READY_TIMEOUT_S,
            lambda: _ran_ok(["xdotool", "getdisplaygeometry"], display),
        )

        # `--nofork` keeps the bus a child this registry can stop; the daemon's
        # own forking mode would hand back a pid that exits immediately, which
        # is the trap the entrypoint documents on the machine's bus.
        socket_path = Path(_bus_socket(display))
        socket_path.unlink(missing_ok=True)
        seat._bus = _spawn(
            [
                "dbus-daemon",
                "--session",
                "--nofork",
                "--nopidfile",
                f"--address=unix:path={socket_path}",
            ],
            display,
        )
        _await(f"session bus for {display}", DISPLAY_READY_TIMEOUT_S, socket_path.exists)

        # The window manager is what makes this a desktop rather than a bare
        # root window: without one a browser window has no decorations, cannot
        # be moved, and a dialog cannot be dismissed by the operator who took
        # over. Nothing else owns this display, so no `--replace`.
        seat._wm = _spawn(["xfwm4"], display)
        _await(
            f"window manager on {display}",
            WM_READY_TIMEOUT_S,
            lambda: _ran_ok(["wmctrl", "-m"], display),
        )

        if not _ran_ok(
            ["feh", "--no-fehbg", "--bg-fill", str(WALLPAPER_PATH)], display
        ):
            raise SeatError(f"could not set wallpaper on {display}")

        # The dock is not decoration: it is the restore control. A window seat
        # had none, which is why minimising froze the screen with no way back
        # (D-060). Its absence must not fail a seat though — a bot works fine
        # without it, and an operator can still reach a minimised window through
        # the window manager.
        if shutil.which("plank"):
            seat._dock = _spawn(["plank"], display)

        # No browser here (D-061). A seat is a DESKTOP, and starting Chrome on
        # every one spent about two thirds of a seat's cost on a browser that a
        # bot which never browses would never open — measured at 136 tasks of a
        # seat's ~200, against §5.1's 512 for the whole machine. That is what
        # held a machine to two screens. `ensure_browser` starts it on the first
        # call that needs CDP, which is exactly when a bot first browses.

        self._start_vnc(seat)

    def _ensure_screen(self, seat: Seat) -> bool:
        # Never discard browser windows or a recording because only x11vnc
        # exited. Failure to restart propagates to the bounded screen retry;
        # it must not fall through to reaping a healthy desktop.
        if not seat.desktop_alive():
            return False
        if seat._vnc is None or seat._vnc.poll() is not None:
            self._start_vnc(seat)
        return True

    def _start_vnc(self, seat: Seat) -> None:
        # A transport process can restart without touching the X display or Chrome.
        # `-noxdamage` for the reason the entrypoint gives on the machine's own
        # server: XDAMAGE under Xvfb misses updates from some toolkits, and a
        # missed update is a permanently stale region on the operator's screen.
        # `-defer 5 -wait 5` because without XDAMAGE x11vnc polls for changes,
        # and its 20 ms defaults are most of what a typed character waits for.
        # `-threads` because otherwise a new client is served by the polling
        # loop, which naps when the screen is quiet: every handshake step waited
        # out a nap, so opening a seat idle for a minute took 1.1-1.4 s before
        # the first byte and up to 2.3 s before a picture. Threaded, each client
        # has its own reader, and a viewer is answered in about 0.1 s (measured
        # 2026-10-15). x11vnc documents Tight as stable this way on Linux.
        display = seat.display
        seat._vnc = _spawn(
            [
                "x11vnc",
                "-display",
                display,
                "-forever",
                "-shared",
                "-nopw",
                "-noxdamage",
                "-defer",
                "5",
                "-wait",
                "5",
                "-threads",
                "-rfbport",
                str(seat.rfb_port),
            ],
            display,
        )
        # A seat is not ready until its port is: `create` returns this seat to
        # a caller that is about to dial it, and the entrypoint waits on the
        # machine's own RFB server for the same reason.
        _await(
            f"RFB server on {display}",
            DISPLAY_READY_TIMEOUT_S,
            lambda: _rfb_ready(seat.rfb_port),
        )


    def ensure_browser(self, bot_id: str, identity_revision: int | None = None) -> dict[str, object]:
        """Start this bot's browser if it is not already running (D-061).

        Idempotent under the creation lock, like `create`: two tool calls
        arriving together must not each start a Chrome on one profile — the
        second would delegate into the first and the caller would drive a window
        nobody is watching.
        """
        with self._lock:
            seat = next((s for s in self._seats.values() if s.bot_id == bot_id), None)
            if seat is None:
                raise SeatError(f"bot {bot_id} has no seat to start a browser on")
            if identity_revision is not None and identity_revision != seat.identity_revision:
                raise SeatError("STALE_IDENTITY: the login selection changed")
            return self._ensure_browser(seat)

    def ensure_browser_on_display(self, display: str) -> dict[str, object]:
        """The same start, addressed by display rather than bot.

        The dock's Chrome icon is such a caller: plank hands the launcher the
        DISPLAY it lives on and nothing else, and the seat on that display is
        the only browser it can mean. A bare `google-chrome` from the desktop
        entry would serve none of it — no `--no-sandbox` where the container
        needs it (`browser_sandbox`), so it can die before a window appears,
        and no per-seat `--user-data-dir` or CDP relay, so the bot could not
        drive what opened.
        """
        with self._lock:
            seat = next((s for s in self._seats.values() if s.display == display), None)
            if seat is None:
                raise SeatError(f"no seat on display {display} to start a browser on")
            return self._ensure_browser(seat)

    def _ensure_browser(self, seat: Seat) -> dict[str, object]:
        """Start one seat's browser; the caller holds the creation lock.

        Restart failed browser processes without closing the live desktop.
        A dead desktop is reaped and must be allocated again by the caller.
        """
        if seat.bot_id is not None and seat.identity_revision < self._selection_revisions.get(seat.bot_id, 0):
            raise SeatError("STALE_IDENTITY: this seat's login selection changed; release it before browsing")
        if not self._ensure_screen(seat):
            self._reap(seat)
            raise SeatError(f"the seat on {seat.display} has no live desktop")
        # Chrome can close CDP before its process exits. An alive PID during
        # that shutdown window is not a browser a new turn can connect to.
        if (seat.browser_running() and _cdp_ready(seat.cdp_port + SEAT_COUNT)
                and _cdp_ready(seat.cdp_port)):
            return seat.as_json()
        _stop(seat._relay)
        _stop(seat._chrome)
        seat._relay = None
        seat._chrome = None
        _check_capacity(
            pid_reserve=BROWSER_PID_RESERVE,
            memory_reserve=BROWSER_MEMORY_RESERVE,
            what="browser",
        )
        try:
            self._start_browser(seat)
        except BaseException:
            # Leave the DESKTOP up: the operator is watching it, and a
            # browser that would not start is not a reason to take their
            # screen away. Only what this call started is undone.
            _stop(seat._relay)
            _stop(seat._chrome)
            seat._relay = None
            seat._chrome = None
            raise
        return seat.as_json()

    def _reserve_browser_generation(self, seat: Seat, directory: Path) -> None:
        """Reserve before spawning, so a crash cannot reuse a generation.

        The marker follows the named profile through handoff and computer restart.
        Wall time distinguishes restored profiles; the marker survives clock rollback.
        This is generation metadata, not a second login/holder authority.
        """
        marker = directory / ".crewaid-browser-generation"
        try:
            raw = marker.read_text().strip()
        except FileNotFoundError:
            raw = "0"
        if not raw.isascii() or not raw.isdigit() or len(raw) > 16:
            raise SeatError("invalid browser generation marker; refusing profile launch")
        previous = int(raw)
        generation = max(previous + 1, self._browser_generation + 1, time.time_ns() // 1000)
        if not 0 < generation <= 9007199254740991:
            raise SeatError("browser generation exceeded the safe integer bound")
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", dir=directory, delete=False) as file:
                temporary = Path(file.name)
                file.write(str(generation))
                file.flush()
                os.fsync(file.fileno())
            temporary.replace(marker)
            directory_fd = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
            self._browser_generation = generation
            seat.browser_generation = generation
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def _start_browser(self, seat: Seat) -> None:
        """This seat's browser and the relay in front of it."""
        display = seat.display
        directory = SEAT_PROFILE_ROOT / seat.profile
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        _clear_singleton(directory)
        self._reserve_browser_generation(seat, directory)
        seat._chrome = _spawn(
            [
                "google-chrome",
                # Only where this container cannot give Chrome its own sandbox.
                *([] if browser_sandbox() else ["--no-sandbox"]),
                # Pins WM_CLASS to plain "google-chrome". Chrome otherwise
                # derives it from the `--user-data-dir` below — a seat's window
                # comes up as
                # `google-chrome (/home/bot/.seats/<bot>).Google-chrome` — which
                # matches the StartupWMClass of neither desktop entry it ships.
                # The dock then cannot pair the running window with its pinned
                # launcher and shows Chrome TWICE: once pinned, once unmatched.
                # The entrypoint learned this on the machine's own browser and
                # says the same thing: `--user-data-dir` is what triggers it, so
                # the two flags have to travel together.
                "--class=google-chrome",
                f"--user-data-dir={directory}",
                f"--remote-debugging-port={seat.cdp_port + SEAT_COUNT}",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-dev-shm-usage",
                # Chrome in an unprivileged container cannot self-update under
                # cap_drop/no-new-privileges; suppress outdated-build and
                # component-update nags so "Can't update Chrome / Reinstall
                # Chrome" bubbles never obscure a seat's viewport. Updates ship
                # with rebuilt sandbox images.
                "--disable-component-update",
                "--check-for-update-interval=31536000",
                "--simulate-outdated-no-au=Tue, 31 Dec 2099 23:59:59 GMT",
                # A seat is torn down by killing its browser, which Chrome
                # records as an unclean shutdown — so without this the NEXT
                # seat on that profile opens under a "Restore pages?" bubble
                # over the page, and an operator watching sees a dialog no bot
                # asked for. The teardown is by design, so suppressing the
                # complaint about it is too.
                "--disable-session-crashed-bubble",
                "--hide-crash-restore-bubble",
                f"--window-size={seat.width},{seat.height}",
                "--window-position=0,0",
                seat.url,
            ],
            display,
        )
        _await(
            f"Chrome CDP on {display}",
            CDP_READY_TIMEOUT_S,
            lambda: _cdp_ready(seat.cdp_port + SEAT_COUNT),
        )

        # Chrome binds to loopback even with --remote-debugging-address.
        # Publish a relay just as the machine browser does; mapping Chrome's
        # own loopback listener through Docker cannot reach it.
        seat._relay = _spawn(
            ["socat", f"TCP4-LISTEN:{seat.cdp_port},bind=0.0.0.0,reuseaddr,fork",
             f"TCP4:127.0.0.1:{seat.cdp_port + SEAT_COUNT}"], display,
        )
        _await("seat CDP relay", DISPLAY_READY_TIMEOUT_S,
               lambda: _cdp_ready(seat.cdp_port))

    def _teardown(self, seat: Seat) -> None:
        """Stop every process this seat started, in reverse order.

        Reverse matters: stopping Xvfb first leaves its clients writing to a
        display that is gone, and not all of them exit when that happens.
        """
        # Browser.close flushes pending cookie writes; SIGTERM can lose a
        # login acknowledged immediately before the seat is closed.
        if seat._chrome is not None and seat._chrome.poll() is None:
            try:
                subprocess.run(
                    ["python3", "/opt/crewaid/close-browser.py", str(seat.cdp_port + SEAT_COUNT)],
                    capture_output=True, timeout=5, check=False,
                )
                seat._chrome.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                pass
        for _, process in reversed(seat.parts()):
            _stop(process)

    def _check_revision(self, bot_id: str | None, revision: int) -> None:
        if type(revision) is not int or not 0 <= revision <= 2147483647:
            raise SeatError("invalid identity revision")
        if bot_id is not None:
            if revision < self._selection_revisions.get(bot_id, 0):
                raise SeatError("STALE_IDENTITY: the login selection changed")
            self._selection_revisions[bot_id] = revision

    def close(self, seat_id: str, identity_revision: int | None = None) -> bool:
        with self._lock:
            seat = self._seats.get(seat_id)
            if seat is None:
                return False
            self._check_revision(seat.bot_id, seat.identity_revision if identity_revision is None else identity_revision)
            # Keep the reservation visible until every managed process exits.
            self._teardown(seat)
            self._seats.pop(seat_id, None)
            return True

    def close_all(self) -> None:
        """Try every seat, retaining any reservation whose shutdown is uncertain."""
        with self._lock:
            failures = []
            for seat in list(self._seats.values()):
                try:
                    self._teardown(seat)
                    self._seats.pop(seat.seat_id, None)
                except SeatError:
                    failures.append(seat.seat_id)
            if failures:
                raise SeatError(f"could not confirm exit for seats {failures}")
