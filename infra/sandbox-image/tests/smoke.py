#!/usr/bin/env python3
"""Exercise the built image across a real Docker network under §5.1 limits.

Usage: python3 infra/sandbox-image/tests/smoke.py [image]
The image must already be built. All resources created here are removed.
"""
import json
import subprocess
import sys
import time
import uuid

IMAGE = sys.argv[1] if len(sys.argv) > 1 else "crewaid/sandbox:dev"
NAME = f"crewaid-image-test-{uuid.uuid4().hex[:10]}"


def docker(*args, timeout=60, **kwargs):
    try:
        return subprocess.run(
            ["docker", *args], check=True, text=True, capture_output=True,
            timeout=timeout, **kwargs,
        ).stdout.strip()
    except subprocess.CalledProcessError as failure:
        # capture_output hides the daemon's own explanation behind a bare
        # "returned non-zero exit status" — the same reporting gap
        # await_ready() closes for a boot that dies with its explanation in
        # the logs. A refused `docker run` announces WHY on stderr; the log
        # should hold those words, not just the number.
        print(failure.stderr, file=sys.stderr, end="")
        raise


PEER = r'''
import base64, hashlib, http.client, json, os, socket, struct, sys
ip = sys.argv[1]
def get(port, path):
    conn = http.client.HTTPConnection(ip, port, timeout=5)
    conn.request("GET", path)
    response = conn.getresponse()
    assert response.status == 200, (path, response.status, response.read())
    data = json.loads(response.read())
    conn.close()
    return data
health = get(7070, "/health")
assert health["ok"], health
# The screen the machine ADVERTISES: what a seat is created at and what a
# client synthesises its handshake from. The X display underneath is a little
# larger so a seat can BE this size (M5-BE-25), and is reported separately.
assert health["checks"]["display"]["widthPx"] == 1280, health
assert health["checks"]["display"]["heightPx"] == 800, health
display_w = health["checks"]["display"]["displayWidthPx"]
display_h = health["checks"]["display"]["displayHeightPx"]
assert display_w >= 1280 and display_h >= 800, health

# M2-IN-04: the bridge captures the real fixed framebuffer as PNG bytes.
conn = http.client.HTTPConnection(ip, 7070, timeout=10)
conn.request("GET", "/screenshot")
response = conn.getresponse()
screenshot = response.read()
assert response.status == 200, (response.status, screenshot)
assert response.getheader("Content-Type") == "image/png", response.getheaders()
assert screenshot.startswith(b"\x89PNG\r\n\x1a\n"), screenshot[:20]
# `/screenshot` is the whole X display, margin included — it is the machine's
# picture, not one seat's. A seat's own picture comes from its window-scoped
# RFB stream, and `screenshot()` the tool takes it through CDP.
assert struct.unpack("!II", screenshot[16:24]) == (display_w, display_h), screenshot[16:24]
conn.close()

# The v1 AT-SPI consumer is deferred, but the M2 bridge must expose a usable
# SSE stream now. The initial retry frame proves headers have been flushed and
# the client is subscribed without waiting for a desktop event.
conn = http.client.HTTPConnection(ip, 7070, timeout=5)
conn.request("GET", "/atspi/events")
response = conn.getresponse()
assert response.status == 200, (response.status, response.read())
assert response.getheader("Content-Type") == "text/event-stream", response.getheaders()
assert response.readline() == b"retry: 3000\n", response.readline()
assert response.readline() == b"\n"
conn.close()

# Creating the seat is part of the claim rather than setup: it is the path a bot
# takes; browser startup is a separate demand after the desktop is ready.
conn = http.client.HTTPConnection(ip, 7070, timeout=90)
conn.request("POST", "/seats", json.dumps({"botId": "smoke"}), {"Content-Type": "application/json"})
response = conn.getresponse()
created = json.loads(response.read())
assert response.status == 200, (response.status, created)
conn.close()
seat = created["seat"]
assert seat["display"].startswith(":"), seat
cdp_port = seat["cdpPort"]
rfb_port = seat["rfbPort"]


# M3-PK-01: a valid request EXECUTES inside this sandbox through the in-image
# Node skill runner — the executor is part of the image now, and the run's
# outcome is the response body (D-040). A script that throws is an outcome
# too; only a runner that cannot run at all answers 5xx.
def skill(payload):
    conn = http.client.HTTPConnection(ip, 7070, timeout=30)
    conn.request("POST", "/skill/run?botId=smoke", json.dumps(payload), {"Content-Type": "application/json"})
    response = conn.getresponse()
    status_code = response.status
    reply = json.loads(response.read())
    conn.close()
    return status_code, reply

# 1. Real execution, TypeScript annotations and all — the image's Node strips
#    them, the module runs, params reach it, and its logs come back.
status, run = skill({
    "script": "export default async (ctx: { log: (m: string) => void }, params: { a: number; b: number }): Promise<{ sum: number }> => { ctx.log('summing'); return { sum: params.a + params.b }; }",
    "params": {"a": 40, "b": 2},
})
assert status == 200, (status, run)
assert run["ok"] is True and run["result"] == {"sum": 42}, run
assert run["logs"] == ["summing"], run

# 2. The context drives the real desktop: click moves the pointer (the host
#    asserts the position below) and screenshot returns the real framebuffer.
status, run = skill({
    "script": "export default async (ctx) => { await ctx.click(640, 400); const png = await ctx.screenshot(); return { bytes: png.length, head: Array.from(png.slice(0, 4)) }; }",
    "params": {},
})
assert status == 200 and run["ok"] is True, (status, run)
assert run["result"]["head"] == [137, 80, 78, 71], run
assert run["result"]["bytes"] > 1000, run

# 3. A failing script is a reported outcome, not a broken transport.
status, run = skill({
    "script": "export default async (): Promise<never> => { throw new Error('planned failure'); }",
    "params": {},
})
assert status == 200 and run["ok"] is False, (status, run)
assert run["code"] == "SKILL_EXECUTION_FAILED" and "planned failure" in run["detail"], run

with socket.create_connection((ip, 5900), timeout=5) as rfb:
    assert rfb.recv(12).startswith(b"RFB ")

# A browser lives in a SEAT, not on the machine (D-060). This block used to
# probe 9222, where the machine ran a Chrome of its own because every bot's seat
# was a window inside it; that browser is gone, and with it the 141 tasks it
# spent serving nobody. So the same claim — "a real browser in this container
# answers a real CDP command" — is made where a browser actually is.
#

# The seat's own screen, whole-display rather than window-scoped.
with socket.create_connection((ip, rfb_port), timeout=10) as seat_rfb:
    assert seat_rfb.recv(12).startswith(b"RFB "), seat

assert seat["browserReady"] is False, seat

# D-060: a seat runs its OWN session bus, and the bridge reports where. This
# peer runs in a container of its own, so it can only read the SHAPE — the
# socket it names lives on the machine, and the host asserts that half below.
assert seat["dbusAddress"].startswith("unix:path="), seat
# The dock's Chrome icon asks by DISPLAY — its launcher knows nothing else
# about the seat it was clicked on. This is the icon's exact path, exercised
# on a seat whose browser has not started, because a start that only worked
# through the runner would leave the icon as dead as it was before.
conn = http.client.HTTPConnection(ip, 7070, timeout=90)
conn.request("POST", "/seats/browser", json.dumps({"display": seat["display"]}),
             {"Content-Type": "application/json"})
response = conn.getresponse()
started = json.loads(response.read())
conn.close()
assert response.status == 200 and started["ok"], (response.status, started)
assert started["seat"]["seatId"] == seat["seatId"], started
assert started["seat"]["browserReady"] is True, started

# A saved browser skill reaches the same browser through the runner's lazy
# page connection, which itself calls the loopback route (by botId) before
# CDP discovery.
conn = http.client.HTTPConnection(ip, 7070, timeout=60)
conn.request("POST", "/skill/run?botId=smoke", json.dumps({
    "script": "export default async (ctx) => { await ctx.page.waitForSelector('body'); return 'browser ready'; }",
    "params": {},
}), {"Content-Type": "application/json"})
response = conn.getresponse()
run = json.loads(response.read())
assert response.status == 200 and run["ok"], run
conn.close()
assert get(7070, "/seats?botId=smoke")["seat"]["browserReady"] is True
version = get(cdp_port, "/json/version")
from urllib.parse import urlsplit
endpoint = urlsplit(version["webSocketDebuggerUrl"])
# Chrome binds its debugger to loopback, so the port reachable from here is the
# relay the bridge puts in front of it — the discovery document names Chrome's
# own. What matters is that the relay carries the upgrade, which the command
# below proves.
with socket.create_connection((ip, cdp_port), timeout=10) as ws:
    key = base64.b64encode(os.urandom(16)).decode()
    ws.sendall((f"GET {endpoint.path} HTTP/1.1\r\nHost: {ip}:{cdp_port}\r\n"
                "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
    response = b""
    while not response.endswith(b"\r\n\r\n"):
        chunk = ws.recv(1)
        assert chunk, response
        response += chunk
    assert response.startswith(b"HTTP/1.1 101"), response
    accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest())
    assert accept in response, response
    payload = b'{"id":1,"method":"Browser.getVersion"}'
    mask = os.urandom(4)
    ws.sendall(bytes([0x81, 0x80 | len(payload)]) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))
    def read_exact(n):
        result = b""
        while len(result) < n:
            chunk = ws.recv(n - len(result))
            assert chunk, result
            result += chunk
        return result
    head = read_exact(2)
    assert head[0] == 0x81 and not head[1] & 0x80, head
    size = head[1] & 0x7f
    if size == 126:
        size = struct.unpack("!H", read_exact(2))[0]
    elif size == 127:
        size = struct.unpack("!Q", read_exact(8))[0]
    reply = json.loads(read_exact(size))
    assert reply["id"] == 1 and reply["result"]["product"].startswith("Chrome/"), reply

# The complaint that resized this machine (D-063): TWO bots browsing at once.
# A second seat gets its own display and its own browser from the same shared
# budget, and BOTH CDP relays must answer while both run — the state the old
# per-bot containers each carried alone, proven on the machine that now
# carries them together.
conn = http.client.HTTPConnection(ip, 7070, timeout=90)
conn.request("POST", "/seats", json.dumps({"botId": "smoke2"}), {"Content-Type": "application/json"})
response = conn.getresponse()
second = json.loads(response.read())
conn.close()
assert response.status == 200, (response.status, second)
seat2 = second["seat"]
assert seat2["display"] != seat["display"] and seat2["cdpPort"] != cdp_port, second
conn = http.client.HTTPConnection(ip, 7070, timeout=90)
conn.request("POST", "/seats/browser", json.dumps({"display": seat2["display"]}),
             {"Content-Type": "application/json"})
response = conn.getresponse()
started2 = json.loads(response.read())
conn.close()
assert response.status == 200 and started2["ok"], (response.status, started2)
assert started2["seat"]["browserReady"] is True, started2
assert get(cdp_port, "/json/version")["Browser"].startswith("Chrome/")
assert get(seat2["cdpPort"], "/json/version")["Browser"].startswith("Chrome/")
# Keep the first seat for the host's pointer assertion; retire the second.
for seat_id in (seat2["seatId"],):
    conn = http.client.HTTPConnection(ip, 7070, timeout=30)
    conn.request("POST", f"/seats/{seat_id}/close", "", {"Content-Type": "application/json"})
    response = conn.getresponse()
    assert response.status == 200, (seat_id, response.status, response.read())
    conn.close()
print("PASS: peer bridge routes, fixed display, skill execution, machine RFB, a SEAT's display, RFB, CDP discovery and WebSocket command, and a SECOND seat browsing alongside the first")
'''


# D-223: the screen gateway, driven from inside the container as a viewer that
# reached it through a provider's preview would: refused without the key, then
# given one through the bridge, then a real stream of the bot's private seat
# read under a ticket signed with it, every mark acked.
GATEWAY_VIEWER = r"""
const { generateKeyPairSync, sign, randomUUID } = require('node:crypto');
const http = require('node:http');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
const session = 'smoke-session';
let seatPort;
const ticket = (claims) => {
  const body = Buffer.from(JSON.stringify({ v: 1, aud: 'crewaid-screen', session, botId: 'smoke',
    port: seatPort, exp: Date.now() + 60000, jti: randomUUID(), ...claims })).toString('base64url');
  return body + '.' + sign(null, Buffer.from(body), privateKey).toString('base64url');
};
const open = (t) => new Promise((resolve) => {
  const ws = new WebSocket('ws://127.0.0.1:7071/v1/stream?quality=5&ticket=' + encodeURIComponent(t));
  ws.binaryType = 'arraybuffer';
  let binary = 0, marks = 0;
  const timer = setTimeout(() => { ws.close(); resolve({ opened: false, binary, marks }); }, 15000);
  ws.onerror = () => { clearTimeout(timer); resolve({ opened: false, binary, marks }); };
  ws.onmessage = (event) => {
    if (typeof event.data !== 'string') { binary += 1; return; }
    const message = JSON.parse(event.data);
    if (message.t === 'mark') { marks += 1; ws.send(JSON.stringify({ t: 'ack', seq: message.seq })); }
    if (binary >= 2 && marks >= 1) { clearTimeout(timer); ws.close(); resolve({ opened: true, binary, marks }); }
  };
});
const post = (path, body) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: 7070, path, method: 'POST',
    headers: { 'content-type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode); });
  req.on('error', reject); req.end(JSON.stringify(body));
});
(async () => {
  // Earlier desktop checks close this seat; give the gateway a live private
  // display instead of relying on another probe's lifecycle.
  const created = await post('/seats', { botId: 'smoke' });
  if (created !== 200) throw new Error('could not create the gateway seat: ' + created);
  const response = await fetch('http://127.0.0.1:7070/seats?botId=smoke');
  const current = await response.json();
  if (!response.ok || current.seat?.botId !== 'smoke') throw new Error('missing smoke seat');
  seatPort = current.seat.rfbPort;
  const before = await open(ticket({}));
  if (before.opened) throw new Error('a stream opened before any key was delivered');
  const status = await post('/screen/key', { publicKey: pub, session });
  if (status !== 200) throw new Error('the bridge refused the key: ' + status);
  const stranger = await open(ticket({ session: 'another-computer' }));
  if (stranger.opened) throw new Error('a ticket for another computer opened a stream');
  const viewer = await open(ticket({}));
  if (!viewer.opened) throw new Error('no picture on the stream: ' + JSON.stringify(viewer));
  console.log('gateway streamed', viewer.binary, 'messages and', viewer.marks, 'marks');
})().catch((error) => { console.error(error.message); process.exit(1); });
"""


def screen_gateway():
    health = docker("exec", NAME, "curl", "-fsS", "--max-time", "5", "http://127.0.0.1:7071/health")
    assert health == "ok", health
    owner = docker("exec", NAME, "sh", "-c", "ps -o user= -p $(pgrep -f '^node /opt/screen-gateway/gateway.cjs$')")
    assert owner.strip() == "bot", owner
    print(docker("exec", NAME, "node", "-e", GATEWAY_VIEWER, timeout=60))
    print("PASS: the screen gateway serves a real stream only under a ticket its delivered key verifies")
    # A viewer service failing must not take the bot's desktop with it.
    docker("exec", NAME, "pkill", "-KILL", "-f", "^node /opt/screen-gateway/gateway.cjs$")
    deadline = time.monotonic() + 10
    while True:
        try:
            if docker("exec", NAME, "curl", "-fsS", "--max-time", "2", "http://127.0.0.1:7071/health") == "ok":
                break
        except subprocess.CalledProcessError:
            pass
        assert time.monotonic() < deadline, "the screen gateway did not come back"
        time.sleep(0.5)
    assert json.loads(docker("inspect", NAME))[0]["State"]["Running"] is True
    print("PASS: a dead screen gateway restarts, and the desktop stays up")


def await_ready():
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        state = json.loads(docker("inspect", NAME))[0]["State"]
        if not state["Running"]:
            # GTK reports display initialization failures on stdout, while the
            # supervisor reports its exit on stderr. Keep both so a failed
            # restart identifies the child failure as well as the container's.
            logs = subprocess.run(
                ["docker", "logs", "--tail", "100", NAME],
                text=True, capture_output=True, timeout=30,
            )
            raise AssertionError(f"{state}\n{logs.stdout}\n{logs.stderr}")
        try:
            docker("exec", NAME, "curl", "-fsS", "--max-time", "2", "http://127.0.0.1:7070/health")
            return
        except subprocess.CalledProcessError:
            time.sleep(0.2)
    raise AssertionError("sandbox did not become ready")


# The §5.1 limits as D-063 sizes them, and what the host proving them can
# hold. The orchestrator creates the machine at 8 GiB / 4 CPUs / 2048 pids,
# and mirroring those numbers here was meant to prove the image under the
# budget it will actually run inside. But the budget is also a promise the
# HOST has to be able to keep: a standard GitHub runner for a private repo
# is 2 vCPUs and 8 GB, and asking that machine to bound a container at
# 8 GiB and 4 CPUs is refused at `docker run` with exit 125 — before the
# entrypoint ever runs, with nothing booted and nothing asserted.
#
# So the budget here is min(production, this host), at three quarters of
# the host's RAM so the daemon and everything around it keep room to
# breathe. What the proof holds to is the SHAPE of the constraint — a
# memory ceiling with swap denied, a CPU quota, a pid cap — not the
# production numbers, which are the orchestrator's to size and its tests'
# to assert (packages/sandbox-docker/src/docker-sandbox-provider.ts).
PRODUCTION_MEMORY_BYTES = 8 * 1024**3
PRODUCTION_CPUS = 4


def machine_budget():
    info = json.loads(docker("info", "--format", "{{json .}}"))
    return (min(PRODUCTION_MEMORY_BYTES, int(info["MemTotal"] * 0.75)),
            min(PRODUCTION_CPUS, int(info["NCPU"])))


BUDGET_MEMORY, BUDGET_CPUS = machine_budget()


def run_machine(*extra):
    docker("run", "-d", "--name", NAME,
           "--memory", str(BUDGET_MEMORY), "--memory-swap", str(BUDGET_MEMORY),
           "--cpus", str(BUDGET_CPUS), "--pids-limit", "2048",
           "--security-opt", "no-new-privileges", "--cap-drop", "ALL",
           "--network", NAME, "--tmpfs", "/dev/shm:size=512m",
           *extra, "--restart", "no", IMAGE)
    await_ready()


def boot_with_workspace():
    """Like start(), with the bot's durable workspace mounted at $HOME."""
    run_machine("--mount", f"type=volume,source={NAME},target=/home/bot")


def start():
    run_machine()


try:
    docker("network", "create", NAME)
    start()
    # Xvfb runs as `bot` and cannot create this root-owned socket directory.
    # Linux's abstract X socket can make a missing directory look healthy to
    # one client while xfce4-session still exits, so assert the filesystem
    # prerequisite directly instead of waiting for that race.
    x_socket_dir = docker("exec", NAME, "stat", "-c", "%a:%u:%g", "/tmp/.X11-unix")
    assert x_socket_dir == "1777:0:0", x_socket_dir
    ip = json.loads(docker("inspect", NAME))[0]["NetworkSettings"]["Networks"][NAME]["IPAddress"]
    # The peer contains a seat's FIRST Chrome start, whose readiness budget
    # alone is 40s inside the bridge (a cold first start has been measured at
    # more than half of that) — so the host bound has to cover it, not race it.
    try:
        print(docker("run", "--rm", "--network", NAME, "--entrypoint", "python3", IMAGE,
                     "-c", PEER, ip, timeout=180))
    except subprocess.CalledProcessError as failure:
        # The peer's traceback reaches the log through docker()'s failure
        # reporting now. What that path cannot show is a peer that said
        # something on stdout before dying, so that half stays here.
        print(failure.stdout or "", end="")
        raise
    # WORKSPACE §19's layout, on the MACHINE rather than in the peer. The
    # per-bot area is created with the seat — a bot whose own directory does
    # not exist writes into the team's shared area instead, where the next bot
    # to write overwrites it — and the shared half comes from boot rather than
    # from the first board_add.
    layout = docker("exec", NAME, "sh", "-c",
                    "test -d /home/bot/agents/smoke && test -d /home/bot/shared && echo yes")
    assert layout == "yes", layout
    print("PASS: the seat's bot has its own area, and the machine has the shared one")

    # M3-PK-01: the peer's skill ran INSIDE this container, so the input it
    # injected is real input — the pointer must be exactly where it clicked.
    pointer = docker("exec", NAME, "env", "DISPLAY=:10", "xdotool", "getmouselocation")
    assert "x:640 y:400" in pointer, pointer
    print("PASS: a skill ran in-container and its click moved the real pointer")
    seat = json.loads(docker("exec", NAME, "curl", "-fsS", "http://127.0.0.1:7070/seats?botId=smoke"))["seat"]
    docker("exec", NAME, "curl", "-fsS", "-X", "POST", f"http://127.0.0.1:7070/seats/{seat['seatId']}/close")
    # The dock's Chrome icon must ASK THE BRIDGE, not run a bare
    # google-chrome-stable: §5.1's cap_drop ALL kills that before a window
    # appears, which is the icon that did nothing however many times it was
    # clicked. The entry is rewired in the image and the launcher must be
    # executable, or the click is a fast path to the same crash.
    execs = docker("exec", NAME, "sh", "-c",
                   "grep '^Exec=' /usr/share/applications/google-chrome.desktop")
    assert "/opt/crewaid/open-seat-browser" in execs, execs
    assert "google-chrome-stable" not in execs, execs
    assert docker("exec", NAME, "sh", "-c",
                  "test -x /opt/crewaid/open-seat-browser && echo yes") == "yes"
    print("PASS: the dock's Chrome icon launches through the agent bridge")
    # The peer probe above proves the SSE route subscribes. Drive a real native
    # application here as well, so a registry that accepts a listener but never
    # delivers an event cannot pass the image gate.
    event_stream = subprocess.Popen(
        ["docker", "exec", NAME, "curl", "-sSN", "--max-time", "6",
         "http://127.0.0.1:7070/atspi/events"],
        text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    time.sleep(0.5)
    docker("exec", NAME, "sh", "-c",
           "DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/runtime-bot/bus "
           "xfce4-terminal --disable-server >/tmp/atspi-smoke.log 2>&1 &")
    event_output, _ = event_stream.communicate(timeout=10)
    assert "event: atspi\n" in event_output, event_output
    assert '"type":"' in event_output and '"source":{' in event_output, event_output
    print("PASS: a real native desktop event reaches the AT-SPI SSE stream")
    screen_gateway()
    # A supervised component dying must fail the container — "any exit at all is
    # a failure, including a clean one", because a desktop missing a piece is
    # worse than one that is gone.
    #
    # This killed `socat` until D-060, when the machine stopped running a browser
    # of its own and the relay in front of it went with them. The claim is
    # unchanged; the component it is made against has to be one that still
    # exists, so it is the machine's RFB server. A SEAT's relay dying is
    # deliberately NOT this: a seat is a child of the bridge, and `Seat.alive()`
    # reaps it so one bot's broken desktop cannot take everyone's machine down.
    docker("exec", NAME, "pkill", "-KILL", "-f", "^python3 /opt/agent-bridge/bridge.py$")
    assert int(docker("wait", NAME)) != 0, "bridge death must fail the entire computer"
    print("PASS: bridge death exits the entire computer, including its replay processes")
    docker("rm", NAME)
    start()
    # A killed desktop must be able to come back, because resuming it is the ONLY
    # way out of UNHEALTHY (M2-QA-04) — D-031 forbids replacing it with a fresh
    # one, since the bot's workspace and browser profile live inside it.
    # `docker start` replays this entrypoint against the filesystem the previous
    # run left behind, which is the path nothing exercised before M2-QA-04.
    #
    # This case is the SCENARIO; the deterministic guard for the defect it found
    # is the planted lock below. Whether a real restart trips it depends on which
    # pid the stale lock happens to name, and this one passed repeatedly against
    # a broken image — which is precisely why it is not the guard.
    docker("kill", NAME)
    docker("start", NAME)
    await_ready()
    print("PASS: a killed desktop restarts")
    docker("stop", "--time", "8", NAME)
    assert json.loads(docker("inspect", NAME))[0]["State"]["ExitCode"] == 0
    print("PASS: requested shutdown exits cleanly")
    docker("rm", NAME)
    # The restart defect above, held still.
    #
    # Xvfb refuses a display whose /tmp/.X1-lock names a LIVE pid. A restarted
    # container gets a fresh pid namespace, so the pid the previous run wrote
    # there is often alive again — the old Xvfb was pid 8 and so is the new one.
    # Waiting for that coincidence is not a test. Planting the lock is: pid 1 is
    # always alive, so this is exactly the state a restart can leave behind, made
    # reproducible. Against the image before the entrypoint cleared these locks
    # it dies with "(EE) Server is already active for display 1" and the exit
    # contract fires; the fix has to make it boot.
    docker("run", "-d", "--name", NAME, "--network", NAME, "--entrypoint", "bash",
           IMAGE, "-c", 'printf "%10d\n" 1 > /tmp/.X1-lock; exec /usr/local/bin/entrypoint.sh')
    await_ready()
    print("PASS: a stale X lock naming a live pid does not wedge the boot")
    docker("rm", "-f", NAME)
    # Replace only xdotool with a hung executable and run the real entrypoint.
    # Removing its timeout makes this regression hang instead of failing boot.
    started = time.monotonic()
    result = subprocess.run(
        ["docker", "run", "--name", NAME, "--entrypoint", "bash", IMAGE, "-c",
         "mkdir -p /tmp/probe-bin; printf '#!/bin/sh\\nexec sleep 60\\n' > /tmp/probe-bin/xdotool; "
         "chmod +x /tmp/probe-bin/xdotool; export PATH=/tmp/probe-bin:$PATH; "
         "exec /usr/local/bin/entrypoint.sh"],
        text=True, capture_output=True, timeout=25,
    )
    assert result.returncode == 1 and "X display :1 did not become ready" in result.stderr, result
    assert time.monotonic() - started < 22
    print("PASS: wedged X readiness probe is bounded")
    docker("rm", NAME)

    # ── D-039: the durable workspace, and what the image may and may not own ──
    #
    # Docker seeds a named volume from the image only while the volume is
    # empty, so config written straight into /home/bot would freeze at whatever
    # a bot's first boot produced. The skel exists to break that, and these two
    # assertions are the ones that would notice if it stopped working: the
    # operator's file must survive a reboot, and the dock launcher they deleted
    # must come back, because it is the IMAGE's and not theirs.
    docker("volume", "create", NAME)
    launchers = "/home/bot/.config/plank/dock1/launchers"
    boot_with_workspace()
    docker("exec", NAME, "sh", "-c",
           f"echo mine > /home/bot/notes.txt; rm -f {launchers}/01-thunar.dockitem")
    remaining = docker("exec", NAME, "sh", "-c", f"ls {launchers} | wc -l")
    assert remaining.strip() == "2", remaining
    # Replace the CONTAINER, keep the volume — the path that makes losing a
    # container survivable instead of catastrophic.
    docker("rm", "-f", NAME)
    boot_with_workspace()
    assert docker("exec", NAME, "cat", "/home/bot/notes.txt") == "mine"
    restored = docker("exec", NAME, "sh", "-c", f"ls {launchers} | tr '\n' ' '")
    assert "01-thunar.dockitem" in restored, restored
    assert docker("exec", NAME, "sh", "-c", "test -d /home/bot/.chrome && echo yes") == "yes"
    print("PASS: workspace survives container replacement; image-owned config is restored")
finally:
    subprocess.run(["docker", "rm", "-f", NAME], capture_output=True, timeout=30)
    subprocess.run(["docker", "network", "rm", NAME], capture_output=True, timeout=30)
    subprocess.run(["docker", "volume", "rm", NAME], capture_output=True, timeout=30)
