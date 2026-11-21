#!/usr/bin/env python3
"""D-208: Git smart HTTP over exec stdin/stdout. No provider credentials here."""
import http.server
import json
import os
import pathlib
import queue
import signal
import struct
import subprocess
import sys
import threading

CHUNK = 65536
LIMIT = 1024 ** 3
out_lock = threading.Lock()
responses = queue.Queue(maxsize=8)
stopping = threading.Event()
cancelled = threading.Event()
child = None


def frame(kind, payload):
    if not isinstance(payload, bytes):
        payload = json.dumps(payload, ensure_ascii=False).encode()
        if kind == 33 and len(payload) > CHUNK:
            raise ValueError('oversized Git result')
    with out_lock:
        sys.stdout.buffer.write(struct.pack('!BI', kind, len(payload)) + payload)
        sys.stdout.buffer.flush()


def exact(stream, size):
    parts = bytearray()
    while len(parts) < size:
        data = stream.read(size - len(parts))
        if not data:
            raise EOFError('relay closed')
        parts.extend(data)
    return bytes(parts)


def stop(*_):
    cancelled.set()
    stopping.set()
    if child is not None and child.poll() is None:
        try:
            os.killpg(child.pid, signal.SIGTERM)
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def input_loop():
    try:
        while not stopping.is_set():
            kind, length = struct.unpack('!BI', exact(sys.stdin.buffer, 5))
            if length > CHUNK:
                raise ValueError('oversized relay frame')
            item = (kind, exact(sys.stdin.buffer, length))
            while not stopping.is_set():
                try:
                    responses.put(item, timeout=.2)
                    break
                except queue.Full:
                    continue
    except (EOFError, ValueError):
        stop()


def response():
    while not stopping.is_set():
        try:
            return responses.get(timeout=.2)
        except queue.Empty:
            continue
    raise EOFError('relay closed')


class Relay(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_):
        pass

    def do_GET(self):
        self.relay()

    def do_POST(self):
        self.relay()

    def relay(self):
        try:
            headers = {key: self.headers[key] for key in ('Content-Type', 'Accept', 'Git-Protocol') if key in self.headers}
            frame(1, {'method': self.command, 'path': self.path, 'headers': headers})
            total = 0
            if self.headers.get('Transfer-Encoding', '').lower() == 'chunked':
                while True:
                    size = int(self.rfile.readline(128).split(b';')[0], 16)
                    if not size:
                        while self.rfile.readline(8192).strip():
                            pass
                        break
                    total += size
                    if total > LIMIT:
                        raise ValueError('transfer limit')
                    while size:
                        data = exact(self.rfile, min(size, CHUNK))
                        frame(2, data)
                        size -= len(data)
                    if exact(self.rfile, 2) != b'\r\n':
                        raise ValueError('invalid chunk')
            else:
                remaining = int(self.headers.get('Content-Length', '0'))
                if remaining < 0 or remaining > LIMIT:
                    raise ValueError('transfer limit')
                while remaining:
                    data = exact(self.rfile, min(remaining, CHUNK))
                    frame(2, data)
                    remaining -= len(data)
            frame(3, b'')
            kind, payload = response()
            if kind != 17:
                raise ValueError('invalid response head')
            head = json.loads(payload)
            self.send_response(head['status'])
            self.send_header('Content-Type', head['contentType'])
            self.send_header('Transfer-Encoding', 'chunked')
            self.send_header('Connection', 'close')
            self.end_headers()
            total = 0
            while True:
                kind, payload = response()
                if kind == 19:
                    self.wfile.write(b'0\r\n\r\n')
                    self.wfile.flush()
                    break
                if kind != 18:
                    raise ValueError('invalid response frame')
                total += len(payload)
                if total > LIMIT:
                    raise ValueError('transfer limit')
                self.wfile.write(('%x\r\n' % len(payload)).encode() + payload + b'\r\n')
                self.wfile.flush()
            self.close_connection = True
        except (OSError, EOFError, ValueError):
            self.close_connection = True
            stop()


def git(args, cwd, env):
    global child
    if cancelled.is_set():
        raise EOFError('Git operation cancelled')
    child = subprocess.Popen(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', *args], cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
    output, _ = child.communicate()
    if child.returncode:
        raise subprocess.CalledProcessError(child.returncode, 'git')
    return output.decode().strip()


def owned_path(root, name):
    lexical_root = pathlib.Path(root).absolute()
    root = lexical_root.resolve(strict=True)
    if root != lexical_root:
        raise ValueError('bot workspace root contains a symlink')
    path = pathlib.Path(name)
    if not path.is_absolute():
        path = root / path
    # Resolve existing parents as well as the target: symlink escapes fail closed.
    resolved = path.resolve()
    if resolved == root or root not in resolved.parents:
        raise ValueError('path is outside the bot workspace')
    if path.is_symlink():
        raise ValueError('checkout cannot be a symlink')
    return resolved


def inspect(spec, cwd, env):
    dotgit = cwd / '.git'
    if not dotgit.is_dir() or dotgit.is_symlink() or pathlib.Path(git(['rev-parse', '--show-toplevel'], cwd, env)).resolve() != cwd:
        raise ValueError('ordinary owned checkout required')
    if git(['rev-parse', '--is-bare-repository'], cwd, env) != 'false':
        raise ValueError('a working checkout is required')
    for folder, directories, files in os.walk(dotgit, followlinks=False):
        for name in directories + files:
            item = pathlib.Path(folder) / name
            if item.is_symlink() and cwd not in item.resolve().parents:
                raise ValueError('Git metadata symlink escapes the checkout')
    grafts = dotgit / 'info/grafts'
    if grafts.exists() and grafts.stat().st_size:
        raise ValueError('rewritten local ancestry is unsupported')
    alternates = dotgit / 'objects/info/alternates'
    if alternates.exists() and alternates.stat().st_size:
        raise ValueError('external Git object stores are unsupported')
    head = git(['rev-parse', 'HEAD'], cwd, env)
    tree = git(['rev-parse', 'HEAD^{tree}'], cwd, env)
    ancestor = spec.get('previousHead')
    base = ancestor or 'refs/remotes/origin/' + spec['defaultBranch']
    valid = True
    if ancestor:
        try:
            git(['merge-base', '--is-ancestor', ancestor, head], cwd, env)
        except subprocess.CalledProcessError:
            valid = False
    try:
        files = []
        size = 0
        for name in git(['diff', '--no-ext-diff', '--no-textconv', '--name-only', base, head, '--'], cwd, env).splitlines():
            size += len(name.encode())
            if len(files) == 200 or size > 16000:
                break
            files.append(name)
        summary = git(['diff', '--no-ext-diff', '--no-textconv', '--stat', base, head, '--'], cwd, env).encode()[:16000].decode(errors='ignore')
    except subprocess.CalledProcessError:
        files, summary = [], 'Base commit is unavailable locally; fetch before publishing.'
    return {'head': head, 'tree': tree, 'branch': git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, env), 'files': files, 'summary': summary, 'ancestor': valid}


def main():
    global child
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    watchdog = threading.Timer(600, stop)
    watchdog.daemon = True
    watchdog.start()
    spec = json.loads(sys.argv[1])
    mode = spec['mode']
    if mode not in ('clone', 'fetch', 'push', 'inspect'):
        raise ValueError('unsupported Git operation')
    env = {**{key: value for key, value in os.environ.items() if not key.startswith('GIT_')}, 'GIT_TERMINAL_PROMPT': '0', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_LFS_SKIP_SMUDGE': '1', 'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_TRACE': '0', 'GIT_TRACE_CURL': '0'}
    # A shell/user environment must not inject credentials or configuration into this tool.
    for key in list(env):
        if key.startswith('GIT_CONFIG_KEY_') or key.startswith('GIT_CONFIG_VALUE_') or key in ('GIT_CONFIG_COUNT', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_TRACE_PACKET', 'GIT_TRACE_CURL_NO_DATA'):
            env.pop(key, None)
    pathlib.Path(spec['root']).mkdir(parents=True, exist_ok=True)
    cwd = owned_path(spec['root'], spec['path'])
    if mode == 'inspect':
        frame(33, {'exitCode': 0, **inspect(spec, cwd, env)})
        return
    if mode == 'clone':
        cwd.parent.mkdir(parents=True, exist_ok=True)
        cwd = owned_path(spec['root'], str(cwd))
        cwd.mkdir()  # Exclusive reservation: never replace an existing directory.
    elif not cwd.is_dir():
        raise ValueError('checkout does not exist')
    if mode == 'fetch':
        inspect(spec, cwd, env)
    repository = spec['repository']
    if not isinstance(repository, str) or '/' not in repository or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-/' for c in repository):
        raise ValueError('invalid repository')
    server = http.server.HTTPServer(('127.0.0.1', 0), Relay)
    threading.Thread(target=input_loop, daemon=True).start()
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = 'https://github.com/' + repository + '.git'
    config = ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'credential.helper=', '-c', 'http.extraHeader=', '-c', 'http.followRedirects=false', '-c', 'protocol.version=2', '-c', 'url.http://127.0.0.1:%d/.insteadOf=https://github.com/' % server.server_port]
    if mode == 'clone':
        args = ['clone', '--no-recurse-submodules']
        if spec.get('branch'):
            args += ['--branch', spec['branch']]
        args += ['--', url, str(cwd)]
    elif mode == 'fetch':
        args = ['fetch', '--no-recurse-submodules', '--no-tags', url, '+refs/heads/*:refs/remotes/origin/*']
    else:
        head = inspect(spec, cwd, env)
        if head['head'] != spec['head'] or head['tree'] != spec['tree'] or not head['ancestor']:
            raise ValueError('approved commit changed or update is not fast-forward')
        branch = spec['branch']
        git(['check-ref-format', 'refs/heads/' + branch], cwd, env)
        args = ['push', '--porcelain', '--force-with-lease=refs/heads/%s:%s' % (branch, spec.get('previousHead') or ''), url, '%s:refs/heads/%s' % (spec['head'], branch)]
    child = subprocess.Popen(config + args, cwd=cwd.parent if mode == 'clone' else cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)

    def drain(stream):
        retained = 0
        while True:
            data = stream.read(CHUNK)
            if not data:
                break
            if retained < 16000:
                frame(32, data[:16000-retained])
                retained += len(data)
    threads = [threading.Thread(target=drain, args=(stream,), daemon=True) for stream in (child.stdout, child.stderr)]
    for thread in threads:
        thread.start()
    code = child.wait()
    for thread in threads:
        thread.join(timeout=2)
    stopping.set()
    watchdog.cancel()
    server.shutdown()
    server.server_close()
    if code == 0 and mode == 'clone':
        identity = spec.get('identity') or {}
        for field in ('name', 'email'):
            try:
                git(['config', '--get', 'user.' + field], cwd, env)
            except subprocess.CalledProcessError:
                identity_env = dict(env)
                identity_env.pop('GIT_CONFIG_GLOBAL', None)
                try:
                    value = git(['config', '--global', '--get', 'user.' + field], cwd, identity_env)
                except subprocess.CalledProcessError:
                    value = identity.get(field)
                if value:
                    git(['config', '--local', 'user.' + field, value], cwd, env)
    result = {'exitCode': code}
    if code == 0:
        result.update(inspect(spec, cwd, env))
    frame(33, result)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        stop()
        # Never serialize an exception which could contain input data or environment values.
        frame(33, {'exitCode': 1, 'message': 'Git helper refused or failed the operation.'})
        sys.exit(1)
