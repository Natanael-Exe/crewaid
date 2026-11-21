import { createHash, randomUUID } from 'node:crypto';
import type { Browser, BrowserContext, Page } from 'playwright-core';

export interface BrowserPage {
  navigate(url: string, signal?: AbortSignal): Promise<{ readonly url: string }>;
  read(signal?: AbortSignal): Promise<string>;
  click(reference: string, signal?: AbortSignal): Promise<void>;
  type(reference: string, text: string, signal?: AbortSignal): Promise<void>;
  screenshot(signal?: AbortSignal): Promise<Buffer>;
  /** Best effort recovery of a navigation that never committed. */
  stopLoading(): Promise<void>;
}

export interface OpenedBrowser {
  readonly page: BrowserPage;
  /** Disconnect the client; leave the existing browser and profile alive. */
  close(): Promise<void>;
}

/** The connection lost its seat/profile authority; the next observation must reconnect. */
export class BrowserInvalidatedError extends Error {}

type Scope = { epoch: number; mode: 'agent' | 'draining' | 'human' };
const WAIT_MS = 10_000;
const NAVIGATION_MS = 15_000;
const STALE = 'STALE_REFERENCE: read the page again and use a reference from that snapshot.';

/**
 * Rewrite only native reference annotations, never text that a page put inside
 * a quoted label or after a text/value delimiter. Page labels are untrusted.
 * Playwright continues to own the snapshot and reference selector grammar.
 */
export function namespaceSnapshot(
  snapshot: string,
  namespace: string,
): { text: string; references: Map<string, string> } {
  const references = new Map<string, string>();
  let bytes = 0;
  const allLines = snapshot.split('\n');
  const lines: string[] = [];
  for (const line of allLines.slice(0, 500)) {
    if (bytes + Buffer.byteLength(line) > 60_000) break;
    bytes += Buffer.byteLength(line);
    if (!/^\s*-\s+[a-z][a-z0-9-]*(?:\s|$)/.test(line)) {
      lines.push(line);
      continue;
    }
    let quoted = false;
    let escaped = false;
    let result = '';
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i] ?? '';
      if (escaped) escaped = false;
      else if (char === '\\' && quoted) escaped = true;
      else if (char === '"') quoted = !quoted;
      else if (!quoted && char === ':') {
        result += line.slice(i);
        break;
      } else if (!quoted && char === '[') {
        const match = /^\[ref=((?:f\d+)*e\d+)\]/.exec(line.slice(i));
        const native = match?.[1];
        if (match !== null && native !== undefined) {
          const reference = `${namespace}_${native}`;
          references.set(reference, native);
          result += `[ref=${reference}]`;
          i += match[0].length - 1;
          continue;
        }
      }
      result += char;
    }
    lines.push(result);
  }
  if (lines.length < allLines.length) lines.push('… snapshot truncated');
  return { text: lines.join('\n'), references };
}

/** Native Playwright actions on one existing seat, scoped to one turn connection. */
export function playwrightBrowserPage(
  browser: Browser,
  context: BrowserContext,
  scope: () => Scope,
  binding: { seatId: string; browserGeneration: number },
): BrowserPage {
  const seatKey = createHash('sha256').update(binding.seatId).digest('hex').slice(0, 12);
  let selected = context.pages()[0];
  if (selected === undefined) throw new Error('The existing browser has no page.');
  let revision = 0;
  let observedEpoch: number | undefined;
  let references = new Map<string, string>();
  let tail: Promise<unknown> = Promise.resolve();
  const invalidate = () => {
    revision += 1;
    references.clear();
    observedEpoch = undefined;
  };
  const watch = (page: Page) => {
    page.on('framenavigated', invalidate);
    page.on('close', invalidate);
    page.on('popup', (popup) => {
      if (selected === page) {
        selected = popup;
        invalidate();
      }
    });
  };
  context.pages().forEach(watch);
  context.on('page', watch);
  browser.on('disconnected', invalidate);

  const current = (): Page => {
    if (!browser.isConnected())
      throw new Error('The seat browser disconnected; retry in a new turn.');
    if (selected?.isClosed() !== false) {
      selected = context.pages().find((page) => !page.isClosed());
      invalidate();
    }
    if (selected === undefined) throw new Error('The seat browser has no live page.');
    return selected;
  };
  const serial = <T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> => {
    const attempt = tail.then(() => {
      signal?.throwIfAborted();
      return operation();
    });
    tail = attempt.catch(() => undefined);
    return attempt;
  };
  const locator = (reference: string) => {
    const page = current();
    const state = scope();
    const native = references.get(reference);
    if (state.mode !== 'agent' || state.epoch !== observedEpoch || native === undefined) {
      invalidate();
      throw new Error(STALE);
    }
    return page.locator(`aria-ref=${native}`);
  };
  const options = (signal?: AbortSignal) => ({
    timeout: WAIT_MS,
    ...(signal === undefined ? {} : { signal }),
  });
  const stopLoading = async (): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = async () => {
      const session = await context.newCDPSession(current());
      try {
        await session.send('Page.stopLoading');
      } finally {
        await session.detach().catch(() => undefined);
      }
    };
    try {
      // Bound attachment and detach too: the bridge is an untrusted peer.
      await Promise.race([
        stop(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Stop loading timed out')), 2_000);
          timer.unref();
        }),
      ]);
    } catch {
      // Disposal must still disconnect a browser which already disappeared.
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    navigate: (url, signal) =>
      serial(signal, async () => {
        const page = current();
        invalidate();
        try {
          await page.goto(url, {
            ...options(signal),
            timeout: NAVIGATION_MS,
            waitUntil: 'domcontentloaded',
          });
          return { url: page.url() };
        } catch (error) {
          await stopLoading();
          throw error;
        }
      }),
    read: (signal) =>
      serial(signal, async () => {
        const page = current();
        invalidate();
        const started = scope();
        const version = revision;
        const snapshot = await page.ariaSnapshot({ ...options(signal), mode: 'ai' });
        const result = namespaceSnapshot(
          snapshot,
          `s${seatKey}_b${binding.browserGeneration}_r${randomUUID().replaceAll('-', '')}`,
        );
        const ended = scope();
        if (
          version === revision &&
          selected === page &&
          browser.isConnected() &&
          started.mode === 'agent' &&
          ended.mode === 'agent' &&
          started.epoch === ended.epoch
        ) {
          references = result.references;
          observedEpoch = started.epoch;
        }
        return `Page: ${page.url()}\n${result.text}`;
      }),
    click: (reference, signal) =>
      serial(signal, async () => {
        const actingPage = current();
        const target = locator(reference);
        try {
          await target.click(options(signal));
        } catch {
          if (actingPage.isClosed()) {
            throw new Error(
              'ACTION_UNCERTAIN: the page closed during the click. Read the remaining page before acting again.',
            );
          }
          throw new Error('STALE_REFERENCE: element is missing, disabled or blocked; read again.');
        }
      }),
    type: (reference, text, signal) =>
      serial(signal, async () => {
        const target = locator(reference);
        try {
          await target.fill(text, options(signal));
        } catch {
          // Native fill errors can quote the value. Never persist a credential
          // through a diagnostic, including the failure path.
          throw new Error(
            'Fill failed: reference is stale or the field is not editable/available; read again.',
          );
        }
      }),
    screenshot: (signal) =>
      serial(signal, () => current().screenshot({ ...options(signal), type: 'png' })),
    stopLoading,
  };
}
