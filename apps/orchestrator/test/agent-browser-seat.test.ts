import { describe, expect, it, vi } from 'vitest';
import { AgentBrowserService } from '../src/agent/agent-browser.service.js';

const BOT = 'clx1a2b3c4d5e6f7g8h9i0j1';
function fixture() {
  const seat = {
    seatId: 'seat-owned',
    browserGeneration: 1,
    profile: 'private-fixture',
    botId: BOT,
    display: ':10',
    rfbPort: 5901,
    cdpPort: 9301,
    browserReady: true,
    widthPx: 1280,
    heightPx: 800,
  };
  const getPortEndpoint = vi.fn(async () => ({
    url: 'https://relay.test:31000',
    headers: { 'x-relay-auth': 'test-only' },
  }));
  const provider = { attachSession: vi.fn(async () => ({ getPortEndpoint })) };
  const prisma = {
    sandbox: {
      findFirst: vi.fn(async () => ({ sessionId: 'user-computer', widthPx: 1280, heightPx: 800 })),
    },
  };
  const seats = {
    ensureSeat: vi.fn(async () => seat),
    ensureBrowser: vi.fn(async () => seat),
    assertCurrentBrowser: vi.fn(async () => undefined),
  };
  const page = { on: vi.fn(), isClosed: () => false };
  const context = { pages: () => [page], on: vi.fn() };
  const browser = { contexts: () => [context], on: vi.fn(), close: vi.fn(async () => undefined) };
  const connect = vi.fn(async () => browser);
  const fetch = vi.fn(async () =>
    Response.json({ webSocketDebuggerUrl: 'wss://wrong-host.test:9222/devtools/browser/owned' }),
  );
  vi.stubGlobal('fetch', fetch);
  const service = new AgentBrowserService(
    prisma as never,
    provider as never,
    seats as never,
    { agentStateFor: () => ({ epoch: 0, mode: 'agent' }) } as never,
    connect as never,
  );
  return { service, seats, provider, getPortEndpoint, connect, fetch, browser, prisma };
}

describe('Playwright attaches only to this bot’s existing private browser', () => {
  it('ensures this bot’s seat and browser before resolving its private port', async () => {
    const f = fixture();
    await f.service.connect(BOT);
    expect(f.provider.attachSession).toHaveBeenCalledWith({ sessionId: 'user-computer' });
    expect(f.seats.ensureSeat).toHaveBeenCalledWith('user-computer', BOT, {
      widthPx: 1280,
      heightPx: 800,
    });
    expect(f.seats.ensureBrowser).toHaveBeenCalledWith('user-computer', BOT);
    expect(f.getPortEndpoint).toHaveBeenCalledWith({ port: 9301 });
    expect(f.connect).toHaveBeenCalledWith('wss://relay.test:31000/devtools/browser/owned', {
      headers: { 'x-relay-auth': 'test-only' },
      timeout: 10_000,
      noDefaults: true,
    });
    expect(f.fetch).toHaveBeenCalledWith(
      'https://relay.test:31000/json/version',
      expect.objectContaining({ headers: { 'x-relay-auth': 'test-only', connection: 'close' } }),
    );
  });
  it('screen-only seat acquisition does not start Chrome or Playwright', async () => {
    const f = fixture();
    await f.service.ensureSeatFor(BOT);
    expect(f.seats.ensureBrowser).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('rechecks durable selection before every operation on an already connected driver', async () => {
    const f = fixture();
    const opened = await f.service.connect(BOT);
    f.seats.assertCurrentBrowser.mockRejectedValue(new Error('STALE_REFERENCE: login revoked'));
    const operations = [
      () => opened.page.read(),
      () => opened.page.navigate('https://fixture.test'),
      () => opened.page.click('old-reference'),
      () => opened.page.type('old-reference', 'text'),
      () => opened.page.screenshot(),
    ];
    for (const operation of operations)
      await expect(operation()).rejects.toThrow('Read again to reconnect');
    expect(f.seats.assertCurrentBrowser).toHaveBeenCalledTimes(5);
    expect(f.seats.assertCurrentBrowser).toHaveBeenLastCalledWith(
      'user-computer',
      BOT,
      await f.seats.ensureBrowser(),
    );
    // Disconnect must remain possible after authority has changed.
    await opened.close();
    expect(f.browser.close).toHaveBeenCalledTimes(1);
  });
  it('missing computer refuses before opening a connection', async () => {
    const f = fixture();
    f.prisma.sandbox.findFirst.mockResolvedValueOnce(null as never);
    await expect(f.service.connect(BOT)).rejects.toThrow('has no computer');
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('refuses a bridge answer naming another bot or replaced seat', async () => {
    const f = fixture();
    const ready = await f.seats.ensureBrowser();
    f.seats.ensureBrowser.mockResolvedValueOnce({ ...ready, botId: 'another-bot' });
    await expect(f.service.connect(BOT)).rejects.toThrow('different bot seat');
    f.seats.ensureBrowser.mockResolvedValueOnce({ ...ready, seatId: 'replacement-seat' });
    await expect(f.service.connect(BOT)).rejects.toThrow('different bot seat');
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('uses the relay’s TLS scheme rather than Chrome’s internal loopback scheme', async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(
      Response.json({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/owned' }),
    );
    await f.service.connect(BOT);
    expect(f.connect.mock.calls[0]?.[0]).toBe('wss://relay.test:31000/devtools/browser/owned');
  });
  it('invalid discovery and an empty browser refuse rather than creating a page', async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(Response.json({ webSocketDebuggerUrl: 'file:///etc/passwd' }));
    await expect(f.service.connect(BOT)).rejects.toThrow('WebSocket URL');
    expect(f.connect).not.toHaveBeenCalled();
    f.browser.contexts = () => [];
    await expect(f.service.connect(BOT)).rejects.toThrow('no page');
    expect(f.browser.close).toHaveBeenCalledTimes(1);
  });
});
