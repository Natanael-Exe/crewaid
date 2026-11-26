import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { LocalConnector } from '@prisma/client';
import {
  CONNECTOR_TOKEN_PREFIX,
  LocalConnectorHarnessIdSchema,
  LocalConnectorReportModeSchema,
  type CreateConnectorBody,
  type CreateConnectorResponse,
  type ListConnectorsResponse,
  type LocalConnectorHarnessId,
  type LocalConnectorReportMode,
  type LocalConnectorStatus,
  type LocalConnectorView,
  type RotateConnectorResponse,
} from '@crewaid/shared';

import { TurnEventBus } from '../agent/turn-event.bus.js';
import { StructuredLogger } from '../logging/structured-logger.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Live socket hooks supplied by `ConnectorWsHost` without circular DI. */
export interface ConnectorHostHooks {
  isBusy(connectorId: string): boolean;
  isConnectedLocally(connectorId: string): boolean;
  kick(connectorId: string, code: number, reason: string): void;
}

export interface AuthenticatedConnector {
  readonly connectorId: string;
  readonly userId: string;
  readonly name: string;
}

export interface MarkConnectorOnlineInput {
  readonly userId: string;
  readonly connectorId: string;
  readonly workspaceName: string;
  readonly hostName: string;
  readonly harnesses: readonly LocalConnectorHarnessId[];
  readonly defaultHarness: LocalConnectorHarnessId | null;
  readonly reportMode: LocalConnectorReportMode;
  readonly busy: boolean;
}

export type DispatchConnectorResolution =
  | { readonly ok: true; readonly connector: LocalConnectorView }
  | {
      readonly ok: false;
      readonly code:
        | 'CONNECTOR_NOT_FOUND'
        | 'CONNECTOR_OFFLINE'
        | 'CONNECTOR_BUSY'
        | 'CONNECTOR_ON_OTHER_INSTANCE';
      readonly message: string;
    };

/**
 * Stale `ONLINE` threshold cleared at process boot: covers hard crashes of a
 * previous single-orchestrator process without disturbing another live replica
 * that is actively sending 15s heartbeats.
 */
const STALE_ONLINE_THRESHOLD_MS = 2 * 60_000;

/**
 * Hash a raw connector bearer token (`crw_conn_…`) into its stored SHA-256 hex digest.
 */
export function hashConnectorSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function mintConnectorSecret(): {
  readonly secret: string;
  readonly tokenHash: string;
  readonly tokenPrefix: string;
} {
  const secret = `${CONNECTOR_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return {
    secret,
    tokenHash: hashConnectorSecret(secret),
    tokenPrefix: secret.slice(0, 16),
  };
}

function parseHarnesses(raw: unknown): LocalConnectorHarnessId[] {
  if (!Array.isArray(raw)) return [];
  const out: LocalConnectorHarnessId[] = [];
  for (const item of raw) {
    const parsed = LocalConnectorHarnessIdSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function parseDefaultHarness(raw: string | null): LocalConnectorHarnessId | null {
  if (raw === null) return null;
  const parsed = LocalConnectorHarnessIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function parseReportMode(raw: string): LocalConnectorReportMode {
  const parsed = LocalConnectorReportModeSchema.safeParse(raw);
  return parsed.success ? parsed.data : 'summary';
}

function toConnectorView(row: LocalConnector, busy: boolean): LocalConnectorView {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    busy,
    tokenPrefix: row.tokenPrefix,
    reportMode: parseReportMode(row.reportMode),
    workspaceName: row.workspaceName,
    hostName: row.hostName,
    harnesses: parseHarnesses(row.harnesses),
    defaultHarness: parseDefaultHarness(row.defaultHarness),
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Owner-scoped CRUD, bearer token lifecycle, and online presence tracking for
 * opt-in local coding connectors (`crewaid-connect`).
 */
@Injectable()
export class ConnectorsService implements OnModuleInit, OnModuleDestroy {
  /** Ephemeral process id written into `LocalConnector.connectedInstanceId`. */
  readonly instanceId: string = randomUUID();
  private host: ConnectorHostHooks | undefined;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TurnEventBus) private readonly events: TurnEventBus,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
  ) {}

  attachHost(hooks: ConnectorHostHooks): void {
    this.host = hooks;
  }

  async onModuleInit(): Promise<void> {
    try {
      const prisma = this.prisma;
      const cutoff = new Date(Date.now() - STALE_ONLINE_THRESHOLD_MS);
      const cleared = await prisma.localConnector.updateMany({
        where: {
          status: 'ONLINE',
          OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: cutoff } }],
        },
        data: {
          status: 'OFFLINE',
          connectedInstanceId: null,
        },
      });
      if (cleared.count > 0) {
        this.logger.info('connectors.stale_cleared', { count: cleared.count });
      }
    } catch (error: unknown) {
      this.logger.warn('connectors.boot_cleanup_failed', {
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      const prisma = this.prisma;
      await prisma.localConnector.updateMany({
        where: {
          connectedInstanceId: this.instanceId,
          status: 'ONLINE',
        },
        data: {
          status: 'OFFLINE',
          connectedInstanceId: null,
        },
      });
    } catch {
      // Shutdown cleanup is best-effort; stale rows also clear on next boot.
    }
  }

  async list(userId: string): Promise<ListConnectorsResponse> {
    const prisma = this.prisma;
    const rows = await prisma.localConnector.findMany({
      where: { userId, status: { not: 'REVOKED' } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return {
      connectors: rows.map((row) => toConnectorView(row, this.host?.isBusy(row.id) ?? false)),
    };
  }

  async create(userId: string, body: CreateConnectorBody): Promise<CreateConnectorResponse> {
    const prisma = this.prisma;
    const { secret, tokenHash, tokenPrefix } = mintConnectorSecret();
    const row = await prisma.localConnector.create({
      data: {
        userId,
        name: body.name,
        tokenHash,
        tokenPrefix,
        status: 'OFFLINE',
        reportMode: 'summary',
        harnesses: [],
      },
    });
    this.logger.info('connectors.created', { userId, connectorId: row.id });
    return {
      connector: toConnectorView(row, false),
      secret,
    };
  }

  async rotateSecret(userId: string, id: string): Promise<RotateConnectorResponse> {
    const prisma = this.prisma;
    const existing = await prisma.localConnector.findFirst({
      where: { id, userId, status: { not: 'REVOKED' } },
      select: { id: true },
    });
    if (existing === null) {
      throw new NotFoundException(`No active connector found with id "${id}".`);
    }
    const { secret, tokenHash, tokenPrefix } = mintConnectorSecret();
    await prisma.localConnector.updateMany({
      where: { id, userId, status: { not: 'REVOKED' } },
      data: {
        tokenHash,
        tokenPrefix,
        status: 'OFFLINE',
        connectedInstanceId: null,
      },
    });
    const updated = await prisma.localConnector.findFirst({
      where: { id, userId, status: { not: 'REVOKED' } },
    });
    if (updated === null) {
      throw new NotFoundException(`No active connector found with id "${id}".`);
    }
    this.host?.kick(id, 4001, 'Token rotated');
    this.events.emitConnectorStatus(userId, {
      connectorId: id,
      status: 'OFFLINE',
      busy: false,
    });
    this.logger.info('connectors.rotated', { userId, connectorId: id });
    return {
      connector: toConnectorView(updated, false),
      secret,
    };
  }

  async remove(userId: string, id: string): Promise<void> {
    const prisma = this.prisma;
    const result = await prisma.localConnector.updateMany({
      where: { id, userId, status: { not: 'REVOKED' } },
      data: {
        status: 'REVOKED',
        revokedAt: new Date(),
        connectedInstanceId: null,
      },
    });
    if (result.count === 0) {
      throw new NotFoundException(`No active connector found with id "${id}".`);
    }
    this.host?.kick(id, 4001, 'Connector revoked');
    this.events.emitConnectorStatus(userId, {
      connectorId: id,
      status: 'REVOKED',
      busy: false,
    });
    this.logger.info('connectors.revoked', { userId, connectorId: id });
  }

  async hasActiveConnectors(userId: string): Promise<boolean> {
    const prisma = this.prisma;
    const count = await prisma.localConnector.count({
      where: { userId, status: { not: 'REVOKED' } },
    });
    return count > 0;
  }

  async resolveForDispatch(userId: string, id: string): Promise<DispatchConnectorResolution> {
    const prisma = this.prisma;
    const row = await prisma.localConnector.findFirst({
      where: { id, userId, status: { not: 'REVOKED' } },
    });
    if (row === null) {
      return {
        ok: false,
        code: 'CONNECTOR_NOT_FOUND',
        message: `No active local connector with id "${id}" (no action was dispatched).`,
      };
    }
    if (
      row.status === 'ONLINE' &&
      row.connectedInstanceId !== null &&
      row.connectedInstanceId !== this.instanceId
    ) {
      return {
        ok: false,
        code: 'CONNECTOR_ON_OTHER_INSTANCE',
        message:
          `Local connector "${row.name}" is connected to another orchestrator instance; ` +
          'local connectors require a single orchestrator process (no action was dispatched).',
      };
    }
    const connectedLocally = this.host?.isConnectedLocally(row.id) ?? false;
    if (row.status !== 'ONLINE' || !connectedLocally) {
      return {
        ok: false,
        code: 'CONNECTOR_OFFLINE',
        message:
          `Local connector "${row.name}" is currently offline. Start crewaid-connect on your machine and try again (no action was dispatched).`,
      };
    }
    if (this.host?.isBusy(row.id) === true) {
      return {
        ok: false,
        code: 'CONNECTOR_BUSY',
        message:
          `Local connector "${row.name}" is already running a task; only one task per connector may run at a time (no action was dispatched).`,
      };
    }
    return { ok: true, connector: toConnectorView(row, false) };
  }

  /**
   * Authenticates an inbound `/ws/connectors` Bearer token by unique SHA-256
   * digest. Never accepts revoked tokens and never logs token bytes.
   */
  async authenticateBearer(rawToken: string): Promise<AuthenticatedConnector | null> {
    if (
      !rawToken.startsWith(CONNECTOR_TOKEN_PREFIX) ||
      rawToken.length < 24 ||
      rawToken.length > 256
    ) {
      return null;
    }
    const candidateHash = hashConnectorSecret(rawToken);
    const prisma = this.prisma;
    const row = await prisma.localConnector.findUnique({
      where: { tokenHash: candidateHash },
      select: { id: true, userId: true, name: true, status: true, revokedAt: true, tokenHash: true },
    });
    if (row === null || row.status === 'REVOKED' || row.revokedAt !== null) {
      return null;
    }
    const expected = Buffer.from(row.tokenHash, 'hex');
    const actual = Buffer.from(candidateHash, 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return null;
    }
    return { connectorId: row.id, userId: row.userId, name: row.name };
  }

  async markOnline(input: MarkConnectorOnlineInput): Promise<boolean> {
    const prisma = this.prisma;
    const result = await prisma.localConnector.updateMany({
      where: {
        id: input.connectorId,
        userId: input.userId,
        status: { not: 'REVOKED' },
      },
      data: {
        status: 'ONLINE',
        connectedInstanceId: this.instanceId,
        workspaceName: input.workspaceName,
        hostName: input.hostName,
        harnesses: [...input.harnesses],
        defaultHarness: input.defaultHarness,
        reportMode: input.reportMode,
        lastSeenAt: new Date(),
      },
    });
    if (result.count === 0) return false;
    this.events.emitConnectorStatus(input.userId, {
      connectorId: input.connectorId,
      status: 'ONLINE',
      busy: input.busy,
      workspaceName: input.workspaceName,
      harnesses: [...input.harnesses],
      reportMode: input.reportMode,
    });
    return true;
  }

  async markOffline(userId: string, connectorId: string): Promise<void> {
    const prisma = this.prisma;
    const result = await prisma.localConnector.updateMany({
      where: {
        id: connectorId,
        userId,
        status: 'ONLINE',
        connectedInstanceId: this.instanceId,
      },
      data: {
        status: 'OFFLINE',
        connectedInstanceId: null,
        lastSeenAt: new Date(),
      },
    });
    if (result.count > 0) {
      this.events.emitConnectorStatus(userId, {
        connectorId,
        status: 'OFFLINE',
        busy: false,
      });
    }
  }

  async touchHeartbeat(userId: string, connectorId: string): Promise<void> {
    const prisma = this.prisma;
    await prisma.localConnector.updateMany({
      where: {
        id: connectorId,
        userId,
        status: 'ONLINE',
        connectedInstanceId: this.instanceId,
      },
      data: { lastSeenAt: new Date() },
    });
  }

  notifyBusy(
    userId: string,
    connectorId: string,
    status: LocalConnectorStatus,
    busy: boolean,
  ): void {
    this.events.emitConnectorStatus(userId, { connectorId, status, busy });
  }
}
