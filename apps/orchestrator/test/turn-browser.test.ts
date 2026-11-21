import { describe, expect, it } from 'vitest';
import type { SandboxStatusResponse } from '@crewaid/shared';

import { createTurnBrowser } from '../src/agent/turn-browser.js';
import {
  BrowserInvalidatedError,
  type BrowserPage,
  type OpenedBrowser,
} from '../src/agent/browser-page.js';
import type { CdpConnection } from '../src/recordings/cdp-connection.js';
import type { TurnComputer } from '../src/agent/turn-computer.js';

/**
 * M5-BE-04 / M5-BE-27 — the turn's browser, and the switch that invalidates it.
 *
 * M5-BE-04's laziness (a turn that touches no browser tool opens no socket) is
 * pinned end-to-end by `browser-tools.test.ts` and the Chrome-gated suite. What
 * is here is the one thing those cannot state: this handle under a RACE.
 *
 * A step runs its tool calls at once — the AI SDK's streaming tool loop hands
 * one step's calls to `Promise.all`, measured against ai@7.0.89 — so
 * `use_identity` can be resetting this handle in the same moment a `browser_*`
 * tool is opening it. Which profile a page is on is the whole subject of
 * M5-BE-27, and an open that outlives the switch would answer with the profile
 * the bot has just left, silently, because a page carries a target id and
 * nothing about it says which profile it came from.
 */

const RUNNING = { state: 'RUNNING' } as unknown as SandboxStatusResponse;

type Opened = OpenedBrowser;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function fakeComputer(): TurnComputer {
  return {
    ensure: async () => RUNNING,
    wasRequested: () => true,
    dispose: async () => undefined,
  };
}

/** A connection that records being closed, the way the real one does. */
function fakeConnection() {
  const state = { closed: false };
  const connection = {
    get closed() {
      return state.closed;
    },
    close: async () => {
      state.closed = true;
    },
  } as unknown as CdpConnection;
  return { connection, state };
}

/** Let every microtask queued so far run, so an open reaches its `connect`. */
const settled = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

/**
 * A page that records the one call a turn's exit path makes on it.
 *
 * `stopLoading` is the only member the turn itself uses — the four tools go
 * through the page they were handed — and the ORDER matters: it has to be
 * sent while the socket is still open, because a page left on a navigation
 * that never commits is otherwise unrecoverable (M5-QA-06).
 */
function fakePage(
  sessionId: string,
  connection: { closed: boolean },
): BrowserPage & { stops: number; stoppedWhileOpen: boolean[] } {
  const page = {
    sessionId,
    stops: 0,
    stoppedWhileOpen: [] as boolean[],
    stopLoading: async (): Promise<void> => {
      page.stops += 1;
      // The socket's state AT THE MOMENT of the stop. A `stopLoading` sent
      // after the close is a command nobody receives, and the bug it exists
      // to prevent would be back with the test still green.
      page.stoppedWhileOpen.push(!connection.closed);
    },
  };
  return page as unknown as BrowserPage & { stops: number; stoppedWhileOpen: boolean[] };
}

function browserWith(connections: ReturnType<typeof fakeConnection>[]) {
  let opened = 0;
  const pages: BrowserPage[] = [];
  const handle = createTurnBrowser({
    computer: fakeComputer(),
    connect: async () => {
      const next = connections[opened] ?? fakeConnection();
      opened += 1;
      const page = fakePage(`session-${opened}`, next.state);
      pages.push(page);
      return { page, close: () => next.connection.close() };
    },
  });
  return { handle, pages, connects: () => opened };
}

describe('M5-BE-04 the page is opened once for the turn', () => {
  it('drops an invalidated login connection without retrying an action, then reconnects on read', async () => {
    const first = fakeConnection();
    const second = fakeConnection();
    let opens = 0;
    let clicks = 0;
    const handle = createTurnBrowser({
      computer: fakeComputer(),
      connect: async () => {
        opens += 1;
        const next = opens === 1 ? first : second;
        const page = fakePage(`session-${opens}`, next.state);
        page.click = async () => {
          clicks += 1;
          throw new BrowserInvalidatedError('login changed');
        };
        page.read = async () => 'current login';
        return { page, close: () => next.connection.close() };
      },
    });
    const old = await handle.page();
    await expect(old.click('old-reference')).rejects.toThrow('login changed');
    expect(clicks).toBe(1);
    expect(opens).toBe(1);
    expect(first.state.closed).toBe(true);
    const fresh = await handle.page();
    expect(await fresh.read()).toBe('current login');
    expect(opens).toBe(2);
    // An old pending operation must never disconnect the replacement.
    await expect(old.click('old-reference')).rejects.toThrow('login changed');
    expect(second.state.closed).toBe(false);
    expect(await handle.page()).toBe(fresh);
    await handle.dispose();
  });
  it('memoizes one connection across calls', async () => {
    const connections = [fakeConnection()];
    const { handle, connects } = browserWith(connections);

    const first = await handle.page();
    const second = await handle.page();

    expect(second).toBe(first);
    expect(connects()).toBe(1);
  });

  it('closes the connection on dispose, and stays disposed', async () => {
    const connections = [fakeConnection()];
    const { handle, pages } = browserWith(connections);
    await handle.page();

    await handle.dispose();
    // M5-BE-27's reset is not a way back from a finished turn: the turn is
    // over, and a page here would be a socket nothing closes.
    await handle.reset();

    expect(connections[0]?.state.closed).toBe(true);
    // Stopped exactly once, and by dispose rather than by the reset after it:
    // a finished turn has no page to stop a second time.
    const stopped = pages[0] as unknown as { stops: number; stoppedWhileOpen: boolean[] };
    expect(stopped.stops).toBe(1);
    expect(stopped.stoppedWhileOpen).toEqual([true]);
    await expect(handle.page()).rejects.toThrow(/already finished/);
  });
});

describe('M5-BE-27 a switch during an open', () => {
  it('refuses a page whose opening outlived it, rather than memoizing the old profile', async () => {
    const interrupted = deferred<Opened>();
    const first = fakeConnection();
    const second = fakeConnection();
    let opened = 0;
    const pages: BrowserPage[] = [];
    const handle = createTurnBrowser({
      computer: fakeComputer(),
      connect: () => {
        opened += 1;
        return opened === 1
          ? interrupted.promise
          : Promise.resolve({
              page: fakePage('session-2', second.state),
              close: () => second.connection.close(),
            });
      },
    });

    // A browser tool opening a page, and the switch landing while it is still
    // connecting — one step's tool calls, at once.
    const opening = handle.page();
    await settled();
    expect(opened).toBe(1);
    await handle.reset();
    interrupted.resolve({
      page: fakePage('session-1', first.state),
      close: () => first.connection.close(),
    });

    // The connection is closed rather than handed to the model: it is attached
    // to the target the seat release just closed, and a page on it would look
    // like it worked.
    await expect(opening).rejects.toThrow(/switched to a different browser identity/);
    expect(first.state.closed).toBe(true);
    expect(pages).toHaveLength(0);

    // The next call is a real open on the profile the bot now has, rather than
    // the refused one being reused.
    const page = await handle.page();
    expect(page).toBeDefined();
    expect(opened).toBe(2);
    expect(second.state.closed).toBe(false);
  });

  it('drops the page the turn already had, so the next call opens a new one', async () => {
    const connections = [fakeConnection(), fakeConnection()];
    const { handle, pages, connects } = browserWith(connections);

    const before = await handle.page();
    await handle.reset();
    const after = await handle.page();

    expect(after).not.toBe(before);
    expect(pages).toHaveLength(2);
    expect(connects()).toBe(2);
    expect(connections[0]?.state.closed).toBe(true);
  });
});
