import { Inject, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import {
  ClientEventSchemas,
  CLIENT_EVENT_TYPES,
  decodeScreenInputFrame,
  readClientEnvelope,
  stampWireVersion,
  type WsFrame,
} from '@crewaid/shared';
import { TurnEventBus } from '../agent/turn-event.bus.js';
import { TurnControlService } from '../agent/turn-control.service.js';
import { validateClientInput } from '../screen/rfb-input.js';
import { ScreenError, ScreenService } from '../screen/screen.service.js';
import { recallHandshake } from './ws-adapter.js';
import { WsPrincipals } from './ws-principals.js';
import { nestsDeeperThan, sendBounded, WS_MAX_FRAME_DEPTH } from './ws-limits.js';

/**
 * How long a revoked session's LISTENING socket can go on receiving.
 *
 * A socket that sends nothing is never asked about by a control frame, so
 * without a sweep a signed-out window would keep streaming transcripts and
 * screens until it happened to reconnect. The bus checks EXPIRY per frame
 * against a timestamp, so for chat frames this bounds only revocation; screen
 * frames do not go through the bus, and this bounds both for them. The cost is
 * one session read per open socket per interval.
 */
const REVOCATION_SWEEP_MS = 15_000;

/**
 * The WS gateway.
 *
 * Single endpoint: `ws://<host>/ws?token=<session token>`. The handshake is
 * part of the §4.4 auth boundary: CrewaidWsAdapter's ws `verifyClient` hook
 * resolves the session during HTTP Upgrade, so bad/missing credentials receive
 * HTTP 401 before a socket is established. The gateway's
 * handleConnection check remains defense in depth and closes 1008 only if a
 * nonstandard adapter bypasses the pre-upgrade hook.
 *
 * Every frame with an effect acts as THE CONNECTION'S OWN PRINCIPAL.
 * Before it, all of them passed `SINGLETON_USER_ID` — so on an install with
 * two accounts, one person's click cancelled the other's turn. The principal
 * is re-checked per control frame rather than trusted from the handshake,
 * because a socket outlives a sign-out: see `WsPrincipals`.
 *
 * Routing: CrewaidWsAdapter normalizes every text frame onto ONE catch-all
 * channel carrying the parsed frame, because Nest's WsAdapter silently drops
 * frames whose event has no handler — and WebSocket requires every frame to be
 * answered (an `error` frame for anything invalid). The CONTRACTUAL event
 * names and payload schemas come from packages/shared's registries, never
 * hand-typed literals.
 *
 * M2 adds the §4.3 screen subscriptions at those per-type branches. They are
 * the first client events that can FAIL for a reason the client must see —
 * a stopped sandbox, a bot that is not theirs — so they answer with a WebSocket
 * `error` frame rather than throwing into the socket, where Nest would close
 * the connection and take every other subscription with it.
 *
 * `screen.input` arrives on a third channel because it is binary and has no
 * envelope to route on; see `handleBinary`.
 */
@WebSocketGateway({ path: '/ws' })
export class WsGateway implements OnGatewayConnection, OnModuleInit, OnModuleDestroy {
  private readonly inputQueues = new WeakMap<WebSocket, { tail: Promise<void>; depth: number }>();

  private readonly logger = new Logger(WsGateway.name);
  /** Every admitted socket, for the revocation sweep. */
  private readonly admitted = new Set<WebSocket>();
  private sweep: NodeJS.Timeout | undefined;

  constructor(
    @Inject(TurnEventBus) private readonly turnEvents: TurnEventBus,
    @Inject(TurnControlService) private readonly turns: TurnControlService,
    @Inject(ScreenService) private readonly screens: ScreenService,
    @Inject(WsPrincipals) private readonly principals: WsPrincipals,
  ) {}

  onModuleInit(): void {
    this.sweep = setInterval(() => void this.sweepRevoked(), REVOCATION_SWEEP_MS);
    // A timer must not be the thing keeping a process alive after shutdown.
    this.sweep.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweep);
  }

  /**
   * End every admitted socket whose session is gone.
   *
   * `fresh`, because re-reading the row is the sweep's whole job: a socket
   * that acted within the last second would otherwise be answered from the
   * memo. `principalFor` keeps the principal through a database blip, so an
   * outage cannot sign everybody out — and cannot extend a session past its
   * expiry either, which is checked without the read.
   */
  async sweepRevoked(): Promise<void> {
    await Promise.all(
      [...this.admitted].map(async (client) => {
        const principal = await this.principals.principalFor(client, { fresh: true });
        if (principal === null) this.refuseRevoked(client, null);
      }),
    );
  }

  /**
   * The connection is only usable once its owner is known.
   *
   * The session was already resolved during the Upgrade, so this reads the
   * verdict rather than repeating the lookup. An absent verdict means the
   * pre-upgrade hook did not run — a nonstandard adapter — and the socket is
   * closed rather than admitted as nobody, which is what the old code's
   * fall-through to `SINGLETON_USER_ID` amounted to.
   */
  handleConnection(client: WebSocket, request: IncomingMessage): void {
    const admitted = recallHandshake(request);
    if (admitted === undefined) {
      this.logger.warn('WS handshake rejected: no session resolved during upgrade');
      client.close(1008, 'Unauthorized');
      return;
    }
    this.principals.register(client, admitted.userId, admitted.token, admitted.expiresAt);
    this.admitted.add(client);
    client.once('close', () => this.admitted.delete(client));
    // The account is asked per frame rather than captured here, so a session
    // that expires mid-stream stops receiving at its next frame.
    this.turnEvents.add(client, {
      userId: () => this.principals.currentUserId(client),
      expired: () => this.refuseRevoked(client, null),
    });
    // A dropped socket is an unsubscribe from every screen it was watching.
    // Without this the multiplexer keeps pulling frames for a viewer that no
    // longer exists, and nothing errors to reveal it.
    client.once('close', () => this.screens.detach(client));
  }

  /**
   * The session behind this socket is gone. Answer, then close.
   *
   * The frame is answered first because a socket that simply drops is
   * indistinguishable from a network failure, and the operator's next move
   * would be to retry rather than to sign in. 1008 is `ws`'s policy-violation
   * close, which is what an expired credential is.
   */
  private refuseRevoked(client: WebSocket, id: string | null): void {
    this.admitted.delete(client);
    this.sendError(client, id, 'This session is no longer valid. Sign in again.');
    client.close(1008, 'Unauthorized');
  }

  private sendError(
    client: WebSocket,
    id: string | null,
    message: string,
    code = 'VALIDATION_ERROR',
  ): void {
    sendBounded(
      client,
      JSON.stringify(
        stampWireVersion({
          // WebSocket requires an id on every frame; error replies correlate to
          // the offending frame when its id parsed, else the all-zero uuid.
          id: id ?? '00000000-0000-4000-8000-000000000000',
          type: 'error',
          ts: Date.now(),
          payload: { code, message },
        }),
      ),
    );
  }

  /**
   * WebSocket `screen.input`. The only binary client frame there is.
   *
   * It carries no JSON envelope — raw RFB bytes behind the D-035 header — so
   * there is no frame id to correlate a failure to, and a refusal answers with
   * the all-zero uuid the way `handleRaw` does.
   *
   * Every refusal IS answered rather than dropped, even though this is a
   * high-rate path. A client whose input silently goes nowhere looks exactly
   * like a wedged desktop, and that is the single most expensive way for this
   * to fail: the operator concludes the sandbox is broken and restarts it.
   */
  @SubscribeMessage('crewaid.ws.binary')
  async handleBinary(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() payload: unknown,
  ): Promise<void> {
    if (!Buffer.isBuffer(payload)) {
      this.sendError(client, null, 'Binary frame did not arrive as bytes');
      return;
    }
    const decoded = decodeScreenInputFrame(payload);
    if (!decoded.ok) {
      this.sendError(client, null, decoded.reason);
      return;
    }
    const validInput = validateClientInput(decoded.frame.rfb);
    if (!validInput.ok) {
      this.sendError(client, null, validInput.reason);
      return;
    }
    let queue = this.inputQueues.get(client);
    if (queue === undefined) {
      queue = { tail: Promise.resolve(), depth: 0 };
      this.inputQueues.set(client, queue);
    }
    if (queue.depth >= 256) {
      client.close(1008, 'Screen input queue exceeded');
      this.screens.detach(client);
      return;
    }
    queue.depth += 1;
    const pending = queue.tail.then(() => this.forwardBinary(client, decoded.frame));
    // One failed send cannot poison all later input. The caller still sees its
    // own error, while the queue remains bounded and preserves press/release order.
    queue.tail = pending.catch(() => undefined);
    try {
      await pending;
    } finally {
      queue.depth -= 1;
    }
  }

  private async forwardBinary(
    client: WebSocket,
    frame: { botId: string; rfb: Uint8Array; epoch: number },
  ): Promise<void> {
    if (client.readyState !== 1) return;
    // `ScreenService.input` only fences on being SUBSCRIBED, and a subscription
    // outlives the session that opened it — so without this, revoking a session
    // would leave its owner typing into a desktop until they closed the window.
    // The one frame that does NOT pass `fresh`: it arrives per mouse move, and
    // re-reading the session row that often would cost tens of queries a second
    // per viewer. `WsPrincipals` bounds the staleness instead, and expiry is
    // still exact because that is a timestamp rather than a query.
    const principal = await this.principals.principalFor(client);
    if (principal === null) {
      this.refuseRevoked(client, null);
      return;
    }
    if (client.readyState !== 1) return;
    try {
      this.screens.input(client, frame.botId, frame.rfb, frame.epoch);
    } catch (error: unknown) {
      this.sendError(
        client,
        null,
        messageOf(error),
        error instanceof ScreenError ? error.code : undefined,
      );
    }
  }

  /**
   * Raw catch-all: non-JSON text and objects without a usable `type` land
   * here (routed by CrewaidWsAdapter's parser) so they get a VALIDATION_ERROR
   * reply instead of silence.
   */
  @SubscribeMessage('crewaid.ws.raw')
  handleRaw(@ConnectedSocket() client: WebSocket): void {
    this.sendError(
      client,
      null,
      'Frame is not a §4.2 envelope (needs id, type, ts, payload as JSON)',
    );
  }

  /**
   * The single frame entrypoint (fed by CrewaidWsAdapter's parser as
   * `crewaid.ws.frame`). Validates the WebSocket envelope and the per-type payload
   * against the shared registries.
   */
  @SubscribeMessage('crewaid.ws.frame')
  handleFrame(@ConnectedSocket() client: WebSocket, @MessageBody() frame: unknown): void {
    // The shared JSON schema is recursive, and a client chooses how deep a
    // frame nests: a megabyte of `[[[…]]]` is a stack overflow inside the
    // parse below. No frame in the contract is anywhere near this deep.
    if (nestsDeeperThan(frame, WS_MAX_FRAME_DEPTH)) {
      this.sendError(client, null, 'Frame fails the §4.2 envelope');
      return;
    }
    // The adapter routed here because the text parsed as JSON with a string
    // `type`. Re-validate the FULL envelope through the shared schema —
    // that schema is the contract, not this handler's opinion.
    const envelope = readClientEnvelope(frame);
    if (!envelope.ok) {
      // The two failures are different problems and get different
      // sentences. "Your build is newer than this orchestrator" is something
      // an operator can act on; "this frame is broken" is not, and one
      // message for both is the silent gap CC-19 exists to close.
      this.sendError(
        client,
        null,
        envelope.reason === 'unsupported-version'
          ? `Frame is wire version ${envelope.wireVersion}; this orchestrator speaks ${envelope.supported}. Update the orchestrator, or use a desktop build that matches it.`
          : 'Frame fails the §4.2 envelope',
      );
      return;
    }

    const valid: WsFrame = envelope.frame;
    if (!(CLIENT_EVENT_TYPES as readonly string[]).includes(valid.type)) {
      this.sendError(client, valid.id, `Unknown event type: ${valid.type}`);
      return;
    }

    const schema = ClientEventSchemas[valid.type as keyof typeof ClientEventSchemas];
    const payload = schema.safeParse(valid.payload);
    if (!payload.success) {
      this.sendError(
        client,
        valid.id,
        `Payload for ${valid.type} is invalid: ${payload.error.issues[0]?.message ?? 'unknown'}`,
      );
      return;
    }

    if (valid.type === 'bot.cancel') {
      // The producer checks the run's owner and only aborts this bot's run —
      // so passing the WRONG principal here does not cancel somebody else's
      // run, it silently cancels nothing. That is the failure this frame used to have with one
      // account and would have had with two.
      const cancelPayload = ClientEventSchemas['bot.cancel'].parse(valid.payload);
      void this.principals.principalFor(client, { fresh: true }).then((principal) => {
        if (principal === null) {
          this.refuseRevoked(client, valid.id);
          return;
        }
        this.turns.cancelTurn(principal.userId, cancelPayload.botId);
      });
      return;
    }

    if (valid.type === 'screen.subscribe') {
      const subscribe = ClientEventSchemas['screen.subscribe'].parse(valid.payload);
      // Fire-and-forget with an explicit catch: the handler is sync because
      // §4.2 frames are not request/response, and an unhandled rejection here
      // would take the process down over one bad subscribe.
      void this.principals
        .principalFor(client, { fresh: true })
        .then(async (principal) => {
          if (principal === null) {
            this.refuseRevoked(client, valid.id);
            return;
          }
          // Watching a screen is the longest-lived thing a frame can start, so
          // it is the one most worth checking freshly: a subscribe admitted on
          // a dead session would let it drive a desktop for as long as the
          // socket stayed open.
          await this.screens.subscribe(principal.userId, client, subscribe.botId);
        })
        .catch((error: unknown) => {
          this.sendError(client, valid.id, messageOf(error));
        });
      return;
    }

    if (valid.type === 'screen.control') {
      const request = ClientEventSchemas['screen.control'].parse(valid.payload);
      void this.principals
        .principalFor(client, { fresh: true })
        .then(async (principal) => {
          if (principal === null) {
            this.refuseRevoked(client, valid.id);
            return;
          }
          await this.screens.control(client, request.botId, request);
        })
        .catch((error: unknown) => {
          this.sendError(
            client,
            valid.id,
            messageOf(error),
            error instanceof ScreenError ? error.code : undefined,
          );
        });
      return;
    }

    if (valid.type === 'screen.unsubscribe') {
      const unsubscribe = ClientEventSchemas['screen.unsubscribe'].parse(valid.payload);
      this.screens.unsubscribe(client, unsubscribe.botId);
      return;
    }

    if (valid.type === 'approval.respond') {
      // M5-BE-09. The turn is already stopped — the agent stream ended with
      // the call unexecuted — so this only has to reach the promise it is
      // waiting on. Synchronous for the same reason `bot.cancel` is: the
      // operator's click should not wait on a database round trip.
      //
      // A response nobody is waiting on is answered, not silently dropped. It
      // means the turn was cancelled, the orchestrator restarted, or the
      // button was clicked twice, and a client that hears nothing back leaves
      // a prompt on screen that will never resolve.
      const response = ClientEventSchemas['approval.respond'].parse(valid.payload);
      void this.principals
        .principalFor(client, { fresh: true })
        .then(async (principal) => {
          if (principal === null) {
            this.refuseRevoked(client, valid.id);
            return;
          }
          const outcome = await this.turns.respondToApproval(
            principal.userId,
            response.toolCallId,
            response.approved,
            response.reason,
            response.editedArgs,
          );
          // D-191: a run's approval is answered through `POST /bots/:id/chat`,
          // which records the decision before anything acts on it; delivering
          // it here would approve a call the durable admission never saw.
          if (outcome === 'wrong-route') {
            this.sendError(
              client,
              valid.id,
              'This conversation answers approvals over its chat route, not this frame.',
            );
          } else if (outcome === 'not-waiting') {
            this.sendError(
              client,
              valid.id,
              `No tool call is waiting on approval ${response.toolCallId}`,
            );
          }
        })
        .catch(() =>
          this.sendError(client, valid.id, 'Approval could not be recorded; try again.'),
        );
      return;
    }

    // Valid frame on a known client→server type with no side effects yet.
    this.logger.debug(`ws frame accepted: ${valid.type}`);
    void client;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
