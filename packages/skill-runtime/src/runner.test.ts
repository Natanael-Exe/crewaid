import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

import type { SkillHost } from './executor.js';
import { createUnavailablePage, type BrowserPage } from './browser.js';
import type { SkillModule } from './index.js';
import { main, parseRequest, runOne, SkillRequestError } from './runner.js';

/** No desktop, no clock — the runner's filesystem behaviour is what these tests assert. */
const quietHost: SkillHost = {
  runCommand() {
    /* no commands are issued by the fixtures */
    return Promise.resolve();
  },
  captureScreenshot() {
    return Promise.resolve(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  },
  delay() {
    /* the fixtures never wait */
    return Promise.resolve();
  },
  now: () => 0,
};

function loaderReturning(
  module: SkillModule<unknown>,
): (source: string) => Promise<SkillModule<unknown>> {
  return () => Promise.resolve(module);
}

function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'crewaid-runner-test-'));
}

describe('parseRequest', () => {
  it('accepts the exact shape the bridge validates', () => {
    expect(
      parseRequest(JSON.stringify({ script: 'export default async () => 1', params: {} })),
    ).toEqual({ script: 'export default async () => 1', params: {} });
  });

  it('rejects anything else with a typed error', () => {
    const invalid = [
      'not json at all',
      JSON.stringify([]),
      JSON.stringify({ script: '', params: {} }),
      JSON.stringify({ script: '   ', params: {} }),
      JSON.stringify({ script: 1, params: {} }),
      JSON.stringify({ script: 'x', params: null }),
      JSON.stringify({ script: 'x', params: [] }),
      JSON.stringify({ script: 'x' }),
    ];
    for (const raw of invalid) {
      expect(() => parseRequest(raw)).toThrow(SkillRequestError);
    }
  });
});

describe('runOne', () => {
  it('writes the outcome JSON and exits 0 for a successful run', async () => {
    const directory = await tempDir();
    const outcomePath = join(directory, 'outcome.json');
    const module: SkillModule<unknown> = () => Promise.resolve({ ok: true });
    const code = await runOne(
      JSON.stringify({ script: 'export default async () => ({ ok: true })', params: {} }),
      outcomePath,
      { host: quietHost, loadModule: loaderReturning(module) },
    );
    expect(code).toBe(0);
    const outcome: unknown = JSON.parse(await readFile(outcomePath, 'utf8'));
    expect(outcome).toMatchObject({ ok: true, result: { ok: true }, logs: [] });
  });

  it('carries a script failure inside the outcome and still exits 0', async () => {
    const directory = await tempDir();
    const outcomePath = join(directory, 'outcome.json');
    const failing: SkillModule<unknown> = () => Promise.reject(new Error('nope'));
    const code = await runOne(
      JSON.stringify({
        script: 'export default async () => { throw new Error("nope"); }',
        params: {},
      }),
      outcomePath,
      { host: quietHost, loadModule: loaderReturning(failing) },
    );
    expect(code).toBe(0);
    const outcome: unknown = JSON.parse(await readFile(outcomePath, 'utf8'));
    expect(outcome).toMatchObject({ ok: false, code: 'SKILL_EXECUTION_FAILED' });
  });

  it('executes a TS-annotated module through the real loader', async () => {
    // The default loadModule — the real one — writes the source and imports
    // it. Vitest evaluates the import the same way Node 22 does in the image:
    // annotations stripped, module executed.
    const directory = await tempDir();
    const outcomePath = join(directory, 'outcome.json');
    const code = await runOne(
      JSON.stringify({
        script:
          'export default async (_ctx: unknown, params: { n: number }): Promise<{ doubled: number }> => ({ doubled: params.n * 2 });',
        params: { n: 21 },
      }),
      outcomePath,
      { host: quietHost },
    );
    expect(code).toBe(0);
    const outcome: unknown = JSON.parse(await readFile(outcomePath, 'utf8'));
    expect(outcome).toMatchObject({ ok: true, result: { doubled: 42 } });
  });

  it('reports a module that does not default-export a function', async () => {
    const directory = await tempDir();
    const outcomePath = join(directory, 'outcome.json');
    const code = await runOne(
      JSON.stringify({ script: 'export const notARun = 1;', params: {} }),
      outcomePath,
      { host: quietHost },
    );
    expect(code).toBe(0);
    const outcome: unknown = JSON.parse(await readFile(outcomePath, 'utf8'));
    expect(outcome).toMatchObject({ ok: false, code: 'SKILL_EXECUTION_FAILED' });
  });

  it('runs the skill against the injected page, and closes it when the run ends', async () => {
    const directory = await tempDir();
    const outcomePath = join(directory, 'outcome.json');
    const clicks: string[] = [];
    let closes = 0;
    const page: BrowserPage = {
      ...createUnavailablePage(),
      click(selector) {
        clicks.push(selector);
        return Promise.resolve();
      },
      fill: () => Promise.resolve(),
      waitForSelector: () => Promise.resolve(),
      waitForLoadState: () => Promise.resolve(),
      close: () => {
        closes += 1;
        return Promise.resolve();
      },
    };
    const module: SkillModule<unknown> = async (ctx) => {
      await ctx.page.click('#save');
      return 'done';
    };

    const code = await runOne(
      JSON.stringify({ script: 'export default async () => "done"', params: {} }),
      outcomePath,
      { host: quietHost, loadModule: loaderReturning(module), page },
    );

    expect(code).toBe(0);
    const outcome: unknown = JSON.parse(await readFile(outcomePath, 'utf8'));
    expect(outcome).toMatchObject({ ok: true, result: 'done' });
    expect(clicks).toEqual(['#save']);
    // The socket must not outlive the run (it would hold the process — and
    // the bridge call waiting on it — open), so the runner closes the page
    // even though nothing in the outcome says so.
    expect(closes).toBe(1);
  });

  it('closes the page even when the script throws', async () => {
    const directory = await tempDir();
    const outcomePath = join(directory, 'outcome.json');
    let closes = 0;
    const page: BrowserPage = {
      ...createUnavailablePage(),
      click: () => Promise.reject(new Error('closed by the page')),
      fill: () => Promise.reject(new Error('unused')),
      waitForSelector: () => Promise.reject(new Error('unused')),
      waitForLoadState: () => Promise.reject(new Error('unused')),
      close: () => {
        closes += 1;
        return Promise.resolve();
      },
    };
    const module: SkillModule<unknown> = async (ctx) => {
      await ctx.page.click('#save');
    };

    const code = await runOne(
      JSON.stringify({ script: 'export default async () => 1', params: {} }),
      outcomePath,
      { host: quietHost, loadModule: loaderReturning(module), page },
    );

    expect(code).toBe(0);
    const outcome: unknown = JSON.parse(await readFile(outcomePath, 'utf8'));
    expect(outcome).toMatchObject({ ok: false, code: 'SKILL_EXECUTION_FAILED' });
    expect(closes).toBe(1);
  });
});

describe('main', () => {
  it('refuses to run without an absolute outcome path', async () => {
    expect(await main([], '{}')).toBe(2);
    expect(await main(['relative.json'], '{}')).toBe(2);
  });

  it('returns a non-zero runner code when no outcome could be produced', async () => {
    expect(await main(['/tmp/crewaid-runner-test-ignored.json'], 'not json')).toBe(1);
  });
});

describe('on-demand seat browser for skill replay', () => {
  it('leaves desktop-only skills browser-free and starts before CDP discovery', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response('insufficient pids headroom', { status: 503 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const directory = await tempDir();
    const outcomePath = join(directory, 'outcome.json');
    const options = {
      host: quietHost,
      botId: 'bot-a',
      seatId: 'seat-a',
      cdpEndpoint: 'http://127.0.0.1:9301',
    };
    const raw = JSON.stringify({ script: 'unused', params: {} });
    await runOne(raw, outcomePath, {
      ...options,
      loadModule: loaderReturning(() => Promise.resolve('desktop only')),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await runOne(raw, outcomePath, {
      ...options,
      loadModule: loaderReturning(async (ctx) => {
        await ctx.page.click('#submit');
      }),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:7070/seats/browser',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ botId: 'bot-a' }),
      }),
    );
    const outcome = JSON.parse(await readFile(outcomePath, 'utf8'));
    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).toContain('insufficient pids headroom');
  });
});

describe('native replay seat binding', () => {
  const ready = {
    botId: 'bot-a',
    seatId: 'seat-a',
    cdpPort: 9301,
    browserReady: true,
    profile: 'bot-a',
    browserGeneration: 123,
  };
  const options = {
    host: quietHost,
    botId: 'bot-a',
    seatId: 'seat-a',
    cdpEndpoint: 'http://127.0.0.1:9301',
  };
  const raw = JSON.stringify({
    script: 'export default async ctx => { await ctx.page.click("#save"); return "done"; }',
    params: {},
  });

  it.each([
    { botId: 'another-bot' },
    { seatId: 'replaced-seat' },
    { cdpPort: 9302 },
    { browserReady: false },
    { browserGeneration: 0 },
    { browserGeneration: Number.MAX_SAFE_INTEGER + 1 },
    { profile: undefined },
  ])('refuses mismatched readiness before native attachment: %j', async (change) => {
    const connectBrowser = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ ok: true, seat: { ...ready, ...change } }));
    vi.stubGlobal('fetch', fetchMock);
    const directory = await tempDir();
    const outcomePath = join(directory, 'outcome.json');
    await runOne(raw, outcomePath, { ...options, connectBrowser });
    const outcome = JSON.parse(await readFile(outcomePath, 'utf8'));
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('authorized private seat');
    expect(connectBrowser).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('requires an explicit bridge seat and forbids remote or global endpoint fallback', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const directory = await tempDir();
    const outcomePath = join(directory, 'outcome.json');
    for (const configuration of [
      { host: quietHost },
      { ...options, cdpEndpoint: 'https://remote.invalid:9301' },
      { ...options, cdpEndpoint: 'http://127.0.0.1:9301?bot=other' },
    ]) {
      await runOne(raw, outcomePath, configuration);
      expect(JSON.parse(await readFile(outcomePath, 'utf8')).ok).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rewrites discovery to the authorized relay before invoking the native connector', async () => {
    const connectBrowser = vi.fn().mockRejectedValue(new Error('native attach fixture'));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ok: true, seat: ready }))
      .mockResolvedValueOnce(
        Response.json({
          webSocketDebuggerUrl: 'ws://reported-host:9399/devtools/browser/existing',
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const directory = await tempDir();
    const outcomePath = join(directory, 'outcome.json');
    await runOne(raw, outcomePath, { ...options, connectBrowser });
    expect(connectBrowser).toHaveBeenCalledWith('ws://127.0.0.1:9301/devtools/browser/existing');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(outcomePath, 'utf8')).detail).toContain(
      'native attach fixture',
    );
  });
});
