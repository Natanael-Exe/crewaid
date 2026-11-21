import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { WebSocket } from 'ws';
import { ServerFrameSchema, type ServerFrame, type Principal, WIRE_VERSION } from '@crewaid/shared';
import type { WsGateway } from '../src/ws/ws.gateway.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { signIn, signOutAndDelete } from './auth-fixture.js';

/**
 * M1-BE-04 — WS gateway: token handshake + WsFrame envelope validation.
 *
 * §4.2: single endpoint `ws://<host>/ws?token=<session token>`. Frames are
 * the §4.2 envelope (id/type/botId?/ts/payload) with per-type Zod validation
 * against the shared registries. Event names are CONTRACTUAL — the tests
 * assert the exact strings from packages/shared.
 *
 * Handshake: a missing or wrong token is rejected with HTTP 401 before the
 * socket upgrades. */
const DATABASE_URL = process.env['DATABASE_URL'];

async function listen(app: INestApplication): Promise<number> {
  await app.listen(0);
  const address = app.getHttpServer().address();
  expect(address).toBeTruthy();
  expect(typeof address).toBe('object');
  return (address as { port: number }).port;
}

function wsUrl(port: number, token?: string): string {
  return token === undefined
    ? `ws://127.0.0.1:${port}/ws`
    : `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`;
}

/** Open a socket and capture open/unexpected HTTP response, resolving first. */
function handshake(
  url: string,
): Promise<{ opened: true; ws: WebSocket } | { opened: false; status?: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    const finish = (
      result: { opened: true; ws: WebSocket } | { opened: false; status?: number },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.terminate();
      reject(new Error('handshake timeout'));
    }, 3000);
    ws.once('open', () => finish({ opened: true, ws }));
    ws.once('unexpected-response', (_request, response) => {
      response.resume();
      finish({ opened: false, status: response.statusCode });
    });
    ws.once('error', (err: Error & { statusCode?: number }) => {
      finish({ opened: false, status: err.statusCode });
    });
  });
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'WS gateway (M1-BE-04, §4.2)',
  () => {
    let app: INestApplication;
    let port: number;
    let prisma: PrismaService;
    /** A live session token — the same credential REST accepts as a bearer. */
    let TOKEN: string;
    let actorId: string;
    const warnings: Array<{ event: string; fields: Record<string, unknown> }> = [];

    beforeAll(async () => {
      const { Test } = await import('@nestjs/testing');
      const { AppModule } = await import('../src/app.module.js');
      const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      // Same WS wiring shape as main.ts — the adapter must be set before init
      // or SocketModule falls back to socket.io (not installed) and exits.
      // A capturing logger: the pre-upgrade 401 is the ONLY place a failed WS
      // authentication is visible, so the log line is part of the contract.
      const capturingLogger = {
        warn: (event: string, fields: Record<string, unknown> = {}) => {
          warnings.push({ event, fields });
        },
      };
      app.useWebSocketAdapter(new CrewaidWsAdapter(app, capturingLogger as never));
      port = await listen(app);

      // V1-09: the handshake resolves a session, so the socket needs a real
      // one rather than a value from the environment.
      prisma = app.get(PrismaService);
      ({ token: TOKEN, userId: actorId } = await signIn(prisma, { label: 'wsguard' }));
    });

    afterAll(async () => {
      if (prisma !== undefined && actorId !== undefined) {
        await signOutAndDelete(prisma, actorId);
      }
      await app?.close();
    });

    it('accepts a connection with the valid token', async () => {
      const result = await handshake(wsUrl(port, TOKEN));
      expect(result.opened).toBe(true);
      if (result.opened) result.ws.close();
    });

    it('rejects a missing token with pre-upgrade HTTP 401', async () => {
      const result = await handshake(wsUrl(port));
      expect(result).toEqual({ opened: false, status: 401 });
    });

    it('rejects a wrong token with pre-upgrade HTTP 401', async () => {
      const result = await handshake(wsUrl(port, 'wrong-token'));
      expect(result).toEqual({ opened: false, status: 401 });
    });

    it('leaves a log line for every rejected handshake, and never the token', async () => {
      warnings.length = 0;
      await handshake(wsUrl(port, 'another-wrong-token'));
      await handshake(wsUrl(port));

      const rejections = warnings.filter((w) => w.event === 'ws.handshake.rejected');
      expect(rejections).toHaveLength(2);
      expect(rejections.every((w) => w.fields['status'] === 401)).toBe(true);
      // Credential probing must be visible, but the presented token must not be.
      expect(JSON.stringify(warnings)).not.toContain('another-wrong-token');
    });

    it('answers a screen.subscribe for an unknown bot instead of going silent', async () => {
      const result = await handshake(wsUrl(port, TOKEN));
      expect(result.opened).toBe(true);
      if (!result.opened) return;
      const { ws } = result;

      let gotFrame: string | null = null;
      ws.once('message', (data: Buffer) => {
        gotFrame = data.toString('utf8');
      });

      ws.send(
        JSON.stringify({
          id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
          type: 'screen.subscribe',
          botId: 'cmtk4b0x20009a03bc8vtxx0w',
          ts: Date.now(),
          payload: { botId: 'cmtk4b0x20009a03bc8vtxx0w', quality: 5 },
        }),
      );

      // M2-BE-06 gave this frame a side effect, so it can now fail — and §4.2
      // requires every frame to be answered. The bot does not exist, and R7
      // says a bot that is not yours is answered exactly like one that does
      // not exist, so the reply must not distinguish the two.
      await new Promise((r) => setTimeout(r, 500));
      expect(gotFrame).not.toBeNull();
      const parsed = JSON.parse(gotFrame ?? '{}') as {
        type: string;
        payload: { message: string };
      };
      expect(parsed.type).toBe('error');
      expect(parsed.payload.message).toBe('Bot not found');
      // A failed subscribe must not take the socket down with it: the client
      // may be watching other bots on the same connection.
      expect(ws.readyState).toBe(WebSocket.OPEN);

      ws.send(
        JSON.stringify({
          id: '3f2504e0-4f89-11d3-9a0c-0305e82c3309',
          type: 'bot.cancel',
          ts: Date.now(),
          payload: { wrongShape: true },
        }),
      );
      const replied = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('pipeline dead — no reply to invalid frame')),
          2000,
        );
        ws.once('message', (data: Buffer) => {
          clearTimeout(timer);
          resolve(data.toString('utf8'));
        });
      });
      const frame = JSON.parse(replied) as { type: string; payload: { code: string } };
      expect(frame.type).toBe('error');
      expect(frame.payload.code).toBe('VALIDATION_ERROR');
      ws.close();
    });

    it('rejects an unknown event type with an error frame (M1-QA-01 shape)', async () => {
      const result = await handshake(wsUrl(port, TOKEN));
      expect(result.opened).toBe(true);
      if (!result.opened) return;
      const { ws } = result;

      const received = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no frame received')), 3000);
        ws.once('message', (data: Buffer) => {
          clearTimeout(timer);
          resolve(data.toString('utf8'));
        });
      });

      ws.send(
        JSON.stringify({
          id: '3f2504e0-4f89-11d3-9a0c-0305e82c3302',
          type: 'not.a.real.type',
          ts: Date.now(),
          payload: {},
        }),
      );

      const frame = JSON.parse(await received) as {
        type: string;
        payload: { code: string; message: string };
      };
      expect(frame.type).toBe('error');
      expect(frame.payload.code).toBe('VALIDATION_ERROR');
      expect(frame.payload.message).toContain('not.a.real.type');
      ws.close();
    });

    it('rejects a bad payload for a KNOWN type with VALIDATION_ERROR', async () => {
      const result = await handshake(wsUrl(port, TOKEN));
      expect(result.opened).toBe(true);
      if (!result.opened) return;
      const { ws } = result;

      const received = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no frame received')), 3000);
        ws.once('message', (data: Buffer) => {
          clearTimeout(timer);
          resolve(data.toString('utf8'));
        });
      });

      ws.send(
        JSON.stringify({
          id: '3f2504e0-4f89-11d3-9a0c-0305e82c3303',
          type: 'screen.subscribe',
          ts: Date.now(),
          payload: { botId: 'cmtk4b0x20009a03bc8vtxx0w', quality: 99 }, // quality max is 9
        }),
      );

      const frame = JSON.parse(await received) as {
        type: string;
        payload: { code: string };
      };
      expect(frame.type).toBe('error');
      expect(frame.payload.code).toBe('VALIDATION_ERROR');
      ws.close();
    });

    it('rejects a frame missing the envelope id with VALIDATION_ERROR', async () => {
      const result = await handshake(wsUrl(port, TOKEN));
      expect(result.opened).toBe(true);
      if (!result.opened) return;
      const { ws } = result;

      const received = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no frame received')), 3000);
        ws.once('message', (data: Buffer) => {
          clearTimeout(timer);
          resolve(data.toString('utf8'));
        });
      });

      ws.send(
        JSON.stringify({
          type: 'bot.cancel',
          ts: Date.now(),
          payload: { botId: 'cmtk4b0x20009a03bc8vtxx0w' },
        }),
      );

      const frame = JSON.parse(await received) as {
        type: string;
        payload: { code: string };
      };
      expect(frame.type).toBe('error');
      expect(frame.payload.code).toBe('VALIDATION_ERROR');
      ws.close();
    });

    it('tells a NEWER client which versions are in play (CC-19/D-071)', async () => {
      // The inbound half of the same problem: a desktop ahead of this
      // orchestrator used to get "Frame fails the §4.2 envelope", which is
      // true and useless. The answer now names both versions, because the
      // fix is a version change and the operator cannot make one without
      // knowing which way it goes.
      const result = await handshake(wsUrl(port, TOKEN));
      expect(result.opened).toBe(true);
      if (!result.opened) return;
      const { ws } = result;

      const received = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no frame received')), 3000);
        ws.once('message', (data: Buffer) => {
          clearTimeout(timer);
          resolve(data.toString('utf8'));
        });
      });

      ws.send(
        JSON.stringify({
          id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
          type: 'bot.cancel',
          ts: Date.now(),
          wireVersion: WIRE_VERSION + 1,
          payload: { botId: 'cmtk4b0x20009a03bc8vtxx0w' },
        }),
      );

      const frame = JSON.parse(await received) as {
        type: string;
        wireVersion?: number;
        payload: { code: string; message: string };
      };
      expect(frame.type).toBe('error');
      expect(frame.payload.message).toContain(String(WIRE_VERSION + 1));
      expect(frame.payload.message).toContain(String(WIRE_VERSION));
      // And the refusal itself is stamped: a frame that says "your version is
      // wrong" and carries no version of its own is not much of an answer.
      expect(frame.wireVersion).toBe(WIRE_VERSION);
      ws.close();
    });

    it('rejects malformed JSON with VALIDATION_ERROR', async () => {
      const result = await handshake(wsUrl(port, TOKEN));
      expect(result.opened).toBe(true);
      if (!result.opened) return;
      const { ws } = result;

      const received = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no frame received')), 3000);
        ws.once('message', (data: Buffer) => {
          clearTimeout(timer);
          resolve(data.toString('utf8'));
        });
      });

      ws.send('this is not json');

      const frame = JSON.parse(await received) as {
        type: string;
        payload: { code: string };
      };
      expect(frame.type).toBe('error');
      expect(frame.payload.code).toBe('VALIDATION_ERROR');
      ws.close();
    });
  },
);

/**
 * The same §4.2 envelope rules, taken against the gateway directly.
 *
 * The suite above proves the whole pipeline, but booting AppModule needs
 * Postgres, so it is skipped on any checkout without a live database — which
 * is precisely where a frame-validation regression would pass unchallenged.
 * `handleFrame` is a pure function of the frame and the socket it answers on,
 * so the rules can be proven with neither a database nor a real socket.
 */
describe('WS frame validation (§4.2, no database)', () => {
  const FRAME_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3309';
  const BOT_ID = 'cmtk4b0x20009a03bc8vtxx0w';
  const TS = 1_700_000_000_000;
  /**
   * §4.2 requires an id on every frame. A frame whose own id never parsed has
   * nothing to echo, so the reply carries this one and the client still has
   * something to correlate against instead of an unattributable error.
   */
  const UNCORRELATED_ID = '00000000-0000-4000-8000-000000000000';

  type CancelSpy = (userId: string, botId: string) => void;
  /** The user the fake socket belongs to — deliberately not the singleton. */
  const SOCKET_OWNER: Principal = { userId: 'usr_ws_unit_owner', scopes: ['*'] };
  let makeGateway: (onCancel?: CancelSpy, principal?: Principal | null) => WsGateway;

  beforeAll(async () => {
    const { WsGateway: Gateway } = await import('../src/ws/ws.gateway.js');
    makeGateway = (onCancel = () => undefined, principal: Principal | null = SOCKET_OWNER) =>
      new Gateway(
        { add: () => undefined } as never,
        { cancelTurn: onCancel } as never,
        {
          subscribe: () => Promise.resolve(),
          unsubscribe: () => undefined,
          detach: () => undefined,
        } as never,
        // V1-09: the gateway asks this who the socket is on every acting
        // frame. Supplying `null` is how a case says "this session was
        // revoked while the socket was open".
        {
          register: () => undefined,
          forget: () => undefined,
          principalFor: () => Promise.resolve(principal),
        } as never,
      );
  });

  /** Captures what the gateway sends without opening a socket. */
  function recordingSocket(): { sent: string[]; closed: number[]; socket: WebSocket } {
    const sent: string[] = [];
    const closed: number[] = [];
    return {
      sent,
      closed,
      socket: {
        send: (data: string) => {
          sent.push(data);
        },
        close: (code: number) => {
          closed.push(code);
        },
      } as never,
    };
  }

  /**
   * Let the gateway's own promises run.
   *
   * V1-09 made the acting frames resolve a principal before they do anything,
   * and `handleFrame` stays synchronous because §4.2 frames are not
   * request/response — so the effect lands a microtask later. Without this the
   * assertions run first and every case passes for the wrong reason.
   */
  function settled(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }

  /**
   * Asserts exactly one reply, that it is an `error`, and that it is itself a
   * legal §4.2 frame — an error the client's own receive-side parse would
   * drop turns a rejected frame back into the silence §4.2 forbids.
   */
  function onlyErrorFrame(sent: readonly string[]): Extract<ServerFrame, { type: 'error' }> {
    expect(sent).toHaveLength(1);
    const parsed = ServerFrameSchema.safeParse(JSON.parse(sent[0] ?? ''));
    if (!parsed.success) {
      throw new Error(`reply is not a valid ServerFrame: ${parsed.error.issues[0]?.message ?? ''}`);
    }
    const frame = parsed.data;
    if (frame.type !== 'error') {
      throw new Error(`expected an error frame, got ${frame.type}`);
    }
    return frame;
  }

  it('rejects an unknown event type, echoing the offending frame id', () => {
    const { sent, socket } = recordingSocket();
    makeGateway().handleFrame(socket, {
      id: FRAME_ID,
      type: 'not.a.real.type',
      ts: TS,
      payload: {},
    });

    const frame = onlyErrorFrame(sent);
    expect(frame.id).toBe(FRAME_ID);
    expect(frame.payload.code).toBe('VALIDATION_ERROR');
    expect(frame.payload.message).toContain('not.a.real.type');
  });

  it('rejects a frame missing the envelope id, replying with the uncorrelated id', () => {
    const { sent, socket } = recordingSocket();
    makeGateway().handleFrame(socket, {
      type: 'screen.subscribe',
      ts: TS,
      payload: { botId: BOT_ID },
    });

    const frame = onlyErrorFrame(sent);
    expect(frame.id).toBe(UNCORRELATED_ID);
    expect(frame.payload.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a bad payload for a KNOWN type, naming the type', () => {
    const { sent, socket } = recordingSocket();
    makeGateway().handleFrame(socket, {
      id: FRAME_ID,
      type: 'screen.subscribe',
      ts: TS,
      // A bot id is at least one character.
      payload: { botId: '' },
    });

    const frame = onlyErrorFrame(sent);
    expect(frame.id).toBe(FRAME_ID);
    expect(frame.payload.code).toBe('VALIDATION_ERROR');
    expect(frame.payload.message).toContain('screen.subscribe');
  });

  it.each([
    ['a non-uuid id', { id: 'not-a-uuid', type: 'bot.cancel', ts: TS, payload: { botId: BOT_ID } }],
    ['an empty type', { id: FRAME_ID, type: '', ts: TS, payload: { botId: BOT_ID } }],
    ['a fractional ts', { id: FRAME_ID, type: 'bot.cancel', ts: 1.5, payload: { botId: BOT_ID } }],
    ['a negative ts', { id: FRAME_ID, type: 'bot.cancel', ts: -1, payload: { botId: BOT_ID } }],
  ])('rejects %s at the envelope', (_caseName, badFrame) => {
    const { sent, socket } = recordingSocket();
    makeGateway().handleFrame(socket, badFrame);

    expect(onlyErrorFrame(sent).payload.code).toBe('VALIDATION_ERROR');
  });

  it('answers text that is not an envelope at all', () => {
    const { sent, socket } = recordingSocket();
    makeGateway().handleRaw(socket);

    expect(onlyErrorFrame(sent).id).toBe(UNCORRELATED_ID);
  });

  it('accepts a valid frame on a known type and stays silent', () => {
    const { sent, socket } = recordingSocket();
    makeGateway().handleFrame(socket, {
      id: FRAME_ID,
      type: 'screen.subscribe',
      ts: TS,
      payload: { botId: BOT_ID },
    });

    expect(sent).toEqual([]);
  });

  it("routes a valid bot.cancel under THIS CONNECTION'S principal", async () => {
    // The assertion that changed with V1-09. It used to expect
    // SINGLETON_USER_ID, which was the same answer for every socket on the
    // install — so with two accounts, one person's cancel carried the other
    // person's id.
    const calls: Array<[string, string]> = [];
    const { sent, socket } = recordingSocket();
    makeGateway((userId, botId) => calls.push([userId, botId])).handleFrame(socket, {
      id: FRAME_ID,
      type: 'bot.cancel',
      ts: TS,
      payload: { botId: BOT_ID },
    });
    await settled();

    expect(calls).toEqual([[SOCKET_OWNER.userId, BOT_ID]]);
    expect(sent).toEqual([]);
  });

  it('refuses a cancel whose session was revoked, and closes the socket', async () => {
    // Asserted against a presence: the case above sends the same frame on the
    // same gateway shape and reaches the turn service, so what is measured
    // here is the revocation rather than a frame that never worked.
    const calls: Array<[string, string]> = [];
    const { sent, socket, closed } = recordingSocket();
    makeGateway((userId, botId) => calls.push([userId, botId]), null).handleFrame(socket, {
      id: FRAME_ID,
      type: 'bot.cancel',
      ts: TS,
      payload: { botId: BOT_ID },
    });
    await settled();

    expect(calls).toEqual([]);
    expect(onlyErrorFrame(sent).payload.message).toMatch(/no longer valid/i);
    // Answered BEFORE the close: a socket that just drops is indistinguishable
    // from a network failure, and the client would retry rather than sign in.
    expect(closed).toEqual([1008]);
  });
});
