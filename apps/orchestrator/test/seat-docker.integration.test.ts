import { chromium, type Browser } from 'playwright-core';
import { playwrightBrowserPage } from '../src/agent/browser-page.js';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * M5-BE-18 — a seat is a screen of its own on a shared machine (D-046,
 * WORKSPACE §20).
 *
 * Exercise display isolation, fixed framebuffer geometry, minimization,
 * profile persistence and the published CDP/recording paths on real desktops.
 *
 * Everything here runs against a real container because every claim is about
 * what the window manager, Chrome and x11vnc actually do — there is nothing to
 * learn from a fake that returns the answers we wrote down.
 */

// @skip-reason: live Docker and the built sandbox image; run with CREWAID_DOCKER_TESTS=1.
describe.skipIf(!process.env['CREWAID_DOCKER_TESTS'])(
  'a seat on a shared machine (real Docker)',
  () => {
    const run = promisify(execFile);
    const name = `crewaid-seat-it-${randomUUID().slice(0, 8)}`;
    const image = process.env['SANDBOX_IMAGE'] ?? 'crewaid/sandbox:m5-be18';
    let bridge = 0;
    let machineRfb = 0;
    let seatRfbBase = 0;

    /** The seat's own display geometry, read off the RFB `ServerInit` message. */
    async function serverInit(port: number): Promise<{ width: number; height: number }> {
      return new Promise((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1');
        let stage = 'version';
        let buf = Buffer.alloc(0);
        const timer = setTimeout(() => {
          sock.destroy();
          reject(new Error(`RFB ${port}: timed out`));
        }, 8000);
        sock.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        sock.on('data', (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          if (stage === 'version' && buf.length >= 12) {
            sock.write(Buffer.from('RFB 003.008\n'));
            stage = 'security';
            buf = buf.subarray(12);
          }
          if (stage === 'security' && buf.length >= 1 && buf.length >= 1 + buf[0]!) {
            const count = buf[0]!;
            sock.write(Buffer.from([1]));
            stage = 'result';
            buf = buf.subarray(1 + count);
          }
          if (stage === 'result' && buf.length >= 4) {
            sock.write(Buffer.from([1]));
            stage = 'init';
            buf = buf.subarray(4);
          }
          if (stage === 'init' && buf.length >= 4) {
            clearTimeout(timer);
            sock.destroy();
            resolve({ width: buf.readUInt16BE(0), height: buf.readUInt16BE(2) });
          }
        });
      });
    }

    const inContainer = async (script: string): Promise<string> =>
      (await run('docker', ['exec', '-u', 'bot', name, 'bash', '-lc', script])).stdout;

    /**
     * The host port Docker published for a container port.
     *
     * A seat's `rfbPort` is the port INSIDE the machine; the orchestrator will
     * reach it through whatever the provider published, and so does this suite.
     * Looked up per call rather than cached because a seat's port is chosen at
     * seat creation, after the container started.
     */
    async function publishedPort(containerPort: number): Promise<number> {
      const published = JSON.parse(
        (await run('docker', ['inspect', name, '--format', '{{json .NetworkSettings.Ports}}']))
          .stdout,
      ) as Record<string, Array<{ HostPort: string }> | null>;
      return Number(published[`${containerPort}/tcp`]?.[0]?.HostPort ?? 0);
    }

    const post = async (path: string, body: unknown = {}) => {
      const response = await fetch(`http://127.0.0.1:${bridge}${path}`, {
        method: 'POST',
        signal: AbortSignal.timeout(120_000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as Record<string, never> };
    };
    const get = async (path: string) =>
      (await (await fetch(`http://127.0.0.1:${bridge}${path}`)).json()) as Record<string, never>;

    beforeEach(async ({ task }) => {
      // Isolation needs two desktops; the capacity test retains production limits.
      const isolation = task.name.includes('concurrent seats');
      // Ports are picked by Docker so a developer's own sandbox can be running.
      const { stdout } = await run('docker', [
        'run',
        '-d',
        '--name',
        name,
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges:true',
        '--cpus',
        '4',
        '--memory',
        isolation ? '3g' : '2g',
        '--pids-limit',
        isolation ? '1024' : '512',
        '--tmpfs',
        '/dev/shm:size=512m',
        '-e',
        'SCREEN_WIDTH=1280',
        '-e',
        'SCREEN_HEIGHT=800',
        '-e',
        'SCREEN_DEPTH=24',
        ...[5900, 7070, 5901, 5902, 9301, 9302].flatMap((port) => ['-p', `127.0.0.1::${port}`]),
        image,
      ]);
      expect(stdout.trim()).toBeTruthy();
      const published = JSON.parse(
        (await run('docker', ['inspect', name, '--format', '{{json .NetworkSettings.Ports}}']))
          .stdout,
      ) as Record<string, Array<{ HostPort: string }> | null>;
      const hostPort = (containerPort: string): number =>
        Number(published[`${containerPort}/tcp`]?.[0]?.HostPort ?? 0);
      bridge = hostPort('7070');
      machineRfb = hostPort('5900');
      seatRfbBase = hostPort('5901');
      expect(machineRfb, 'the machine RFB port was published').toBeGreaterThan(0);
      expect(seatRfbBase, 'the first seat RFB port was published').toBeGreaterThan(0);
      expect(bridge, 'the bridge port was published').toBeGreaterThan(0);

      const deadline = Date.now() + 120_000;
      for (;;) {
        try {
          const response = await fetch(`http://127.0.0.1:${bridge}/health`, {
            signal: AbortSignal.timeout(2000),
          });
          if (response.ok) break;
        } catch {
          // The published socket may exist before the bridge starts.
        }
        if (Date.now() > deadline) throw new Error('the sandbox never came up');
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }, 180_000);

    afterEach(async () => {
      await run('docker', ['rm', '-f', name]).catch(() => undefined);
    }, 60_000);

    type Seat = {
      seatId: string;
      botId: string;
      display: string;
      rfbPort: number;
      cdpPort: number;
      dbusAddress: string;
      browserGeneration: number;
    };
    async function create(botId: string, profile?: string): Promise<Seat> {
      const result = await post('/seats', { botId, ...(profile ? { profile } : {}) });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      return result.body['seat'] as unknown as Seat;
    }
    async function browser(seat: Seat) {
      const started = await post('/seats/browser', { botId: seat.botId });
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      const { openCdpConnection } = await import('../src/recordings/cdp-connection.js');
      const port = await publishedPort(seat.cdpPort);
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      expect(response.status).toBe(200);
      const version = (await response.json()) as { webSocketDebuggerUrl: string };
      const url = new URL(version.webSocketDebuggerUrl);
      url.host = `127.0.0.1:${port}`;
      const connection = await openCdpConnection({
        url: url.toString(),
        handshakeTimeoutMs: 5000,
        commandTimeoutMs: 5000,
      });
      const targets = await connection.send('Target.getTargets', {});
      const target = (targets['targetInfos'] as { type: string; targetId: string }[]).find(
        (t) => t.type === 'page',
      )!;
      const attached = await connection.send('Target.attachToTarget', {
        targetId: target.targetId,
        flatten: true,
      });
      return { connection, targetId: target.targetId, session: String(attached['sessionId']) };
    }
    async function screenshot(botId: string): Promise<Buffer> {
      const response = await fetch(`http://127.0.0.1:${bridge}/screenshot?botId=${botId}`);
      expect(response.status).toBe(200);
      return Buffer.from(await response.arrayBuffer());
    }

    it('uses Playwright on concurrent seats and preserves a named login through transfer', async () => {
      const connections: Browser[] = [];
      const attach = async (seat: Seat) => {
        const ready = await post('/seats/browser', { botId: seat.botId });
        expect(ready.status).toBe(200);
        const generation = (ready.body['seat'] as unknown as Seat).browserGeneration;
        expect(Number.isSafeInteger(generation) && generation > 0).toBe(true);
        const port = await publishedPort(seat.cdpPort);
        const version = (await (
          await fetch(`http://127.0.0.1:${port}/json/version`, { headers: { connection: 'close' } })
        ).json()) as {
          webSocketDebuggerUrl: string;
        };
        const endpoint = new URL(version.webSocketDebuggerUrl);
        endpoint.host = `127.0.0.1:${port}`;
        const browser = await chromium.connectOverCDP(endpoint.toString(), {
          noDefaults: true,
          timeout: 10_000,
        });
        connections.push(browser);
        const context = browser.contexts()[0]!;
        const page = playwrightBrowserPage(browser, context, () => ({ epoch: 0, mode: 'agent' }), {
          seatId: seat.seatId,
          browserGeneration: generation,
        });
        return { browser, context, page, generation };
      };
      const observedRef = (text: string) => {
        const reference = text.match(/\[ref=([^\]]+)\]/)?.[1];
        if (reference === undefined) throw new Error('No observed reference');
        return reference;
      };
      try {
        const a = await create('native-alpha', 'company-login');
        const b = await create('native-beta');
        const alpha = await attach(a);
        const beta = await attach(b);
        expect(a.cdpPort).not.toBe(b.cdpPort);
        await alpha.context.addCookies([
          {
            name: 'session',
            value: 'signed-in-company',
            url: 'https://company.test/',
            expires: Date.now() / 1000 + 3600,
          },
        ]);
        await alpha.page.navigate(
          'data:text/html,' +
            encodeURIComponent(`<button onclick="this.textContent='Alpha clicked'">Alpha</button>`),
        );
        await beta.page.navigate('data:text/html,<button>Beta</button>');
        const alphaRef = observedRef(await alpha.page.read());
        await beta.page.read();
        await expect(beta.page.click(alphaRef)).rejects.toThrow('STALE_REFERENCE');
        await alpha.page.click(alphaRef);
        expect(await alpha.page.read()).toContain('Alpha clicked');
        expect(await beta.page.read()).toContain('Beta');
        expect(await beta.context.cookies('https://company.test/')).toEqual([]);
        expect((await alpha.page.screenshot()).subarray(0, 8)).toEqual(
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        );
        await alpha.page.stopLoading();
        await alpha.browser.close();
        const reconnected = await attach(a);
        expect(reconnected.generation).toBe(alpha.generation);
        expect((await reconnected.context.cookies('https://company.test/'))[0]?.value).toBe(
          'signed-in-company',
        );
        expect(await reconnected.page.read()).toContain('Alpha clicked');
        const beforeRelaunch = observedRef(await reconnected.page.read());
        const restart = await reconnected.browser.newBrowserCDPSession();
        await restart.send('Browser.close').catch(() => undefined);
        await expect.poll(() => reconnected.browser.isConnected(), { timeout: 5_000 }).toBe(false);
        const relaunched = await attach(a);
        expect(relaunched.generation).toBeGreaterThan(reconnected.generation);
        expect((await relaunched.context.cookies('https://company.test/'))[0]?.value).toBe(
          'signed-in-company',
        );
        await relaunched.page.read();
        await expect(relaunched.page.click(beforeRelaunch)).rejects.toThrow('STALE_REFERENCE');
        await relaunched.browser.close();
        expect(
          (await post('/seats', { botId: 'native-gamma', profile: 'company-login' })).status,
        ).toBe(503);
        await reconnected.browser.close();
        expect((await post(`/seats/${a.seatId}/close`)).status).toBe(200);
        const transferred = await create('native-gamma', 'company-login');
        const gamma = await attach(transferred);
        expect(gamma.generation).toBeGreaterThan(alpha.generation);
        expect((await gamma.context.cookies('https://company.test/'))[0]?.value).toBe(
          'signed-in-company',
        );
        await gamma.page.read();
        await expect(gamma.page.click(alphaRef)).rejects.toThrow('STALE_REFERENCE');
        expect(await beta.context.cookies('https://company.test/')).toEqual([]);
      } finally {
        await Promise.all(
          connections.map((connection) => connection.close().catch(() => undefined)),
        );
      }
    }, 120_000);

    it('restarts x11vnc without destroying the browser or its recording target', async () => {
      const seat = await create('teaching-recovery');
      const cdp = await browser(seat);
      try {
        await cdp.connection.send(
          'Runtime.evaluate',
          {
            expression: 'window.__teachingProof = "still here"',
          },
          cdp.session,
        );
        await run('docker', ['exec', name, 'pkill', '-f', `^x11vnc -display ${seat.display} `]);
        // The registry read repairs the transport in place. Poll the real
        // handshake too, so an advertised but dead port cannot pass.
        await expect
          .poll(
            async () => {
              const found = await get(`/seats?botId=${seat.botId}`);
              expect((found['seat'] as unknown as Seat).seatId).toBe(seat.seatId);
              return serverInit(await publishedPort(seat.rfbPort));
            },
            { timeout: 15_000 },
          )
          .toEqual({ width: 1280, height: 800 });
        const result = await cdp.connection.send(
          'Runtime.evaluate',
          {
            expression: 'window.__teachingProof',
            returnByValue: true,
          },
          cdp.session,
        );
        expect((result['result'] as { value: string }).value).toBe('still here');
      } finally {
        await cdp.connection.close();
      }
    }, 90_000);

    it('keeps separate displays, cookies and reachable CDP ports for concurrent seats', async () => {
      // Legacy profiles must survive seat allocation even though boot no longer creates one.
      await inContainer('mkdir -p /home/bot/.chrome/Default');
      const [a, b] = await Promise.all([create('alpha'), create('beta')]);
      expect(a.display).not.toBe(b.display);
      expect(a.cdpPort).not.toBe(b.cdpPort);
      expect(a.rfbPort).not.toBe(b.rfbPort);
      for (const seat of [a, b]) {
        expect(await serverInit(await publishedPort(seat.rfbPort))).toEqual({
          width: 1280,
          height: 800,
        });
      }
      const ca = await browser(a);
      const cb = await browser(b);
      try {
        await ca.connection.send(
          'Network.setCookie',
          {
            name: 'session',
            value: 'alpha',
            url: 'http://127.0.0.1/',
            expires: Date.now() / 1000 + 3600,
          },
          ca.session,
        );
        const cookies = await cb.connection.send(
          'Network.getCookies',
          { urls: ['http://127.0.0.1/'] },
          cb.session,
        );
        expect(cookies['cookies']).toEqual([]);
      } finally {
        await ca.connection.close();
        await cb.connection.close();
      }
      expect((await create('alpha')).seatId).toBe(a.seatId);
      const own = await inContainer('ls /home/bot/.seats');
      expect(own).toContain('alpha');
      expect(own).toContain('beta');
      expect(await inContainer('test -d /home/bot/.chrome/Default && echo kept')).toContain('kept');
    }, 180_000);

    it('gives the bot its own area, on a desktop with its own session bus', async () => {
      const seat = await create('tenant');

      // WORKSPACE §19's three-way split, materialized: the bot's own area, and
      // the machine's shared one. A bot that finds no directory of its own
      // writes into the team's — where the next bot to write overwrites it —
      // and the tools that default to it (`fs_write` with a relative path,
      // `record_screen_stop`) have nowhere to land.
      expect((await inContainer('test -d /home/bot/agents/tenant && echo yes')).trim()).toBe('yes');
      expect((await inContainer('test -d /home/bot/shared && echo yes')).trim()).toBe('yes');

      // D-060: the seat runs its OWN session bus, and the bridge says where.
      // A command run on this seat without it joins the MACHINE's session —
      // the failure `plank` already documents — so the address the bridge
      // reports has to be a live socket while the desktop is up, and not the
      // machine's.
      const socket = seat.dbusAddress.replace('unix:path=', '');
      expect(seat.dbusAddress.startsWith('unix:path=')).toBe(true);
      expect(socket).not.toBe('/tmp/runtime-bot/bus');
      expect((await inContainer(`test -S ${socket} && echo yes`)).trim()).toBe('yes');
    }, 120_000);

    it('keeps the desktop responsive when Chrome is minimized and its framebuffer fixed after resize', async () => {
      const seat = await create('minimize');
      const { connection, targetId, session } = await browser(seat);
      try {
        await connection.send('Page.navigate', { url: 'http://127.0.0.1:7070/health' }, session);
        const placed = await connection.send('Browser.getWindowForTarget', { targetId });
        const before = await screenshot(seat.botId);
        await connection.send('Browser.setWindowBounds', {
          windowId: placed['windowId'],
          bounds: { windowState: 'minimized' },
        });
        await expect.poll(async () => (await screenshot(seat.botId)).equals(before)).toBe(false);
        expect(await serverInit(await publishedPort(seat.rfbPort))).toEqual({
          width: 1280,
          height: 800,
        });
        await connection.send('Browser.setWindowBounds', {
          windowId: placed['windowId'],
          bounds: { windowState: 'normal' },
        });
        await connection.send('Browser.setWindowBounds', {
          windowId: placed['windowId'],
          bounds: { width: 700, height: 500 },
        });
        expect(await serverInit(await publishedPort(seat.rfbPort))).toEqual({
          width: 1280,
          height: 800,
        });
        const replay = await post(`/skill/run?botId=${seat.botId}`, {
          script:
            'export default async (ctx) => { await ctx.key("ctrl+l"); await ctx.type("http://127.0.0.1:7070/health"); await ctx.key("Return"); await ctx.page.waitForSelector("pre"); return (await ctx.screenshot()).length; }',
          params: {},
        });
        expect(replay.body, JSON.stringify(replay.body)).toMatchObject({ ok: true });
        expect(Number(replay.body['result'])).toBeGreaterThan(1000);
      } finally {
        await connection.close();
      }
    }, 180_000);

    it('flushes cookies on close, reuses the slot, and reaps retired display profiles at boot', async () => {
      const seat = await create('retired-bot');
      const cdp = await browser(seat);
      await cdp.connection.send(
        'Network.setCookie',
        {
          name: 'session',
          value: 'persist',
          url: 'http://127.0.0.1/',
          expires: Date.now() / 1000 + 3600,
        },
        cdp.session,
      );
      await cdp.connection.close();
      expect((await post(`/seats/${seat.seatId}/close`)).status).toBe(200);
      const reopened = await create('retired-bot');
      expect(reopened.rfbPort).toBe(seat.rfbPort);
      const next = await browser(reopened);
      try {
        const cookies = await next.connection.send(
          'Network.getCookies',
          { urls: ['http://127.0.0.1/'] },
          next.session,
        );
        expect(cookies['cookies']).toEqual(
          expect.arrayContaining([expect.objectContaining({ name: 'session', value: 'persist' })]),
        );
      } finally {
        await next.connection.close();
      }
      await inContainer('mkdir -p /home/bot/.seats/sibling && touch /home/bot/.seats/sibling/keep');
      await inContainer('python3 /opt/agent-bridge/profiles.py retire retired-bot');
      await post(`/seats/${reopened.seatId}/close`);
      expect((await post('/seats', { botId: 'retired-bot' })).status).toBe(503);
      await run('docker', ['restart', name]);
      await expect
        .poll(
          async () => {
            try {
              bridge = await publishedPort(7070);
              return (await fetch(`http://127.0.0.1:${bridge}/health`)).status;
            } catch {
              return 0;
            }
          },
          { timeout: 120_000, interval: 1000 },
        )
        .toBe(200);
      expect(await inContainer('test ! -e /home/bot/.seats/retired-bot && echo gone')).toContain(
        'gone',
      );
      expect(await inContainer('test -f /home/bot/.seats/sibling/keep && echo kept')).toContain(
        'kept',
      );
      expect((await post('/seats', { botId: 'retired-bot' })).status).toBe(503);
      await create('sibling');
    }, 240_000);

    it('refuses identity contention and capacity without killing existing seats', async () => {
      const first = await create('owner', 'company-google');
      expect((await post('/seats', { botId: 'other', profile: 'company-google' })).status).toBe(
        503,
      );
      let refused = false;
      for (let index = 0; index < 16; index++) {
        const result = await post('/seats', { botId: `capacity-${index}` });
        if (result.status === 503) {
          expect(String(result.body['detail'])).toMatch(/headroom|every seat slot/);
          refused = true;
          break;
        }
        expect(result.status, JSON.stringify(result.body)).toBe(200);
      }
      expect(refused).toBe(true);
      const browserStart = await post('/seats/browser', { botId: first.botId });
      expect(browserStart.status).toBe(503);
      expect(String(browserStart.body['detail'])).toContain('headroom for another browser');
      expect(await serverInit(await publishedPort(first.rfbPort))).toEqual({
        width: 1280,
        height: 800,
      });
      expect(await inContainer('cat /sys/fs/cgroup/pids.events')).toMatch(/^max 0$/m);
      expect(await inContainer('cat /sys/fs/cgroup/memory.events')).toMatch(/^oom_kill 0$/m);
    }, 240_000);
  },
);
