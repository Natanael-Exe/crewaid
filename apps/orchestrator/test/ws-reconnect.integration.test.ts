import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ServerFrameSchema, type ServerFrame } from '@crewaid/shared';
import { TurnEventBus } from '../src/agent/turn-event.bus.js';

/**
 * M1-QA-04 — a socket that drops must cost the operator nothing.
 *
 * What is left here is the bus's side: it forgets a dead client and keeps
 * serving the rest. The reply itself no longer travels over this socket — a
 * run streams over its own AG-UI response, which a reconnecting window
 * rejoins by run id (D-190, `mod-ai16-chat-send`), so the old drop-mid-reply
 * case went with the AI SDK engine (D-199).
 */

/** The reply, split at the point the connection dies. */
const HEAD = 'The first half arrives before the drop, ';
const TAIL = 'and the second half after the reconnect.';

// ── §4.2 fan-out lifecycle (no database) ───────────────────────────────────

/**
 * `ws` sockets are EventEmitters with a numeric readyState; the bus uses only
 * `once`, `send` and `readyState`, so a fake covering those is the whole
 * surface — and it can be driven into states a real socket reaches only by
 * timing (CLOSING, or a close event that has not fired yet).
 */
class FakeSocket {
  readyState = 1;
  readonly sent: string[] = [];
  private readonly handlers = new Map<string, Array<() => void>>();

  send(data: string): void {
    this.sent.push(data);
  }

  once(event: string, handler: () => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }

  /** Fire a lifecycle event the way `ws` would. */
  fire(event: string): void {
    const handlers = this.handlers.get(event) ?? [];
    this.handlers.delete(event);
    for (const handler of handlers) handler();
  }

  frames(): ServerFrame[] {
    return this.sent.map((raw) => ServerFrameSchema.parse(JSON.parse(raw)));
  }
}

/** The bus reads a bot's owner before delivering; every bot here is FAKE_OWNER's. */
const FAKE_OWNER = 'user_1';
function busForTests(): TurnEventBus {
  const prisma = { bot: { findUnique: async () => ({ userId: FAKE_OWNER }) } };
  return new TurnEventBus(prisma as never);
}
const asOwner = { userId: () => FAKE_OWNER, expired: () => undefined };
/** Lets the bus's first owner read resolve and release what it held. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('TurnEventBus client lifecycle (M1-QA-04, no database)', () => {
  it('drops a client that closed and keeps delivering to the survivors', async () => {
    const bus = busForTests();
    const dropped = new FakeSocket();
    const survivor = new FakeSocket();
    bus.add(dropped as never, asOwner);
    bus.add(survivor as never, asOwner);

    bus.emitError('bot_1', 'UNKNOWN', HEAD);
    await settle();
    expect(dropped.frames()).toHaveLength(1);
    expect(survivor.frames()).toHaveLength(1);

    // The lid closes. `ws` reports 'close' and the registration must go with it,
    // or the set grows a dead socket per disconnect for the process's lifetime.
    dropped.fire('close');
    bus.emitError('bot_1', 'UNKNOWN', TAIL);
    await settle();

    expect(dropped.frames()).toHaveLength(1);
    expect(survivor.frames().map((frame) => frame.type)).toEqual(['error', 'error']);
  });

  it('drops a client that errored, since a failed socket emits no close', async () => {
    const bus = busForTests();
    const failed = new FakeSocket();
    bus.add(failed as never, asOwner);

    failed.fire('error');
    bus.emitError('bot_1', 'UNKNOWN', TAIL);
    await settle();

    expect(failed.sent).toEqual([]);
  });

  it('never writes to a socket that is closing but has not fired close yet', async () => {
    const bus = busForTests();
    const closing = new FakeSocket();
    bus.add(closing as never, asOwner);

    // CLOSING (2): the handshake is in flight, the registration is still live.
    // Only the readyState check stops the write, and `ws` throws on send here.
    closing.readyState = 2;
    bus.emitError('bot_1', 'UNKNOWN', TAIL);
    await settle();

    expect(closing.sent).toEqual([]);
  });

  it('serves a client that registered after the turn already started', async () => {
    const bus = busForTests();
    const late = new FakeSocket();

    bus.emitError('bot_1', 'UNKNOWN', HEAD);
    await settle();
    bus.add(late as never, asOwner);
    bus.emitBotStatus('bot_1', 'IDLE');
    await settle();

    // Exactly the reconnect case: it missed the first half and is caught up on
    // §4.1, but everything from registration onwards reaches it live.
    expect(late.frames().map((frame) => frame.type)).toEqual(['bot.status']);
  });
});
