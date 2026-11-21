import { describe, expect, it, vi } from 'vitest';
import {
  buildWsUrl,
  WsClient,
  type WsClientError,
  type WsConnectionState,
  type WebSocketLike,
} from '../src/renderer/connection/wsClient';
import { reconnectDelayMs } from '../src/renderer/connection/wsBackoff';
import {
  decodeScreenInputFrame,
  decodeScreenBinaryFrame,
  encodeScreenBinaryFrame,
  WIRE_VERSION,
} from '@crewaid/shared';

class FakeSocket implements WebSocketLike {
  static readonly OPEN = 1;

  binaryType = 'blob';
  readonly sent: (string | ArrayBufferView | ArrayBuffer)[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closeCalls = 0;

  send(data: string | ArrayBufferView | ArrayBuffer): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  receive(data: unknown): void {
    this.onmessage?.({ data });
  }

  closeFromPeer(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

class FakeTimers {
  private nextId = 1;
  private readonly callbacks = new Map<number, { callback: () => void; delay: number }>();

  setTimeout = (callback: () => void, delay: number): number => {
    const id = this.nextId++;
    this.callbacks.set(id, { callback, delay });
    return id;
  };

  clearTimeout = (id: unknown): void => {
    this.callbacks.delete(id as number);
  };

  takeNext(): { delay: number; run: () => void } | undefined {
    const first = this.callbacks.entries().next().value as
      [number, { callback: () => void; delay: number }] | undefined;
    if (first === undefined) return undefined;
    this.callbacks.delete(first[0]);
    return { delay: first[1].delay, run: first[1].callback };
  }

  get size(): number {
    return this.callbacks.size;
  }
}

function tokenProvider(): Promise<{ orchestratorToken: string; orchestratorBaseUrl: string }> {
  return Promise.resolve({
    orchestratorToken: 'secret-token',
    orchestratorBaseUrl: 'https://orchestrator.example/api/v1',
  });
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('reconnectDelayMs', () => {
  it('doubles from one second and caps every later retry at 30 seconds', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(reconnectDelayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
  });

  it('treats negative and fractional retry numbers as the first retry', () => {
    expect(reconnectDelayMs(-2)).toBe(1_000);
    expect(reconnectDelayMs(0.5)).toBe(1_000);
  });
});

describe('buildWsUrl', () => {
  it('converts the orchestrator HTTP base to the unprefixed authenticated WS endpoint', () => {
    const url = new URL(buildWsUrl('https://orchestrator.example/api/v1', 'secret token'));
    expect(url.protocol).toBe('wss:');
    expect(url.pathname).toBe('/ws');
    expect(url.searchParams.get('token')).toBe('secret token');
  });

  it('rejects missing credentials and unsupported base protocols', () => {
    expect(() => buildWsUrl('http://localhost:3000', '')).toThrow(
      'WebSocket credentials are missing',
    );
    expect(() => buildWsUrl('file:///tmp/orchestrator', 'token')).toThrow(
      'Orchestrator URL must use HTTP or HTTPS',
    );
  });
});

describe('WsClient', () => {
  it('connects with the token, emits typed server frames, and validates client frames', async () => {
    const sockets: FakeSocket[] = [];
    const statuses: WsConnectionState[] = [];
    const errors: WsClientError[] = [];
    const client = new WsClient({
      tokenProvider,
      webSocketFactory: (url) => {
        expect(url).toContain('wss://orchestrator.example/ws?token=secret-token');
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      onStatus: (state) => statuses.push(state),
      onError: (error) => errors.push(error),
    });
    const frames: unknown[] = [];
    client.onFrame((frame) => frames.push(frame));

    client.start();
    await settle();
    expect(statuses.at(-1)?.status).toBe('connecting');
    sockets[0]?.open();
    expect(client.state.status).toBe('connected');

    const validFrame = {
      id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      type: 'bot.status',
      ts: Date.now(),
      payload: { botId: 'cmtk4b0x20009a03bc8vtxx0w', status: 'IDLE' },
    } as const;
    sockets[0]?.receive(JSON.stringify(validFrame));
    sockets[0]?.receive('{"id":"bad"}');
    expect(frames).toEqual([validFrame]);
    expect(errors).toEqual([
      { code: 'PROTOCOL_ERROR', message: 'Received an invalid server event.' },
    ]);

    expect(
      client.send({
        id: '3f2504e0-4f89-11d3-9a0c-0305e82c3302',
        type: 'bot.cancel',
        ts: Date.now(),
        payload: { botId: 'cmtk4b0x20009a03bc8vtxx0w' },
      }),
    ).toBe(true);
    expect(sockets[0]?.sent).toHaveLength(1);
    expect(client.send({ type: 'bot.cancel' } as never)).toBe(false);
    expect(errors.at(-1)).toEqual({
      code: 'PROTOCOL_ERROR',
      message: 'Refused to send an invalid client event.',
    });
  });

  it('names an unreadable NEWER frame instead of calling it invalid (CC-19/D-071)', async () => {
    // The failure the version exists for. An older desktop meeting a frame
    // from a newer orchestrator used to report "Received an invalid server
    // event" — the same sentence a corrupt frame gets — so the operator had
    // no way to learn their build was behind.
    const sockets: FakeSocket[] = [];
    const errors: WsClientError[] = [];
    const client = new WsClient({
      tokenProvider,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      onStatus: () => undefined,
      onError: (error) => errors.push(error),
    });
    const frames: unknown[] = [];
    client.onFrame((frame) => frames.push(frame));
    client.start();
    await settle();
    sockets[0]?.open();

    const envelope = {
      id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      ts: Date.now(),
      payload: { botId: 'cmtk4b0x20009a03bc8vtxx0w', status: 'IDLE' },
    };

    // A frame from the future, carrying a type this build has never heard of
    // — which is what a real wire change looks like from here.
    sockets[0]?.receive(
      JSON.stringify({
        ...envelope,
        type: 'something.this.build.has.never.heard.of',
        wireVersion: WIRE_VERSION + 1,
      }),
    );
    expect(errors.at(-1)?.code).toBe('UNSUPPORTED_WIRE_VERSION');
    // Both numbers, because "update the app" without saying from what to what
    // is the same dead end in nicer words.
    expect(errors.at(-1)?.message).toContain(String(WIRE_VERSION + 1));
    expect(errors.at(-1)?.message).toContain(String(WIRE_VERSION));

    // A corrupt frame at a version this build DOES speak is still a protocol
    // error. Reporting it as a version problem would send an operator off to
    // update a build that is already current.
    sockets[0]?.receive(JSON.stringify({ ...envelope, type: 'bot.status', payload: {} }));
    expect(errors.at(-1)?.code).toBe('PROTOCOL_ERROR');

    // And an UNSTAMPED frame is delivered, because every frame an orchestrator
    // that predates D-071 sends looks exactly like this.
    const legacy = { ...envelope, type: 'bot.status' as const };
    sockets[0]?.receive(JSON.stringify(legacy));
    expect(frames).toEqual([legacy]);
  });

  it('wraps screen input in a binary bot-id envelope and refuses it while disconnected', async () => {
    const sockets: FakeSocket[] = [];
    const client = new WsClient({
      tokenProvider,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const key = new Uint8Array([4, 1, 0, 0, 0, 0, 0, 97]);

    expect(client.sendScreenInput('cmtk4b0x20009a03bc8vtxx0w', key)).toBe(false);
    client.start();
    await settle();
    sockets[0]?.open();
    expect(client.sendScreenInput('cmtk4b0x20009a03bc8vtxx0w', key)).toBe(false);
    sockets[0]?.onmessage?.({
      data: JSON.stringify({
        id: crypto.randomUUID(),
        type: 'screen.control.state',
        ts: Date.now(),
        payload: {
          botId: 'cmtk4b0x20009a03bc8vtxx0w',
          mode: 'human',
          epoch: 7,
          holder: 'self',
          leaseExpiresAt: Date.now() + 30000,
          observationRequired: false,
        },
      }),
    });
    expect(client.sendScreenInput('cmtk4b0x20009a03bc8vtxx0w', key)).toBe(true);

    const sent = sockets[0]?.sent[0];
    expect(sent).toBeInstanceOf(Uint8Array);
    const decoded = decodeScreenInputFrame(sent as Uint8Array);
    expect(decoded).toEqual({
      ok: true,
      frame: { botId: 'cmtk4b0x20009a03bc8vtxx0w', epoch: 7, rfb: key },
    });
  });

  it('refuses an ungranted bot id without throwing at the caller', async () => {
    // `sendScreenInput` is called from noVNC's event handlers, at mouse-move
    // rates. A throw there unwinds into noVNC's own dispatch, so the failure
    // has to become a reported error and a `false` — the same shape `send`
    // uses for a frame that fails the contract.
    const errors: WsClientError[] = [];
    const sockets: FakeSocket[] = [];
    const client = new WsClient({
      tokenProvider,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      onError: (error) => errors.push(error),
    });
    client.start();
    await settle();
    sockets[0]?.open();

    expect(client.sendScreenInput('', new Uint8Array([5, 0, 0, 0, 0, 0]))).toBe(false);

    expect(errors).toEqual([]);
    expect(sockets[0]?.sent).toEqual([]);
  });

  it('reconnects with 1/2/4/8/16/30 second backoff after peer closes', async () => {
    const timers = new FakeTimers();
    const sockets: FakeSocket[] = [];
    const statuses: WsConnectionState[] = [];
    const client = new WsClient({
      tokenProvider,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      onStatus: (state) => statuses.push(state),
    });

    client.start();
    await settle();
    sockets[0]?.open();

    const delays: number[] = [];
    for (const expectedDelay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]) {
      sockets.at(-1)?.closeFromPeer();
      const retry = timers.takeNext();
      expect(retry).toBeDefined();
      if (retry === undefined) continue;
      delays.push(retry.delay);
      expect(statuses.at(-1)).toMatchObject({
        status: 'reconnecting',
        attempt: delays.length,
        retryDelayMs: expectedDelay,
      });
      retry.run();
      await settle();
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
  });

  it('stops the socket and cancels a pending reconnect', async () => {
    const timers = new FakeTimers();
    const sockets: FakeSocket[] = [];
    const client = new WsClient({
      tokenProvider,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
    });

    client.start();
    await settle();
    sockets[0]?.open();
    sockets[0]?.closeFromPeer();
    expect(timers.size).toBe(1);
    client.stop();
    expect(timers.size).toBe(0);
    expect(client.state.status).toBe('disconnected');
    timers.takeNext()?.run();
    expect(sockets).toHaveLength(1);
  });

  it('stays disconnected when the token store has no configured credentials', async () => {
    const factory = vi.fn(() => new FakeSocket());
    const statuses: WsConnectionState[] = [];
    const client = new WsClient({
      tokenProvider: () => Promise.resolve({}),
      webSocketFactory: factory,
      onStatus: (state) => statuses.push(state),
    });

    client.start();
    await settle();
    expect(factory).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toMatchObject({
      status: 'disconnected',
      attempt: 0,
      retryDelayMs: null,
    });
  });
});

describe('WsClient binary frames', () => {
  const open = async () => {
    let socket!: FakeSocket;
    const client = new WsClient({
      tokenProvider: async () => ({
        orchestratorToken: 't',
        orchestratorBaseUrl: 'http://localhost:3000',
      }),
      webSocketFactory: () => {
        socket = new FakeSocket();
        return socket;
      },
    });
    client.start();
    await Promise.resolve();
    await Promise.resolve();
    socket.readyState = FakeSocket.OPEN;
    socket.onopen?.();
    return { client, socket };
  };

  it('asks for arraybuffer before a frame can arrive', async () => {
    const { socket } = await open();
    // The browser default hands binary over as a Blob, which is readable only
    // asynchronously — enough to reorder frames on a stream whose entire
    // contract is that they arrive in order.
    expect(socket.binaryType).toBe('arraybuffer');
  });

  it('reports a binary frame as an invalid event: pixels have a stream of their own', async () => {
    const { client, socket } = await open();
    const errors: WsClientError[] = [];
    const frames: unknown[] = [];
    client.onError((error) => errors.push(error));
    client.onFrame((frame) => frames.push(frame));

    // What the §4.2 socket used to carry for a desktop. Nothing reads it now,
    // so it is a server this build does not understand, said out loud rather
    // than dropped.
    socket.onmessage?.({ data: encodeScreenBinaryFrame('bot-1', new Uint8Array([0, 0, 0, 1])) });

    expect(frames).toEqual([]);
    expect(errors).toEqual([
      { code: 'PROTOCOL_ERROR', message: 'Received an invalid server event.' },
    ]);
  });

  it('still rejects a non-string, non-binary payload', async () => {
    const { client, socket } = await open();
    const errors: WsClientError[] = [];
    client.onError((error) => errors.push(error));
    socket.onmessage?.({ data: 42 });
    expect(errors[0]?.message).toBe('Received an invalid server event.');
  });
});
