#!/usr/bin/env bash
#
# PID 1 for a bot sandbox (PRD §5, M2-IN-03).
#
# Starts the desktop in dependency order and then supervises it. The whole
# contract is one sentence from §5: "If any supervised process exits, the
# entrypoint exits non-zero so Docker marks the container unhealthy." That is
# what turns a half-dead desktop — X still up, Chrome gone, the operator staring
# at a frozen screen — into a container the orchestrator can observe as
# UNHEALTHY and replace (M2-BE-05).
#
# Ordering is not stylistic. Each step below blocks until the thing it starts is
# actually answering, because every later step connects to an earlier one, and a
# race here surfaces as an intermittent black screen rather than an error.

set -uo pipefail

log() { printf '[entrypoint] %s\n' "$*" >&2; }
die() { log "FATAL: $*"; teardown; exit 1; }

declare -A CHILD_NAME=()

# Track each child by pid so the exit message can name what died. A supervisor
# that reports "a process exited" sends the next person to read six logs.
supervise() {
  local name=$1
  shift
  "$@" &
  local pid=$!
  CHILD_NAME[$pid]=$name
  log "started ${name} (pid ${pid})"
}

# Take the whole desktop down together. Half of these processes hold the X
# display open, so leaving any of them behind keeps the container alive past the
# point where it can serve anyone.
teardown() {
  local pid
  for pid in "${!CHILD_NAME[@]}"; do
    [[ ${pid} == "${1:-}" ]] && continue
    kill -TERM "$pid" 2>/dev/null || true
  done
}

# Ask the bridge to close its seats, then give it a bounded chance to flush them
# while every seat's X display and session bus are still serving it.
#
# The reasoning is the one this used to apply to the machine's own Chrome and is
# unchanged by D-060: Chrome acknowledges a cookie-setting CDP command before its
# batched SQLite write reaches disk, and signal/window-manager shutdown both lost
# that cookie reproducibly. What changed is WHOSE browser matters. The bridge
# holds every seat, and its SIGTERM handler runs `SEATS.close_all()`, which asks
# each seat's Chrome to close before stopping its display — so stopping the
# bridge first is what preserves a real logged-in session now.
stop_seats_gracefully() {
  local pid state deadline
  for pid in "${!CHILD_NAME[@]}"; do
    [[ ${CHILD_NAME[$pid]} == agent-bridge ]] || continue
    kill -TERM "$pid" 2>/dev/null || true
    deadline=$(( SECONDS + 15 ))
    while (( SECONDS < deadline )); do
      state=$(ps -o stat= -p "$pid" 2>/dev/null)
      [[ -z $state || $state == Z* ]] && break
      sleep 0.1
    done
    return
  done
}

# `docker stop` should be a clean shutdown rather than a 10-second wait for
# SIGKILL on every sandbox the operator closes.
shutdown() {
  trap - TERM INT
  log "signal received — stopping ${#CHILD_NAME[@]} supervised processes"
  # The seats' browsers first, with each seat's X and session bus still serving
  # them. This is what makes a requested stop preserve a real logged-in session
  # rather than merely preserve the directory it used to live in.
  stop_seats_gracefully
  teardown
  wait
  exit 0
}
trap shutdown TERM INT

# Name the first supervised child that is gone, if there is one. Bash reaps
# nothing until we wait, so a dead child is a zombie rather than a missing pid,
# and `kill -0` still succeeds on it — the process state is the only honest
# signal.
dead_child() {
  local pid state
  for pid in "${!CHILD_NAME[@]}"; do
    state=$(ps -o stat= -p "$pid" 2>/dev/null)
    if [[ -z $state || $state == Z* ]]; then
      printf '%s' "${CHILD_NAME[$pid]}"
      return 0
    fi
  done
  return 1
}

# Bounded wait. Every readiness probe below is one of these, so a component that
# never comes up fails the container at boot with a named reason instead of
# hanging PID 1 forever and letting the 20 s start budget (§7.4) expire on a
# container that will never be ready.
#
# It watches the children as well as the clock. Waiting only on the clock
# reports "did not become ready within 40s" for a process that died two seconds
# in — the wrong reason, 38 seconds late, and already past the cold-start budget
# whoever is timing the boot is measuring against. Chrome's first run under the
# §5.1 constraints fails exactly this way.
await() {
  local what=$1 timeout=$2
  shift 2
  local deadline=$(( SECONDS + timeout )) casualty
  until "$@" >/dev/null 2>&1; do
    if casualty=$(dead_child); then
      die "${casualty} exited while starting ${what}"
    fi
    (( SECONDS < deadline )) || die "${what} did not become ready within ${timeout}s"
    sleep 0.2
  done
  log "ready: ${what}"
}

# x11vnc accepts a TCP connection slightly before it can serve a framebuffer,
# so "the port is open" is not the same question as "RFB is up". Reading the
# protocol version banner is the first thing a real client does and costs one
# round trip.
#
# curl speaks telnet:// and looks like the obvious probe here. It is not: its
# telnet handler connects and then blocks forever waiting for input that never
# arrives, and --connect-timeout stops applying the moment the connect
# succeeds. The probe hangs instead of failing, which reads as a slow boot
# rather than a broken one.
rfb_ready() {
  local banner=''
  exec 3<>/dev/tcp/127.0.0.1/5900 || return 1
  read -r -t 2 banner <&3
  exec 3>&-
  [[ $banner == RFB* ]]
}

# ── 0. workspace ─────────────────────────────────────────────────────────────
# D-039. $HOME is a durable volume in production and a plain image directory in
# tests; this step makes both look the same to everything below it.
#
# Image-owned configuration is replaced from the skel on EVERY boot. That is
# the whole reason the skel exists: Docker seeds a named volume from the image
# only while the volume is empty, so config written straight into /home/bot
# would freeze at whatever the bot's first boot produced and no image update
# would ever reach it — including the dock, which §5 lists as an acceptance
# criterion. The consequence is deliberate and worth knowing: an edit to an
# image-owned path does not survive a restart. Anything a bot must be able to
# keep is bot-owned and is never in the skel.
#
# `cp -a` runs as `bot` over a skel already owned by `bot`, so ownership is
# preserved without needing root.
if [[ -d /opt/crewaid/skel ]]; then
  cp -a /opt/crewaid/skel/. "$HOME"/ || die "could not apply the image skel to ${HOME}"
  log "applied image-owned config from /opt/crewaid/skel"
fi

# Bot-owned directories: created if absent, NEVER overwritten. A fresh volume
# arrives with these already copied from the image, and a bot that removed one
# should get an empty directory back rather than a boot failure — but a bot
# that filled one must keep it. Putting .chrome in the skel instead would reset
# every browser profile, and every logged-in session, on every restart.
#
# `shared` is WORKSPACE §19's team area — the board, the memory, whatever two
# bots hand each other — and it is the machine's, so it exists from boot rather
# than from the first board_add. The per-bot half of the layout cannot be here:
# `<home>/agents/<botId>` names a tenant, and the machine knows its tenants only
# when each one's seat opens (`seats.py::_ensure_agent_dir`).
mkdir -p "$HOME/.chrome" "$HOME/shared" "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME"

# Chrome's profile lock, for the same reason as the X lock below and with the
# same fix. Chrome writes SingletonLock into its user-data-dir naming
# "<hostname>-<pid>", and refuses to start when it finds one it cannot attribute
# to a live local process. A durable profile (D-039) keeps that file across a
# container replacement, and the replacement always has a NEW hostname — so
# Chrome reads it as "in use by another computer" and exits, which the
# supervisor correctly turns into a dead sandbox:
#
#   The profile appears to be in use by another Google Chrome process (124)
#   on another computer (228071f663a7).
#
# That makes it a hard failure on EVERY replacement, not an intermittent one,
# and it would have made "the browser profile survives" an empty promise. Safe
# to clear here for the same reason: this is pid 1 in a private pid namespace,
# before any Chrome has started, so a lock found here is always stale.
rm -f "$HOME/.chrome/SingletonLock" "$HOME/.chrome/SingletonCookie" \
      "$HOME/.chrome/SingletonSocket"

# Chrome can recreate a loaded profile after rmtree. Reap before any browser
# starts, including after a stopped machine loses a tenant.
python3 /opt/agent-bridge/profiles.py reap || die "could not reap retired profiles"

# ── 1. session bus ───────────────────────────────────────────────────────────
# AT-SPI has no other way to reach the desktop, and xfce4-session refuses to
# start without a session bus. --nofork keeps it a child this script can wait
# on; the daemon's own forking mode would hand us a pid that exits immediately
# and trip the supervisor at boot.
export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
supervise dbus-daemon \
  dbus-daemon --session --nofork --nopidfile --address="$DBUS_SESSION_BUS_ADDRESS"
# A socket file appears before dbus-daemon is necessarily accepting messages.
# Starting XFCE in that gap makes xfce4-session exit immediately on a loaded
# host even though the readiness check just passed. Exercise the bus with the
# same session address XFCE will use so readiness means a complete round trip.
await "session bus" 10 dbus-send --session --dest=org.freedesktop.DBus \
  --type=method_call --print-reply / org.freedesktop.DBus.ListNames

# ── 2. X display ─────────────────────────────────────────────────────────────
# R8: NO -resize AND NO RANDR RESOLUTION CHANGES. The framebuffer is fixed for
# the container's entire lifetime and the client scales the image. A resizable
# display would renegotiate mid-session, which invalidates every recorded input
# coordinate (M3) and every cached screen dimension the client holds.
# -nolisten tcp keeps X off the network; everything here connects over the unix
# socket, so the display is not reachable from `agent-net` at all.
#
# The lock files are cleared first because this entrypoint runs on RESTART as
# well as on first boot, and `docker start` after a kill replays it against a
# filesystem the previous run left behind. Xvfb refuses a display whose
# /tmp/.X1-lock names a live pid — and a restarted container gets a FRESH pid
# namespace, so the dead pid recorded in that lock is very likely alive again
# (the old Xvfb was pid 8; so is the new one). The result is "Server is already
# active for display 1", the entrypoint's exit contract fires, and the sandbox
# a health poll just marked UNHEALTHY can never be started again — intermittently,
# depending on which pid the stale lock happens to name.
#
# Unconditional removal is safe HERE and nowhere else: this runs as pid 1 in a
# private pid and mount namespace, before anything in it has opened a display,
# so there is no other X server whose lock this could be stealing.
rm -f /tmp/.X"${DISPLAY#:}"-lock "/tmp/.X11-unix/X${DISPLAY#:}"
# The X screen is DELIBERATELY larger than the screen the product advertises.
#
# D-046 / M5-BE-25: a client does not read the geometry off the RFB stream. It
# SYNTHESISES the handshake from the `Sandbox` row (`rfbChannel.ts`), so a seat
# that streams anything other than SCREEN_WIDTH x SCREEN_HEIGHT gives a
# misaligned picture and offset input — R8's whole point.
#
# And a window cannot be the full size of the screen it is on: measured, a
# window asked for 1280x800 on a 1280x800 display comes back 1279x799, one
# pixel short in each direction, whether or not it is decorated. So the
# display gets a margin the product never mentions, and a seat is created at
# exactly the advertised size inside it.
#
# The margin is small on purpose — the framebuffer costs
# (W+M)*(H+M)*4 bytes — and the extra strip is only ever visible in the
# machine-wide stream on 5900, which is not what any bot's §4.3 stream shows.
SCREEN_MARGIN="${SCREEN_MARGIN:-8}"
DISPLAY_WIDTH=$(( SCREEN_WIDTH + SCREEN_MARGIN ))
DISPLAY_HEIGHT=$(( SCREEN_HEIGHT + SCREEN_MARGIN ))
supervise Xvfb \
  Xvfb :1 -screen 0 "${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}x${SCREEN_DEPTH}" -nolisten tcp
await "X display :1" 15 timeout 2 xdotool getdisplaygeometry

# ── 3. desktop session ───────────────────────────────────────────────────────
# xfce4-panel is deliberately not installed, so there is no panel to disable —
# plank is the dock (§5). xfwm4 and xfdesktop4 come up as session children of
# xfce4-session rather than as supervised processes of ours; killing the session
# takes them with it, which is the behaviour we want from a single pid.
supervise xfce4-session xfce4-session
await "window manager" 30 timeout 2 wmctrl -m

supervise plank plank

# ── 4. (no browser here) ─────────────────────────────────────────────────────
# The machine ran a Chrome of its own until D-060, on private port 9223 behind a
# relay on the contractual 9222, because every bot's seat was a WINDOW inside it.
# A seat is now a display with its own browser on its own `--user-data-dir`, so
# that one served nobody: measured at 141 tasks and ~300 MB, which is MORE than
# a whole seat costs, against §5.1's 512-task ceiling. It is what made a second
# bot's screen fail with "insufficient pids headroom" on a machine with room for
# the work.
#
# 9222 stays published. Nothing listens on it, and an unpublished port cannot be
# added later — `setPorts` is not implemented — so leaving the binding costs a
# port and keeps the readiness gate, the `Sandbox.cdpPort` column and any
# operator's muscle memory pointing somewhere harmless rather than gone.
#
# What a browser is FOR is now per seat: `/seats` starts one, waits for its CDP,
# and puts a relay in front of it exactly the way this block used to.

# ── 5. RFB server ────────────────────────────────────────────────────────────
# -nopw is not an oversight: R6 routes every client through the orchestrator's
# RFB proxy, which is already authenticated, and the port is unreachable from
# anywhere else. A second password here would be a credential inside a sandbox,
# which §7.3 forbids outright.
# -noxdamage trades a little bandwidth for correctness — the XDAMAGE extension
# under Xvfb misses updates from some toolkits, and a missed update shows up as
# a permanently stale region on the operator's screen.
# -defer 5 -wait 5: without XDAMAGE, x11vnc finds changes by polling, and its
# defaults (20 ms each) took 77 ms (p50) to send a typed character; these took
# 57 ms, with no idle CPU to measure. Every keystroke a person types pays it.
supervise x11vnc \
  x11vnc -display :1 -forever -shared -nopw -rfbport 5900 -noxdamage -defer 5 -wait 5
await "RFB server" 15 rfb_ready

# ── 6. agent-bridge ──────────────────────────────────────────────────────────
supervise agent-bridge python3 /opt/agent-bridge/bridge.py
await "agent-bridge" 15 curl -fsS --max-time 10 http://127.0.0.1:7070/health

# ── 7. screen gateway (D-223) ────────────────────────────────────────────────
# Serves this machine's screens straight to viewers that hold a grant, on
# loopback only. In a restart loop rather than supervised directly: every
# supervised exit tears the whole desktop down, and a viewer service failing
# must not take the bot's desktop with it. It is not awaited either — nothing
# here needs it, and a viewer that arrives first is refused and reconnects. The
# trap hands teardown's TERM to node: on a host where this script is not the
# container's main process, a gateway left behind would hold 7071 against the
# next desktop's.
supervise screen-gateway sh -c \
  'trap "kill \$child 2>/dev/null; exit 0" TERM INT
   while :; do node /opt/screen-gateway/gateway.cjs & child=$!; wait $child; sleep 1; done'

log "sandbox up: seats ${SCREEN_WIDTH}x${SCREEN_HEIGHT} on a ${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}x${SCREEN_DEPTH} display :1"

# ── supervise ────────────────────────────────────────────────────────────────
# Any exit at all is a failure, including a clean one. A component that decides
# to shut itself down tidily still leaves the operator with a desktop that is
# missing a piece, and "exited 0" would let Docker report the container as
# stopped-successfully — the one state the orchestrator would not replace.
dead_pid=
wait -n -p dead_pid
status=$?
name=${CHILD_NAME[${dead_pid:-}]:-unknown}

log "${name} (pid ${dead_pid:-?}) exited with status ${status} — tearing down the sandbox"
teardown "${dead_pid:-}"

(( status == 0 )) && status=1
exit "$status"
