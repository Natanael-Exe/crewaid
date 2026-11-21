import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { SANDBOX_PROVIDER, type SandboxProvider } from '../sandbox/sandbox.provider.js';
import { chromium, type Browser } from 'playwright-core';
import {
  BrowserInvalidatedError,
  playwrightBrowserPage,
  type OpenedBrowser,
} from './browser-page.js';
import { SeatControlService } from '../screen/seat-control.service.js';
import { computerOfBot } from '../sandbox/attached-computer.js';
import { SeatService, type Seat } from '../sandbox/seat.service.js';

/** The driver opens a client connection, never a browser or profile. */
export const PLAYWRIGHT_CONNECT = Symbol('PLAYWRIGHT_CONNECT');
export type PlaywrightConnect = (
  url: string,
  options: { headers: Record<string, string>; timeout: number; noDefaults: true },
) => Promise<Browser>;
export const connectPlaywright: PlaywrightConnect = (url, options) =>
  chromium.connectOverCDP(url, options);

@Injectable()
export class AgentBrowserService {
  private static readonly TIMEOUT_MS = 10_000;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SANDBOX_PROVIDER) private readonly provider: SandboxProvider,
    @Inject(SeatService) private readonly seats: SeatService,
    @Inject(SeatControlService) private readonly control: SeatControlService,
    @Inject(PLAYWRIGHT_CONNECT) private readonly open: PlaywrightConnect,
  ) {}

  /**
   * Open a connection to this bot's browser.
   *
   * Rejects rather than resolving null: unlike a recording, where a missing
   * browser is a degradation, a `browser_*` tool has nothing to offer without
   * one — and the tool turns the rejection into a result the model can read.
   * The bot id comes from the turn's own row, never from a request.
   */
  /**
   * This bot's seat, creating one if it has none — WITHOUT opening CDP.
   *
   * The screen-level built-ins (machine capture, recording, pointer) need the
   * seat's display and geometry and nothing else, and `connect` costs a
   * browser start they must not pay for (D-061: a seat is a desktop; its
   * browser is a separate, deliberate spend). `ensureSeat` here is the same
   * lazy create the browser path uses, so a bot reaching for its screen and a
   * bot reaching for its page converge on the one seat either way.
   */
  async ensureSeatFor(botId: string): Promise<Seat> {
    const computer = await computerOfBot(this.prisma, botId, {
      id: true,
      sessionId: true,
      widthPx: true,
      heightPx: true,
    });
    if (computer === null) throw new Error(`bot ${botId} has no computer`);
    const sessionId = computer.sessionId ?? computer.id;
    const session = await this.provider.attachSession({ sessionId });
    if (session === null) throw new Error(`no container is attached to session ${sessionId}`);
    return this.seats.ensureSeat(sessionId, botId, {
      widthPx: computer.widthPx,
      heightPx: computer.heightPx,
    });
  }

  async connect(botId: string): Promise<OpenedBrowser> {
    const computer = await computerOfBot(this.prisma, botId, {
      id: true,
      sessionId: true,
      widthPx: true,
      heightPx: true,
    });
    if (computer === null) throw new Error(`bot ${botId} has no computer`);
    const sessionId = computer.sessionId ?? computer.id;
    const session = await this.provider.attachSession({ sessionId });
    if (session === null) throw new Error(`no container is attached to session ${sessionId}`);

    // The seat comes FIRST, because the seat is what says which browser
    // to dial — a seat is a browser of its own on its own `--user-data-dir`,
    // so the port is the bot's. The seat is ensured rather than looked up: a
    // bot reaching for a browser tool is a bot that needs a screen, and this
    // is the same lazy create the §4.3 subscribe does. The size comes from the
    // machine's row because that is the geometry every client of this bot has
    // cached, and R8 fixes it for the seat's lifetime.
    const allocated = await this.seats.ensureSeat(sessionId, botId, {
      widthPx: computer.widthPx,
      heightPx: computer.heightPx,
    });

    // Recheck on the machine: a browser may have exited since seat allocation.
    const ready = await this.seats.ensureBrowser(sessionId, botId);
    if (ready.botId !== botId || ready.seatId !== allocated.seatId) {
      throw new Error(
        'The bridge returned a different bot seat; no browser connection was opened.',
      );
    }
    const endpoint = await session.getPortEndpoint({ port: ready.cdpPort });
    const headers = { ...endpoint.headers };

    const response = await fetch(`${endpoint.url}/json/version`, {
      // Chrome restart replaces the relay at the same port. Discovery must
      // not reuse a socket to the previous relay from an earlier turn.
      headers: { ...headers, connection: 'close' },
      signal: AbortSignal.timeout(AgentBrowserService.TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`/json/version answered ${response.status}`);
    const reported = readDebuggerUrl(await response.json());
    if (reported === null) throw new Error('/json/version named no webSocketDebuggerUrl');
    const target = new URL(reported);
    if (target.protocol !== 'ws:' && target.protocol !== 'wss:') {
      throw new Error(`/json/version named ${target.protocol} where a WebSocket URL was expected`);
    }
    const relay = new URL(endpoint.url);
    target.host = relay.host;
    target.protocol = relay.protocol === 'https:' ? 'wss:' : 'ws:';

    const browser = await this.open(target.toString(), {
      headers,
      timeout: AgentBrowserService.TIMEOUT_MS,
      noDefaults: true,
    });
    try {
      const context = browser.contexts()[0];
      if (context === undefined || context.pages().length === 0) {
        throw new Error("this seat's existing browser has no page; open a tab and retry");
      }
      const page = playwrightBrowserPage(
        browser,
        context,
        () => this.control.agentStateFor(botId),
        ready,
      );
      const validate = async () => {
        try {
          await this.seats.assertCurrentBrowser(sessionId, botId, ready);
        } catch {
          throw new BrowserInvalidatedError(
            'STALE_REFERENCE: this browser or login could not be confirmed. Read again to reconnect before acting.',
          );
        }
      };
      return {
        page: {
          navigate: async (url, signal) => {
            await validate();
            return page.navigate(url, signal);
          },
          read: async (signal) => {
            await validate();
            return page.read(signal);
          },
          click: async (reference, signal) => {
            await validate();
            return page.click(reference, signal);
          },
          type: async (reference, text, signal) => {
            await validate();
            return page.type(reference, text, signal);
          },
          screenshot: async (signal) => {
            await validate();
            return page.screenshot(signal);
          },
          stopLoading: () => page.stopLoading(),
        },
        close: async () => {
          // For connectOverCDP, close disconnects this client, preserving Chrome.
          await browser.close();
        },
      };
    } catch (error) {
      await browser.close();
      throw error;
    }
  }
}

/**
 * Pull `webSocketDebuggerUrl` out of a `/json/version` body. The sandbox is
 * the untrusted side of this connection, so the body is a value to
 * inspect, not a shape to assume.
 */
function readDebuggerUrl(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>)['webSocketDebuggerUrl'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
