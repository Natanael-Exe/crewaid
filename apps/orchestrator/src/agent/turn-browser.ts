import { BrowserInvalidatedError, type BrowserPage, type OpenedBrowser } from './browser-page.js';
import type { TurnComputer } from './turn-computer.js';

/**
 * The turn's browser, opened on demand.
 *
 * Layered on M5-BE-14's `TurnComputer` and following the same rule one step
 * further out: a turn that only answers starts no desktop, and a turn that
 * uses no browser tool opens no CDP socket either. Registering the four tools
 * costs nothing; the first `browser_*` call is what wakes the computer and
 * then connects to Chrome inside it.
 *
 * The connection is the turn's, not the recording's. `CdpAttachService` keys
 * one attachment per bot against a `recordingId`, so borrowing it would make
 * a tool and a running recording fight over the same slot — and detaching one
 * would silently blind the other. CDP allows many clients on one browser, so
 * a turn opens its own and closes its own.
 */
export interface TurnBrowser {
  /** The page these tools act on, waking and connecting on first use. */
  page(): Promise<BrowserPage>;
  /** Close the connection. Idempotent; runs on every turn exit. */
  dispose(): Promise<void>;
  /**
   * Drop the connection so the NEXT tool call opens a fresh one.
   *
   * Not `dispose`: that ends the browser for the turn, and this is the middle
   * of one. A granted identity moves the bot to a different Chrome profile,
   * which means a different seat, a different window and a different CDP
   * target — the page memoized above is attached to a target the machine has
   * just closed, and every later `browser_*` call in this turn would act on
   * it. Forgetting it here is what makes "use this identity, then open the
   * page" one working sequence instead of two that disagree.
   *
   * A step runs its tool calls at ONCE, so a `browser_*` call can be opening
   * a page in the same moment this lands. An open that was already connecting
   * when the switch happened is attaching to the profile the turn has just
   * left, so it is closed and refused rather than memoized — see the guard in
   * `page()`.
   */
  reset(): Promise<void>;
}

export function createTurnBrowser(deps: {
  computer: TurnComputer;
  /** Opens a CDP connection to the bot's browser. Called at most once. */
  connect: () => Promise<OpenedBrowser>;
}): TurnBrowser {
  let inFlight: Promise<BrowserPage> | undefined;
  let connection: OpenedBrowser | undefined;
  /**
   * The page the connection above is attached to, kept for one reason: the
   * turn has to stop whatever it left loading before it lets go. See
   * `settle()`.
   */
  let page: BrowserPage | undefined;
  let disposed = false;
  /**
   * Bumped by `reset()`, read by an open that is already connecting.
   *
   * The switch invalidates an open the same way `disposed` does, and for the
   * same reason: a connection nobody can use is a socket to close, not to
   * memoize. A page carries a target id and nothing about it says which
   * profile it came from, so an open that outlived the switch would put every
   * later `browser_*` call in this turn back on the profile the bot left.
   */
  let generation = 0;

  return {
    async page(): Promise<BrowserPage> {
      if (disposed) throw new Error('The turn that owns this browser has already finished.');
      if (inFlight !== undefined) return inFlight;

      const attempt = (async (): Promise<BrowserPage> => {
        // Read before the first await, so the open can tell afterwards whether
        // the turn moved to another profile while it was connecting.
        const openedFor = generation;
        // The desktop first: there is no Chrome to connect to until the
        // computer is running, and `ensure` is what makes that true.
        await deps.computer.ensure();
        const opened = await deps.connect();
        if (disposed) {
          await opened.page.stopLoading();
          await opened.close();
          throw new Error('The turn that owns this browser was cancelled.');
        }
        if (openedFor !== generation) {
          // The cancellation above, one step earlier in the same story: the
          // target this page would act on is the one the release just closed.
          await opened.page.stopLoading();
          await opened.close();
          throw new Error(
            'The bot was switched to a different browser identity while this page was ' +
              'opening; call the browser tool again for one on the identity it now has.',
          );
        }
        connection = opened;
        const run = async <T>(operation: () => Promise<T>): Promise<T> => {
          try {
            return await operation();
          } catch (error) {
            if (error instanceof BrowserInvalidatedError && connection === opened) {
              // Never repeat an action. Drop only its stale connection, so a
              // later read can observe the currently selected browser.
              generation += 1;
              inFlight = undefined;
              await settle();
            }
            throw error;
          }
        };
        page = {
          navigate: (url, signal) => run(() => opened.page.navigate(url, signal)),
          read: (signal) => run(() => opened.page.read(signal)),
          click: (reference, signal) => run(() => opened.page.click(reference, signal)),
          type: (reference, text, signal) => run(() => opened.page.type(reference, text, signal)),
          screenshot: (signal) => run(() => opened.page.screenshot(signal)),
          stopLoading: () => opened.page.stopLoading(),
        };
        return page;
      })();

      inFlight = attempt;
      try {
        return await attempt;
      } catch (error) {
        // Not memoized as a failure, for the same reason the computer is not:
        // a full host or a browser still starting is a moment, not a verdict
        // on the rest of the turn.
        if (inFlight === attempt) inFlight = undefined;
        throw error;
      }
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await settle();
    },

    async reset(): Promise<void> {
      // A disposed browser stays disposed: the turn is over, and reopening
      // one here would be a socket nothing closes.
      if (disposed) return;
      // Before the connection is dropped, so an open already in flight reads
      // the new value once its connect resolves and knows it is stale.
      generation += 1;
      inFlight = undefined;
      await settle();
    },
  };

  /**
   * Let go of the page and the socket, in that order.
   *
   * The ORDER is the whole of it. Closing the connection does not stop what
   * the page is doing, and a page left on a navigation that never COMMITS
   * serves no renderer-scoped command afterwards — `Page.enable` and
   * `Accessibility.enable` both time out on a FRESH connection, and a later
   * navigate does not clear it, so the bot's browser is dead for the life of
   * the seat (M5-QA-06 measures this; M5-QA-04 found it). `Page.stopLoading`
   * is answered in that state and recovers the target, so it goes first,
   * while there is still a socket to send it on.
   *
   * On every exit path, not only cancellation: a navigate whose 15s settle
   * wait expired leaves exactly the same page, and that turn ended normally.
   */
  async function settle(): Promise<void> {
    const open = connection;
    const held = page;
    connection = undefined;
    page = undefined;
    if (held !== undefined) await held.stopLoading();
    if (open !== undefined) await open.close();
  }
}
