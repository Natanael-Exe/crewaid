import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterAll, describe, expect, it } from 'vitest';
import { SANDBOX_PORTS, type HarnessV1NetworkSandboxSession } from '@crewaid/sandbox-core';

import {
  DockerSandboxProvider,
  SANDBOX_IDENTITY_LABEL,
  SANDBOX_LABELS,
  SANDBOX_MANAGED_BY,
  workspaceVolumeNameFor,
} from '@crewaid/sandbox-docker';
import { BROWSER_SANDBOX_SECCOMP } from './seccomp-profile.js';
import { useTestSupervisor } from './testing.js';

/**
 * M2-BE-01 and M2-QA-01 against a real Docker daemon and the real §5 image.
 *
 * The unit suites prove the session and provider agree with a fake. This proves
 * they agree with Docker, which is the half that has actually been wrong:
 * exec stream demultiplexing, the stdin half-close that ends a write, and
 * whether the §5.1 constraints survive the trip through dockerode's HostConfig
 * are all things a fake will happily confirm and a daemon will not.
 *
 * Constraints are read back with the `docker` CLI rather than dockerode,
 * because R2 bans that import outside the supervisor's engine — and because it asserts
 * what an operator inspecting the container would actually see.
 *
 * @skip-reason: needs a Docker daemon and a built crewaid/sandbox image; set
 * CREWAID_DOCKER_TESTS=1 to run (Natanael). Declared in turbo.json globalEnv so
 * Turbo's strict env mode cannot strip the gate and turn this into a dormant
 * guard (D-017).
 */
const DOCKER_TESTS = process.env['CREWAID_DOCKER_TESTS'];
const IMAGE = process.env['SANDBOX_IMAGE'] ?? 'crewaid/sandbox:dev';
const NETWORK = 'crewaid-it-net';

// The provider reaches Docker only through a supervisor (D-200), configured
// for this suite's own network so the admission check is the real one.
const supervisor =
  DOCKER_TESTS === '1' ? await useTestSupervisor({ SANDBOX_NETWORK: NETWORK }) : null;
afterAll(async () => supervisor?.close());

const run = promisify(execFile);

/** One boot of a full XFCE desktop, plus room for a cold image on a slow host. */
const BOOT_MS = 90_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// The M5 margin the entrypoint adds around the advertised screen (D-046),
// mirrored so the screenshot assertion below tracks the display the bridge
// actually captures rather than a number that drifts with the image.
const SCREEN_MARGIN = 8;

type PortEndpoint = {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
};

async function dockerInspect(containerId: string): Promise<Record<string, unknown>> {
  const { stdout } = await run('docker', ['inspect', containerId]);
  const parsed: unknown = JSON.parse(stdout);
  const [first] = parsed as Record<string, unknown>[];
  if (first === undefined) throw new Error(`docker inspect returned nothing for ${containerId}`);
  return first;
}

function hostConfigOf(inspected: Record<string, unknown>): Record<string, unknown> {
  return inspected['HostConfig'] as Record<string, unknown>;
}

async function cdpCommand(
  endpoint: PortEndpoint,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const versionResponse = await fetch(`${endpoint.url}/json/version`, {
    headers: { ...endpoint.headers },
  });
  expect(versionResponse.status).toBe(200);
  const version = (await versionResponse.json()) as { webSocketDebuggerUrl?: string };
  if (version.webSocketDebuggerUrl === undefined) {
    throw new Error('Chrome discovery response omitted webSocketDebuggerUrl');
  }

  // Keep the provider-resolved address authoritative: a remote provider may
  // proxy a different public host from the one Chrome sees in its container.
  const socketUrl = new URL(version.webSocketDebuggerUrl);
  const resolved = new URL(endpoint.url);
  socketUrl.protocol = resolved.protocol === 'https:' ? 'wss:' : 'ws:';
  socketUrl.hostname = resolved.hostname;
  socketUrl.port = resolved.port;

  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = new WebSocket(socketUrl);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`CDP ${method} timed out`));
    }, 10_000);
    const fail = (error: Error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    };

    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method, params })), {
      once: true,
    });
    socket.addEventListener('error', () => fail(new Error(`CDP ${method} WebSocket failed`)), {
      once: true,
    });
    socket.addEventListener('message', (event) => {
      try {
        const reply = JSON.parse(String(event.data)) as {
          id?: number;
          result?: Record<string, unknown>;
          error?: { message?: string };
        };
        if (reply.id !== 1) return;
        clearTimeout(timer);
        socket.close();
        if (reply.error !== undefined) {
          reject(new Error(`CDP ${method}: ${reply.error.message ?? 'unknown error'}`));
        } else {
          resolve(reply.result ?? {});
        }
      } catch (error: unknown) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

async function setQaSessionCookie(session: HarnessV1NetworkSandboxSession): Promise<void> {
  const endpoint = await browserEndpoint(session);
  await cdpCommand(endpoint, 'Storage.setCookies', {
    cookies: [
      {
        name: 'crewaid_qa_session',
        value: 'authenticated',
        domain: 'crewaid.qa.local',
        path: '/',
        expires: Math.floor(Date.now() / 1000) + 3600,
      },
    ],
  });
}

async function expectQaSessionCookie(session: HarnessV1NetworkSandboxSession): Promise<void> {
  const endpoint = await browserEndpoint(session);
  const result = await cdpCommand(endpoint, 'Storage.getCookies');
  const cookies = result['cookies'] as { name?: string; value?: string; domain?: string }[];
  expect(cookies).toContainEqual(
    expect.objectContaining({
      name: 'crewaid_qa_session',
      value: 'authenticated',
      domain: 'crewaid.qa.local',
    }),
  );
}

/** Browsers live in private seats and start on demand, including after a restart. */
async function browserEndpoint(session: HarnessV1NetworkSandboxSession): Promise<PortEndpoint> {
  const bridge = await session.getPortEndpoint({ port: SANDBOX_PORTS.bridge });
  const allocated = await fetch(`${bridge.url}/seats`, {
    method: 'POST',
    headers: { ...bridge.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ botId: 'qa-browser' }),
  });
  expect(allocated.status).toBe(200);
  const { seat } = (await allocated.json()) as { seat: { display: string; cdpPort: number } };
  const started = await fetch(`${bridge.url}/seats/browser`, {
    method: 'POST',
    headers: { ...bridge.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ display: seat.display }),
  });
  expect(started.status).toBe(200);
  return session.getPortEndpoint({ port: seat.cdpPort });
}

describe.skipIf(DOCKER_TESTS === undefined || DOCKER_TESTS === '')(
  'DockerSandboxProvider against real Docker',
  () => {
    const provider = new DockerSandboxProvider({ image: IMAGE, network: NETWORK });
    const sessionId = `it-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let session: HarnessV1NetworkSandboxSession | undefined;

    afterAll(async () => {
      // A failed test must not leave a desktop behind; the next run would then
      // fail on the name rather than on whatever actually broke.
      // destroy() is PromiseLike, not Promise — no .catch() to reach for.
      try {
        await session?.destroy();
      } catch {
        /* the test that failed already said why; cleanup must not mask it */
      }
      await run('docker', ['network', 'rm', NETWORK]).catch(() => undefined);
    }, 60_000);

    it(
      'creates a session whose ports are reachable',
      async () => {
        session = await provider.createSession({ sessionId });

        expect(session.id).toBe(sessionId);
        for (const port of [SANDBOX_PORTS.rfb, SANDBOX_PORTS.cdp, SANDBOX_PORTS.bridge]) {
          const endpoint = await session.getPortEndpoint({ port });
          expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        }
      },
      BOOT_MS,
    );

    it('applies every §5.1 constraint as D-063 sizes them', async () => {
      const host = hostConfigOf(await dockerInspect(await requireContainerId(sessionId)));

      expect(host['Memory']).toBe(8 * 1024 ** 3);
      // Equal to Memory is how Docker spells "swap disabled".
      expect(host['MemorySwap']).toBe(8 * 1024 ** 3);
      expect(host['NanoCpus']).toBe(4_000_000_000);
      expect(host['PidsLimit']).toBe(2048);
      expect(host['SecurityOpt']).toContain('no-new-privileges:true');
      // D-145: the browser profile, not Docker's default, and still no capability.
      expect(host['SecurityOpt']).toContain(`seccomp=${JSON.stringify(BROWSER_SANDBOX_SECCOMP)}`);
      expect(host['CapDrop']).toEqual(['ALL']);
      expect(host['NetworkMode']).toBe(NETWORK);
      expect(host['Tmpfs']).toMatchObject({ '/dev/shm': `size=${512 * 1024 ** 2}` });
      expect((host['RestartPolicy'] as { Name?: string })['Name']).toBe('no');
    }, 30_000);

    it('gives the bot no host filesystem and no Docker socket (R5)', async () => {
      const inspected = await dockerInspect(await requireContainerId(sessionId));
      expect(inspected).toMatchObject({
        Mounts: [],
      });
      const env = (inspected['Config'] as { Env: string[] }).Env;
      expect(
        env.some((entry) =>
          /^(SANDBOX_SUPERVISOR_SECRET|ORCH_API_TOKEN|DATABASE_URL|CREDENTIAL_KEY)=/.test(entry),
        ),
      ).toBe(false);
      expect(JSON.stringify(inspected)).not.toContain(process.env['SANDBOX_SUPERVISOR_SECRET']);

      const probe = await session!.run({ command: 'ls /var/run/docker.sock 2>&1; echo "exit:$?"' });
      expect(probe.stdout).toContain('exit:');
      expect(probe.stdout).not.toMatch(/^\/var\/run\/docker\.sock$/m);
    }, 30_000);

    it('serves the agent-bridge health check through the resolved endpoint', async () => {
      const { url } = await session!.getPortEndpoint({ port: SANDBOX_PORTS.bridge });
      const response = await fetch(`${url}/health`);
      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        ok: boolean;
        checks: { display: { widthPx: number; heightPx: number }; browser: { ok: boolean } };
      };
      expect(body.ok).toBe(true);
      // R8: the framebuffer is whatever the image fixed it at, for life.
      expect(body.checks.display).toMatchObject({ widthPx: 1280, heightPx: 800 });
      expect(body.checks.browser.ok).toBe(true);
    }, 30_000);

    it('reaches CDP over the resolved endpoint, not just over the bridge (D-030)', async () => {
      // The bridge's cdp check runs INSIDE the container and answers over
      // loopback. Headed Chrome binds loopback regardless of
      // --remote-debugging-address, so that check passed for an image whose CDP
      // port refused every connection from outside it — a green light on the one
      // path that is not the real one. M4 attaches from the orchestrator, across
      // the container boundary, which is this path.
      const { url } = await browserEndpoint(session!);
      const response = await fetch(`${url}/json/version`);
      expect(response.status).toBe(200);

      const version = (await response.json()) as { Browser?: string };
      expect(version.Browser).toMatch(/^Chrome\//);
    }, 30_000);

    it('runs a command and reports its streams separately', async () => {
      // Separately is the point: with a TTY attached Docker merges both onto
      // one unframed stream, and every file read would come back with stderr
      // spliced into its bytes.
      const result = await session!.run({ command: 'echo out; echo err >&2; exit 7' });
      expect(result).toEqual({ exitCode: 7, stdout: 'out\n', stderr: 'err\n' });
    }, 30_000);

    it('captures the running desktop as a fixed-size PNG (M2-QA-01)', async () => {
      const endpoint = await session!.getPortEndpoint({ port: SANDBOX_PORTS.bridge });
      const response = await fetch(`${endpoint.url}/screenshot`, {
        headers: { ...endpoint.headers },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/png');

      const png = Buffer.from(await response.arrayBuffer());
      expect(png.subarray(0, PNG_SIGNATURE.length)).toEqual(PNG_SIGNATURE);
      // PNG's IHDR width and height are unsigned big-endian values at 16..23.
      // The machine's X display carries the M5 margin around the screen the
      // product advertises (D-046: a window cannot be the full size of its
      // screen), so `/screenshot` — the whole display, not one seat's — is
      // 1288x808 while the advertised screen stays 1280x800. The smoke suite
      // asserts the same pair against `/health`'s two geometries.
      expect(png.readUInt32BE(16)).toBe(1280 + SCREEN_MARGIN);
      expect(png.readUInt32BE(20)).toBe(800 + SCREEN_MARGIN);
    }, 30_000);

    it('can wait after stdout has already ended, and wait again', async () => {
      const process = await session!.spawn({ command: 'echo done; exit 7' });
      await new Response(process.stdout).text();
      await new Response(process.stderr).text();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await expect(process.wait()).resolves.toEqual({ exitCode: 7 });
      await expect(process.wait()).resolves.toEqual({ exitCode: 7 });
    }, 5_000);

    it('kills a running exec and its child processes', async () => {
      const process = await session!.spawn({ command: 'sleep 60 & wait' });
      await new Promise((resolve) => setTimeout(resolve, 200));
      await process.kill();
      const result = await process.wait();
      expect(result.exitCode).not.toBe(0);
      await new Response(process.stdout).text();
      await new Response(process.stderr).text();
    }, 5_000);

    it('round-trips a file through the desktop', async () => {
      const path = '/home/bot/nested/dir/proof.txt';
      await session!.writeTextFile({ path, content: 'written by the orchestrator\n' });

      await expect(session!.readTextFile({ path })).resolves.toBe('written by the orchestrator\n');
      // And the desktop itself can see it — not just our own read path.
      const seen = await session!.run({ command: `cat ${path}` });
      expect(seen.stdout).toBe('written by the orchestrator\n');
    }, 30_000);

    it('round-trips bytes that a text path would corrupt', async () => {
      const content = new Uint8Array([0, 1, 2, 0xff, 0xfe, 10, 0]);
      await session!.writeBinaryFile({ path: '/home/bot/bytes.bin', content });
      await expect(session!.readBinaryFile({ path: '/home/bot/bytes.bin' })).resolves.toEqual(
        content,
      );
    }, 30_000);

    it('resolves null for a missing file rather than throwing', async () => {
      await expect(session!.readBinaryFile({ path: '/home/bot/absent' })).resolves.toBeNull();
    }, 30_000);

    it(
      'resumes the same container after a stop, without recreating it',
      async () => {
        const before = await requireContainerId(sessionId);
        await session!.stop();

        const resumed = await provider.resumeSession({ sessionId });
        session = resumed;

        expect(await containerIdFor(sessionId)).toBe(before);
        expect(resumed.id).toBe(sessionId);
        // The file written before the stop is still there: same filesystem,
        // not a fresh container wearing the same name.
        await expect(
          resumed.readTextFile({ path: '/home/bot/nested/dir/proof.txt' }),
        ).resolves.toBe('written by the orchestrator\n');
      },
      BOOT_MS,
    );

    it(
      'boots with the configured display dimensions',
      async () => {
        const custom = await new DockerSandboxProvider({
          image: IMAGE,
          network: NETWORK,
          screen: { widthPx: 1024, heightPx: 768 },
        }).createSession();
        try {
          const { url } = await custom.getPortEndpoint({ port: SANDBOX_PORTS.bridge });
          const response = await fetch(`${url}/health`);
          const body = await response.json();
          expect(body).toMatchObject({ checks: { display: { widthPx: 1024, heightPx: 768 } } });
          expect(custom.description).toContain('1024x768');
        } finally {
          await custom.destroy();
        }
      },
      BOOT_MS,
    );

    it('destroys the container', async () => {
      await session!.destroy();
      session = undefined;
      await expect(containerIdFor(sessionId)).resolves.toBeNull();
    }, 60_000);
  },
);

describe.skipIf(DOCKER_TESTS === undefined || DOCKER_TESTS === '')(
  'the durable workspace against real Docker (M2-QA-08, D-039)',
  () => {
    const provider = new DockerSandboxProvider({ image: IMAGE, network: NETWORK });
    // A bot id, not a session id: the workspace is keyed on the bot (D-039 §2).
    const botId = `it-ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const volume = workspaceVolumeNameFor(botId);
    const replacementImage = `crewaid/sandbox:qa08-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    afterAll(async () => {
      try {
        const stranded = await provider.attachSession({ sessionId: botId });
        await stranded?.destroy();
      } catch {
        /* the failing test already said why */
      }
      // The suite removes its own volume BECAUSE nothing else will: D-039
      // forbids runtime cleanup from touching a workspace, which is exactly
      // what the second assertion below relies on.
      await run('docker', ['volume', 'rm', '--force', volume]).catch(() => undefined);
      await run('docker', ['image', 'rm', '--force', replacementImage]).catch(() => undefined);
    }, 90_000);

    it(
      'survives losing its container, with the files and the browser profile intact',
      async () => {
        // D-031's headline promise, end to end. Everything else in this file
        // tests a container; this tests what outlives one.
        const first = await provider.createSession({ sessionId: botId, identity: botId });

        const inspected = await dockerInspect(first.containerId);
        const mounts = inspected['Mounts'] as {
          Type: string;
          Name?: string;
          Destination: string;
        }[];
        const workspace = mounts.find((mount) => mount.Destination === '/home/bot');
        expect(workspace?.Name).toBe(volume);
        expect(workspace?.Type).toBe('volume');
        // R5: durable storage is a named volume and never a host path, so a
        // bind mount here would be a violation rather than a variation.
        expect(mounts.every((mount) => mount.Type === 'volume')).toBe(true);

        const labels = JSON.parse(
          (await run('docker', ['volume', 'inspect', volume, '--format', '{{json .Labels}}']))
            .stdout,
        ) as Record<string, string>;
        expect(labels[SANDBOX_LABELS.botId]).toBe(botId);
        expect(labels[SANDBOX_LABELS.managedBy]).toBe(SANDBOX_MANAGED_BY);

        await first.writeTextFile({
          path: '/home/bot/work/notes.txt',
          content: "the bot's work\n",
        });
        // A real persistent Chrome cookie, not a stand-in file under .chrome.
        // If Chrome starts with a fresh profile after either lifecycle edge,
        // Storage.getCookies has nothing from which to manufacture this value.
        await setQaSessionCookie(first);
        await expectQaSessionCookie(first);

        const launchers = '/home/bot/.config/plank/dock1/launchers';
        const removedLauncher = `${launchers}/01-thunar.dockitem`;
        const addedLauncher = `${launchers}/03-qa-image.dockitem`;
        expect((await first.run({ command: `rm -f ${removedLauncher}` })).exitCode).toBe(0);

        // Starting an existing container activates its configured mounts again,
        // so resume must revalidate the exact volume and its daemon labels just
        // like a fresh attachment does. Exercise that path against Docker, not
        // only the fake-engine ownership tests.
        await first.stop();
        const resumed = await provider.resumeSession({ sessionId: botId });
        expect(resumed.containerId).toBe(first.containerId);
        await expect(resumed.readTextFile({ path: '/home/bot/work/notes.txt' })).resolves.toBe(
          "the bot's work\n",
        );
        await expectQaSessionCookie(resumed);
        // The original image restores its owned launcher on every boot, while
        // a launcher that exists only in the future image is still absent.
        await expect(resumed.readTextFile({ path: removedLauncher })).resolves.toContain(
          'thunar.desktop',
        );
        await expect(resumed.readTextFile({ path: addedLauncher })).resolves.toBeNull();

        // Produce a genuinely different image without putting the bot's volume
        // into its layers: mutate the image-owned skel, then commit the runtime.
        // Docker excludes /home/bot because it is a named-volume mount.
        await resumed.writeTextFile({
          path: '/opt/crewaid/skel/.config/plank/dock1/launchers/03-qa-image.dockitem',
          content:
            '[PlankDockItemPreferences]\nLauncher=file:///usr/share/applications/xfce4-terminal.desktop\n',
        });
        await run('docker', ['commit', resumed.containerId, replacementImage]);
        const originalImageId = (
          await run('docker', ['image', 'inspect', '--format', '{{.Id}}', IMAGE])
        ).stdout;
        const replacementImageId = (
          await run('docker', ['image', 'inspect', '--format', '{{.Id}}', replacementImage])
        ).stdout;
        expect(replacementImageId.trim()).not.toBe(originalImageId.trim());

        // Lose the container. Not stop — destroy, which is the state a crashed
        // host, a `docker rm`, or a failed image replacement leaves behind.
        await resumed.destroy();
        await expect(containerIdFor(botId)).resolves.toBeNull();

        // D-039 §12.4 and the rule most likely to be broken by a well-meaning
        // cleanup change: destroying the runtime must not touch the workspace.
        const survivors = await run('docker', [
          'volume',
          'ls',
          '--quiet',
          '--filter',
          `name=^${volume}$`,
        ]);
        expect(survivors.stdout.trim()).toBe(volume);

        // Replacement from saved workspace: a NEW container, the SAME volume.
        // An image upgrade also upgrades the supervisor's admitted image.
        // Merely changing the provider's image is deliberately refused.
        const upgradedSupervisor = await useTestSupervisor({
          SANDBOX_NETWORK: NETWORK,
          SANDBOX_IMAGE: replacementImage,
        });
        try {
          const replacement = await new DockerSandboxProvider({
            image: replacementImage,
            network: NETWORK,
          }).createSession({ sessionId: botId, identity: botId });
          try {
            expect(replacement.containerId).not.toBe(first.containerId);
            await expect(
              replacement.readTextFile({ path: '/home/bot/work/notes.txt' }),
            ).resolves.toBe("the bot's work\n");
            // Chrome itself is alive against the persisted profile and still
            // carries the session cookie through the new container and image.
            await expectQaSessionCookie(replacement);
            await expect(replacement.readTextFile({ path: removedLauncher })).resolves.toContain(
              'thunar.desktop',
            );
            await expect(replacement.readTextFile({ path: addedLauncher })).resolves.toContain(
              'xfce4-terminal.desktop',
            );
          } finally {
            await replacement.destroy();
          }
        } finally {
          await upgradedSupervisor?.close();
          if (supervisor !== null) {
            process.env['SANDBOX_SUPERVISOR_URL'] = supervisor.url;
            process.env['SANDBOX_SUPERVISOR_SECRET'] = supervisor.secret;
          }
        }
      },
      BOOT_MS * 3,
    );

    it(
      'refuses a workspace that belongs to another bot',
      async () => {
        // The silent cross-bot leak. Asserted against the real daemon because
        // the label is read from Docker, and a unit test can only prove the
        // provider checks what its fake was told to say.
        const foreign = `${volume}-foreign`;
        await run('docker', [
          'volume',
          'create',
          '--label',
          `${SANDBOX_LABELS.botId}=someone-else`,
          '--label',
          `${SANDBOX_LABELS.managedBy}=${SANDBOX_MANAGED_BY}`,
          foreign,
        ]);
        try {
          const impostor = `${botId}-foreign`;
          await expect(
            provider.createSession({ sessionId: impostor, identity: impostor }),
          ).rejects.toThrow(/not owned by/);
          await expect(containerIdFor(impostor)).resolves.toBeNull();
        } finally {
          await run('docker', ['volume', 'rm', '--force', foreign]).catch(() => undefined);
        }
      },
      BOOT_MS,
    );
  },
);

describe.skipIf(DOCKER_TESTS === undefined || DOCKER_TESTS === '')(
  'runtime orphan cleanup against real Docker (M2-BE-12)',
  () => {
    const provider = new DockerSandboxProvider({ image: IMAGE, network: NETWORK });
    const botId = `it-reconcile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const volume = workspaceVolumeNameFor(botId);
    let containerId: string | null = null;

    afterAll(async () => {
      if (containerId !== null) {
        await run('docker', ['rm', '--force', containerId]).catch(() => undefined);
      }
      await run('docker', ['volume', 'rm', '--force', volume]).catch(() => undefined);
    });

    it('lists and removes the orphan container while preserving its named workspace', async () => {
      await run('docker', [
        'volume',
        'create',
        '--label',
        `${SANDBOX_LABELS.botId}=${botId}`,
        '--label',
        `${SANDBOX_LABELS.managedBy}=${SANDBOX_MANAGED_BY}`,
        volume,
      ]);
      const created = await run('docker', [
        'create',
        '--network',
        NETWORK,
        '--label',
        `${SANDBOX_LABELS.sessionId}=${botId}`,
        '--label',
        `${SANDBOX_LABELS.managedBy}=${SANDBOX_MANAGED_BY}`,
        '--label',
        `${SANDBOX_IDENTITY_LABEL}=${botId}`,
        '--volume',
        `${volume}:/home/bot`,
        IMAGE,
      ]);
      containerId = created.stdout.trim();

      await expect(provider.listManagedSessions()).resolves.toContainEqual({
        containerId,
        sessionId: botId,
        botId,
        running: false,
        workspace: { ok: true, volumeName: volume },
      });

      await provider.removeManagedSession({ containerId });
      await expect(containerIdFor(botId)).resolves.toBeNull();
      containerId = null;
      const volumes = await run('docker', [
        'volume',
        'ls',
        '--quiet',
        '--filter',
        `name=^${volume}$`,
      ]);
      expect(volumes.stdout.trim()).toBe(volume);
    }, 30_000);
  },
);

async function requireContainerId(sessionId: string): Promise<string> {
  const id = await containerIdFor(sessionId);
  if (id === null) throw new Error(`no container carries ${SANDBOX_LABELS.sessionId}=${sessionId}`);
  return id;
}

async function containerIdFor(sessionId: string): Promise<string | null> {
  const { stdout } = await run('docker', [
    'ps',
    '--all',
    '--quiet',
    '--filter',
    `label=${SANDBOX_LABELS.sessionId}=${sessionId}`,
  ]);
  return stdout.trim() === '' ? null : stdout.trim().split('\n')[0]!;
}
