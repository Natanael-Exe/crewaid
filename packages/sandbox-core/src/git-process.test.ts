import { afterEach, describe, expect, it } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { relayGitProcess, type GitProcessSpec, type GitHttpForward } from './git-process.js';
import type { ContainerProcess } from './container.js';

const helper = fileURLToPath(
  new URL('../../../infra/sandbox-image/agent-bridge/git_helper.py', import.meta.url),
);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function processFor(spec: GitProcessSpec): ContainerProcess {
  const child = spawn('python3', [helper, JSON.stringify(spec)]);
  const done = new Promise<{ exitCode: number }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ exitCode: code ?? 1 }));
  });
  return {
    stdout: Readable.toWeb(child.stdout),
    stderr: Readable.toWeb(child.stderr),
    stdin: Writable.toWeb(child.stdin),
    wait: () => done,
    kill: async () => {
      child.kill('SIGTERM');
      await done;
    },
  };
}
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'crewaid-git-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await mkdir(source);
  git(source, 'init', '--initial-branch=main');
  await writeFile(path.join(source, 'hello.txt'), 'original\n');
  const binary = Buffer.alloc(256000, 193);
  await writeFile(path.join(source, 'image.bin'), binary);
  git(source, 'add', '.');
  git(
    source,
    '-c',
    'user.name=Human',
    '-c',
    'user.email=human@example.test',
    'commit',
    '-m',
    'Initial',
  );
  await mkdir(path.join(root, 'owner'));
  git(root, 'clone', '--bare', source, path.join(root, 'owner/repo.git'));
  git(path.join(root, 'owner/repo.git'), 'config', 'http.receivepack', 'true');
  let authenticated = 0;
  const serve = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.headers.authorization !== 'Basic server-only-test-secret') {
      response.writeHead(401);
      response.end();
      return;
    }
    authenticated++;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks),
      url = new URL(request.url ?? '/', 'http://localhost');
    const backend = spawn('git', ['http-backend'], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        REQUEST_METHOD: request.method,
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: request.headers['content-type'] ?? '',
        CONTENT_LENGTH: String(body.length),
        HTTP_GIT_PROTOCOL: String(request.headers['git-protocol'] ?? ''),
        REMOTE_USER: 'test',
      },
    });
    const output: Buffer[] = [];
    backend.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    backend.stderr.resume();
    // http-backend may exit before reading the whole request body (it answers
    // from the headers alone, or rejects the request), and writing the rest then
    // fails with EPIPE. The reply is judged from its output on 'close' below, so
    // that write error is not the test's to report; unhandled, it would surface
    // as an uncaught error and fail the whole run at random.
    backend.stdin.on('error', () => undefined);
    backend.stdin.end(body);
    backend.once('close', () => {
      const bytes = Buffer.concat(output),
        split = bytes.indexOf('\r\n\r\n');
      if (split < 0) {
        response.writeHead(500);
        response.end();
        return;
      }
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of bytes.subarray(0, split).toString().split('\r\n')) {
        const i = line.indexOf(':');
        if (i < 0) continue;
        const name = line.slice(0, i),
          value = line.slice(i + 1).trim();
        if (name.toLowerCase() === 'status') status = Number.parseInt(value);
        else headers[name] = value;
      }
      response.writeHead(status, headers);
      response.end(bytes.subarray(split + 4));
    });
  };
  const server = createServer((request, response) => {
    void serve(request, response).catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  );
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing test address');
  const forward: GitHttpForward = async (request, signal) => {
    expect(request.headers).not.toHaveProperty('Authorization');
    expect(request.path).toMatch(/^\/(owner|account)\/repo\.git\//);
    const result = await fetch(`http://127.0.0.1:${address.port}${request.path}`, {
      method: request.method,
      headers: { ...request.headers, Authorization: 'Basic server-only-test-secret' },
      signal,
      ...(request.body ? { body: request.body, duplex: 'half' } : {}),
    });
    return {
      status: result.status,
      contentType: result.headers.get('content-type') ?? '',
      body: result.body,
    };
  };
  const own = path.join(root, 'bot');
  await mkdir(own);
  const base: GitProcessSpec = {
    mode: 'clone',
    root: own,
    path: path.join(own, 'repo'),
    repository: 'owner/repo',
    defaultBranch: 'main',
    identity: { name: 'Connected account', email: '123+account@users.noreply.github.com' },
  };
  const run = (spec: GitProcessSpec, transport = forward, signal = AbortSignal.timeout(15000)) =>
    relayGitProcess(processFor(spec), spec, transport, signal);
  return { root, source, base, run, forward, binary, authenticated: () => authenticated };
}

describe('D-208 streamed Git over the provider exec port', () => {
  it('clones history and binary bytes, fetches without changing files, and publishes a feature branch', async () => {
    const f = await fixture();
    const clone = await f.run(f.base);
    expect(clone.exitCode, clone.output).toBe(0);
    expect(await readFile(path.join(f.base.path, 'image.bin'))).toEqual(f.binary);
    expect(git(f.base.path, 'remote', 'get-url', 'origin')).toBe(
      'https://github.com/owner/repo.git',
    );
    let configured = '';
    try {
      configured = git(f.base.path, 'config', '--global', '--get', 'user.email');
    } catch {
      /* The connected account supplies the fallback. */
    }
    expect(git(f.base.path, 'config', 'user.email')).toBe(
      configured || '123+account@users.noreply.github.com',
    );
    expect(git(f.base.path, 'log', '--format=%s')).toBe('Initial');
    await writeFile(path.join(f.base.path, 'hello.txt'), 'local uncommitted change\n');
    const fetched = await f.run({ ...f.base, mode: 'fetch' });
    expect(fetched.exitCode, fetched.output).toBe(0);
    expect(await readFile(path.join(f.base.path, 'hello.txt'), 'utf8')).toBe(
      'local uncommitted change\n',
    );
    git(f.base.path, 'add', '.');
    git(f.base.path, 'commit', '-m', 'Fix');
    const head = git(f.base.path, 'rev-parse', 'HEAD'),
      tree = git(f.base.path, 'rev-parse', 'HEAD^{tree}');
    const pushed = await f.run({ ...f.base, mode: 'push', branch: 'codex/fix', head, tree });
    expect(pushed.exitCode, pushed.output).toBe(0);
    expect(git(path.join(f.root, 'owner/repo.git'), 'rev-parse', 'refs/heads/codex/fix')).toBe(
      head,
    );
    expect(f.authenticated()).toBeGreaterThan(0);
    expect(JSON.stringify([clone, fetched, pushed])).not.toContain('server-only-test-secret');
  }, 30000);
  it('publishes to a fork and preserves the credential-free source remote', async () => {
    const f = await fixture();
    await f.run(f.base);
    await mkdir(path.join(f.root, 'account'));
    git(
      f.root,
      'clone',
      '--bare',
      path.join(f.root, 'owner/repo.git'),
      path.join(f.root, 'account/repo.git'),
    );
    git(path.join(f.root, 'account/repo.git'), 'config', 'http.receivepack', 'true');
    const head = git(f.base.path, 'rev-parse', 'HEAD'),
      tree = git(f.base.path, 'rev-parse', 'HEAD^{tree}');
    expect(
      (
        await f.run({
          ...f.base,
          mode: 'push',
          repository: 'account/repo',
          branch: 'fix',
          head,
          tree,
        })
      ).exitCode,
    ).toBe(0);
    expect(git(path.join(f.root, 'account/repo.git'), 'rev-parse', 'refs/heads/fix')).toBe(head);
    expect(git(f.base.path, 'remote', 'get-url', 'origin')).toBe(
      'https://github.com/owner/repo.git',
    );
  }, 30000);
  it('refuses non-fast-forward commits and races against a remote branch update', async () => {
    const f = await fixture();
    await f.run(f.base);
    const initial = git(f.base.path, 'rev-parse', 'HEAD');
    await writeFile(path.join(f.base.path, 'hello.txt'), 'first fix');
    git(f.base.path, 'add', '.');
    git(f.base.path, 'commit', '-m', 'First fix');
    const first = git(f.base.path, 'rev-parse', 'HEAD'),
      firstTree = git(f.base.path, 'rev-parse', 'HEAD^{tree}');
    await f.run({ ...f.base, mode: 'push', branch: 'fix', head: first, tree: firstTree });
    git(f.base.path, 'checkout', '--detach', initial);
    const rejected = await f.run({
      ...f.base,
      mode: 'push',
      branch: 'fix',
      previousHead: first,
      head: initial,
      tree: git(f.base.path, 'rev-parse', 'HEAD^{tree}'),
    });
    expect(rejected.exitCode).not.toBe(0);
    git(f.base.path, 'checkout', '--detach', first);
    await writeFile(path.join(f.base.path, 'hello.txt'), 'next fix');
    git(f.base.path, 'add', '.');
    git(f.base.path, 'commit', '-m', 'Next fix');
    const next = git(f.base.path, 'rev-parse', 'HEAD'),
      nextTree = git(f.base.path, 'rev-parse', 'HEAD^{tree}');
    // The server advances after ref discovery, before receive-pack sees the update.
    let raced = false;
    const bare = path.join(f.root, 'owner/repo.git');
    const advance = git(
      f.base.path,
      'commit-tree',
      firstTree,
      '-p',
      first,
      '-m',
      'Other publisher',
    );
    git(bare, 'fetch', f.base.path, advance);
    const transport: GitHttpForward = async (request, signal) => {
      if (request.method === 'POST' && request.path.endsWith('git-receive-pack')) {
        git(bare, 'update-ref', 'refs/heads/fix', advance, first);
        raced = true;
      }
      // Fixture transport supplied below independently, so the server still enforces CAS.
      return f.forward(request, signal);
    };
    expect(
      (
        await f.run(
          {
            ...f.base,
            mode: 'push',
            branch: 'fix',
            previousHead: first,
            head: next,
            tree: nextTree,
          },
          transport,
        )
      ).exitCode,
    ).not.toBe(0);
    expect(raced).toBe(true);
    expect(git(bare, 'rev-parse', 'refs/heads/fix')).toBe(advance);
    expect(git(f.base.path, 'rev-parse', 'HEAD')).toBe(next);
  }, 30000);
  it('refuses existing directories and workspace symlink escapes before contacting the remote', async () => {
    const f = await fixture();
    await mkdir(f.base.path);
    await writeFile(path.join(f.base.path, 'keep'), 'keep');
    expect((await f.run(f.base)).exitCode).not.toBe(0);
    expect(await readFile(path.join(f.base.path, 'keep'), 'utf8')).toBe('keep');
    await symlink(f.source, path.join(f.base.root, 'escape'));
    expect(
      (await f.run({ ...f.base, path: path.join(f.base.root, 'escape/repo') })).exitCode,
    ).not.toBe(0);
    expect(f.authenticated()).toBe(0);
  });
  it('kills the helper and Git when the relay is cancelled during authentication', async () => {
    const f = await fixture();
    const abort = new AbortController();
    let entered = false;
    const transport: GitHttpForward = (_request, _signal) => {
      entered = true;
      abort.abort();
      throw new Error('Cancelled');
    };
    await expect(f.run(f.base, transport, abort.signal)).rejects.toThrow();
    expect(entered).toBe(true);
  });
});
