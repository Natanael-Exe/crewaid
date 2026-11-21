import { once } from 'node:events';
import { connect, type Socket } from 'node:net';

import type { RuntimeForward } from './runtime-client.js';

/** Runs on either guest. The archive never lands on the orchestrator's disk. */
export const WORKSPACE_TRANSFER_SERVER = String.raw`
import hashlib, hmac, json, os, socket, struct, subprocess, sys, tempfile

mode, token, ready, root = sys.argv[1:]
os.umask(0o077)
server = socket.socket()
server.bind(('127.0.0.1', 0))
server.listen(1)
server.settimeout(600)
with open(ready, 'w') as f:
    f.write(str(server.getsockname()[1]))
os.chmod(ready, 0o644)

def exact(stream, size):
    result = bytearray()
    while len(result) < size:
        block = stream.read(size - len(result))
        if not block:
            raise RuntimeError('archive stream ended early')
        result.extend(block)
    return result

try:
    conn, _ = server.accept()
    conn.settimeout(600)
    with conn, conn.makefile('rwb', buffering=256 * 1024) as stream:
        if not hmac.compare_digest(stream.readline(256).decode().rstrip('\n'), token):
            raise RuntimeError('invalid transfer capability')
        digest, size = hashlib.sha256(), 0
        with tempfile.TemporaryFile() as errors:
            if mode == 'send':
                # Never dereference symlinks or archive the bound home twice.
                proc = subprocess.Popen([
                    'tar', '--numeric-owner', '--acls', '--xattrs', '-cp',
                    '--exclude=workspace/.crewaid-home',
                    '--exclude=workspace/.crewaid-home.next',
                    '--exclude=workspace/.crewaid-transfer-*',
                    '-C', root, 'home/bot', 'workspace'
                ], stdout=subprocess.PIPE, stderr=errors)
                try:
                    while True:
                        chunk = proc.stdout.read(256 * 1024)
                        if not chunk:
                            break
                        digest.update(chunk)
                        size += len(chunk)
                        stream.write(struct.pack('!I', len(chunk)))
                        stream.write(chunk)
                    code = proc.wait()
                    stream.write(struct.pack('!I', 0))
                    stream.write((json.dumps({'ok': code == 0, 'sha256': digest.hexdigest(), 'size': size}) + '\n').encode())
                finally:
                    if proc.poll() is None:
                        proc.kill()
                    proc.wait()
            elif mode == 'receive':
                os.makedirs(root, mode=0o700, exist_ok=False)
                proc = subprocess.Popen(['tar', '--numeric-owner', '--acls', '--xattrs', '-xp', '-C', root], stdin=subprocess.PIPE, stderr=errors)
                try:
                    while True:
                        count = struct.unpack('!I', exact(stream, 4))[0]
                        if count == 0:
                            break
                        if count > 256 * 1024:
                            raise RuntimeError('archive frame exceeds its bound')
                        chunk = exact(stream, count)
                        digest.update(chunk)
                        size += len(chunk)
                        proc.stdin.write(chunk)
                    proc.stdin.close()
                    code = proc.wait()
                    sent = json.loads(stream.readline(4096))
                    ok = code == 0 and sent.get('ok') is True and sent.get('size') == size and sent.get('sha256') == digest.hexdigest()
                    stream.write((json.dumps({'ok': ok, 'sha256': digest.hexdigest(), 'size': size}) + '\n').encode())
                finally:
                    if proc.poll() is None:
                        proc.kill()
                    proc.wait()
            else:
                raise RuntimeError('unknown transfer mode')
finally:
    server.close()
`;

/** A slow destination backpressures the source instead of buffering a home in RAM. */
export async function transferWorkspaceArchive(
  source: RuntimeForward,
  destination: RuntimeForward,
  token: string,
  signal: AbortSignal,
): Promise<void> {
  const sockets: Socket[] = [];
  const open = async (endpoint: RuntimeForward) => {
    const socket = connect({ ...endpoint, allowHalfOpen: true, signal });
    sockets.push(socket);
    // Both directions keep an error listener while the other direction is pending.
    socket.on('error', () => undefined);
    await once(socket, 'connect', { signal });
    socket.write(`${token}\n`);
    return socket;
  };
  try {
    const [input, output] = await Promise.all([open(source), open(destination)]);
    const receive = async () => {
      let reply = '';
      for await (const chunk of output) {
        reply += String(chunk);
        if (reply.length > 4096) throw new Error('Workspace transfer reply exceeded its bound');
      }
      const result: unknown = JSON.parse(reply);
      if (
        typeof result !== 'object' ||
        result === null ||
        !('ok' in result) ||
        result.ok !== true
      ) {
        throw new Error('Workspace archive failed its integrity or extraction check');
      }
    };
    const send = async () => {
      for await (const chunk of input) {
        const bytes: unknown = chunk;
        if (!(bytes instanceof Uint8Array))
          throw new Error('Workspace stream contained non-binary data');
        if (!output.write(bytes)) await once(output, 'drain', { signal });
      }
      output.end();
    };
    await Promise.all([send(), receive()]);
  } finally {
    for (const socket of sockets) socket.destroy();
  }
}

/** No desktop process may keep a Chrome database open while it is copied. */
export const QUIESCE_DESKTOP = String.raw`
import os, signal, time
me = os.getpid()
for name in os.listdir('/proc'):
    if not name.isdigit() or int(name) == me:
        continue
    try:
        argv = open('/proc/' + name + '/cmdline', 'rb').read().split(b'\0')
        if b'/usr/local/bin/entrypoint.sh' in argv or b'/usr/local/bin/crewaid-runtime-start' in argv:
            os.kill(int(name), signal.SIGTERM)
    except (OSError, ProcessLookupError):
        pass
import subprocess
subprocess.run(['pkill', '-TERM', '-u', 'bot', '-x', 'chrome'], check=False)
for _ in range(100):
    if subprocess.run(['pgrep', '-u', 'bot', '-x', 'chrome'], stdout=subprocess.DEVNULL).returncode != 0:
        break
    time.sleep(.2)
else:
    raise RuntimeError('Chrome did not close; refusing to copy an open profile')
`;

/** Only a freshly created, unexposed destination may run this after verified extraction. */
export const INSTALL_WORKSPACE = String.raw`
import os, shutil, stat, subprocess, sys
stage = sys.argv[1]
home, workspace = stage + '/home/bot', stage + '/workspace'
for path in [home, workspace]:
    if not stat.S_ISDIR(os.lstat(path).st_mode):
        raise RuntimeError('archive lacks a real home or workspace directory')
if subprocess.run(['mountpoint', '-q', '/home/bot']).returncode == 0:
    # Runtime's own helpers can retain a cwd on this fresh, image-seeded bind.
    # Detach that mount; the launcher binds the restored home before serving it.
    subprocess.run(['umount', '-l', '/home/bot'], check=True)
# The destination is new; its image-seeded home contains no user data.
for entry in os.scandir('/workspace'):
    if entry.path == stage:
        continue
    if entry.is_dir(follow_symlinks=False):
        shutil.rmtree(entry.path)
    else:
        os.unlink(entry.path)
for entry in os.scandir(workspace):
    os.rename(entry.path, '/workspace/' + entry.name)
metadata = os.stat(workspace)
shutil.copystat(workspace, '/workspace', follow_symlinks=False)
os.chown('/workspace', metadata.st_uid, metadata.st_gid)
os.rename(home, '/workspace/.crewaid-home')
shutil.rmtree(stage)
os.sync()
`;
