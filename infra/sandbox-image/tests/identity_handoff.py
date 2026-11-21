#!/usr/bin/env python3
"""Prove profile handoff with real Chrome, storage and Linux process teardown.

Usage: python3 infra/sandbox-image/tests/identity_handoff.py [built-image]
Only this fixture's container is removed. No model credentials are required.
"""
from concurrent.futures import ThreadPoolExecutor
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

IMAGE = sys.argv[1] if len(sys.argv) > 1 else "crewaid/sandbox:dev"
NAME = f"crewaid-login-test-{uuid.uuid4().hex[:10]}"


def docker(*args, timeout=90, **kwargs):
    result = subprocess.run(["docker", *args], text=True, capture_output=True,
                            timeout=timeout, **kwargs)
    if result.returncode:
        raise RuntimeError(f"docker {args[0]} failed: {result.stderr}")
    return result.stdout.strip()


def eventually(check, timeout=45):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            value = check()
            if value:
                return value
        except (OSError, urllib.error.URLError, RuntimeError) as error:
            last = error
        time.sleep(0.1)
    raise AssertionError(f"readiness did not arrive: {last}")


def request(path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data,
                                 headers={"Content-Type": "application/json"})
    try:
        response = urllib.request.urlopen(req, timeout=75)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, json.load(response)


def ok(path, body=None):
    status, value = request(path, body)
    assert status == 200, (path, status, value)
    return value


def create(bot, profile=None, revision=0):
    body = {"botId": bot, "identityRevision": revision, "width": 1280, "height": 800}
    if profile is not None:
        body["profile"] = profile
    return request("/seats", body)


def browser(bot, revision):
    return ok("/seats/browser", {"botId": bot, "identityRevision": revision})["seat"]


def close(seat, revision):
    return ok(f'/seats/{seat["seatId"]}/close', {"identityRevision": revision})


def node(seat, source):
    prelude = f'''
import {{ chromium }} from '/opt/skill-runtime/node_modules/playwright-core/index.mjs';
const browser = await chromium.connectOverCDP('http://127.0.0.1:{seat['cdpPort']}');
const context = browser.contexts()[0];
const page = context.pages()[0];
'''
    return docker("exec", "-i", NAME, "node", "--input-type=module",
                  input=prelude + source + "\nawait browser.close();\nprocess.exit(0);\n")


FIXTURE = r'''
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        value = parse_qs(urlsplit(self.path).query).get('login', [None])[0]
        self.send_response(200)
        if value:
            self.send_header('Set-Cookie', f'login={value}; Max-Age=86400; Path=/; HttpOnly; SameSite=Lax')
        self.end_headers()
        self.wfile.write(b'<h1>Login fixture</h1>')
    def log_message(self, *_): pass
ThreadingHTTPServer(('127.0.0.1', 18085), Handler).serve_forever()
'''


def start_fixture():
    docker("exec", "-d", NAME, "python3", "-u", "-c", FIXTURE)
    eventually(lambda: docker("exec", NAME, "curl", "-fsS", "http://127.0.0.1:18085"))


def save_login(seat, value):
    node(seat, f'''
await page.goto('http://127.0.0.1:18085/?login={value}');
await page.evaluate(value => localStorage.setItem('login', value), {json.dumps(value)});
''')


def stored_login(seat):
    return json.loads(node(seat, '''
await page.goto('http://127.0.0.1:18085/');
console.log(JSON.stringify({
  cookie: (await context.cookies()).find(item => item.name === 'login')?.value ?? null,
  local: await page.evaluate(() => localStorage.getItem('login')),
}));
'''))


def assert_profile_exited(profile):
    script = r'''
from pathlib import Path
import sys
needle = ('--user-data-dir=/home/bot/.seats/' + sys.argv[1]).encode()
for path in Path('/proc').glob('[0-9]*/cmdline'):
    try:
        assert needle not in path.read_bytes().split(b'\0'), str(path)
    except FileNotFoundError:
        pass
print('profile processes exited')
'''
    docker("exec", NAME, "python3", "-c", script, profile)


try:
    print("image:", docker("image", "inspect", "--format", "{{.Id}}", IMAGE), flush=True)
    docker("run", "-d", "--name", NAME, "--memory", "3g", "--memory-swap", "3g",
           "--cpus", "2", "--pids-limit", "2048", "--cap-drop", "ALL",
           "--security-opt", "no-new-privileges", "-p", "127.0.0.1::7070", IMAGE)
    PORT = docker("port", NAME, "7070/tcp").rsplit(":", 1)[1]
    BASE = f"http://127.0.0.1:{PORT}"
    eventually(lambda: request("/health")[0] == 200)
    start_fixture()

    for bot in ("private-a", "private-b"):
        status, value = create(bot)
        assert status == 200, value
        seat = browser(bot, 0)
        save_login(seat, bot)
    a, b = browser("private-a", 0), browser("private-b", 0)
    assert a["display"] != b["display"] and a["cdpPort"] != b["cdpPort"]
    assert stored_login(a) == {"cookie": "private-a", "local": "private-a"}
    assert stored_login(b) == {"cookie": "private-b", "local": "private-b"}
    close(a, 1)
    close(b, 1)
    print("PASS concurrent private browsers preserve separate logins", flush=True)

    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(lambda bot: (bot, create(bot, "company", 1)), ("holder-a", "holder-b")))
    winners = [(bot, value["seat"]) for bot, (status, value) in results if status == 200]
    losers = [(bot, value) for bot, (status, value) in results if status != 200]
    assert len(winners) == len(losers) == 1, results
    winner, seat = winners[0]
    loser, refusal = losers[0]
    assert "IDENTITY_IN_USE" in refusal["detail"] and winner in refusal["detail"], refusal
    seat = browser(winner, 1)
    save_login(seat, "shared")
    assert stored_login(seat) == {"cookie": "shared", "local": "shared"}
    # Stale close cannot remove the newer holder.
    assert request(f'/seats/{seat["seatId"]}/close', {"identityRevision": 0})[0] == 503
    assert ok(f'/seats?botId={winner}')["seat"]["seatId"] == seat["seatId"]
    close(seat, 2)
    assert_profile_exited("company")
    assert create(winner, "company", 1)[0] == 503
    status, value = create(loser, "company", 1)
    assert status == 200, value
    seat = browser(loser, 1)
    assert stored_login(seat) == {"cookie": "shared", "local": "shared"}
    print("PASS simultaneous named acquire, stale refusal and flushed transfer", flush=True)

    generation = seat["browserGeneration"]
    # Browser.close is an actual Chrome process exit, not a Playwright disconnect.
    node(seat, "const session = await browser.newBrowserCDPSession(); await session.send('Browser.close').catch(() => undefined);")
    eventually(lambda: ok(f'/seats?botId={loser}')["seat"]["browserReady"] is False)
    seat = browser(loser, 1)
    assert seat["browserGeneration"] > generation
    assert stored_login(seat) == {"cookie": "shared", "local": "shared"}
    print("PASS browser replacement preserves stored login and changes generation", flush=True)

    # An active replay must finish before profile teardown; later replay is refused.
    script = "import { writeFileSync } from 'node:fs'; export default async () => { writeFileSync('/tmp/login-replay-started', 'yes'); await new Promise(r => setTimeout(r, 1500)); return { finished: true }; };"
    with ThreadPoolExecutor(2) as pool:
        replay = pool.submit(request, f"/skill/run?botId={loser}", {"script": script, "params": {}})
        eventually(lambda: docker("exec", NAME, "test", "-f", "/tmp/login-replay-started") == "")
        closing = pool.submit(close, seat, 2)
        refused = eventually(lambda: (value if (value := request(
            f"/skill/run?botId={loser}", {"script": "export default async () => 42", "params": {}}
        ))[0] == 409 else None), timeout=5)
        assert refused[1]["code"] == "SEAT_UNAVAILABLE", refused
        assert replay.result()[1]["result"] == {"finished": True}
        closing.result()
    assert_profile_exited("company")
    print("PASS replay drains before teardown; later replay cannot enter", flush=True)

    # Restart the same computer while Chrome owns the shared profile.
    status, value = create(loser, "company", 2)
    assert status == 200, value
    seat = browser(loser, 2)
    generation = seat["browserGeneration"]
    docker("exec", NAME, "sh", "-c", "printf fixture > /home/bot/login-workspace-marker")
    docker("stop", "--time", "20", NAME)
    docker("start", NAME)
    PORT = docker("port", NAME, "7070/tcp").rsplit(":", 1)[1]
    BASE = f"http://127.0.0.1:{PORT}"
    eventually(lambda: request("/health")[0] == 200)
    start_fixture()
    assert ok("/seats")["seats"] == []
    status, value = create(winner, "company", 3)
    assert status == 200, value
    restarted = browser(winner, 3)
    assert restarted["browserGeneration"] > generation
    assert stored_login(restarted) == {"cookie": "shared", "local": "shared"}
    assert docker("exec", NAME, "cat", "/home/bot/login-workspace-marker") == "fixture"
    close(restarted, 4)
    print("PASS computer stop/start preserves login/workspace without stale holder", flush=True)

    # Crash after closure has begun draining a runner, before it can finish.
    assert create(winner, "company", 4)[0] == 200
    seat = browser(winner, 4)
    generation = seat["browserGeneration"]
    docker("exec", NAME, "rm", "-f", "/tmp/login-replay-started")
    with ThreadPoolExecutor(2) as pool:
        replay = pool.submit(request, f"/skill/run?botId={winner}",
                             {"script": script.replace('1500', '10000'), "params": {}})
        eventually(lambda: docker("exec", NAME, "test", "-f", "/tmp/login-replay-started") == "")
        closing = pool.submit(close, seat, 5)
        eventually(lambda: request(f"/skill/run?botId={winner}", {
            "script": "export default async () => 42", "params": {}
        })[0] == 409, timeout=5)
        docker("kill", NAME)
        for pending in (replay, closing):
            try:
                pending.result()
            except (OSError, urllib.error.URLError):
                pass
            else:
                raise AssertionError("a killed in-flight request claimed success")
    docker("start", NAME)
    PORT = docker("port", NAME, "7070/tcp").rsplit(":", 1)[1]
    BASE = f"http://127.0.0.1:{PORT}"
    eventually(lambda: request("/health")[0] == 200)
    start_fixture()
    assert ok("/seats")["seats"] == []
    assert create(loser, "company", 5)[0] == 200
    recovered = browser(loser, 5)
    assert recovered["browserGeneration"] > generation
    assert stored_login(recovered) == {"cookie": "shared", "local": "shared"}
    close(recovered, 6)
    print("PASS crash during handoff recovers one holder without claiming old success", flush=True)

    # A real live lock owner outside the registry is never killed or cleared.
    docker("exec", "-d", NAME, "python3", "-c",
           "import os,time; open('/tmp/login-lock-owner','w').write(str(os.getpid())); time.sleep(600)")
    pid = int(eventually(lambda: docker("exec", NAME, "cat", "/tmp/login-lock-owner")))
    docker("exec", NAME, "python3", "-c", '''
import socket,sys
from pathlib import Path
profile = Path('/home/bot/.seats/unowned')
profile.mkdir()
(profile / 'SingletonLock').symlink_to(socket.gethostname() + '-' + sys.argv[1])
(profile / 'SingletonCookie').write_text('preserve')
''', str(pid))
    status, value = create("lock-check", "unowned", 1)
    assert status == 200, value
    refused = request("/seats/browser", {"botId": "lock-check", "identityRevision": 1})
    assert refused[0] == 503 and "IDENTITY_IN_USE" in refused[1]["detail"], refused
    assert docker("exec", NAME, "cat", "/home/bot/.seats/unowned/SingletonCookie") == "preserve"
    docker("exec", NAME, "kill", "-0", str(pid))
    # Only the fixture terminates its own process; a later launch can clear the dead lock.
    docker("exec", NAME, "kill", str(pid))
    eventually(lambda: request("/seats/browser", {"botId": "lock-check", "identityRevision": 1})[0] == 200)
    close(value["seat"], 2)
    print("PASS live unowned singleton is preserved; only dead-lock cleanup permits reuse", flush=True)
    print("PASS real Linux identity handoff", flush=True)
except BaseException:
    print(docker("logs", "--tail", "100", NAME), file=sys.stderr)
    print(docker("inspect", "--format", "{{json .State}} {{json .NetworkSettings.Ports}}", NAME), file=sys.stderr)
    raise
finally:
    subprocess.run(["docker", "rm", "-f", NAME], capture_output=True, check=False)
