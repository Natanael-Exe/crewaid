import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { ServerFrameSchema, WIRE_VERSION } from '@crewaid/shared';
import { TurnEventBus } from '../src/agent/turn-event.bus.js';

class FakeClient extends EventEmitter {
  readonly readyState = 1;
  readonly frames: string[] = [];

  send(frame: string): void {
    this.frames.push(frame);
  }
}

const OWNER = 'cm-owner';
const STRANGER = 'cm-stranger';

/** Only `bot.findUnique` is read: the owner of the bot a frame names. */
function ownersOf(owners: Record<string, string>) {
  return {
    bot: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const userId = owners[where.id];
        return userId === undefined ? null : { userId };
      }),
    },
  };
}

function busFor(owners: Record<string, string> = { 'cm-bot': OWNER }): TurnEventBus {
  return new TurnEventBus(ownersOf(owners) as never);
}

/** A socket admitted as `userId`, whose session has not expired. */
function listeningAs(userId: string) {
  return { userId: () => userId, expired: vi.fn() };
}

/** Lets a pending owner read resolve and release the frames it held. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('TurnEventBus', () => {
  it('delivers a bot’s frames, correlated to it, in order', async () => {
    const bus = busFor();
    const client = new FakeClient();
    bus.add(client as never, listeningAs(OWNER));

    bus.emitBotStatus('cm-bot', 'THINKING');
    bus.emitError('cm-bot', 'RATE_LIMITED', 'Try again shortly.');
    bus.emitBotStatus('cm-bot', 'IDLE');

    await settle();
    expect(client.frames).toHaveLength(3);
    const frames = client.frames.map((frame) => JSON.parse(frame));
    expect(frames.map((frame) => frame.type)).toEqual(['bot.status', 'error', 'bot.status']);
    expect(frames[0].payload).toEqual({ botId: 'cm-bot', status: 'THINKING' });
    expect(frames[1].payload).toEqual({ code: 'RATE_LIMITED', message: 'Try again shortly.' });
    expect(frames[2].payload).toEqual({ botId: 'cm-bot', status: 'IDLE' });
    expect(frames.every((frame) => frame.botId === 'cm-bot')).toBe(true);
    expect(frames.every((frame) => typeof frame.id === 'string')).toBe(true);
  });

  it('announces a roster change so an open window re-reads it', async () => {
    // The frame carries no row on purpose: the client's repair is the same
    // `GET /bots` that owns the full shape, and this says WHEN that read is
    // worth making — a bot tool created a teammate, or another window deleted
    // one, and the sidebar otherwise kept showing the roster from whenever it
    // last asked.
    const bus = busFor();
    const client = new FakeClient();
    bus.add(client as never, listeningAs(OWNER));

    bus.emitBotsChanged(OWNER, 'cm-newbot', 'created');

    await settle();
    expect(client.frames).toHaveLength(1);
    const frame = JSON.parse(client.frames[0]);
    expect(frame.type).toBe('bots.changed');
    expect(frame.payload).toEqual({ botId: 'cm-newbot', change: 'created' });
    expect(ServerFrameSchema.safeParse(frame).success).toBe(true);
  });

  it('stamps the wire version on every frame it puts on the wire (CC-19/D-071)', async () => {
    // Stamped on the way OUT rather than before the union parse above: the
    // union schemas do not declare `wireVersion` and zod strips what they do
    // not declare, so a stamp applied first would be removed by that parse
    // and every frame would leave unversioned with nothing failing to say so.
    const bus = busFor();
    const client = new FakeClient();
    bus.add(client as never, listeningAs(OWNER));

    bus.emitBotStatus('cm-bot', 'THINKING');
    bus.emitBotStatus('cm-bot', 'IDLE');
    bus.emitError('cm-bot', 'RATE_LIMITED', 'Try again shortly.');

    await settle();
    expect(client.frames.length).toBeGreaterThan(0);
    for (const raw of client.frames) {
      const frame = JSON.parse(raw) as { wireVersion?: number };
      expect(frame.wireVersion).toBe(WIRE_VERSION);
    }
  });

  it('emits only frames that satisfy the §4.2 contract the client enforces', async () => {
    const bus = busFor();
    const client = new FakeClient();
    bus.add(client as never, listeningAs(OWNER));

    bus.emitBotStatus('cm-bot', 'THINKING');
    bus.emitBotStatus('cm-bot', 'IDLE');
    bus.emitError('cm-bot', 'RATE_LIMITED', 'Try again shortly.');

    // The renderer's WsClient rejects anything failing this schema, so a frame
    // that does not parse here is an event the user would never see.
    await settle();
    for (const raw of client.frames) {
      expect(ServerFrameSchema.safeParse(JSON.parse(raw)).success).toBe(true);
    }
  });

  it('drops and logs an invalid frame instead of putting it on the wire', async () => {
    const bus = busFor();
    const client = new FakeClient();
    bus.add(client as never, listeningAs(OWNER));
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    // §4.2 requires an error's code. A frame the client would silently
    // discard is dropped here instead, with a log line to explain it.
    bus.emitError('cm-bot', '', 'hello');

    await settle();
    expect(client.frames).toHaveLength(0);
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });

  it('emits a JSON payload whose object carries undefined fields', async () => {
    const bus = busFor();
    const client = new FakeClient();
    bus.add(client as never, listeningAs(OWNER));

    // A key that is present for JsonSchema's record branch (which rejects it)
    // and absent from the bytes on the wire (which are legal §4.2). Validating
    // the object instead of its serialization refused every such payload.
    bus.emitApprovalRequested('cm-bot', {
      turnId: 'cm-turn',
      toolCallId: 'tc-1',
      toolName: 'shell',
      args: { command: 'ls', cwd: undefined },
      binding: {
        toolName: 'shell',
        effect: 'unknown',
        scope: 'call',
        argsHash: 'a'.repeat(64),
        grantRevision: 'b'.repeat(64),
        resourceRevision: null,
        seat: null,
        commit: null,
      },
    });

    await settle();
    expect(client.frames).toHaveLength(1);
    const frame = JSON.parse(client.frames[0] as string) as {
      payload: { args: unknown };
    };
    // The undefined key was never data, so what survives is exactly the
    // arguments the client would have received anyway.
    expect(frame.payload.args).toEqual({ command: 'ls' });
  });

  it('drops an unserializable payload rather than throwing into the turn', async () => {
    const bus = busFor();
    const client = new FakeClient();
    bus.add(client as never, listeningAs(OWNER));
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const cyclic: Record<string, unknown> = { type: 'tool-call' };
    cyclic['self'] = cyclic;

    // A notification path must not fail the turn it is reporting on, so an
    // impossible frame is a logged drop and never an exception.
    expect(() =>
      bus.emitApprovalRequested('cm-bot', {
        turnId: 'cm-turn',
        toolCallId: 'tc-1',
        toolName: 'shell',
        args: cyclic,
        binding: {
          toolName: 'shell',
          effect: 'unknown',
          scope: 'call',
          argsHash: 'a'.repeat(64),
          grantRevision: 'b'.repeat(64),
          resourceRevision: null,
          seat: null,
          commit: null,
        },
      }),
    ).not.toThrow();
    await settle();
    expect(client.frames).toHaveLength(0);
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });
});

describe('TurnEventBus audience — a frame reaches its owner and nobody else', () => {
  it('delivers a bot’s frames only to the sockets of the account that owns it', async () => {
    // Each socket gets a frame of its own too. Without that control, a bus
    // that delivered nothing to anybody would pass the stranger's assertion.
    const bus = busFor({ 'cm-bot': OWNER, 'cm-theirs': STRANGER });
    const owner = new FakeClient();
    const stranger = new FakeClient();
    bus.add(owner as never, listeningAs(OWNER));
    bus.add(stranger as never, listeningAs(STRANGER));

    bus.emitError('cm-bot', 'UNKNOWN', 'private to the owner');
    bus.emitApprovalRequested('cm-bot', {
      turnId: 'cm-turn',
      toolCallId: 'tc-1',
      toolName: 'shell',
      args: { command: 'cat ~/.ssh/id_ed25519' },
      binding: {
        toolName: 'shell',
        effect: 'unknown',
        scope: 'call',
        argsHash: 'a'.repeat(64),
        grantRevision: 'b'.repeat(64),
        resourceRevision: null,
        seat: null,
        commit: null,
      },
    });
    bus.emitError('cm-theirs', 'UNKNOWN', 'private to the stranger');
    await settle();

    const botsOf = (client: FakeClient) =>
      client.frames.map((raw) => (JSON.parse(raw) as { botId?: string }).botId);
    expect(botsOf(owner)).toEqual(['cm-bot', 'cm-bot']);
    expect(botsOf(stranger)).toEqual(['cm-theirs']);
  });

  it('delivers a frame that names no bot to the account the caller names', async () => {
    const bus = busFor();
    const owner = new FakeClient();
    const stranger = new FakeClient();
    bus.add(owner as never, listeningAs(OWNER));
    bus.add(stranger as never, listeningAs(STRANGER));

    bus.emitWorkChanged(OWNER, 'task.changed', { taskId: 'cm-task' });
    bus.emitMcpStatus(OWNER, 'cm-server', 'ERROR', 0, 'refused');
    bus.emitWorkChanged(STRANGER, 'goal.changed', { goalId: 'cm-goal' });

    const typesOf = (client: FakeClient) =>
      client.frames.map((raw) => (JSON.parse(raw) as { type: string }).type);
    expect(typesOf(owner)).toEqual(['task.changed', 'mcp.status']);
    expect(typesOf(stranger)).toEqual(['goal.changed']);
  });

  it('keeps a bot’s frames in order while its owner is still being read', async () => {
    // The first frame of a bot is the one that waits for the owner read; a
    // frame emitted during that read must queue behind it, and one emitted
    // after it must not overtake anything still queued.
    const bus = busFor();
    const client = new FakeClient();
    bus.add(client as never, listeningAs(OWNER));

    bus.emitError('cm-bot', 'UNKNOWN', 'one ');
    bus.emitError('cm-bot', 'UNKNOWN', 'two ');
    await settle();
    bus.emitError('cm-bot', 'UNKNOWN', 'three');

    const chunks = client.frames.map(
      (raw) => (JSON.parse(raw) as { payload: { message: string } }).payload.message,
    );
    expect(chunks).toEqual(['one ', 'two ', 'three']);
  });

  it('never delivers a frame emitted before the socket registered', async () => {
    // The owner read opens a window the old synchronous broadcast did not
    // have: a frame waits, a socket joins, the read returns. The socket must
    // still start from the frames emitted after it joined, as it always did.
    const bus = busFor();
    const early = new FakeClient();
    bus.add(early as never, listeningAs(OWNER));
    const late = new FakeClient();

    bus.emitError('cm-bot', 'UNKNOWN', 'before the late socket');
    bus.add(late as never, listeningAs(OWNER));
    bus.emitError('cm-bot', 'UNKNOWN', 'after it');
    await settle();

    const chunksOf = (client: FakeClient) =>
      client.frames.map(
        (raw) => (JSON.parse(raw) as { payload: { message: string } }).payload.message,
      );
    expect(chunksOf(early)).toEqual(['before the late socket', 'after it']);
    expect(chunksOf(late)).toEqual(['after it']);
  });

  it('reads a bot’s owner once, not once per frame', async () => {
    const owners = ownersOf({ 'cm-bot': OWNER });
    const bus = new TurnEventBus(owners as never);
    const client = new FakeClient();
    bus.add(client as never, listeningAs(OWNER));

    for (let index = 0; index < 5; index += 1) bus.emitError('cm-bot', 'UNKNOWN', 'x');
    await settle();
    for (let index = 0; index < 5; index += 1) bus.emitError('cm-bot', 'UNKNOWN', 'y');

    expect(client.frames).toHaveLength(10);
    expect(owners.bot.findUnique).toHaveBeenCalledOnce();
  });

  it('drops a frame whose bot has no owner rather than sending it to anyone', async () => {
    const bus = busFor({ 'cm-bot': OWNER });
    const client = new FakeClient();
    bus.add(client as never, listeningAs(OWNER));
    const warned = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    bus.emitError('cm-unknown', 'UNKNOWN', 'nobody owns this');
    bus.emitError('cm-bot', 'UNKNOWN', 'control');
    await settle();

    // The control proves the socket was listening, so the absence is the drop.
    const bots = client.frames.map((raw) => (JSON.parse(raw) as { botId?: string }).botId);
    expect(bots).toEqual(['cm-bot']);
    expect(warned).toHaveBeenCalled();
    warned.mockRestore();
  });

  it('drops a bot’s frames when its owner cannot be read, and asks again next time', async () => {
    const owners = ownersOf({ 'cm-bot': OWNER });
    owners.bot.findUnique.mockRejectedValueOnce(new Error('connection reset'));
    const bus = new TurnEventBus(owners as never);
    const client = new FakeClient();
    bus.add(client as never, listeningAs(OWNER));
    const warned = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    bus.emitError('cm-bot', 'UNKNOWN', 'lost to the blip');
    await settle();
    expect(client.frames).toHaveLength(0);

    bus.emitError('cm-bot', 'UNKNOWN', 'after the blip');
    await settle();
    expect(client.frames).toHaveLength(1);
    expect(owners.bot.findUnique).toHaveBeenCalledTimes(2);
    warned.mockRestore();
  });

  it('ends a socket whose session expired at its next frame, once', async () => {
    const bus = busFor();
    const client = new FakeClient();
    let live = true;
    const audience = { userId: () => (live ? OWNER : null), expired: vi.fn() };
    bus.add(client as never, audience);

    bus.emitError('cm-bot', 'UNKNOWN', 'before');
    await settle();
    live = false;
    bus.emitError('cm-bot', 'UNKNOWN', 'after');
    bus.emitError('cm-bot', 'UNKNOWN', 'and after that');

    expect(client.frames).toHaveLength(1);
    expect(audience.expired).toHaveBeenCalledOnce();
  });

  it('reads no owner at all while nobody is listening', async () => {
    const owners = ownersOf({ 'cm-bot': OWNER });
    const bus = new TurnEventBus(owners as never);

    bus.emitError('cm-bot', 'UNKNOWN', 'nobody is watching');
    await settle();

    expect(owners.bot.findUnique).not.toHaveBeenCalled();
  });
});
