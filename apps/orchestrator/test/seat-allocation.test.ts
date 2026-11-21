import { describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
import { SeatError, SeatService } from '../src/sandbox/seat.service.js';
import { createStructuredLogger } from '../src/logging/structured-logger.js';

/**
 * M5-BE-23 — which screen belongs to which bot.
 *
 * There is no row for a seat, deliberately: it is a window inside a container
 * that outlives an orchestrator restart, so the machine is the only thing that
 * knows the truth and a mirror in Postgres would be a second source that can
 * disagree with the window actually running. Everything here is therefore
 * about the conversation with the machine — and about the two ways that
 * conversation can produce a second window for one bot.
 */

type Call = {
  path: string;
  method: string;
  body: unknown;
  headers?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
};

function machine(
  responses: (call: Call) => { status: number; body: unknown },
  options: {
    bridgeUrl?: string;
    headers?: Record<string, string>;
    /** M5-BE-27: the identity this bot has been granted, if any. */
    profile?: string | null;
  } = {},
) {
  const calls: Call[] = [];
  const fetchSpy = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      path: `${url.pathname}${url.search}`,
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      headers: init?.headers as Record<string, string> | undefined,
      signal: init?.signal,
    };
    calls.push(call);
    const { status, body } = responses(call);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchSpy);

  const provider = {
    attachSession: async () => ({
      getPortEndpoint: async ({ port }: { port: number }) => ({
        url: options.bridgeUrl ?? `http://127.0.0.1:${port === 7070 ? 31000 : port}`,
        ...(options.headers === undefined ? {} : { headers: options.headers }),
      }),
    }),
  };
  const logs: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, done) {
      logs.push(chunk.toString());
      done();
    },
  });
  // M5-BE-27: a seat's profile is a grant lookup away, and these cases are
  // about the call into the machine rather than about grants — so the default
  // is the answer every bot without one gives, and a case that cares says so.
  const identities = {
    selectionFor: async () => ({ profile: options.profile ?? null, revision: 0 }),
  };
  const service = new SeatService(
    provider as never,
    createStructuredLogger(sink) as never,
    identities as never,
    {} as never,
  );
  return { service, calls, logs };
}

// D-060: a seat is a display, so what the machine reports is the display it
// owns and the two ports that reach it — not the Chrome target and window id
// that picked one bot's window out of a shared browser.
const seatJson = (botId: string, over: Record<string, unknown> = {}) => ({
  seatId: 'seat-1',
  browserGeneration: 1,
  profile: botId,
  botId,
  display: ':10',
  rfbPort: 5901,
  cdpPort: 9301,
  width: 1280,
  height: 800,
  left: 0,
  top: 0,
  ...over,
});

const GEOMETRY = { widthPx: 1280, heightPx: 800 };

describe('SeatService.ensureSeat', () => {
  it('asks the machine before it creates anything', async () => {
    // The read half is what makes allocation survive a restart: the window is
    // still open, and nothing in the database remembers it.
    const { service, calls } = machine((call) =>
      call.method === 'GET'
        ? { status: 200, body: { ok: true, seat: seatJson('bot-1') } }
        : { status: 500, body: { ok: false } },
    );

    const seat = await service.ensureSeat('session-1', 'bot-1', GEOMETRY);

    expect(seat).toMatchObject({ seatId: 'seat-1', botId: 'bot-1', rfbPort: 5901 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/seats?botId=bot-1' });
  });

  it('creates one when the machine has none, labelled with the bot', async () => {
    const { service, calls } = machine((call) =>
      call.method === 'GET'
        ? { status: 404, body: { ok: false, code: 'NO_SUCH_SEAT' } }
        : { status: 200, body: { ok: true, seat: seatJson('bot-1') } },
    );

    await service.ensureSeat('session-1', 'bot-1', GEOMETRY);

    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    // The label is the whole mechanism. A seat created without one is a window
    // nothing can ever find again.
    expect(calls[1]?.body).toMatchObject({ botId: 'bot-1', width: 1280, height: 800 });
  });

  it('sends a granted identity as the seat\u2019s profile, and nothing when there is none', async () => {
    // M5-BE-27. The FIELD's absence is half the claim: the machine reads a
    // missing profile as the bot's own (D-056), so a service that always sent
    // one — even an empty string — would move every bot onto a shared jar and
    // the seat would still be created, still be labelled, and still stream.
    const ungranted = machine((call) =>
      call.method === 'GET'
        ? { status: 404, body: { ok: false } }
        : { status: 200, body: { ok: true, seat: seatJson('bot-1') } },
    );
    await ungranted.service.ensureSeat('session-1', 'bot-1', GEOMETRY);
    expect(ungranted.calls[1]?.body).not.toHaveProperty('profile');

    vi.unstubAllGlobals();
    const granted = machine(
      (call) =>
        call.method === 'GET'
          ? { status: 404, body: { ok: false } }
          : {
              status: 200,
              body: { ok: true, seat: seatJson('bot-1', { profile: 'company-google' }) },
            },
      { profile: 'company-google' },
    );
    await granted.service.ensureSeat('session-1', 'bot-1', GEOMETRY);
    expect(granted.calls[1]?.body).toMatchObject({
      botId: 'bot-1',
      profile: 'company-google',
    });
    // Logged, because which profile a seat opened on is the difference between
    // a bot's own browser state and one shared with its siblings.
    expect(granted.logs.join('')).toContain('company-google');
  });

  it('passes the size the caller cached rather than letting the machine default', async () => {
    // R8 protects the framebuffer a CLIENT is streaming. The machine has no
    // idea what anyone cached, so a defaulted seat would come up at a size
    // nobody is expecting and the stream would renegotiate.
    const { service, calls } = machine((call) =>
      call.method === 'GET'
        ? { status: 404, body: { ok: false } }
        : { status: 200, body: { ok: true, seat: seatJson('bot-1', { width: 900, height: 600 }) } },
    );

    await service.ensureSeat('session-1', 'bot-1', { widthPx: 900, heightPx: 600 });

    expect(calls[1]?.body).toMatchObject({ width: 900, height: 600 });
  });

  it('makes one request when two callers arrive together', async () => {
    // A turn's first browser tool and a §4.3 subscribe can land in the same
    // tick. Two requests would be two windows for one bot — the machine's own
    // lock catches it too, but only after a round trip that this avoids.
    let creates = 0;
    const { service } = machine((call) => {
      if (call.method === 'GET') return { status: 404, body: { ok: false } };
      creates += 1;
      return { status: 200, body: { ok: true, seat: seatJson('bot-1') } };
    });

    const [a, b] = await Promise.all([
      service.ensureSeat('session-1', 'bot-1', GEOMETRY),
      service.ensureSeat('session-1', 'bot-1', GEOMETRY),
    ]);

    expect(creates).toBe(1);
    expect(a).toEqual(b);
  });

  it('asks again after the first request settles', async () => {
    // The in-flight promise is not a cache of the answer: a seat can be
    // closed and a machine replaced, so a remembered port would outlive the
    // window it names.
    const { service, calls } = machine(() => ({
      status: 200,
      body: { ok: true, seat: seatJson('bot-1') },
    }));

    await service.ensureSeat('session-1', 'bot-1', GEOMETRY);
    await service.ensureSeat('session-1', 'bot-1', GEOMETRY);

    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2);
  });

  it('keeps an existing seat at its own size, and says so', async () => {
    // R8's one-way door: a seat that exists cannot be resized, and the
    // machine would refuse anyway — its window's geometry is pinned. Silence
    // here would leave an operator looking at a stream that is simply the
    // wrong shape with nothing in the log to explain it.
    const { service, logs } = machine(() => ({
      status: 200,
      body: { ok: true, seat: seatJson('bot-1', { width: 1024, height: 640 }) },
    }));

    const seat = await service.ensureSeat('session-1', 'bot-1', GEOMETRY);

    expect(seat).toMatchObject({ widthPx: 1024, heightPx: 640 });
    const warned = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(warned.some((entry) => entry['event'] === 'seat.geometry.differs')).toBe(true);
  });

  it('refuses a seat the machine described in a way the proxy cannot use', async () => {
    // A payload from another process, read rather than cast: a seat with no
    // port would otherwise reach the RFB proxy as NaN and fail there.
    const { service } = machine((call) =>
      call.method === 'GET'
        ? { status: 404, body: { ok: false } }
        : { status: 200, body: { ok: true, seat: { seatId: 'seat-1', botId: 'bot-1' } } },
    );

    await expect(service.ensureSeat('session-1', 'bot-1', GEOMETRY)).rejects.toThrow(SeatError);
  });

  it.each([
    { browserGeneration: -1 },
    { browserGeneration: Number.MAX_SAFE_INTEGER + 1 },
    { browserGeneration: 0, browserReady: true },
    { browserGeneration: undefined },
    { profile: '' },
  ])('refuses invalid launch metadata %j', async (metadata) => {
    const { service } = machine((call) =>
      call.method === 'GET'
        ? { status: 404, body: { ok: false } }
        : { status: 200, body: { ok: true, seat: seatJson('bot-1', metadata) } },
    );
    await expect(service.ensureSeat('session-1', 'bot-1', GEOMETRY)).rejects.toThrow(SeatError);
  });

  it('surfaces what the machine said when it refuses', async () => {
    // "This machine is full" and "this bot has no screen" are different
    // problems, and only the machine knows which one it is.
    const { service } = machine((call) =>
      call.method === 'GET'
        ? { status: 404, body: { ok: false } }
        : {
            status: 503,
            body: { ok: false, code: 'SEAT_UNAVAILABLE', detail: 'every seat port is in use (16' },
          },
    );

    await expect(service.ensureSeat('session-1', 'bot-1', GEOMETRY)).rejects.toThrow(
      /every seat port is in use/,
    );
  });

  it('lets a later caller retry after a failure', async () => {
    let attempt = 0;
    const { service } = machine((call) => {
      if (call.method === 'GET') return { status: 404, body: { ok: false } };
      attempt += 1;
      return attempt === 1
        ? { status: 503, body: { ok: false, detail: 'busy' } }
        : { status: 200, body: { ok: true, seat: seatJson('bot-1') } };
    });

    await expect(service.ensureSeat('session-1', 'bot-1', GEOMETRY)).rejects.toThrow();
    // The in-flight entry has to be cleared on the failure path too, or one
    // transient error makes a bot screenless until the orchestrator restarts.
    await expect(service.ensureSeat('session-1', 'bot-1', GEOMETRY)).resolves.toMatchObject({
      seatId: 'seat-1',
      browserGeneration: 1,
      profile: 'bot-1',
    });
  });
});

describe('SeatService.releaseSeat', () => {
  it('closes the seat the bot owns', async () => {
    const { service, calls } = machine((call) =>
      call.method === 'GET'
        ? { status: 200, body: { ok: true, seat: seatJson('bot-1') } }
        : { status: 200, body: { ok: true } },
    );

    expect(await service.releaseSeat('session-1', 'bot-1')).toBe(true);
    expect(calls[1]).toMatchObject({ method: 'POST', path: '/seats/seat-1/close' });
  });

  it('is a no-op for a bot with no seat', async () => {
    const { service, calls } = machine(() => ({ status: 404, body: { ok: false } }));
    expect(await service.releaseSeat('session-1', 'bot-1')).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

/**
 * D-012 — an endpoint's headers must be SENT when connecting, and the decision
 * names the bridge calls specifically.
 *
 * Dropping them does not fail as a missing header. It fails as a refused or
 * hung connection, which reads as a broken sandbox rather than as a caller
 * that ignored the contract — which is exactly how long it would take anyone
 * to find.
 */
describe('the call into the machine', () => {
  it('sends the endpoint’s own headers on both verbs', () => {
    return (async () => {
      const { service, calls } = machine(
        (call) =>
          call.method === 'GET'
            ? { status: 404, body: { ok: false } }
            : { status: 200, body: { ok: true, seat: seatJson('bot-1') } },
        { headers: { authorization: 'Bearer machine-token' } },
      );

      await service.ensureSeat('session-1', 'bot-1', GEOMETRY);

      expect(calls[0]?.headers).toMatchObject({ authorization: 'Bearer machine-token' });
      expect(calls[1]?.headers).toMatchObject({ authorization: 'Bearer machine-token' });
      // And the create still declares what it is sending.
      expect(calls[1]?.headers).toMatchObject({ 'content-type': 'application/json' });
    })();
  });

  it('bounds every call, because the caller cannot recover from one that hangs', async () => {
    // `ensureSeat` holds an in-flight promise per bot and clears it when the
    // request SETTLES. A connection that is accepted and never answered is the
    // one failure that map cannot clear: this bot's allocation would be pinned
    // forever and every later caller would queue behind it.
    const { service, calls } = machine(() => ({
      status: 200,
      body: { ok: true, seat: seatJson('bot-1') },
    }));

    await service.ensureSeat('session-1', 'bot-1', GEOMETRY);

    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('SeatService.ensureBrowser', () => {
  it('requests the bot browser through the authenticated bridge endpoint', async () => {
    const { service, calls } = machine(
      () => ({
        status: 200,
        body: { ok: true, seat: seatJson('bot-1', { browserReady: true }) },
      }),
      { headers: { authorization: 'Bearer endpoint-token' } },
    );
    expect((await service.ensureBrowser('session-1', 'bot-1')).browserReady).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[2]).toMatchObject({
      path: '/seats/browser',
      method: 'POST',
      body: { botId: 'bot-1' },
      headers: { authorization: 'Bearer endpoint-token' },
    });
  });

  it('rejects a response that does not confirm browser startup', async () => {
    const { service } = machine(() => ({ status: 200, body: { seat: seatJson('bot-1') } }));
    await expect(service.ensureBrowser('session-1', 'bot-1')).rejects.toThrow('selected browser');
  });

  it('preserves a capacity refusal for the caller', async () => {
    const { service } = machine(() => ({
      status: 503,
      body: { detail: 'insufficient pids headroom for another browser' },
    }));
    await expect(service.ensureBrowser('session-1', 'bot-1')).rejects.toThrow(
      'insufficient pids headroom',
    );
  });
});
