import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { playwrightBrowserPage, type BrowserPage } from '../src/agent/browser-page.js';

// Owner: MOD-BR-03. The live suite runs whenever Chrome is installed (including CI).
const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find(existsSync);
function ref(snapshot: string, label: string, index = 0) {
  const line = snapshot.split('\n').filter((line) => line.includes(`"${label}"`))[index];
  const reference = line?.match(/\[ref=([^\]]+)\]/)?.[1];
  if (reference === undefined) throw new Error(`missing ${label} in ${snapshot}`);
  return reference;
}
const data = (html: string) => `data:text/html,${encodeURIComponent(html)}`;

describe.skipIf(CHROME === undefined)(
  'native Playwright observed references on existing Chrome',
  () => {
    let chrome: ChildProcess;
    let profile: string;
    let endpoint: string;
    let browser: Browser;
    let context: BrowserContext;
    let driver: BrowserPage;
    let server: Server;
    let origin: string;
    let chromeError: Error | undefined;
    let chromeStderr = '';
    const ownProcessGroup = process.platform !== 'win32';
    const state = { epoch: 1, mode: 'agent' as 'agent' | 'human' | 'draining' };
    beforeAll(async () => {
      profile = mkdtempSync(join(tmpdir(), 'crewaid-br03-'));
      chrome = spawn(
        CHROME!,
        [
          '--remote-debugging-port=0',
          `--user-data-dir=${profile}`,
          '--headless=new',
          '--no-first-run',
          '--no-default-browser-check',
          '--no-sandbox',
          '--disable-dev-shm-usage',
          'about:blank',
        ],
        { stdio: ['ignore', 'ignore', 'pipe'], detached: ownProcessGroup },
      );
      chrome.on('error', (error) => {
        chromeError = error;
      });
      chrome.stderr?.on('data', (chunk: Buffer) => {
        chromeStderr = (chromeStderr + chunk.toString()).slice(-4096);
      });
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        if (chromeError !== undefined || chrome.exitCode !== null || chrome.signalCode !== null)
          break;
        try {
          const [port, path] = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8')
            .trim()
            .split('\n');
          endpoint = `ws://127.0.0.1:${port}${path}`;
          browser = await chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: 2_000 });
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      if (browser === undefined)
        throw new Error(
          `Chrome did not start: ${chromeError?.message ?? chrome.exitCode ?? chrome.signalCode ?? 'startup deadline'}; ${chromeStderr}`,
        );
      context = browser.contexts()[0]!;
      driver = playwrightBrowserPage(browser, context, () => ({ ...state }), {
        seatId: 'local-chrome',
        browserGeneration: 1,
      });
      server = createServer((req, res) => {
        if (req.url === '/blackhole') return;
        res.setHeader('Content-Type', 'text/html');
        if (req.url === '/frames') return void res.end('<iframe src="/frame"></iframe>');
        if (req.url === '/frame')
          return void res.end(
            '<button onclick="this.textContent=\'Frame clicked\'">Frame</button>',
          );
        if (req.url === '/popup')
          return void res.end('<h1>Popup</h1><button onclick="window.close()">Close</button>');
        if (req.url === '/redirect') {
          res.writeHead(302, { location: '/cookie' });
          return void res.end();
        }
        if (req.url === '/cookie') {
          res.setHeader('Set-Cookie', 'session=logged-in; Path=/; HttpOnly');
          return void res.end('<h1>Signed in</h1>');
        }
        res.end('<h1>Recovered</h1>');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no HTTP port');
      origin = `http://127.0.0.1:${address.port}`;
    }, 30_000);
    afterAll(async () => {
      try {
        await browser?.close();
      } finally {
        const stopped = () =>
          chrome === undefined ||
          chrome.pid === undefined ||
          chrome.exitCode !== null ||
          chrome.signalCode !== null;
        const signal = (value: NodeJS.Signals) => {
          if (chrome?.pid === undefined) return;
          try {
            // The detached group contains only Chrome and helpers spawned by this fixture.
            if (ownProcessGroup) process.kill(-chrome.pid, value);
            else if (!stopped()) chrome.kill(value);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        };
        const waitForExit = async (ms: number) => {
          const deadline = Date.now() + ms;
          while (!stopped() && Date.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 50));
        };
        try {
          signal('SIGTERM');
          await waitForExit(5_000);
          // Also stop fixture helpers left in the group after their parent exited.
          signal('SIGKILL');
          await waitForExit(2_000);
          if (!stopped()) throw new Error('Fixture Chrome did not exit; its profile was retained.');
          if (profile !== undefined)
            rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } finally {
          server?.closeAllConnections();
          await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
        }
      }
    }, 15_000);

    it('uses distinct native refs for duplicate labels and produces actual input', async () => {
      await driver.navigate(
        data(
          '<button onclick="this.textContent=\'First clicked\'">Go</button><button onclick="this.textContent=\'Second clicked\'">Go</button>',
        ),
      );
      const snapshot = await driver.read();
      expect(ref(snapshot, 'Go', 0)).not.toBe(ref(snapshot, 'Go', 1));
      await driver.click(ref(snapshot, 'Go', 1));
      expect(await driver.read()).toContain('Second clicked');
      expect(await driver.read()).toContain('"Go"');
    });
    it('fills only the observed field and refuses a non-editable target without leaking text', async () => {
      await driver.navigate(
        data('<button>Other</button><input aria-label="Search"><input aria-label="Untouched">'),
      );
      const snapshot = await driver.read();
      await driver.type(ref(snapshot, 'Search'), 'crewaid');
      expect(await driver.read()).toContain('crewaid');
      const fresh = await driver.read();
      await expect(driver.type(ref(fresh, 'Other'), 'secret')).rejects.toThrow('Fill failed');
      expect(
        await context.pages()[0]!.getByRole('textbox', { name: 'Untouched' }).inputValue(),
      ).toBe('');
    });
    it('does not click disabled elements and honours cancellation during the wait', async () => {
      await driver.navigate(data('<button disabled>Disabled</button>'));
      const snapshot = await driver.read();
      await expect(
        driver.click(ref(snapshot, 'Disabled'), AbortSignal.timeout(100)),
      ).rejects.toThrow();
      expect(await driver.read()).toContain('[disabled]');
    });
    it('resolves native iframe refs without a hand-built frame selector', async () => {
      await driver.navigate(`${origin}/frames`);
      await context.pages()[0]!.frameLocator('iframe').getByRole('button').waitFor();
      const snapshot = await driver.read();
      await driver.click(ref(snapshot, 'Frame'));
      expect(await driver.read()).toContain('Frame clicked');
    });
    it('follows a popup, rejects the old page refs, and recovers after popup close', async () => {
      await driver.navigate(data(`<button onclick="window.open('${origin}/popup')">Open</button>`));
      const old = ref(await driver.read(), 'Open');
      const opened = context.waitForEvent('page');
      await driver.click(old);
      const popup = await opened;
      await popup.getByRole('heading', { name: 'Popup' }).waitFor();
      expect(await driver.read()).toContain('Popup');
      await expect(driver.click(old)).rejects.toThrow('STALE_REFERENCE');
      const closed = popup.waitForEvent('close');
      // Closing the target can interrupt Chrome's action acknowledgment. A
      // refusal must remain conservative; the close event is separate proof
      // of the effect, and the driver must recover without repeating the click.
      const outcome = await driver
        .click(ref(await driver.read(), 'Close'))
        .catch((error: unknown) => error);
      await closed;
      if (outcome !== undefined) {
        expect(outcome).toBeInstanceOf(Error);
        expect((outcome as Error).message).toContain('ACTION_UNCERTAIN');
      }
      expect(await driver.read()).toContain('Open');
    }, 15_000);
    it('fences handback, external navigation and references from an old connection', async () => {
      await driver.navigate(data('<button>Go</button>'));
      const old = ref(await driver.read(), 'Go');
      state.epoch += 1;
      await expect(driver.click(old)).rejects.toThrow('STALE_REFERENCE');
      const fresh = ref(await driver.read(), 'Go');
      await context.pages()[0]!.goto(data('<button>Different</button>'));
      await expect(driver.click(fresh)).rejects.toThrow('STALE_REFERENCE');
      const other = playwrightBrowserPage(browser, context, () => ({ ...state }), {
        seatId: 'local-chrome',
        browserGeneration: 1,
      });
      const otherRef = ref(await other.read(), 'Different');
      await driver.read();
      await expect(driver.click(otherRef)).rejects.toThrow('STALE_REFERENCE');
    });
    it('an element replaced in the same document cannot redirect its observed reference', async () => {
      await driver.navigate(data('<button>Original</button>'));
      const old = ref(await driver.read(), 'Original');
      await context
        .pages()[0]!
        .getByRole('button')
        .evaluate((button) => {
          const replacement = document.createElement('button');
          replacement.textContent = 'Replacement';
          replacement.onclick = () => {
            replacement.textContent = 'WRONG CLICK';
          };
          button.replaceWith(replacement);
        });
      await expect(driver.click(old, AbortSignal.timeout(100))).rejects.toThrow('STALE_REFERENCE');
      expect(await driver.read()).toContain('Replacement');
      expect(await driver.read()).not.toContain('WRONG CLICK');
    });
    it('reports redirects and preserves logged-in profile across client disconnect', async () => {
      const landed = await driver.navigate(`${origin}/redirect`);
      expect(landed.url).toBe(`${origin}/cookie`);
      expect(
        (await context.cookies(origin)).find((cookie) => cookie.name === 'session')?.value,
      ).toBe('logged-in');
      await driver.stopLoading();
      await browser.close();
      expect(chrome.exitCode).toBeNull();
      browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
      context = browser.contexts()[0]!;
      driver = playwrightBrowserPage(browser, context, () => ({ ...state }), {
        seatId: 'local-chrome',
        browserGeneration: 1,
      });
      expect(
        (await context.cookies(origin)).find((cookie) => cookie.name === 'session')?.value,
      ).toBe('logged-in');
      expect(await driver.read()).toContain('Signed in');
    });
    it('cancels never-committing navigation and the same browser recovers', async () => {
      await expect(
        driver.navigate(`${origin}/blackhole`, AbortSignal.timeout(200)),
      ).rejects.toThrow();
      await driver.navigate(origin);
      expect(await driver.read()).toContain('Recovered');
    });
  },
);
