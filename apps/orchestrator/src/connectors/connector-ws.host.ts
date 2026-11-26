import type { IncomingMessage } from 'node:http';
import { Inject, Injectable, Optional, type OnModuleDestroy } from '@nestjs/common';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  ConnectorClientFrameSchema,
  MIN_CONNECTOR_PROTOCOL_VERSION,
  type ConnectorServerFrame,
  type ConnectorTaskProgressFrame,
  type ConnectorTaskResultFrame,
  type LocalConnectorHarnessId,
  type LocalConnectorReportMode,
} from '@crewaid/shared';

import { StructuredLogger } from '../logging/structured-logger.js';
import {
  ConnectorsService,
  type AuthenticatedConnector,
} from './connectors.service.js';

export const CONNECTOR_WS_MAX_PAYLOAD_BYTES = 512 * 1024;
export const DEFAULT_CONNECTOR_HEARTBEAT_MS = 15_000;
export const DEFAULT_CONNECTOR_DISCONNECT_GRACE_MS = 60_000;
export const DEFAULT_CONNECTOR_HELLO_TIMEOUT_MS = 10_000;
export const DEFAULT_CONNECTOR_CANCEL_GRACE_MS = 5_000;

export const CONNECTOR_WS_OPTIONS = Symbol('CONNECTOR_WS_OPTIONS');

export interface ConnectorWsHostOptions {
  readonly heartbeatMs?: number;
  readonly disconnectGraceMs?: number;
  readonly helloTimeoutMs?: number;
  readonly cancelGraceMs?: number;
  readonly minProtocolVersion?: number;
}

export type ConnectorDispatchErrorCode =
  | 'CONNECTOR_OFFLINE'
  | 'CONNECTOR_BUSY'
  | 'ABORTED';

export class ConnectorDispatchError extends Error {
  constructor(
    readonly code: ConnectorDispatchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ConnectorDispatchError';
  }
}

export interface DispatchLocalTaskInput {
  readonly connectorId: string;
  readonly sessionId: string;
  readonly payloadHash: string;
  readonly botId: string;
  readonly botName: string;
  readonly relativeCwd: string;
  readonly harness: LocalConnectorHarnessId;
  readonly prompt: string;
  readonly verifyCommand?: string;
  readonly maxDurationMs: number;
  readonly abortSignal?: AbortSignal;
  readonly onProgress?: (frame: ConnectorTaskProgressFrame) => void;
}

interface LiveConnector {
  readonly connectorId: string;
  readonly userId: string;
  readonly name: string;
  readonly socket: WebSocket;
  readonly workspaceName: string;
  readonly hostName: string;
  readonly harnesses: readonly LocalConnectorHarnessId[];
  readonly defaultHarness: LocalConnectorHarnessId | null;
  readonly reportMode: LocalConnectorReportMode;
  readonly cliVersion: string;
  alive: boolean;
  superseded: boolean;
  heartbeatTimer: NodeJS.Timeout | undefined;
}

interface PendingTask {
  readonly connectorId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly reportMode: LocalConnectorReportMode;
  readonly startedAt: number;
  readonly onProgress?: (frame: ConnectorTaskProgressFrame) => void;
  readonly resolve: (result: ConnectorTaskResultFrame) => void;
  readonly cleanupAbort: () => void;
  graceTimer: NodeJS.Timeout | undefined;
  cancelTimer: NodeJS.Timeout | undefined;
  deadlineTimer: NodeJS.Timeout | undefined;
  settled: boolean;
}

const WS_OPEN = 1;

function extractBearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const trimmed = header.trim();
  if (!/^bearer\s+/i.test(trimmed)) return null;
  const token = trimmed.slice(trimmed.search(/\s/) + 1).trim();
  return token === '' ? null : token;
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function sendFrame(socket: WebSocket, frame: ConnectorServerFrame): boolean {
  if (socket.readyState !== WS_OPEN) return false;
  try {
    socket.send(JSON.stringify(frame));
    return true;
  } catch {
    return false;
  }
}

/**
 * Outbound WebSocket host for standalone `crewaid-connect` daemons (`/ws/connectors`).
 *
 * Mounted on the orchestrator's HTTP server by `CrewaidWsAdapter` alongside
 * `/ws/screen`. Enforces:
 * - `Authorization: Bearer crw_conn_…` header authentication during Upgrade (401 before socket exists).
 * - Protocol version gate (`MIN_CONNECTOR_PROTOCOL_VERSION`, close `4003` + `CLI_OUTDATED`).
 * - Single active task per connector (`CONNECTOR_BUSY`).
 * - 60s mid-task disconnect grace window with `activeSessionId` reattach (or `task.cancel` if expired).
 * - Zero server→connector permission-answer channel by protocol design.
 */
@Injectable()
export class ConnectorWsHost implements OnModuleDestroy {
  readonly server: WebSocketServer;

  private readonly heartbeatMs: number;
  private readonly disconnectGraceMs: number;
  private readonly helloTimeoutMs: number;
  private readonly cancelGraceMs: number;
  private readonly minProtocolVersion: number;

  private readonly admitted = new WeakMap<IncomingMessage, AuthenticatedConnector>();
  private readonly connections = new Map<string, LiveConnector>();
  private readonly activeTasks = new Map<string, PendingTask>();

  constructor(
    @Inject(ConnectorsService) private readonly connectors: ConnectorsService,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
    @Optional() @Inject(CONNECTOR_WS_OPTIONS) options?: ConnectorWsHostOptions,
  ) {
    this.heartbeatMs = options?.heartbeatMs ?? DEFAULT_CONNECTOR_HEARTBEAT_MS;
    this.disconnectGraceMs = options?.disconnectGraceMs ?? DEFAULT_CONNECTOR_DISCONNECT_GRACE_MS;
    this.helloTimeoutMs = options?.helloTimeoutMs ?? DEFAULT_CONNECTOR_HELLO_TIMEOUT_MS;
    this.cancelGraceMs = options?.cancelGraceMs ?? DEFAULT_CONNECTOR_CANCEL_GRACE_MS;
    this.minProtocolVersion = options?.minProtocolVersion ?? MIN_CONNECTOR_PROTOCOL_VERSION;

    this.connectors.attachHost({
      isBusy: (connectorId) => this.isBusy(connectorId),
      isConnectedLocally: (connectorId) => this.isConnectedLocally(connectorId),
      kick: (connectorId, code, reason) => this.kick(connectorId, code, reason),
    });

    this.server = new WebSocketServer({
      noServer: true,
      maxPayload: CONNECTOR_WS_MAX_PAYLOAD_BYTES,
      verifyClient: (
        info: { req: IncomingMessage },
        done: (verified: boolean, code?: number, message?: string) => void,
      ) => {
        const token = extractBearerToken(info.req);
        if (token === null) {
          this.logger.warn('connector.ws.rejected', { reason: 'missing_bearer' });
          done(false, 401, 'Unauthorized');
          return;
        }
        void this.connectors
          .authenticateBearer(token)
          .then((auth) => {
            if (auth === null) {
              this.logger.warn('connector.ws.rejected', { reason: 'invalid_token' });
              done(false, 401, 'Unauthorized');
              return;
            }
            this.admitted.set(info.req, auth);
            done(true);
          })
          .catch(() => {
            this.logger.warn('connector.ws.rejected', { reason: 'auth_error' });
            done(false, 401, 'Unauthorized');
          });
      },
    });

    this.server.on('error', (error: Error) => {
      this.logger.error(`connector ws server error: ${error.message}`);
    });

    this.server.on('connection', (socket: WebSocket, request: IncomingMessage) => {
      socket.on('error', (error: Error) => {
        this.logger.warn('connector.ws.socket_error', { detail: error.message });
      });
      this.handleConnection(socket, request);
    });
  }

  isConnectedLocally(connectorId: string): boolean {
    const conn = this.connections.get(connectorId);
    return conn !== undefined && conn.socket.readyState === WS_OPEN;
  }

  isBusy(connectorId: string): boolean {
    return this.activeTasks.has(connectorId);
  }

  /** Test seam & operational counter. */
  connectionCount(): number {
    return this.connections.size;
  }

  /** Immediately disconnect a connector (e.g. token rotation or revocation). */
  kick(connectorId: string, code = 4001, reason = 'Disconnected'): void {
    const conn = this.connections.get(connectorId);
    if (conn !== undefined) {
      conn.superseded = true;
      clearInterval(conn.heartbeatTimer);
      this.connections.delete(connectorId);
      try {
        conn.socket.close(code, reason);
      } catch {
        // Socket may already be closing.
      }
    }
    const task = this.activeTasks.get(connectorId);
    if (task !== undefined) {
      this.settleTask(task, {
        type: 'task.result',
        sessionId: task.sessionId,
        status: 'interrupted',
        acpSessionId: null,
        reportMode: task.reportMode,
        summary: `Local connector was disconnected (${reason}).`,
        filesChanged: [],
        commandsRun: [],
        steps: 0,
        durationMs: Math.max(0, Date.now() - task.startedAt),
        error: { code: 'CONNECTOR_REVOKED', message: reason },
      });
    }
  }

  /**
   * Dispatch a single approved coding task to a live local connector.
   *
   * Enforces one concurrent task per connector atomically and resolves when
   * `task.result` arrives, the abort signal triggers, the deadline expires,
   * or a mid-task disconnect outlives the 60s reconnect grace window.
   */
  dispatchTask(input: DispatchLocalTaskInput): Promise<ConnectorTaskResultFrame> {
    const conn = this.connections.get(input.connectorId);
    if (conn === undefined || conn.socket.readyState !== WS_OPEN) {
      return Promise.reject(
        new ConnectorDispatchError(
          'CONNECTOR_OFFLINE',
          'Local connector is offline (no action was dispatched).',
        ),
      );
    }
    if (this.activeTasks.has(input.connectorId)) {
      return Promise.reject(
        new ConnectorDispatchError(
          'CONNECTOR_BUSY',
          'Local connector is already running another task (no action was dispatched).',
        ),
      );
    }
    if (input.abortSignal?.aborted === true) {
      return Promise.reject(
        new ConnectorDispatchError('ABORTED', 'Task was cancelled before dispatch (no action was dispatched).'),
      );
    }

    const dispatchFrame: ConnectorServerFrame = {
      type: 'task.dispatch',
      sessionId: input.sessionId,
      payloadHash: input.payloadHash,
      botId: input.botId,
      botName: input.botName,
      relativeCwd: input.relativeCwd,
      harness: input.harness,
      prompt: input.prompt,
      ...(input.verifyCommand === undefined ? {} : { verifyCommand: input.verifyCommand }),
      maxDurationMs: input.maxDurationMs,
    };

    return new Promise<ConnectorTaskResultFrame>((resolve, reject) => {
      const startedAt = Date.now();
      const onAbort = () => {
        this.requestTaskCancel(pending, 'USER_CANCELLED', 'cancelled');
      };
      input.abortSignal?.addEventListener('abort', onAbort, { once: true });

      const pending: PendingTask = {
        connectorId: input.connectorId,
        userId: conn.userId,
        sessionId: input.sessionId,
        reportMode: conn.reportMode,
        startedAt,
        ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
        resolve,
        cleanupAbort: () => input.abortSignal?.removeEventListener('abort', onAbort),
        graceTimer: undefined,
        cancelTimer: undefined,
        deadlineTimer: undefined,
        settled: false,
      };

      // Claim the connector lock atomically before sending.
      this.activeTasks.set(input.connectorId, pending);

      if (!sendFrame(conn.socket, dispatchFrame)) {
        this.activeTasks.delete(input.connectorId);
        pending.cleanupAbort();
        reject(
          new ConnectorDispatchError(
            'CONNECTOR_OFFLINE',
            'Failed to send task to local connector (no action was dispatched).',
          ),
        );
        return;
      }

      this.connectors.notifyBusy(conn.userId, input.connectorId, 'ONLINE', true);

      // Server-side safety bound so a wedged CLI cannot hold the busy lock indefinitely.
      pending.deadlineTimer = setTimeout(() => {
        this.requestTaskCancel(pending, 'TIMEOUT', 'interrupted', {
          code: 'TIMEOUT',
          message: 'Local connector task exceeded the allowed execution duration.',
        });
      }, input.maxDurationMs + 30_000);
      pending.deadlineTimer.unref();
    });
  }

  onModuleDestroy(): void {
    for (const task of [...this.activeTasks.values()]) {
      this.settleTask(task, {
        type: 'task.result',
        sessionId: task.sessionId,
        status: 'interrupted',
        acpSessionId: null,
        reportMode: task.reportMode,
        summary: 'Orchestrator shut down while the local task was running.',
        filesChanged: [],
        commandsRun: [],
        steps: 0,
        durationMs: Math.max(0, Date.now() - task.startedAt),
        error: { code: 'ORCHESTRATOR_SHUTDOWN', message: 'Orchestrator shutting down.' },
      });
    }
    for (const conn of [...this.connections.values()]) {
      conn.superseded = true;
      clearInterval(conn.heartbeatTimer);
      try {
        conn.socket.close(1001, 'Server shutting down');
      } catch {
        // Ignore close errors during shutdown.
      }
    }
    this.connections.clear();
    this.server.close();
  }

  private handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const auth = this.admitted.get(request);
    if (auth === undefined) {
      socket.close(1008, 'Unauthorized');
      return;
    }

    let live: LiveConnector | undefined;
    const helloTimer = setTimeout(() => {
      if (live === undefined) {
        sendFrame(socket, {
          type: 'connector.error',
          code: 'INVALID_FRAME',
          message: 'Expected connector.hello frame before timeout.',
        });
        socket.close(4000, 'Hello timeout');
      }
    }, this.helloTimeoutMs);
    helloTimer.unref();

    socket.on('message', (raw: RawData) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawDataToString(raw));
      } catch {
        sendFrame(socket, {
          type: 'connector.error',
          code: 'INVALID_FRAME',
          message: 'Frame must be valid JSON.',
        });
        if (live === undefined) socket.close(4000, 'Invalid JSON');
        return;
      }

      const validated = ConnectorClientFrameSchema.safeParse(parsed);
      if (!validated.success) {
        sendFrame(socket, {
          type: 'connector.error',
          code: 'INVALID_FRAME',
          message: `Invalid connector frame: ${validated.error.issues[0]?.message ?? 'schema mismatch'}`,
        });
        if (live === undefined) socket.close(4000, 'Invalid hello frame');
        return;
      }

      const frame = validated.data;
      if (frame.type === 'connector.hello') {
        clearTimeout(helloTimer);
        if (live !== undefined) {
          sendFrame(socket, {
            type: 'connector.error',
            code: 'INVALID_FRAME',
            message: 'connector.hello was already received on this socket.',
          });
          return;
        }
        if (frame.protocolVersion < this.minProtocolVersion) {
          sendFrame(socket, {
            type: 'connector.error',
            code: 'CLI_OUTDATED',
            message:
              `CLI protocol version ${String(frame.protocolVersion)} is older than the minimum ` +
              `supported version ${String(this.minProtocolVersion)}. Please update @crewaid/connector-cli.`,
          });
          socket.close(4003, 'CLI_OUTDATED');
          return;
        }

        const prev = this.connections.get(auth.connectorId);
        if (prev !== undefined) {
          prev.superseded = true;
          clearInterval(prev.heartbeatTimer);
          try {
            prev.socket.close(4002, 'Superseded by newer connection');
          } catch {
            // Ignore close error on stale socket.
          }
        }

        const conn: LiveConnector = {
          connectorId: auth.connectorId,
          userId: auth.userId,
          name: auth.name,
          socket,
          workspaceName: frame.workspaceName,
          hostName: frame.hostName,
          harnesses: frame.harnesses,
          defaultHarness: frame.defaultHarness,
          reportMode: frame.reportMode,
          cliVersion: frame.cliVersion,
          alive: true,
          superseded: false,
          heartbeatTimer: undefined,
        };
        live = conn;
        this.connections.set(auth.connectorId, conn);

        socket.on('pong', () => {
          conn.alive = true;
        });

        conn.heartbeatTimer = setInterval(() => {
          if (conn.superseded || this.connections.get(auth.connectorId) !== conn) {
            clearInterval(conn.heartbeatTimer);
            return;
          }
          if (!conn.alive) {
            this.logger.warn('connector.ws.heartbeat_timeout', {
              connectorId: auth.connectorId,
            });
            clearInterval(conn.heartbeatTimer);
            socket.terminate();
            return;
          }
          conn.alive = false;
          try {
            socket.ping();
          } catch {
            clearInterval(conn.heartbeatTimer);
            socket.terminate();
            return;
          }
          void this.connectors.touchHeartbeat(auth.userId, auth.connectorId).catch(() => undefined);
        }, this.heartbeatMs);
        conn.heartbeatTimer.unref();

        // Check mid-task disconnect grace window reattach.
        const existingTask = this.activeTasks.get(auth.connectorId);
        let resumeAccepted: boolean | undefined;
        if (frame.activeSessionId !== undefined) {
          if (existingTask !== undefined && existingTask.sessionId === frame.activeSessionId) {
            if (existingTask.graceTimer !== undefined) {
              clearTimeout(existingTask.graceTimer);
              existingTask.graceTimer = undefined;
            }
            resumeAccepted = true;
          } else {
            resumeAccepted = false;
          }
        }

        const busy = existingTask !== undefined;
        void this.connectors
          .markOnline({
            userId: auth.userId,
            connectorId: auth.connectorId,
            workspaceName: frame.workspaceName,
            hostName: frame.hostName,
            harnesses: frame.harnesses,
            defaultHarness: frame.defaultHarness,
            reportMode: frame.reportMode,
            busy,
          })
          .then((ok) => {
            if (conn.superseded || this.connections.get(auth.connectorId) !== conn) return;
            if (!ok) {
              conn.superseded = true;
              clearInterval(conn.heartbeatTimer);
              this.connections.delete(auth.connectorId);
              socket.close(4001, 'Connector revoked');
              return;
            }
            sendFrame(socket, {
              type: 'connector.welcome',
              connectorId: auth.connectorId,
              name: auth.name,
              heartbeatMs: this.heartbeatMs,
              ...(resumeAccepted === undefined ? {} : { resumeAccepted }),
            });
            // Tell the CLI immediately if its local harness outlived our grace window.
            if (frame.activeSessionId !== undefined && resumeAccepted === false) {
              sendFrame(socket, {
                type: 'task.cancel',
                sessionId: frame.activeSessionId,
                reason: 'SESSION_EXPIRED',
              });
            }
            this.logger.info('connector.ws.online', {
              connectorId: auth.connectorId,
              cliVersion: frame.cliVersion,
              harnesses: frame.harnesses,
              reportMode: frame.reportMode,
              ...(resumeAccepted === undefined ? {} : { resumeAccepted }),
            });
          })
          .catch((error: unknown) => {
            this.logger.warn('connector.ws.mark_online_failed', {
              connectorId: auth.connectorId,
              detail: error instanceof Error ? error.message : String(error),
            });
            socket.close(1011, 'Failed to register connector');
          });
        return;
      }

      if (live === undefined) {
        sendFrame(socket, {
          type: 'connector.error',
          code: 'INVALID_FRAME',
          message: 'connector.hello must be the first frame.',
        });
        socket.close(4000, 'Expected connector.hello');
        return;
      }

      if (frame.type === 'task.progress') {
        const task = this.activeTasks.get(auth.connectorId);
        if (task !== undefined && task.sessionId === frame.sessionId && !task.settled) {
          task.onProgress?.(frame);
        }
        return;
      }

      if (frame.type === 'task.result') {
        const task = this.activeTasks.get(auth.connectorId);
        if (task !== undefined && task.sessionId === frame.sessionId && !task.settled) {
          this.settleTask(task, frame);
          this.connectors.notifyBusy(auth.userId, auth.connectorId, 'ONLINE', false);
        }
      }
    });

    socket.on('close', () => {
      clearTimeout(helloTimer);
      if (live === undefined || live.superseded) return;
      clearInterval(live.heartbeatTimer);
      if (this.connections.get(auth.connectorId) !== live) return;
      this.connections.delete(auth.connectorId);
      void this.connectors.markOffline(auth.userId, auth.connectorId).catch(() => undefined);

      const task = this.activeTasks.get(auth.connectorId);
      if (task !== undefined && !task.settled) {
        this.logger.warn('connector.ws.dropped_mid_task', {
          connectorId: auth.connectorId,
          sessionId: task.sessionId,
          graceMs: this.disconnectGraceMs,
        });
        task.graceTimer = setTimeout(() => {
          if (task.settled) return;
          this.settleTask(task, {
            type: 'task.result',
            sessionId: task.sessionId,
            status: 'interrupted',
            acpSessionId: null,
            reportMode: task.reportMode,
            summary:
              'The local connector disconnected mid-task and did not reconnect within the grace window.',
            filesChanged: [],
            commandsRun: [],
            steps: 0,
            durationMs: Math.max(0, Date.now() - task.startedAt),
            error: {
              code: 'CONNECTOR_OFFLINE',
              message: 'Local connector disconnected mid-task.',
            },
          });
        }, this.disconnectGraceMs);
        task.graceTimer.unref();
      }
    });
  }

  private requestTaskCancel(
    task: PendingTask,
    reason: string,
    fallbackStatus: 'cancelled' | 'interrupted',
    error?: { readonly code: string; readonly message: string },
  ): void {
    if (task.settled) return;
    const conn = this.connections.get(task.connectorId);
    const sent =
      conn !== undefined &&
      sendFrame(conn.socket, {
        type: 'task.cancel',
        sessionId: task.sessionId,
        reason,
      });

    const finalize = () => {
      if (task.settled) return;
      this.settleTask(task, {
        type: 'task.result',
        sessionId: task.sessionId,
        status: fallbackStatus,
        acpSessionId: null,
        reportMode: task.reportMode,
        summary:
          fallbackStatus === 'cancelled'
            ? 'Local task was cancelled.'
            : (error?.message ?? 'Local task was interrupted.'),
        filesChanged: [],
        commandsRun: [],
        steps: 0,
        durationMs: Math.max(0, Date.now() - task.startedAt),
        ...(error === undefined ? {} : { error }),
      });
      if (this.isConnectedLocally(task.connectorId)) {
        this.connectors.notifyBusy(task.userId, task.connectorId, 'ONLINE', false);
      }
    };

    if (!sent) {
      finalize();
      return;
    }

    if (task.cancelTimer === undefined) {
      task.cancelTimer = setTimeout(finalize, this.cancelGraceMs);
      task.cancelTimer.unref();
    }
  }

  private settleTask(task: PendingTask, result: ConnectorTaskResultFrame): void {
    if (task.settled) return;
    task.settled = true;
    clearTimeout(task.graceTimer);
    clearTimeout(task.cancelTimer);
    clearTimeout(task.deadlineTimer);
    task.cleanupAbort();
    if (this.activeTasks.get(task.connectorId) === task) {
      this.activeTasks.delete(task.connectorId);
    }
    task.resolve(result);
  }
}
