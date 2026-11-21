import { describe, expect, it } from 'vitest';
import type { ScreenGrantResponse } from '@crewaid/shared';

import { ApiRequestError } from '../src/renderer/api';
import {
  buildScreenStreamUrl,
  openScreenStream,
  SCREEN_STREAM_RETRY_DELAYS_MS,
  type ScreenSocket,
  type ScreenStreamEnding,
} from '../src/renderer/screen/screenStreamClient';

class FakeScreenSocket implements ScreenSocket {
  binaryType = 'blob';
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: unknown[] = [];
  closedWith: number | undefined;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number): void {
    this.closedWith = code;
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  text(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const grantFor = (ticket: string): ScreenGrantResponse => ({
  endpoint: { kind: 'orchestrator' },
  ticket,
  expiresAt: '2026-10-14T12:00:00.000Z',
});

/** Everything a stream touches, recorded, with time moved by hand. */
function harness(grant: () => Promise<ScreenGrantResponse> = async () => grantFor('t1')) {
  const sockets: FakeScreenSocket[] = [];
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const received: number[][] = [];
  const endings: ScreenStreamEnding[] = [];
  let grants = 0;
  const stream = openScreenStream({
    botId: 'bot-1',
    quality: 3,
    grant: async () => {
      grants += 1;
      return grant();
    },
    orchestratorBaseUrl: async () => 'https://orchestrator.example.com',
    onRfb: (message) => received.push([...message]),
    onEnded: (ending) => endings.push(ending),
    webSocketFactory: (url) => {
      const socket = new FakeScreenSocket(url);
      sockets.push(socket);
      return socket;
    },
    setTimeoutFn: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeoutFn: () => undefined,
  });
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  };
  const latest = (): FakeScreenSocket => {
    const socket = sockets.at(-1);
    if (socket === undefined) throw new Error('no socket was opened');
    return socket;
  };
  return {
    stream,
    sockets,
    timers,
    received,
    endings,
    settle,
    latest,
    grants: () => grants,
  };
}

describe('buildScreenStreamUrl', () => {
  it('serves an orchestrator grant beside /ws on the address the app holds', () => {
    expect(
      buildScreenStreamUrl({ kind: 'orchestrator' }, 'https://orch.example.com/api/v1', 'tk', 5),
    ).toBe('wss://orch.example.com/ws/screen?ticket=tk&quality=5');
    expect(buildScreenStreamUrl({ kind: 'orchestrator' }, 'http://localhost:3000', 'tk', 0)).toBe(
      'ws://localhost:3000/ws/screen?ticket=tk&quality=0',
    );
  });

  it('keeps a direct grant’s own query, which may carry the provider’s token', () => {
    const url = new URL(
      buildScreenStreamUrl(
        { kind: 'direct', url: 'wss://7071-abc.runtimehost.com/v1/stream?preview=pt' },
        undefined,
        'tk',
        4,
      ),
    );
    expect(url.host).toBe('7071-abc.runtimehost.com');
    expect(url.pathname).toBe('/v1/stream');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      preview: 'pt',
      ticket: 'tk',
      quality: '4',
    });
  });

  it('refuses an orchestrator grant with no address to serve it on', () => {
    expect(() => buildScreenStreamUrl({ kind: 'orchestrator' }, undefined, 'tk', 3)).toThrow(
      /No orchestrator address/,
    );
  });
});

describe('openScreenStream', () => {
  it('opens where the grant points and hands every RFB message to the viewer', async () => {
    const h = harness();
    await h.settle();
    const socket = h.latest();
    expect(socket.url).toBe('wss://orchestrator.example.com/ws/screen?ticket=t1&quality=3');
    // Under the default `blob`, a frame would be read asynchronously and could
    // be reordered.
    expect(socket.binaryType).toBe('arraybuffer');

    socket.open();
    socket.onmessage?.({ data: new Uint8Array([0, 0, 0, 1]).buffer });
    expect(h.received).toEqual([[0, 0, 0, 1]]);
  });

  it('acks every mark at once, so the server paces to this line', async () => {
    const h = harness();
    await h.settle();
    h.latest().open();
    h.latest().text({ t: 'mark', seq: 1 });
    h.latest().text({ t: 'mark', seq: 2 });
    expect(h.latest().sent).toEqual([
      { t: 'ack', seq: 1 },
      { t: 'ack', seq: 2 },
    ]);
  });

  it('changes quality on the open stream rather than reconnecting', async () => {
    const h = harness();
    await h.settle();
    h.latest().open();
    h.stream.setQuality(3);
    h.stream.setQuality(9);
    expect(h.latest().sent).toEqual([{ t: 'quality', quality: 9 }]);
    expect(h.sockets).toHaveLength(1);
  });

  it.each([false, true])(
    'sends the latest quality after a pending socket opens (retry: %s)',
    async (retry) => {
      const h = harness();
      await h.settle();
      if (retry) {
        h.latest().open();
        h.latest().drop();
        h.timers[0]?.callback();
        await h.settle();
      }
      const socket = h.latest();
      expect(new URL(socket.url).searchParams.get('quality')).toBe('3');
      h.stream.setQuality(9);
      h.stream.setQuality(0);
      h.stream.setQuality(8);
      expect(socket.sent).toEqual([]);

      socket.open();
      expect(socket.sent).toEqual([{ t: 'quality', quality: 8 }]);
      expect(h.endings).toEqual([]);
    },
  );

  it('needs no quality update when a pending socket returns to its opening quality', async () => {
    const h = harness();
    await h.settle();
    h.stream.setQuality(9);
    h.stream.setQuality(3);
    h.latest().open();
    expect(h.latest().sent).toEqual([]);
  });

  it('reconnects with a FRESH grant, at the quality the viewer now wants', async () => {
    let n = 0;
    const h = harness(async () => grantFor(`t${++n}`));
    await h.settle();
    h.latest().open();
    h.stream.setQuality(8);
    h.latest().drop();
    expect(h.timers.map((timer) => timer.delay)).toEqual([SCREEN_STREAM_RETRY_DELAYS_MS[0]]);

    h.timers[0]?.callback();
    await h.settle();
    // A ticket opens one stream once: the old one is never reused.
    expect(h.grants()).toBe(2);
    expect(h.latest().url).toBe('wss://orchestrator.example.com/ws/screen?ticket=t2&quality=8');
    expect(h.endings).toEqual([]);
  });

  it('asks again before believing the server that the computer is not running', async () => {
    const h = harness();
    await h.settle();
    for (let attempt = 0; attempt <= SCREEN_STREAM_RETRY_DELAYS_MS.length; attempt += 1) {
      h.latest().open();
      h.latest().text({ t: 'error', code: 'SCREEN_NOT_RUNNING', message: 'Stopped.' });
      h.latest().drop();
      if (attempt < SCREEN_STREAM_RETRY_DELAYS_MS.length) {
        expect(h.endings).toEqual([]);
        h.timers[attempt]?.callback();
        await h.settle();
      }
    }
    expect(h.grants()).toBe(SCREEN_STREAM_RETRY_DELAYS_MS.length + 1);
    expect(h.endings).toEqual([{ kind: 'not-running' }]);
  });

  it('passes on the server’s own word when it gave up', async () => {
    const h = harness();
    await h.settle();
    h.latest().open();
    h.latest().text({ t: 'error', code: 'SCREEN_STREAM_LOST', message: 'Could not reconnect.' });
    h.latest().drop();
    expect(h.endings).toEqual([{ kind: 'lost', message: 'Could not reconnect.' }]);
    expect(h.timers).toEqual([]);
  });

  it('says not running once a refused grant stays refused, and opens nothing', async () => {
    const h = harness(async () => {
      throw new ApiRequestError({ code: 'CONFLICT', message: 'Not running.' });
    });
    await h.settle();
    for (let attempt = 0; attempt < SCREEN_STREAM_RETRY_DELAYS_MS.length; attempt += 1) {
      expect(h.endings).toEqual([]);
      h.timers[attempt]?.callback();
      await h.settle();
    }
    expect(h.timers.map((timer) => timer.delay)).toEqual([...SCREEN_STREAM_RETRY_DELAYS_MS]);
    expect(h.endings).toEqual([{ kind: 'not-running' }]);
    expect(h.sockets).toEqual([]);
  });

  it('opens the stream when a refused grant is given on the next ask', async () => {
    // The app's state and the server's row can disagree for a moment, and a
    // refusal made in that moment is not the last word.
    let refusals = 1;
    const h = harness(async () => {
      if (refusals-- > 0) throw new ApiRequestError({ code: 'CONFLICT', message: 'Not running.' });
      return grantFor('t2');
    });
    await h.settle();
    expect(h.sockets).toEqual([]);
    h.timers[0]?.callback();
    await h.settle();
    expect(h.latest().url).toBe('wss://orchestrator.example.com/ws/screen?ticket=t2&quality=3');
    expect(h.endings).toEqual([]);
  });

  it('does not ask again for a grant the server will never give', async () => {
    const h = harness(async () => {
      throw new ApiRequestError({ code: 'UNAUTHORIZED', message: 'Sign in again.' });
    });
    await h.settle();
    expect(h.endings).toEqual([{ kind: 'lost', message: 'Sign in again.' }]);
    expect(h.timers).toEqual([]);
  });

  it('gives up after the bounded retries, saying so once', async () => {
    const h = harness();
    await h.settle();
    h.latest().drop();
    for (let attempt = 0; attempt < SCREEN_STREAM_RETRY_DELAYS_MS.length; attempt += 1) {
      h.timers[attempt]?.callback();
      await h.settle();
      h.latest().drop();
    }
    expect(h.timers.map((timer) => timer.delay)).toEqual([...SCREEN_STREAM_RETRY_DELAYS_MS]);
    expect(h.endings).toEqual([{ kind: 'lost', message: 'The display disconnected.' }]);
  });

  it('closes its socket and never comes back once the viewer closes it', async () => {
    const h = harness();
    await h.settle();
    const socket = h.latest();
    socket.open();
    h.stream.close();
    expect(socket.closedWith).toBe(1000);
    socket.drop();
    expect(h.timers).toEqual([]);
    expect(h.endings).toEqual([]);
  });
});
