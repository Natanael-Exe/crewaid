import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBrowserPage } from './browser.js';

type Seat = {
  botId: string;
  seatId: string;
  cdpPort: number;
  display: string;
  browserReady: boolean;
};
type BridgeBody = {
  ok: boolean;
  seat: Seat;
  seats: Seat[];
  code?: string;
  detail?: string;
  result?: unknown;
};

// @skip-reason: real Docker/Chrome and the current image; CREWAID_DOCKER_TESTS=1, SANDBOX_IMAGE.
describe.skipIf(!process.env['CREWAID_DOCKER_TESTS'])(
  'native skill replay on private seats (Docker)',
  () => {
    const run = promisify(execFile);
    const name = `crewaid-skillrt-${randomUUID().slice(0, 8)}`;
    const image = process.env['SANDBOX_IMAGE'] ?? 'crewaid/sandbox:dev';
    const botId = randomUUID();
    const otherBot = randomUUID();
    let bridge: string;
    let display: string;
    const connections: Browser[] = [];
    let inspector: Browser;
    let page: Page;

    async function mappedPort(port: number) {
      const { stdout } = await run('docker', ['port', name, String(port)]);
      return stdout.trim().split('\n')[0]!.split(':').at(-1)!;
    }
    async function post(path: string, body: unknown) {
      const response = await fetch(`${bridge}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
      return { status: response.status, body: (await response.json()) as BridgeBody };
    }
    async function replay(script: string, id = botId) {
      return post(`/skill/run?botId=${id}`, { script, params: {} });
    }
    async function attach(id: string) {
      const ready = await post('/seats/browser', { botId: id });
      expect(ready.status, JSON.stringify(ready.body)).toBe(200);
      const port = await mappedPort(ready.body.seat.cdpPort);
      const metadata = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as {
        webSocketDebuggerUrl: string;
      };
      const endpoint = new URL(metadata.webSocketDebuggerUrl);
      endpoint.host = `127.0.0.1:${port}`;
      const browser = await chromium.connectOverCDP(endpoint.href, {
        noDefaults: true,
        timeout: 15000,
      });
      connections.push(browser);
      return browser;
    }
    const fixture = () =>
      `data:text/html,${encodeURIComponent(`
    <body style="background:#21633c"><input id="name"><button id="save" onclick="window.hits++">Save</button>
    <button class="duplicate" onclick="window.wrong++">Same</button><button class="duplicate" onclick="window.wrong++">Same</button>
    <button id="disabled" disabled onclick="window.wrong++">Disabled</button>
    <button id="inside" onclick="window.wrong++">Wrong main-frame target</button>
    <iframe id="frame" srcdoc="<button id='inside' onclick='parent.framesHit++'>Frame</button>"></iframe>
    <div id="host"></div><button id="popup" onclick="const p=window.open('about:blank');p.document.write('<button id=close onclick=window.close()>Close</button>')">Popup</button>
    <script>window.hits=0;window.wrong=0;window.framesHit=0;
    document.getElementById('host').attachShadow({mode:'open'}).innerHTML='<button id=shadow onclick=window.shadowHit=true>Shadow</button>';</script>`)} `;

    beforeAll(async () => {
      await run('docker', [
        'run',
        '-d',
        '--name',
        name,
        '--memory',
        '3g',
        '--memory-swap',
        '3g',
        '--cpus',
        '2',
        '--pids-limit',
        '1024',
        '--security-opt',
        'no-new-privileges',
        '--cap-drop',
        'ALL',
        '--tmpfs',
        '/dev/shm:size=512m',
        '--restart',
        'no',
        '-p',
        '127.0.0.1::7070',
        '-p',
        '127.0.0.1::9301',
        '-p',
        '127.0.0.1::9302',
        image,
      ]);
      bridge = `http://127.0.0.1:${await mappedPort(7070)}`;
      await vi.waitFor(
        async () => {
          expect((await fetch(`${bridge}/health`, { signal: AbortSignal.timeout(2000) })).ok).toBe(
            true,
          );
        },
        { timeout: 120000, interval: 300 },
      );
      const seat = await post('/seats', { botId });
      expect(seat.status).toBe(200);
      expect(seat.body.seat.browserReady).toBe(false);
      display = seat.body.seat.display;
      expect((await post('/seats', { botId: otherBot })).status).toBe(200);
    }, 150000);
    afterAll(async () => {
      await Promise.all(connections.map((browser) => browser.close().catch(() => undefined)));
      await run('docker', ['rm', '-f', name]).catch(() => undefined);
    }, 60000);

    it('ships the exact native library and leaves desktop-only replay browser-free', async () => {
      const { stdout } = await run('docker', [
        'exec',
        name,
        'node',
        '-p',
        'require("/opt/skill-runtime/node_modules/playwright-core/package.json").version',
      ]);
      expect(stdout.trim()).toBe('1.62.1');
      const result = await replay(
        'export default async ctx => ({ display:process.env.DISPLAY, png:(await ctx.screenshot()).subarray(0,8).toString("hex") });',
      );
      expect(result.body).toMatchObject({ ok: true, result: { display, png: '89504e470d0a1a0a' } });
      const seats = (await (await fetch(`${bridge}/seats`)).json()) as BridgeBody;
      expect(seats.seats.every((seat: Seat) => seat.browserReady === false)).toBe(true);
      inspector = await attach(botId);
      page = inspector.contexts()[0]!.pages()[0]!;
    }, 60000);

    it('executes native fill, shadow, frames and popup return on the demonstrated seat', async () => {
      await page.goto(fixture(), { waitUntil: 'domcontentloaded' });
      const other = await attach(otherBot);
      const otherPage = other.contexts()[0]!.pages()[0]!;
      await otherPage.goto(
        'data:text/html,<button id=save onclick="window.wrong=true">Other seat</button>',
      );
      const result = await replay(`export default async ctx => {
      await ctx.page.fill('#name','Ada');
      await ctx.page.click('#save');
      await ctx.page.click('text="Shadow"');
      await ctx.page.frameLocator('#frame').click('#inside');
      await ctx.page.click('#popup');
      await ctx.page.waitForSelector('#close', {visible:true});
      await ctx.page.click('#close');
      await ctx.page.waitForSelector('#name');
      return process.env.DISPLAY;
    };`);
      expect(result.body, JSON.stringify(result.body)).toMatchObject({ ok: true, result: display });
      expect(await page.locator('#name').inputValue()).toBe('Ada');
      expect(await page.evaluate('({hits,wrong,framesHit,shadowHit})')).toEqual({
        hits: 1,
        wrong: 0,
        framesHit: 1,
        shadowHit: true,
      });
      expect(await otherPage.evaluate('window.wrong')).toBeUndefined();
      expect(inspector.isConnected()).toBe(true);
      expect(inspector.contexts()[0]!.pages()).toHaveLength(1);
    }, 60000);

    it('refuses duplicate, disabled and frame-relative targets without misclicking', async () => {
      for (const selector of ['.duplicate', '#disabled', '#missing']) {
        const result = await replay(
          `export default async ctx => { await ctx.page.click(${JSON.stringify(selector)}, {timeout:300}); };`,
        );
        expect(result.body.ok).toBe(false);
        expect(result.body.code).toBe('SKILL_EXECUTION_FAILED');
      }
      expect(await page.evaluate('window.wrong')).toBe(0);
      const failed = await replay(
        'export default async ctx => { await ctx.page.fill("#missing","private-secret",{timeout:300}); };',
      );
      expect(failed.body.ok).toBe(false);
      expect(JSON.stringify(failed.body)).not.toContain('private-secret');
    }, 15000);

    it('refuses replay during human control, then succeeds after handback', async () => {
      const token = randomUUID();
      expect(
        (
          await post(`/seats/control?botId=${botId}`, {
            action: 'take',
            token,
            leaseMs: 30000,
            drainMs: 20000,
          })
        ).status,
      ).toBe(200);
      const blocked = await replay('export default async ctx => {await ctx.page.click("#save");}');
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe('HUMAN_IN_CONTROL');
      expect(await page.evaluate('window.hits')).toBe(1);
      expect(
        (await post(`/seats/control?botId=${botId}`, { action: 'release', token })).status,
      ).toBe(200);
      expect(
        (await replay('export default async ctx => {await ctx.page.click("#save");}')).body.ok,
      ).toBe(true);
      expect(await page.evaluate('window.hits')).toBe(2);
    }, 15000);

    it('cancels a real native wait, keeps Chrome alive and admits a later replay', async () => {
      const connected = await attach(botId);
      const runtime = createBrowserPage(() => Promise.resolve(connected));
      const pending = runtime.click('#never', { timeout: 60000 });
      const failed = expect(pending).rejects.toThrow();
      await expect.poll(() => connected.isConnected()).toBe(true);
      // Let the native request reach the browser, rather than only testing queued cancellation.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const started = Date.now();
      await runtime.close();
      await failed;
      expect(Date.now() - started).toBeLessThan(3000);
      expect(inspector.isConnected()).toBe(true);
      expect(
        (await replay('export default async ctx => {await ctx.page.click("#save");}')).body.ok,
      ).toBe(true);
      expect(await page.evaluate('window.hits')).toBe(3);
    }, 15000);

    it('stops a navigation whose response never commits before disconnecting', async () => {
      const server = `from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
import time
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  if self.path == '/slow':
   Path('/tmp/crewaid-br04-navigation-started').write_text('started')
   time.sleep(30)
  self.send_response(200)
  self.send_header('Content-Type','text/html')
  self.end_headers()
  self.wfile.write(b'<a id="slow-link" href="/slow">Navigate</a>')
ThreadingHTTPServer(('127.0.0.1',18080),Handler).serve_forever()`;
      await run('docker', ['exec', '-d', '-u', 'bot', name, 'python3', '-c', server]);
      await vi.waitFor(
        async () => {
          await run('docker', [
            'exec',
            name,
            'curl',
            '--fail',
            '--silent',
            'http://127.0.0.1:18080/start',
          ]);
        },
        { timeout: 5000, interval: 100 },
      );
      await page.goto('http://127.0.0.1:18080/start', { waitUntil: 'domcontentloaded' });
      const connected = await attach(botId);
      const runtime = createBrowserPage(() => Promise.resolve(connected));
      const pending = runtime.click('#slow-link', { timeout: 60000 });
      const failed = expect(pending).rejects.toThrow();
      await expect
        .poll(
          async () => {
            try {
              await run('docker', [
                'exec',
                name,
                'test',
                '-f',
                '/tmp/crewaid-br04-navigation-started',
              ]);
              return true;
            } catch {
              return false;
            }
          },
          { timeout: 5000 },
        )
        .toBe(true);
      const started = Date.now();
      await runtime.close();
      await failed;
      expect(Date.now() - started).toBeLessThan(3000);
      expect(inspector.isConnected()).toBe(true);
      expect(page.url()).toBe('http://127.0.0.1:18080/start');
      expect(await page.locator('#slow-link').isVisible()).toBe(true);
      expect(
        (
          await replay(
            'export default async ctx => {await ctx.page.waitForSelector("#slow-link");}',
          )
        ).body.ok,
      ).toBe(true);
    }, 15000);
  },
);
