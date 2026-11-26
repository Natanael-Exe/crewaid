import { type INestApplicationContext } from '@nestjs/common';
import type { StructuredLogger } from '../logging/structured-logger.js';
import { WsAdapter } from '@nestjs/platform-ws';
import type { IncomingMessage } from 'node:http';
import { CONNECTOR_WS_PATH, SCREEN_STREAM_PATH } from '@crewaid/shared';
import { rememberHandshake, verifyWsHandshake } from './ws-adapter.js';
import { WS_MAX_INBOUND_FRAME_BYTES } from './ws-limits.js';
import { ConnectorWsHost } from '../connectors/connector-ws.host.js';
import { ScreenStreamHost } from '../screen/screen-stream.host.js';

type CrewaidWsData = string | Buffer | ArrayBuffer | Buffer[];
type WsVerifyInfo = { req: IncomingMessage };
type WsVerifyDone = (
  verified: boolean,
  code?: number,
  message?: string,
  headers?: string[],
) => void;

/** Typed-frame channel the gateway's catch-all handler subscribes to. */
export const CREWAID_WS_FRAME_EVENT = 'crewaid.ws.frame';
/** Raw channel for non-JSON text (no envelope at all). */
export const CREWAID_WS_RAW_EVENT = 'crewaid.ws.raw';
/** Binary channel: §4.3 `screen.input`, which has no JSON envelope by design. */
export const CREWAID_WS_BINARY_EVENT = 'crewaid.ws.binary';

/**
 * The WebSocket WS transport adapter.
 *
 * Two problems with Nest's stock WsAdapter for the WebSocket contract:
 *
 * 1. Its default parser expects socket.io's `{event, data}` shape, but WebSocket
 * frames carry the event key in `type` and the body at top level.
 * 2. Frames whose routed event has no registered handler are silently
 * DROPPED (bindMessageHandler catches and returns EMPTY). WebSocket requires
 * every frame to be answered — an `error` frame for anything invalid.
 *
 * Fix: the parser routes every JSON object with a string `type` to a single
 * `crewaid.ws.frame` channel (the gateway's catch-all handler validates against
 * the shared registries and answers error frames); non-JSON text routes to
 * `crewaid.ws.raw`, which the gateway also subscribes.
 *
 * A third channel carries binary frames. WebSocket gives `screen.input` no JSON
 * envelope at all — it is raw RFB bytes under the D-035 header — so it cannot
 * be routed by a `type` field, and running it through `JSON.parse` would land
 * every mouse move on the raw channel and answer it with a VALIDATION_ERROR.
 * `ws` hands text frames to a MessageEvent as a `string` and binary frames as
 * a Buffer, so the payload's own type is the discriminator; nothing has to be
 * sniffed.
 */
export class CrewaidWsAdapter extends WsAdapter {
  /**
   * NOT named `logger`: Nest's `WsAdapter` base class already owns that
   * property with an incompatible type, so shadowing it fails to compile.
   * Optional so tests can construct the adapter bare; when main.ts supplies
   * it, every pre-upgrade rejection is logged — see `create` below.
   */
  private readonly adapterLogger: StructuredLogger | undefined;
  /** Where the screen stream host is found, when there is an app to ask. */
  private readonly appContext: INestApplicationContext | undefined;
  private screenStreamMounted = false;
  private connectorStreamMounted = false;

  constructor(appOrHttpServer?: INestApplicationContext | object, logger?: StructuredLogger) {
    super(appOrHttpServer, {
      messageParser: (data: CrewaidWsData): { event: string; data: unknown } | undefined => {
        if (typeof data !== 'string') {
          return { event: CREWAID_WS_BINARY_EVENT, data: toBuffer(data) };
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          return { event: CREWAID_WS_RAW_EVENT, data: undefined };
        }
        if (typeof parsed !== 'object' || parsed === null) {
          return { event: CREWAID_WS_RAW_EVENT, data: parsed };
        }
        const frame = parsed as { type?: unknown };
        if (typeof frame.type !== 'string' || frame.type === '') {
          return { event: CREWAID_WS_RAW_EVENT, data: parsed };
        }
        return { event: CREWAID_WS_FRAME_EVENT, data: parsed };
      },
    });
    this.adapterLogger = logger;
    this.appContext = isAppContext(appOrHttpServer) ? appOrHttpServer : undefined;
  }

  /**
   * Supply ws's verifyClient hook because Nest's WsAdapter only forwards the
   * message parser from its constructor options. This runs while handling the
   * HTTP Upgrade request, so bad credentials receive a genuine 401 and never
   * become a WebSocket connection.
   *
   * This is the PRIMARY auth boundary for WebSocket, so it is also the only place
   * that can see a failed WS authentication. WsGateway.handleConnection logs
   * its own rejection, but that path fires only if a nonstandard adapter
   * bypasses this hook — meaning that without the line below, credential
   * probing against /ws left no trace anywhere. The token is never logged.
   */
  override create(
    port: Parameters<WsAdapter['create']>[0],
    options?: Parameters<WsAdapter['create']>[1],
  ): ReturnType<WsAdapter['create']> {
    this.mountScreenStream(port);
    this.mountConnectorStream(port);
    return super.create(port, {
      ...options,
      maxPayload: WS_MAX_INBOUND_FRAME_BYTES,
      // ASYNCHRONOUS since V1-09: the credential is a session row, not a
      // string to compare. `verifyClient`'s callback form is what makes that
      // possible without giving up D-024 — `ws` holds the Upgrade open until
      // `done` is called, so a refusal is still an HTTP 401 and still happens
      // before any socket exists.
      verifyClient: (info: WsVerifyInfo, done: WsVerifyDone) => {
        void verifyWsHandshake(info.req)
          .then((verdict) => {
            if (verdict.ok) {
              // Handed to the gateway through the request object, so the
              // socket is registered as its owner without a second lookup.
              rememberHandshake(info.req, verdict);
              done(true);
              return;
            }
            this.adapterLogger?.warn('ws.handshake.rejected', { status: verdict.status });
            done(false, verdict.status, 'Unauthorized');
          })
          .catch(() => {
            // `verifyWsHandshake` already swallows a failed lookup into a 401,
            // so reaching here means something unforeseen. Refuse: an
            // exception on the auth path must never become an admitted socket.
            this.adapterLogger?.warn('ws.handshake.rejected', { status: 401 });
            done(false, 401, 'Unauthorized');
          });
      },
    });
  }

  /**
   * Put the screen stream route on the same HTTP server as WebSocket.
   *
   * Not optional, and not something the screen module can do for itself:
   * Nest's adapter takes every Upgrade on its server and DESTROYS the socket of
   * any path it has no server registered for. A second `upgrade` listener
   * would find its socket already gone. So the stream host's server is
   * registered here, beside the gateway's, and Nest routes to it by path. Its
   * own `verifyClient` checks the ticket; the session check above never sees it.
   */
  private mountScreenStream(port: Parameters<WsAdapter['create']>[0]): void {
    if (this.screenStreamMounted || this.appContext === undefined) return;
    let host: ScreenStreamHost;
    try {
      host = this.appContext.get(ScreenStreamHost, { strict: false });
    } catch {
      // An app without the screen module (a focused test) has no stream route.
      return;
    }
    this.screenStreamMounted = true;
    this.addWsServerToRegistry(host.server, port, SCREEN_STREAM_PATH);
  }

  /**
   * Put the local connector route (`/ws/connectors`) on the same HTTP server,
   * authenticated by `ConnectorWsHost`'s own `Authorization: Bearer crw_conn_…`
   * pre-upgrade check rather than the desktop session cookie/token check.
   */
  private mountConnectorStream(port: Parameters<WsAdapter['create']>[0]): void {
    if (this.connectorStreamMounted || this.appContext === undefined) return;
    let host: ConnectorWsHost;
    try {
      host = this.appContext.get(ConnectorWsHost, { strict: false });
    } catch {
      // An app without the connectors module (a focused test) has no connector route.
      return;
    }
    this.connectorStreamMounted = true;
    this.addWsServerToRegistry(host.server, port, CONNECTOR_WS_PATH);
  }
}

function isAppContext(value: unknown): value is INestApplicationContext {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { get?: unknown }).get === 'function' &&
    typeof (value as { select?: unknown }).select === 'function'
  );
}

/**
 * Normalise whatever `ws` hands over for a binary frame. It is a Buffer under
 * the default `binaryType` and this adapter never changes it, but the other
 * two shapes are one line each and the alternative to handling them is a
 * runtime surprise on a config change nobody connects to this file.
 */
function toBuffer(data: Exclude<CrewaidWsData, string>): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
