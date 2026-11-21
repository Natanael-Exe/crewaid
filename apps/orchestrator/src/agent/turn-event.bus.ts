import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { Attachment, Message } from '@prisma/client';
import {
  stampWireVersion,
  ServerFrameSchema,
  type BotStatus,
  type ApprovalBinding,
  type McpStatus,
  type RunSettledOutcome,
  type ServerEventType,
  type ServerFrame,
} from '@crewaid/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { sendBounded } from '../ws/ws-limits.js';

/**
 * In-process WebSocket fan-out for server frames, scoped strictly to the
 * owning account.
 *
 * Resolves and caches `Bot.userId` on first emit (queuing frames per bot until
 * the lookup resolves so order is preserved), validates every outbound frame
 * against `ServerFrameSchema`, and disconnects sockets whose session expires.
 */

/** `ws` exposes readyState OPEN as a numeric literal, not an exported value. */
const WS_OPEN = 1;

/**
 * The value the client will actually receive.
 *
 * WebSocket payloads are JSON, but the objects that produce them are not. Tool
 * arguments and provider objects carry keys whose value is `undefined`, a hard
 * rejection for `JsonSchema`'s record branch while being absent from the bytes
 * on the wire. Validating the object therefore refuses frames whose
 * serialization is perfectly legal. Serialize first, then validate what came
 * back, so the parse judges the frame the client sees.
 *
 * A value that cannot serialize at all (a cycle, a BigInt) comes back
 * undefined and fails the parse below rather than throwing: a frame that
 * cannot be built must not fail the turn that produced it.
 */
function toWireValue(frame: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(frame));
  } catch {
    return undefined;
  }
}

/**
 * Which account a registered socket receives frames for, asked per frame.
 *
 * `userId` answers null once the socket's session is over; `expired` is then
 * called exactly once, and ends the socket. The two are separate because the
 * bus decides WHEN a socket has stopped being entitled to a frame, while how a
 * socket is told so — an error frame, a close code — is the gateway's.
 */
export type SocketAudience = {
  readonly userId: () => string | null;
  readonly expired: () => void;
};

/** Where a frame goes: to a bot's owner, or to a user named by the caller. */
type FrameAudience = { readonly botId: string } | { readonly userId: string };

/**
 * A validated frame and its place in emission order. `seq` is what keeps a
 * socket from receiving a frame emitted before it registered, which the owner
 * read would otherwise allow: the frame waits, the socket joins, the read
 * returns.
 */
type Outgoing = { readonly frame: ServerFrame; readonly seq: number };

type Registration = { readonly audience: SocketAudience; readonly since: number };

@Injectable()
export class TurnEventBus {
  private readonly logger = new Logger(TurnEventBus.name);
  private readonly clients = new Map<WebSocket, Registration>();
  /** `Bot.userId` by bot id. Never evicted: a bot's owner cannot change. */
  private readonly owners = new Map<string, string>();
  /** Frames waiting on their bot's owner, in the order they were emitted. */
  private readonly awaitingOwner = new Map<string, Outgoing[]>();
  /** The last frame's place in emission order. */
  private seq = 0;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  add(client: WebSocket, audience: SocketAudience): () => void {
    this.clients.set(client, { audience, since: this.seq });
    const remove = () => this.clients.delete(client);
    client.once('close', remove);
    client.once('error', remove);
    return remove;
  }

  /**
   * Takes the Prisma row directly. `Prisma.JsonValue` and the shared `Json`
   * union are structurally incompatible, so a typed hand-off here would need a
   * cast — and a cast is what hid a live defect in this exact call. Instead the
   * row goes through `emit`, whose parse is the single point that decides
   * whether it is a legal WebSocket payload.
   */
  emitCreated(botId: string, message: Message & { attachments: Attachment[] }): void {
    this.emit('message.created', botId, message);
  }

  /**
   * `message.attachments` — the live half of an attachment claimed onto a
   * reply that is already on the client.
   *
   * A bot attaches DURING its turn, but the draft's `message.created` frame
   * left before the turn ran, so its attachment list is empty by construction.
   * Without this frame the claimed file reached a connected client only on its
   * next history fetch — which is to say, on an app restart. The claimant
   * emits here at the moment the claim lands, so the card appears while the
   * bot is still writing the sentence that promises it.
   *
   * The row shape is the WebSocket `Attachment` payload's, not the Prisma row: the
   * claimant reads back exactly the fields the wire schema admits (zod strips
   * the rest), and typing the parameter that way lets a narrowed SELECT pass
   * without a cast.
   */
  emitMessageAttachments(
    botId: string,
    messageId: string,
    attachments: ReadonlyArray<{
      readonly id: string;
      readonly messageId: string | null;
      readonly filename: string;
      readonly mimeType: string;
      readonly sizeBytes: number;
      readonly storageKey: string;
      /** Absent reads as a plain file, which every claimant before voice is. */
      readonly kind?: 'FILE' | 'VOICE_NOTE';
      readonly durationMs?: number | null;
    }>,
  ): void {
    this.emit('message.attachments', botId, { messageId, attachments });
  }

  /** Rows removed from a bot's conversation, after the delete committed. */
  emitMessagesDeleted(botId: string, messageIds: readonly string[], cleared: boolean): void {
    this.emit('message.deleted', botId, {
      botId,
      messageIds,
      ...(cleared && { cleared: true }),
    });
  }

  /**
   * WebSocket `approval.requested`. The only server frame a turn WAITS
   * on: the agent stream has already ended with the call unexecuted, and
   * nothing moves until an `approval.respond` arrives naming this toolCallId.
   *
   * `args` goes through the same parse as every other payload, so a tool input
   * that cannot be represented as WebSocket JSON is dropped here rather than on the
   * client. That drop is a hang — the operator is never asked — which is why
   * the turn ALSO logs the request rather than relying on the frame.
   */
  emitApprovalRequested(
    botId: string,
    request: {
      turnId: string;
      toolCallId: string;
      toolName: string;
      args: unknown;
      binding: ApprovalBinding;
    },
  ): void {
    this.emit('approval.requested', botId, { botId, ...request });
  }

  emitApprovalResolved(
    botId: string,
    request: { turnId: string; toolCallId: string; approved: boolean; reason?: string },
  ) {
    this.emit('approval.resolved', botId, { botId, ...request });
  }

  emitError(botId: string, code: string, message: string): void {
    this.emit('error', botId, { code, message });
  }

  /**
   * WebSocket `bot.status`. What the sidebar's dot reads.
   *
   * The frame follows the durable write rather than replacing it: a client
   * that connects mid-turn gets the status from `GET /bots`, and one already
   * connected gets it here. Emitting without writing would make the dot right
   * only for whoever happened to be watching.
   */
  emitBotStatus(botId: string, status: BotStatus): void {
    this.emit('bot.status', botId, { botId, status });
  }

  /**
   * WebSocket `run.started`. A conversation run exists, whatever
   * started it.
   *
   * The run's own events never travel on this socket: a window reads them by
   * joining the run's delivery log. This frame is the only way a client learns
   * about a run it did not start itself — a routine's, a chain's, or the one
   * that answers a message stored while another run was working.
   */
  emitRunStarted(botId: string, threadId: string, runId: string): void {
    this.emit('run.started', botId, { botId, threadId, runId });
  }

  /**
   * WebSocket `run.settled`. The last word on the messages a run answered.
   *
   * A window that sent one of them — a call, waiting to read the answer
   * aloud — learns here that nothing more is coming for it. The run's own
   * stream cannot say so: a continuation or a folded message's run follows on
   * a new run id, and the window that sent the message may never read either.
   */
  emitRunSettled(payload: {
    botId: string;
    threadId: string;
    runId: string;
    messageIds: readonly string[];
    outcome: RunSettledOutcome;
    reply: string | null;
  }): void {
    this.emit('run.settled', payload.botId, { ...payload, messageIds: [...payload.messageIds] });
  }

  /**
   * WebSocket `mcp.status`. One plugin server's status moved, and the
   * move was not the answer to a request the caller made — a refresh that
   * refused to mint a token is written to the row and told to the window that
   * is watching, so the plugin modal can offer the one fix there is.
   *
   * NO `botId`. Every other frame here is about a bot, and this one is about
   * a server: at this point in M6 it can be enabled for zero or more bots, and
   * naming one of them would make a server-scoped fact look like a bot-scoped
   * one. The payload is `{serverId, status, toolCount, lastError?}` — a status,
   * a count and a bounded sentence (§7.3: there is no field token material
   * could travel in).
   */
  emitMcpStatus(
    userId: string,
    serverId: string,
    status: McpStatus,
    toolCount: number,
    lastError?: string,
  ): void {
    // Spread rather than an always-present key: an absent `lastError` means
    // "nothing to report", and writing `undefined` into the payload would make
    // the frame's shape depend on the caller's argument list.
    this.emitServerScoped(userId, {
      serverId,
      status,
      toolCount,
      ...(lastError === undefined ? {} : { lastError }),
    });
  }

  /**
   * A Work record changed: `task.changed`, `project.changed`,
   * `goal.changed` or `deliverable.changed`.
   *
   * No `botId`, and not because it could not be found: these frames are the
   * operator's views being told to refetch, and a bot is never sent anything
   * because a task changed. Naming a bot here would make a record
   * about the user's work look like an event in a bot's conversation — which
   * is also why the caller names the owner: there is no bot to read it from.
   */
  emitWorkChanged(
    userId: string,
    type: 'task.changed' | 'project.changed' | 'goal.changed' | 'deliverable.changed',
    payload: unknown,
  ): void {
    this.dispatch(type, { payload }, { userId });
  }

  /**
   * `usage.notice` — the account's plan use crossed 80% or 100% this
   * period. To the account's windows, never a bot's conversation: a plan is not
   * something a bot did.
   */
  emitUsageNotice(
    userId: string,
    payload: { kind: 'compute' | 'model'; level: 80 | 100; resetsAt: string },
  ): void {
    this.dispatch('usage.notice', { payload }, { userId });
  }

  /**
   * `bots.changed` — the roster moved (created, updated, deleted).
   *
   * Emitted by BotsService after the durable write, for the same reason
   * `bot.status` is written before it is emitted: a window that connects
   * later reads the roster from `GET /bots`, and this frame exists so the
   * windows that are already open do not have to wait for a reload.
   *
   * The caller names the owner rather than the bus reading it, because a
   * `deleted` frame is sent after the row is gone and there is nothing left
   * to read it from.
   */
  emitBotsChanged(userId: string, botId: string, change: 'created' | 'updated' | 'deleted'): void {
    this.dispatch('bots.changed', { botId, payload: { botId, change } }, { userId });
  }

  /**
   * WebSocket `sandbox.state`. Chat and sandbox frames share this bus
   * because a client holds one socket and does not care which subsystem a
   * frame came from.
   */
  emitSandboxState(botId: string, state: string, widthPx: number, heightPx: number): void {
    this.emit('sandbox.state', botId, { botId, state, widthPx, heightPx });
  }

  /**
   * WebSocket `recording.event`. The payload carries `counts` rather than
   * a sequence number, so it is a counter update naming the event that moved
   * it — which is why the tee is free to send one per interval instead of one
   * per captured event.
   */
  emitRecordingEvent(
    botId: string,
    recordingId: string,
    layer: string,
    type: string,
    counts: { x11: number; cdp: number },
  ): void {
    this.emit('recording.event', botId, { recordingId, layer, type, counts });
  }

  /** WebSocket `recording.state` — every transition of a `Recording` row. */
  emitRecordingState(botId: string, recordingId: string, state: string): void {
    this.emit('recording.state', botId, { recordingId, state });
  }

  /**
   * WebSocket `skill.compiled`.
   *
   * Carries the name as well as the id because it is what the notification
   * says out loud — "learned open_settings" — and a client that only had the
   * id would have to fetch the skill to render the one line it is showing.
   */
  emitSkillCompiled(botId: string, recordingId: string, skillId: string, name: string): void {
    this.emit('skill.compiled', botId, { recordingId, skillId, name });
  }

  /**
   * The single envelope builder for a frame that belongs to a bot. Every WebSocket
   * frame that names one leaves through here, so the envelope shape
   * (`id`/`type`/`botId`/`ts`/`payload`) is written once.
   *
   * `botId` is REQUIRED, and that requirement is the fence rather than a
   * formality: WebSocket envelope makes the field optional on EVERY frame in the
   * registry, so a bot-scoped frame that lost its id would still parse here
   * and still reach the client — the compile error is the only thing between a
   * mistake at a call site and a transcript the client cannot route. The one
   * frame that is about a SERVER rather than a bot (`mcp.status`) has its own
   * door below rather than widening this one.
   */
  private emit(type: ServerEventType, botId: string, payload: unknown): void {
    this.dispatch(type, { botId, payload }, { botId });
  }

  /**
   * The one WebSocket frame that names no bot: `mcp.status`.
   *
   * It carries the server it is about and deliberately not a bot — a server
   * can be enabled for zero or more bots, so naming one would make a
   * server-scoped fact look bot-scoped — and WebSocket admits the absent id. The
   * spread rather than an always-present key is what keeps it out of the bytes
   * instead of in them as `null`.
   */
  private emitServerScoped(userId: string, payload: unknown): void {
    this.dispatch('mcp.status', { payload }, { userId });
  }

  /** The parse-then-deliver half, shared by every door above. */
  private dispatch(
    type: ServerEventType,
    envelope: { botId?: string; payload: unknown },
    audience: FrameAudience,
  ): void {
    const frame = ServerFrameSchema.safeParse(
      toWireValue({ id: randomUUID(), type, ts: Date.now(), ...envelope }),
    );
    if (!frame.success) {
      // Dropping is correct — the client would reject this frame anyway — but
      // it must never be silent: a dropped frame is a stalled transcript.
      this.logger.error(
        `Refused to emit a ${type} frame that violates §4.2: ${frame.error.message}`,
      );
      return;
    }
    // Nobody to tell, so nothing to resolve: this is also what keeps a
    // process with no window open from reading an owner per bot it touches.
    if (this.clients.size === 0) return;

    this.seq += 1;
    const outgoing: Outgoing = { frame: frame.data, seq: this.seq };
    if ('userId' in audience) {
      this.deliver(outgoing, audience.userId);
      return;
    }
    const owner = this.owners.get(audience.botId);
    if (owner !== undefined) {
      this.deliver(outgoing, owner);
      return;
    }
    // Per bot rather than one queue for everything, so a slow read stalls
    // one bot's frames and not every account's. What that gives up is the
    // order BETWEEN a bot's first frames and a frame addressed to the user,
    // and nothing depends on that: the frames without a bot are all "refetch
    // this" notices.
    const queued = this.awaitingOwner.get(audience.botId);
    if (queued !== undefined) {
      queued.push(outgoing);
      return;
    }
    this.awaitingOwner.set(audience.botId, [outgoing]);
    void this.resolveOwner(audience.botId);
  }

  /**
   * Read a bot's owner, then release the frames that waited for it, in order.
   *
   * The queue is taken and the cache filled in one synchronous step, so a
   * frame emitted after this runs goes straight to `deliver` and cannot
   * overtake one that was queued before it.
   */
  private async resolveOwner(botId: string): Promise<void> {
    let owner: string | null = null;
    let why = 'no such bot';
    try {
      const row = await this.prisma.bot.findUnique({
        where: { id: botId },
        select: { userId: true },
      });
      owner = row?.userId ?? null;
    } catch (error: unknown) {
      why = error instanceof Error ? error.message : String(error);
    }
    const frames = this.awaitingOwner.get(botId) ?? [];
    this.awaitingOwner.delete(botId);
    if (owner === null) {
      // Not cached: a read that failed, or a bot not committed yet, is asked
      // again by the next frame rather than remembered as ownerless.
      this.logger.warn(
        `Dropped ${String(frames.length)} frame(s) for bot ${botId}: owner unknown (${why})`,
      );
      return;
    }
    this.owners.set(botId, owner);
    for (const frame of frames) this.deliver(frame, owner);
  }

  private deliver({ frame, seq }: Outgoing, userId: string): void {
    // Stamped here rather than before the parse above, because the
    // union schemas do not declare `wireVersion` and zod strips what they do
    // not declare — a stamp applied first would be removed by that parse.
    const encoded = JSON.stringify(stampWireVersion(frame));
    for (const [client, { audience, since }] of this.clients) {
      if (client.readyState !== WS_OPEN || since >= seq) continue;
      const current = audience.userId();
      if (current === null) {
        // Removed first, so the socket is ended once however many frames
        // arrive before its close event does.
        this.clients.delete(client);
        audience.expired();
        continue;
      }
      if (current === userId) sendBounded(client, encoded);
    }
  }
}
