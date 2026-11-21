import { EventEmitter } from 'node:events';
import type { Browser } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { createBrowserPage, createUnavailablePage } from './browser.js';

interface TestScope {
  frameLocator(selector: string): TestScope;
  locator(selector: string): {
    click(options: { signal: AbortSignal }): Promise<void>;
    fill(value: string, options: unknown): Promise<void>;
    waitFor(options: unknown): Promise<void>;
  };
}

type TestPage = EventEmitter &
  TestScope & {
    closed: boolean;
    isClosed(): boolean;
    waitForLoadState: ReturnType<typeof vi.fn>;
  };

function fixture() {
  const calls: { path: string; action: string; value?: string; options: unknown }[] = [];
  let failure: Error | undefined;
  let pause: ((options: { signal: AbortSignal }) => Promise<void>) | undefined;
  const scope = (path: string): TestScope => ({
    frameLocator: (selector: string) => scope(`${path}/frame(${selector})`),
    locator: (selector: string) => ({
      async click(options: { signal: AbortSignal }) {
        calls.push({ path: `${path}/${selector}`, action: 'click', options });
        if (failure) throw failure;
        await pause?.(options);
      },
      fill(value: string, options: unknown) {
        calls.push({ path: `${path}/${selector}`, action: 'fill', value, options });
        if (failure) return Promise.reject(failure);
        return Promise.resolve();
      },
      waitFor(options: unknown) {
        calls.push({ path: `${path}/${selector}`, action: 'wait', options });
        return Promise.resolve();
      },
    }),
  });
  const page = (name: string): TestPage => {
    const state = { closed: false };
    const target: TestPage = Object.assign(new EventEmitter(), scope(name), state, {
      isClosed: () => target.closed,
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
    });
    return target;
  };
  const first = page('first');
  const pages = [first];
  const session = {
    send: vi.fn().mockResolvedValue(undefined),
    detach: vi.fn().mockResolvedValue(undefined),
  };
  const context = Object.assign(new EventEmitter(), {
    pages: () => pages,
    newCDPSession: vi.fn().mockResolvedValue(session),
  });
  const close = vi.fn().mockResolvedValue(undefined);
  const browser = {
    contexts: () => [context],
    isConnected: () => true,
    close,
  } as unknown as Browser;
  return {
    browser,
    close,
    first,
    page,
    pages,
    context,
    session,
    calls,
    fail: (error: Error) => {
      failure = error;
    },
    pause: (fn: typeof pause) => {
      pause = fn;
    },
  };
}

describe('native skill browser lifecycle', () => {
  it('connects lazily once and delegates strict locators with bounded options', async () => {
    const f = fixture();
    const connect = vi.fn().mockResolvedValue(f.browser);
    const page = createBrowserPage(connect);
    expect(connect).not.toHaveBeenCalled();
    await page.click('#save');
    await page.fill('#name', 'value', { timeout: 1234 });
    await page.waitForSelector('#exists');
    await page.waitForSelector('#visible', { visible: true });
    await page.waitForLoadState('domcontentloaded', { timeout: 4321 });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(f.calls.map(({ action, path }) => [action, path])).toEqual([
      ['click', 'first/#save'],
      ['fill', 'first/#name'],
      ['wait', 'first/#exists'],
      ['wait', 'first/#visible'],
    ]);
    expect(f.calls[0]?.options).toEqual({ timeout: 10000, signal: expect.any(AbortSignal) });
    expect(f.calls[1]?.options).toMatchObject({ timeout: 1234 });
    expect(f.calls[2]?.options).toMatchObject({ state: 'attached' });
    expect(f.calls[3]?.options).toMatchObject({ state: 'visible' });
    expect(f.first.waitForLoadState).toHaveBeenCalledWith(
      'domcontentloaded',
      expect.objectContaining({ timeout: 4321 }),
    );
    await page.close();
    await page.close();
    expect(f.session.send).toHaveBeenCalledWith('Page.stopLoading');
    expect(f.session.detach).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it('uses explicit nested frame paths without a main-frame fallback', async () => {
    const f = fixture();
    const page = createBrowserPage(() => Promise.resolve(f.browser));
    const frame = page.frameLocator('#outer').frameLocator('#inner');
    await frame.click('#go');
    await frame.fill('#input', 'safe');
    expect(f.calls.map(({ path }) => path)).toEqual([
      'first/frame(#outer)/frame(#inner)/#go',
      'first/frame(#outer)/frame(#inner)/#input',
    ]);
    await page.close();
  });

  it('selects a popup from the current page and recovers when it closes', async () => {
    const f = fixture();
    const page = createBrowserPage(() => Promise.resolve(f.browser));
    await page.click('#open');
    const popup = f.page('popup');
    f.pages.push(popup);
    f.context.emit('page', popup);
    f.first.emit('popup', popup);
    await page.click('#inside');
    popup.closed = true;
    popup.emit('close');
    await page.click('#again');
    expect(f.calls.map(({ path }) => path)).toEqual([
      'first/#open',
      'popup/#inside',
      'first/#again',
    ]);
    await page.close();
  });

  it('never chooses a first match after strict failure and redacts fill diagnostics', async () => {
    const f = fixture();
    const page = createBrowserPage(() => Promise.resolve(f.browser));
    f.fail(new Error('strict mode violation'));
    await expect(page.click('button')).rejects.toThrow('strict mode');
    expect(f.calls).toHaveLength(1);
    f.fail(new Error('native call log: fill super-secret'));
    await expect(page.fill('#password', 'super-secret')).rejects.toThrow('Browser fill failed');
    await page.close();
  });

  it('rejects unbounded timeouts and empty selectors before connecting', async () => {
    const connect = vi.fn();
    const page = createBrowserPage(connect);
    for (const timeout of [0, -1, Infinity, NaN, 60001])
      await expect(page.click('#ok', { timeout })).rejects.toThrow('timeout');
    await expect(page.click(' ')).rejects.toThrow('selector');
    expect(() => page.frameLocator('')).toThrow('selector');
    expect(connect).not.toHaveBeenCalled();
    await page.close();
  });

  it('retries a failed connect without creating a page or context', async () => {
    const f = fixture();
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new Error('relay down'))
      .mockResolvedValue(f.browser);
    const page = createBrowserPage(connect);
    await expect(page.click('#save')).rejects.toThrow('relay down');
    await page.click('#save');
    expect(connect).toHaveBeenCalledTimes(2);
    await page.close();
  });

  it('disconnects an empty existing browser rather than launching a page', async () => {
    const f = fixture();
    f.pages.length = 0;
    const page = createBrowserPage(() => Promise.resolve(f.browser));
    await expect(page.click('#save')).rejects.toThrow('no existing page');
    expect(f.close).toHaveBeenCalledTimes(1);
    await page.close();
  });

  it('closes a late connection instead of reviving an ended run', async () => {
    const f = fixture();
    let resolve!: (browser: Browser) => void;
    const connect = vi.fn(
      () =>
        new Promise<Browser>((done) => {
          resolve = done;
        }),
    );
    const page = createBrowserPage(connect);
    const action = page.click('#save');
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    await page.close();
    resolve(f.browser);
    await expect(action).rejects.toThrow('closed');
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.calls).toHaveLength(0);
  });

  it('aborts running actions and refuses queued actions after close', async () => {
    const f = fixture();
    f.pause(
      ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error(String(signal.reason))), {
            once: true,
          });
        }),
    );
    const page = createBrowserPage(() => Promise.resolve(f.browser));
    const first = page.click('#slow');
    const second = page.click('#queued');
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    await page.close();
    await expect(first).rejects.toThrow('closed');
    await expect(second).rejects.toThrow('closed');
    expect(f.calls).toHaveLength(1);
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it('does not connect for close alone and unavailable frame scopes fail clearly', async () => {
    const connect = vi.fn();
    await createBrowserPage(connect).close();
    expect(connect).not.toHaveBeenCalled();
    await expect(createUnavailablePage().frameLocator('#frame').click('#go')).rejects.toThrow(
      'authorized browser',
    );
  });
});
