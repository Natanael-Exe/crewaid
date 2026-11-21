import { assert, describe, expect, it } from 'vitest';

import {
  createSkillContext,
  runSkill,
  MAX_LOG_ENTRIES,
  MAX_RESULT_BYTES,
  WAIT_POLL_MS,
  type SkillHost,
} from './executor.js';
import type { BrowserPage } from './browser.js';
import type { SkillModule } from './index.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad]);

interface RecordedCommand {
  readonly program: string;
  readonly args: readonly string[];
}

function fakeHost(screenshot: Buffer = PNG): {
  host: SkillHost;
  calls: RecordedCommand[];
  delays: number[];
  advance: (ms: number) => void;
} {
  const calls: RecordedCommand[] = [];
  const delays: number[] = [];
  let clock = 0;
  const host: SkillHost = {
    runCommand(program, args) {
      calls.push({ program, args });
      return Promise.resolve();
    },
    captureScreenshot() {
      return Promise.resolve(screenshot);
    },
    delay(ms) {
      delays.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    now: () => clock,
  };
  return {
    host,
    calls,
    delays,
    advance: (ms) => {
      clock += ms;
    },
  };
}

/** A loader that always hands back the given module — skill source is never evaluated here. */
function loaderReturning(
  module: SkillModule<unknown>,
): (source: string) => Promise<SkillModule<unknown>> {
  return () => Promise.resolve(module);
}

/** A module that fails at run time. */
function failingModule(error: Error): SkillModule<unknown> {
  return () => Promise.reject(error);
}

describe('createSkillContext', () => {
  it('drives click through a synced xdotool pointer move and button press', async () => {
    const { host, calls } = fakeHost();
    await createSkillContext(host, () => undefined).click(640, 400);
    expect(calls).toEqual([
      { program: 'xdotool', args: ['mousemove', '--sync', '640', '400', 'click', '1'] },
    ]);
  });

  it('drives doubleClick as two clicks, not two xdotool invocations', async () => {
    const { host, calls } = fakeHost();
    await createSkillContext(host, () => undefined).doubleClick(10, 20);
    expect(calls).toEqual([
      {
        program: 'xdotool',
        args: ['mousemove', '--sync', '10', '20', 'click', '--repeat', '2', '--delay', '100', '1'],
      },
    ]);
  });

  it('types text verbatim, with -- so a leading dash is text and not an option', async () => {
    const { host, calls } = fakeHost();
    await createSkillContext(host, () => undefined).type('--hello world');
    expect(calls).toEqual([
      {
        program: 'xdotool',
        args: ['type', '--clearmodifiers', '--delay', '12', '--', '--hello world'],
      },
    ]);
  });

  it('sends key combos verbatim — the trace vocabulary is xdotool-native', async () => {
    const { host, calls } = fakeHost();
    await createSkillContext(host, () => undefined).key('ctrl+c');
    expect(calls).toEqual([
      { program: 'xdotool', args: ['key', '--clearmodifiers', '--', 'ctrl+c'] },
    ]);
  });

  it('returns the host capture from screenshot', async () => {
    const { host } = fakeHost();
    await expect(createSkillContext(host, () => undefined).screenshot()).resolves.toEqual(PNG);
  });

  it('routes log through the sink', () => {
    const { host } = fakeHost();
    const messages: string[] = [];
    createSkillContext(host, (message) => messages.push(message)).log('starting');
    expect(messages).toEqual(['starting']);
  });

  describe('waitFor', () => {
    it('resolves without waiting when the predicate already holds', async () => {
      const { host, delays } = fakeHost();
      await createSkillContext(host, () => undefined).waitFor(() => Promise.resolve(true), 5_000);
      expect(delays).toEqual([]);
    });

    it('polls at the documented interval until the predicate holds', async () => {
      const { host, delays } = fakeHost();
      let attempts = 0;
      await createSkillContext(host, () => undefined).waitFor(() => {
        attempts += 1;
        return Promise.resolve(attempts === 3);
      }, 5_000);
      expect(attempts).toBe(3);
      expect(delays).toEqual([WAIT_POLL_MS, WAIT_POLL_MS]);
    });

    it('throws a named timeout instead of sleeping past the budget', async () => {
      const { host, delays } = fakeHost();
      const context = createSkillContext(host, () => undefined);
      await expect(context.waitFor(() => Promise.resolve(false), 1_000)).rejects.toThrow(
        'waitFor timed out after 1000ms',
      );
      expect(delays.length).toBeGreaterThan(0);
      expect(delays.every((ms) => ms <= WAIT_POLL_MS)).toBe(true);
    });

    it('evaluates the predicate once even at a zero timeout', async () => {
      const { host } = fakeHost();
      let attempts = 0;
      await expect(
        createSkillContext(host, () => undefined).waitFor(() => {
          attempts += 1;
          return Promise.resolve(false);
        }, 0),
      ).rejects.toThrow('waitFor timed out after 0ms');
      expect(attempts).toBe(1);
    });
  });
});

describe('runSkill', () => {
  it('returns the script result, its logs, and the elapsed time', async () => {
    const { host, advance } = fakeHost();
    const module: SkillModule<unknown> = (ctx, params) => {
      ctx.log('working');
      expect(params).toEqual({ n: 1 });
      advance(7);
      return Promise.resolve({ sum: 3 });
    };
    const outcome = await runSkill(
      'source',
      { n: 1 },
      { host, loadModule: loaderReturning(module) },
    );
    expect(outcome).toEqual({
      ok: true,
      result: { sum: 3 },
      logs: ['working'],
      durationMs: 7,
    });
  });

  it('reports a module that cannot be loaded as an execution failure', async () => {
    const { host } = fakeHost();
    const outcome = await runSkill(
      'not a module',
      { n: 1 },
      {
        host,
        loadModule: () => Promise.reject(new Error('SyntaxError: Unexpected token')),
      },
    );
    assert(outcome.ok === false);
    expect(outcome.code).toBe('SKILL_EXECUTION_FAILED');
    expect(outcome.detail).toContain('could not be loaded');
    expect(outcome.detail).toContain('Unexpected token');
  });

  it('reports a throwing script as ok:false with the error name and message', async () => {
    const { host } = fakeHost();
    const outcome = await runSkill(
      'source',
      {},
      {
        host,
        loadModule: loaderReturning(failingModule(new TypeError('click target missing'))),
      },
    );
    expect(outcome).toMatchObject({
      ok: false,
      code: 'SKILL_EXECUTION_FAILED',
      detail: 'TypeError: click target missing',
    });
  });

  it('turns an undefined return into a null result', async () => {
    const { host } = fakeHost();
    const module: SkillModule<unknown> = () => Promise.resolve(undefined);
    const outcome = await runSkill('source', {}, { host, loadModule: loaderReturning(module) });
    expect(outcome).toMatchObject({ ok: true, result: null });
  });

  it('rejects a result JSON cannot carry', async () => {
    const { host } = fakeHost();
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const module: SkillModule<unknown> = () => Promise.resolve(circular);
    const outcome = await runSkill('source', {}, { host, loadModule: loaderReturning(module) });
    assert(outcome.ok === false);
    expect(outcome.code).toBe('SKILL_EXECUTION_FAILED');
    expect(outcome.detail).toContain('not JSON-serializable');
  });

  it('refuses a result over the transport cap instead of truncating it', async () => {
    const { host } = fakeHost();
    const module: SkillModule<unknown> = () => Promise.resolve('x'.repeat(MAX_RESULT_BYTES + 100));
    const outcome = await runSkill('source', {}, { host, loadModule: loaderReturning(module) });
    assert(outcome.ok === false);
    expect(outcome.code).toBe('SKILL_RESULT_TOO_LARGE');
    expect(outcome.detail).toContain(`cap is ${MAX_RESULT_BYTES}`);
  });

  it('caps the log list so a chatty script cannot grow the response without bound', async () => {
    const { host } = fakeHost();
    const module: SkillModule<unknown> = (ctx) => {
      for (let index = 0; index < MAX_LOG_ENTRIES + 100; index += 1) ctx.log(`line ${index}`);
      return Promise.resolve(null);
    };
    const outcome = await runSkill('source', {}, { host, loadModule: loaderReturning(module) });
    expect(outcome.ok).toBe(true);
    expect(outcome.logs).toHaveLength(MAX_LOG_ENTRIES);
  });
});

/**
 * M4-BE-06 — the page rides the same seam as the host and the loader: the
 * executor only ever sees an injected `BrowserPage`, and a run that has none
 * fails in words instead of a TypeError.
 */
describe('runSkill — the injected page', () => {
  function fakePage(): { page: BrowserPage; clicks: string[] } {
    const clicks: string[] = [];
    return {
      clicks,
      page: {
        frameLocator: () => fakePage().page,
        click(selector) {
          clicks.push(selector);
          return Promise.resolve();
        },
        fill: () => Promise.resolve(),
        waitForSelector: () => Promise.resolve(),
        waitForLoadState: () => Promise.resolve(),
        close: () => Promise.resolve(),
      },
    };
  }

  it('hands the context the page, and a page call reaches it', async () => {
    const { host } = fakeHost();
    const { page, clicks } = fakePage();
    const module: SkillModule<unknown> = async (ctx) => {
      await ctx.page.click('#save');
      return 'clicked';
    };

    const outcome = await runSkill(
      'source',
      {},
      { host, loadModule: loaderReturning(module), page },
    );

    expect(outcome).toMatchObject({ ok: true, result: 'clicked' });
    expect(clicks).toEqual(['#save']);
  });

  it('fails the run with a readable reason when no page was configured', async () => {
    const { host } = fakeHost();
    const module: SkillModule<unknown> = (ctx) => ctx.page.click('#save');

    const outcome = await runSkill('source', {}, { host, loadModule: loaderReturning(module) });

    assert(outcome.ok === false);
    expect(outcome.code).toBe('SKILL_EXECUTION_FAILED');
    expect(outcome.detail).toContain('No authorized browser');
  });
});
