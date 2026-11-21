import type { Browser, BrowserContext, FrameLocator, Page } from 'playwright-core';

export const PAGE_DEFAULT_TIMEOUT_MS = 10_000;
export const PAGE_MAX_TIMEOUT_MS = 60_000;

export interface PageActionOptions {
  readonly timeout?: number;
}

export interface WaitForSelectorOptions extends PageActionOptions {
  readonly visible?: boolean;
}

export type LoadState = 'load' | 'domcontentloaded';

export interface BrowserScope {
  click(selector: string, options?: PageActionOptions): Promise<void>;
  fill(selector: string, text: string, options?: PageActionOptions): Promise<void>;
  waitForSelector(selector: string, options?: WaitForSelectorOptions): Promise<void>;
  frameLocator(selector: string): BrowserScope;
}

export interface BrowserPage extends BrowserScope {
  waitForLoadState(state?: LoadState, options?: PageActionOptions): Promise<void>;
  /** Disconnect this runner, preserving the seat's Chrome and profile. */
  close(): Promise<void>;
}

export type ConnectBrowser = (signal: AbortSignal) => Promise<Browser>;

function selectorOf(selector: string): string {
  if (typeof selector !== 'string' || selector.trim() === '')
    throw new Error('A browser selector must be a non-empty string.');
  return selector;
}

function timeoutOf(options: PageActionOptions): number {
  const timeout = options.timeout ?? PAGE_DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > PAGE_MAX_TIMEOUT_MS)
    throw new Error('Browser timeout must be positive and at most 60000 milliseconds.');
  return timeout;
}

/** A thin lifecycle adapter; Playwright owns resolution, strictness and waits. */
export function createBrowserPage(connect: ConnectBrowser): BrowserPage {
  const lifetime = new AbortController();
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let selected: Page | undefined;
  let connecting: Promise<Browser> | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  let closing: Promise<void> | undefined;

  const watch = (page: Page) => {
    page.on('popup', (popup) => {
      if (selected === page) selected = popup;
    });
  };
  const connected = async (): Promise<void> => {
    lifetime.signal.throwIfAborted();
    if (browser !== undefined) return;
    connecting ??= connect(lifetime.signal);
    const pending = connecting;
    try {
      const opened = await pending;
      if (lifetime.signal.aborted) {
        await opened.close().catch(() => undefined);
        lifetime.signal.throwIfAborted();
      }
      const existing = opened.contexts()[0];
      const page = existing?.pages().find((candidate) => !candidate.isClosed());
      if (existing === undefined || page === undefined) {
        await opened.close().catch(() => undefined);
        throw new Error('The authorized seat browser has no existing page.');
      }
      browser = opened;
      context = existing;
      selected = page;
      existing.pages().forEach(watch);
      existing.on('page', watch);
    } finally {
      if (connecting === pending) connecting = undefined;
    }
  };
  const current = (): Page => {
    lifetime.signal.throwIfAborted();
    if (!browser?.isConnected()) throw new Error('The seat browser disconnected.');
    if (selected?.isClosed() !== false)
      selected = context?.pages().find((candidate) => !candidate.isClosed());
    if (selected === undefined) throw new Error('The seat browser has no live page.');
    return selected;
  };
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const attempt = tail.then(async () => {
      await connected();
      lifetime.signal.throwIfAborted();
      return operation();
    });
    tail = attempt.catch(() => undefined);
    return attempt;
  };
  const actionOptions = (options: PageActionOptions) => ({
    timeout: timeoutOf(options),
    signal: lifetime.signal,
  });
  const scope = (frames: readonly string[]): BrowserScope => {
    const root = (): Page | FrameLocator => {
      let target: Page | FrameLocator = current();
      for (const selector of frames) target = target.frameLocator(selector);
      return target;
    };
    return {
      async click(selector, options = {}) {
        const target = selectorOf(selector);
        const nativeOptions = actionOptions(options);
        await serial(() => root().locator(target).click(nativeOptions));
      },
      async fill(selector, text, options = {}) {
        const target = selectorOf(selector);
        if (typeof text !== 'string') throw new Error('Browser fill needs string text.');
        const nativeOptions = actionOptions(options);
        try {
          await serial(() => root().locator(target).fill(text, nativeOptions));
        } catch {
          // Native diagnostics can include the supplied credential value.
          throw new Error('Browser fill failed: target unavailable, not editable, or cancelled.');
        }
      },
      async waitForSelector(selector, options = {}) {
        const target = selectorOf(selector);
        const nativeOptions = actionOptions(options);
        await serial(() =>
          root()
            .locator(target)
            .waitFor({
              ...nativeOptions,
              state: options.visible === true ? 'visible' : 'attached',
            }),
        );
      },
      frameLocator(selector) {
        return scope([...frames, selectorOf(selector)]);
      },
    };
  };
  const stopLoading = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          if (!context || !selected || selected.isClosed()) return;
          const session = await context.newCDPSession(selected);
          try {
            await session.send('Page.stopLoading');
          } finally {
            await session.detach().catch(() => undefined);
          }
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Stop loading timed out.')), 2_000);
          timer.unref();
        }),
      ]);
    } catch {
      // Cleanup still disconnects when Chrome or its relay disappeared.
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    ...scope([]),
    async waitForLoadState(state = 'load', options = {}) {
      if (state !== 'load' && state !== 'domcontentloaded')
        throw new Error('Unsupported browser load state.');
      const nativeOptions = actionOptions(options);
      await serial(() => current().waitForLoadState(state, nativeOptions));
    },
    close() {
      lifetime.abort(new Error('The skill browser session was closed.'));
      closing ??= (async () => {
        if (browser === undefined) return;
        await stopLoading();
        await browser.close();
      })();
      return closing;
    },
  };
}

export function createUnavailablePage(): BrowserPage {
  const unavailable = (): Promise<never> =>
    Promise.reject(new Error('No authorized browser is available for this skill.'));
  return {
    click: unavailable,
    fill: unavailable,
    waitForSelector: unavailable,
    frameLocator: createUnavailablePage,
    waitForLoadState: unavailable,
    close: () => Promise.resolve(),
  };
}
