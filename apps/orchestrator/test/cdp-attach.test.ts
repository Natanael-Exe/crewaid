import { createServer } from 'node:http';
import type { IncomingMessage, IncomingHttpHeaders, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { SANDBOX_PORTS } from '@crewaid/sandbox-core';

import { SeatService } from '../src/sandbox/seat.service.js';
import { CdpAttachService } from '../src/recordings/cdp-attach.service.js';
import type { CdpConnection } from '../src/recordings/cdp-connection.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { SandboxProvider } from '../src/sandbox/sandbox.provider.js';

/**
 * M4-BE-01 — the attach lifecycle.
 *
 * A fake Chrome stands in for the sandbox's browser: an HTTP `/json/version`
 * plus the CDP WebSocket, on one port, exactly as the real thing answers
 * behind the sandbox's relay. Docker is not needed — what this suite is about
 * is the lifecycle and the two contractual details D-012 makes load-bearing:
 * the endpoint comes from `getPortEndpoint`, and its headers travel with every
 * request the attach makes. The real-Chrome run is a separate, Docker-gated
 * suite (`cdp-attach-docker.integration.test.ts`).
 */

interface FakeChromeOptions {
  /** What `/json/version` reports as the debugger URL. Defaults to this server. */
  readonly reportDebuggerUrl?: string | ((port: number) => string);
  /** Delay the discovery answer, so a detach can race the connect. */
  readonly versionDelayMs?: number;
  /** What `/json/version` answers with; defaults to a debugger URL on this server. */
  readonly versionBody?: unknown;
  /** Refuse the WebSocket upgrade without a handshake. */
  readonly refuseUpgrade?: boolean;
}

interface FakeChrome {
  readonly url: string;
  /** `/json/version` requests, so a test can read the headers they carried. */
  readonly versionRequests: IncomingMessage[];
  /** WebSocket upgrades, same reason. */
  readonly upgrades: IncomingMessage[];
  /** CDP commands received over the socket. */
  readonly commands: Record<string, unknown>[];
  /** Sockets the server still holds open. */
  readonly sockets: Set<WebSocket>;
  /** How many connections were ever accepted. */
  readonly opened: number;
  headersOf: (request: IncomingMessage) => IncomingHttpHeaders;
  close(): Promise<void>;
}

async function fakeChrome(options: FakeChromeOptions = {}): Promise<FakeChrome> {
  const versionRequests: IncomingMessage[] = [];
  const upgrades: IncomingMessage[] = [];
  const commands: Record<string, unknown>[] = [];
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true });
  let port = 0;
  let opened = 0;

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.url !== '/json/version') {
      response.writeHead(404);
      response.end();
      return;
    }
    versionRequests.push(request);
    const answer = (): void => {
      const reported =
        options.reportDebuggerUrl === undefined
          ? `ws://127.0.0.1:${port}/devtools/browser/fake`
          : typeof options.reportDebuggerUrl === 'function'
            ? options.reportDebuggerUrl(port)
            : options.reportDebuggerUrl;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(options.versionBody ?? { webSocketDebuggerUrl: reported }));
    };
    if (options.versionDelayMs === undefined) answer();
    else setTimeout(answer, options.versionDelayMs);
  });
  server.on('upgrade', (request, socket, head) => {
    if (options.refuseUpgrade === true) {
      socket.destroy();
      return;
    }
    upgrades.push(request);
    wss.handleUpgrade(request, socket, head, (client) => {
      wss.emit('connection', client, request);
    });
  });
  wss.on('connection', (socket) => {
    opened += 1;
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      commands.push(frame);
      socket.send(JSON.stringify({ id: frame['id'], result: { Browser: 'Chrome/fake-1.0' } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    versionRequests,
    upgrades,
    commands,
    sockets,
    get opened() {
      return opened;
    },
    headersOf: (request) => request.headers,
    close: async () => {
      for (const socket of [...sockets]) socket.terminate();
      server.closeAllConnections();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const running: FakeChrome[] = [];

async function startedChrome(options: FakeChromeOptions = {}): Promise<FakeChrome> {
  const chrome = await fakeChrome(options);
  running.push(chrome);
  return chrome;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((chrome) => chrome.close()));
});

/** The provider + database seams, faked the way `click-screenshot.test.ts` fakes them. */
function setup(options: {
  url: string;
  browserReady?: boolean;
  headers?: Record<string, string>;
  sandbox?: { sessionId: string | null } | null;
}) {
  const getPortEndpoint = vi.fn((_options: { port: number }) =>
    Promise.resolve({
      url: options.url,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
    }),
  );
  const attachSession = vi.fn(() => Promise.resolve({ getPortEndpoint }));
  const provider = { attachSession } as unknown as SandboxProvider;
  const sandbox = options.sandbox === undefined ? { sessionId: 'sess' } : options.sandbox;
  const findUnique = vi.fn(() => Promise.resolve(sandbox));
  const prisma = { sandbox: { findFirst: findUnique } } as unknown as PrismaService;
  return {
    // D-060: the endpoint is the SEAT's CDP port, so the service resolves one
    // before it dials. Read-only — a recording must never create a desktop as
    // a side effect of observing it — so a stub that answers is all it needs.
    service: new CdpAttachService(prisma, provider, {
      seatFor: async () => ({
        seatId: 'seat-1',
        browserGeneration: 1,
        profile: 'private-fixture',
        botId: 'bot-1',
        display: ':10',
        rfbPort: 5901,
        cdpPort: 9301,
        // D-061: the capture never starts a browser, so the seat must already
        // have one for an attach to be expected at all.
        browserReady: options.browserReady ?? true,
        widthPx: 1280,
        heightPx: 800,
      }),
    } as unknown as SeatService),
    getPortEndpoint,
    attachSession,
    findUnique,
  };
}

/** The connection a completed attach holds; a null here is always the failure worth reading. */
async function attachedConnection(
  service: CdpAttachService,
  botId: string,
  recordingId: string,
): Promise<CdpConnection> {
  const connection = await service.connectionFor(botId, recordingId);
  if (connection === null) throw new Error('expected an attached CDP connection');
  return connection;
}

describe('CdpAttachService — attaching for a recording', () => {
  it('does not dial or start a browser for a desktop-only seat', async () => {
    const { service, getPortEndpoint } = setup({ url: 'http://127.0.0.1:9', browserReady: false });
    service.attach('bot-1', 'rec-idle');
    expect(await service.connectionFor('bot-1', 'rec-idle')).toBeNull();
    expect(getPortEndpoint).not.toHaveBeenCalled();
    await service.onModuleDestroy();
  });

  it('resolves the endpoint through getPortEndpoint, forwards its headers, and proves the socket', async () => {
    const chrome = await startedChrome();
    const { service, getPortEndpoint, attachSession } = setup({
      url: chrome.url,
      headers: { authorization: 'Bearer endpoint-scoped' },
    });

    service.attach('bot-1', 'rec-1');
    const connection = await attachedConnection(service, 'bot-1', 'rec-1');
    expect(connection.closed).toBe(false);

    // D-012: the address comes from the provider — nothing assembles one
    // from the Sandbox row — and the headers it issued travel with BOTH
    // requests the attach makes.
    //
    // D-060: and the PORT is the seat's, not the machine's. This is where the
    // isolation the capture used to enforce with a window filter now lives: the
    // machine's own CDP port holds only the launch window no bot works in, so
    // dialling it would record nothing the operator is doing, and dialling one
    // seat's port cannot reach another's pages at all.
    expect(getPortEndpoint).toHaveBeenCalledWith({ port: 9301 });
    expect(chrome.headersOf(chrome.versionRequests[0]!)['authorization']).toBe(
      'Bearer endpoint-scoped',
    );
    expect(chrome.upgrades[0]?.headers['authorization']).toBe('Bearer endpoint-scoped');
    expect(attachSession).toHaveBeenCalledWith({ sessionId: 'sess' });

    // "Attached" means proven: a command round-tripped before it counted.
    expect(chrome.commands[0]).toMatchObject({ method: 'Browser.getVersion' });
  });

  it('pins the socket to the endpoint address, not the one Chrome reports', async () => {
    // Chrome behind the relay names its own loopback bind. Port 1 is
    // reachable by nothing; if the reported URL were trusted, this attach
    // would fail — and with endpoint-scoped headers pointed at a host the
    // endpoint never issued them for.
    const chrome = await startedChrome({
      reportDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/fake',
    });
    const { service } = setup({ url: chrome.url });

    service.attach('bot-1', 'rec-1');

    await expect(attachedConnection(service, 'bot-1', 'rec-1')).resolves.toBeDefined();
    expect(chrome.opened).toBe(1);
  });

  it('attaches once per recording, and detach closes the socket and the slot', async () => {
    const chrome = await startedChrome();
    const { service } = setup({ url: chrome.url });

    service.attach('bot-1', 'rec-1');
    service.attach('bot-1', 'rec-1');
    const connection = await attachedConnection(service, 'bot-1', 'rec-1');
    expect(chrome.opened).toBe(1);

    await service.detach('bot-1', 'rec-1');

    expect(connection.closed).toBe(true);
    await vi.waitFor(() => {
      expect(chrome.sockets.size).toBe(0);
    });
    expect(await service.connectionFor('bot-1', 'rec-1')).toBeNull();
    // Detaching again, or for a bot that never attached, is a no-op.
    await service.detach('bot-1', 'rec-1');
    await service.detach('bot-9', 'rec-9');
  });

  it('closes what it attached when the recording ends while the connect is still in flight', async () => {
    const chrome = await startedChrome({ versionDelayMs: 50 });
    const { service } = setup({ url: chrome.url });

    service.attach('bot-1', 'rec-1');
    // Lands mid-discovery. The detach awaits the in-flight attach and what
    // settles after it — without that, this socket outlives its recording
    // for the life of the process.
    await service.detach('bot-1', 'rec-1');

    // The connect still ran to completion and was then closed by its own
    // attach; the server sees that close one event-loop turn later.
    expect(chrome.opened).toBe(1);
    await vi.waitFor(() => {
      expect(chrome.sockets.size).toBe(0);
    });
    expect(await service.connectionFor('bot-1', 'rec-1')).toBeNull();
  });

  it('replaces an attach left over from another recording rather than going silent', async () => {
    const chrome = await startedChrome();
    const { service } = setup({ url: chrome.url });

    service.attach('bot-1', 'rec-1');
    await attachedConnection(service, 'bot-1', 'rec-1');

    // The only way this happens is a settle path that missed its detach;
    // keeping the stale slot would degrade every later recording for this
    // bot to X11 with nothing in any log to say why.
    service.attach('bot-1', 'rec-2');
    const second = await attachedConnection(service, 'bot-1', 'rec-2');
    expect(second.closed).toBe(false);
    expect(await service.connectionFor('bot-1', 'rec-1')).toBeNull();
    await vi.waitFor(() => {
      expect(chrome.sockets.size).toBe(1);
    });
  });

  it('forgets a socket that drops mid-recording instead of holding a dead connection', async () => {
    const chrome = await startedChrome();
    const { service } = setup({ url: chrome.url });
    service.attach('bot-1', 'rec-1');
    await attachedConnection(service, 'bot-1', 'rec-1');

    for (const socket of [...chrome.sockets]) socket.terminate();

    await vi.waitFor(async () => {
      expect(await service.connectionFor('bot-1', 'rec-1')).toBeNull();
    });
  });

  it('closes every attachment on shutdown', async () => {
    const chrome = await startedChrome();
    const { service } = setup({ url: chrome.url });
    service.attach('bot-1', 'rec-1');
    service.attach('bot-2', 'rec-2');
    await Promise.all([
      attachedConnection(service, 'bot-1', 'rec-1'),
      attachedConnection(service, 'bot-2', 'rec-2'),
    ]);
    expect(chrome.sockets.size).toBe(2);

    await service.onModuleDestroy();

    await vi.waitFor(() => {
      expect(chrome.sockets.size).toBe(0);
    });
  });
});

describe('CdpAttachService — chrome is not there', () => {
  it('degrades when nothing is listening on the endpoint', async () => {
    const dead = await startedChrome();
    const url = dead.url;
    await dead.close();
    running.splice(running.indexOf(dead), 1);
    const { service } = setup({ url });

    // Never throws into the recording path: a missing browser costs the CDP
    // layer and nothing else (§6/M4).
    expect(() => service.attach('bot-1', 'rec-1')).not.toThrow();
    expect(await service.connectionFor('bot-1', 'rec-1')).toBeNull();
  });

  it('degrades when the discovery answers without a debugger URL', async () => {
    const chrome = await startedChrome({ versionBody: { Browser: 'Chrome/no-debugger' } });
    const { service } = setup({ url: chrome.url });

    service.attach('bot-1', 'rec-1');

    expect(await service.connectionFor('bot-1', 'rec-1')).toBeNull();
  });

  it('degrades when the upgrade is refused', async () => {
    const chrome = await startedChrome({ refuseUpgrade: true });
    const { service } = setup({ url: chrome.url });

    service.attach('bot-1', 'rec-1');

    expect(await service.connectionFor('bot-1', 'rec-1')).toBeNull();
  });

  it('degrades when the bot has no sandbox row at all', async () => {
    const { service } = setup({ url: 'http://127.0.0.1:0', sandbox: null });

    service.attach('bot-1', 'rec-1');

    expect(await service.connectionFor('bot-1', 'rec-1')).toBeNull();
  });
});

/**
 * M4-BE-07 — the degradation is REPORTED, once, so the lifecycle can record
 * it on the row (`cdpAvailable = false`). What the report becomes is
 * `recordings-lifecycle.test.ts`'s half; this is the attach's.
 */
describe('CdpAttachService — reporting a recording with no CDP (M4-BE-07)', () => {
  const reported: Array<[string, string]> = [];

  /** Collect reports the way `RecordingsService` registers for them. */
  function collector(service: CdpAttachService): Array<[string, string]> {
    reported.length = 0;
    service.onUnavailable((botId, recordingId) => reported.push([botId, recordingId]));
    return reported;
  }

  it('reports an attach that never lands, exactly once', async () => {
    const dead = await startedChrome();
    const url = dead.url;
    await dead.close();
    running.splice(running.indexOf(dead), 1);
    const { service } = setup({ url });
    collector(service);

    service.attach('bot-1', 'rec-1');
    expect(await service.connectionFor('bot-1', 'rec-1')).toBeNull();

    // Awaiting the connection awaited the settle, so the report has landed —
    // and a second detach (the stop path's) is not a second report.
    await service.detach('bot-1', 'rec-1');
    await service.detach('bot-1', 'rec-1');
    expect(reported).toEqual([['bot-1', 'rec-1']]);
  });

  it('reports a socket that drops mid-recording', async () => {
    const chrome = await startedChrome();
    const { service } = setup({ url: chrome.url });
    collector(service);
    service.attach('bot-1', 'rec-1');
    await attachedConnection(service, 'bot-1', 'rec-1');

    for (const socket of [...chrome.sockets]) socket.terminate();

    await vi.waitFor(() => {
      expect(reported).toEqual([['bot-1', 'rec-1']]);
    });
  });

  it('stays silent for a healthy attach, and for the close detach performs', async () => {
    const chrome = await startedChrome();
    const { service } = setup({ url: chrome.url });
    collector(service);

    service.attach('bot-1', 'rec-1');
    const connection = await attachedConnection(service, 'bot-1', 'rec-1');
    expect(connection.closed).toBe(false);
    await service.detach('bot-1', 'rec-1');
    await vi.waitFor(() => {
      expect(connection.closed).toBe(true);
    });

    // A recording that ends with its socket intact never degraded — the
    // close detach caused is not a drop.
    expect(reported).toEqual([]);
  });

  it('stays silent when the recording ends while the connect is still in flight', async () => {
    const chrome = await startedChrome({ versionDelayMs: 50 });
    const { service } = setup({ url: chrome.url });
    collector(service);

    service.attach('bot-1', 'rec-1');
    // The old contract, from the other side: this connect SUCCEEDS (the
    // server answers) and closes itself. CDP was available for this
    // recording; only the recording ended first.
    await service.detach('bot-1', 'rec-1');

    expect(await service.connectionFor('bot-1', 'rec-1')).toBeNull();
    expect(reported).toEqual([]);
  });

  it('never rejects into the recording path when the listener throws', async () => {
    const dead = await startedChrome();
    const url = dead.url;
    await dead.close();
    running.splice(running.indexOf(dead), 1);
    const { service } = setup({ url });
    service.onUnavailable(() => {
      throw new Error('a lifecycle that cannot write');
    });

    service.attach('bot-1', 'rec-1');

    // The settled promise is documented never to reject; a listener that
    // throws must not turn a degradation into an attach failure.
    await expect(service.connectionFor('bot-1', 'rec-1')).resolves.toBeNull();
  });
});
