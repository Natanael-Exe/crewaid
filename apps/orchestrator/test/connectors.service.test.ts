import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import type { LocalConnector } from '@prisma/client';
import {
  CONNECTOR_TOKEN_PREFIX,
  CreateConnectorResponseSchema,
  ListConnectorsResponseSchema,
  RotateConnectorResponseSchema,
} from '@crewaid/shared';

import {
  ConnectorsService,
  hashConnectorSecret,
  type ConnectorHostHooks,
} from '../src/connectors/connectors.service.js';
import type { TurnEventBus } from '../src/agent/turn-event.bus.js';
import type { StructuredLogger } from '../src/logging/structured-logger.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

const USER_A = 'cluseraaaaaaaaaaaaaaaaaaaa';
const USER_B = 'cluserbbbbbbbbbbbbbbbbbbbb';

function makeHarness() {
  const rows = new Map<string, LocalConnector>();
  let seq = 1;

  const prisma = {
    localConnector: {
      findMany: vi.fn(async ({ where }: { where: { userId: string; status?: { not: string } } }) => {
        return [...rows.values()].filter(
          (row) =>
            row.userId === where.userId &&
            (where.status?.not === undefined || row.status !== where.status.not),
        );
      }),
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { id: string; userId: string; status?: { not: string } };
        }) => {
          const row = rows.get(where.id);
          if (row === undefined || row.userId !== where.userId) return null;
          if (where.status?.not !== undefined && row.status === where.status.not) return null;
          return row;
        },
      ),
      findUnique: vi.fn(async ({ where }: { where: { tokenHash: string } }) => {
        return [...rows.values()].find((row) => row.tokenHash === where.tokenHash) ?? null;
      }),
      count: vi.fn(async ({ where }: { where: { userId: string; status?: { not: string } } }) => {
        return [...rows.values()].filter(
          (row) =>
            row.userId === where.userId &&
            (where.status?.not === undefined || row.status !== where.status.not),
        ).length;
      }),
      create: vi.fn(
        async ({
          data,
        }: {
          data: {
            userId: string;
            name: string;
            tokenHash: string;
            tokenPrefix: string;
            status: 'ONLINE' | 'OFFLINE' | 'REVOKED';
            reportMode: string;
            harnesses: string[];
          };
        }) => {
          const now = new Date();
          const id = `clconn${String(seq++).padStart(18, '0')}`;
          const row: LocalConnector = {
            id,
            userId: data.userId,
            name: data.name,
            tokenHash: data.tokenHash,
            tokenPrefix: data.tokenPrefix,
            status: data.status,
            connectedInstanceId: null,
            workspaceName: null,
            hostName: null,
            harnesses: data.harnesses,
            defaultHarness: null,
            reportMode: data.reportMode,
            lastSeenAt: null,
            revokedAt: null,
            createdAt: now,
            updatedAt: now,
          };
          rows.set(id, row);
          return row;
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: {
            id?: string;
            userId?: string;
            status?: string | { not: string };
            connectedInstanceId?: string;
          };
          data: Partial<LocalConnector>;
        }) => {
          let count = 0;
          for (const [id, row] of rows) {
            if (where.id !== undefined && row.id !== where.id) continue;
            if (where.userId !== undefined && row.userId !== where.userId) continue;
            if (typeof where.status === 'string' && row.status !== where.status) continue;
            if (
              typeof where.status === 'object' &&
              where.status !== null &&
              row.status === where.status.not
            )
              continue;
            if (
              where.connectedInstanceId !== undefined &&
              row.connectedInstanceId !== where.connectedInstanceId
            )
              continue;
            rows.set(id, { ...row, ...data, updatedAt: new Date() });
            count += 1;
          }
          return { count };
        },
      ),
    },
  };

  const events = {
    emitConnectorStatus: vi.fn(),
  };

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const host: ConnectorHostHooks = {
    isBusy: vi.fn(() => false),
    isConnectedLocally: vi.fn(() => false),
    kick: vi.fn(),
  };

  const service = new ConnectorsService(
    prisma as unknown as PrismaService,
    events as unknown as TurnEventBus,
    logger as unknown as StructuredLogger,
  );
  service.attachHost(host);

  return { service, rows, events, host };
}

describe('ConnectorsService', () => {
  it('creates an owner-scoped connector with hashed secret and returns raw secret once', async () => {
    const { service, rows } = makeHarness();

    const created = await service.create(USER_A, { name: 'MacBook Pro' });
    expect(CreateConnectorResponseSchema.safeParse(created).success).toBe(true);
    expect(created.secret.startsWith(CONNECTOR_TOKEN_PREFIX)).toBe(true);
    expect(created.connector.tokenPrefix).toBe(created.secret.slice(0, 16));
    expect(created.connector.status).toBe('OFFLINE');
    expect(created.connector.reportMode).toBe('summary');

    const stored = rows.get(created.connector.id);
    expect(stored?.tokenHash).toBe(hashConnectorSecret(created.secret));
    expect(stored?.tokenHash).not.toBe(created.secret);

    // Owner isolation on list
    const listA = await service.list(USER_A);
    const listB = await service.list(USER_B);
    expect(ListConnectorsResponseSchema.safeParse(listA).success).toBe(true);
    expect(listA.connectors).toHaveLength(1);
    expect(listB.connectors).toHaveLength(0);
  });

  it('authenticates valid bearer secrets and rejects malformed, unknown, or revoked tokens', async () => {
    const { service } = makeHarness();
    const created = await service.create(USER_A, { name: 'Work Laptop' });

    const authed = await service.authenticateBearer(created.secret);
    expect(authed).toEqual({
      connectorId: created.connector.id,
      userId: USER_A,
      name: 'Work Laptop',
    });

    expect(await service.authenticateBearer('bad_prefix_token_1234567890')).toBeNull();
    expect(await service.authenticateBearer(`${CONNECTOR_TOKEN_PREFIX}wrong`)).toBeNull();
    expect(
      await service.authenticateBearer(`${CONNECTOR_TOKEN_PREFIX}${'a'.repeat(43)}`),
    ).toBeNull();

    await service.remove(USER_A, created.connector.id);
    expect(await service.authenticateBearer(created.secret)).toBeNull();
  });

  it('rotates secret, kicks live socket with 4001, and invalidates old token', async () => {
    const { service, events, host } = makeHarness();
    const created = await service.create(USER_A, { name: 'Repo Box' });

    const rotated = await service.rotateSecret(USER_A, created.connector.id);
    expect(RotateConnectorResponseSchema.safeParse(rotated).success).toBe(true);
    expect(rotated.secret).not.toBe(created.secret);
    expect(host.kick).toHaveBeenCalledWith(created.connector.id, 4001, 'Token rotated');
    expect(events.emitConnectorStatus).toHaveBeenCalledWith(USER_A, {
      connectorId: created.connector.id,
      status: 'OFFLINE',
      busy: false,
    });

    expect(await service.authenticateBearer(created.secret)).toBeNull();
    expect(await service.authenticateBearer(rotated.secret)).toMatchObject({
      connectorId: created.connector.id,
    });

    await expect(service.rotateSecret(USER_B, created.connector.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('revokes connector, kicks live socket with 4001, and excludes it from list()', async () => {
    const { service, events, host } = makeHarness();
    const created = await service.create(USER_A, { name: 'Old Laptop' });

    await expect(service.remove(USER_B, created.connector.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    await service.remove(USER_A, created.connector.id);
    expect(host.kick).toHaveBeenCalledWith(created.connector.id, 4001, 'Connector revoked');
    expect(events.emitConnectorStatus).toHaveBeenCalledWith(USER_A, {
      connectorId: created.connector.id,
      status: 'REVOKED',
      busy: false,
    });
    expect((await service.list(USER_A)).connectors).toHaveLength(0);
    expect(await service.hasActiveConnectors(USER_A)).toBe(false);
  });

  it('resolves dispatch state cleanly across offline, other-instance, busy, and ready connectors', async () => {
    const { service, rows, host } = makeHarness();
    const created = await service.create(USER_A, { name: 'Dev Laptop' });

    // Offline by default
    expect(await service.resolveForDispatch(USER_A, created.connector.id)).toMatchObject({
      ok: false,
      code: 'CONNECTOR_OFFLINE',
    });

    // Foreign user gets NOT_FOUND
    expect(await service.resolveForDispatch(USER_B, created.connector.id)).toMatchObject({
      ok: false,
      code: 'CONNECTOR_NOT_FOUND',
    });

    // Connected to a different orchestrator replica
    const row = rows.get(created.connector.id)!;
    rows.set(created.connector.id, {
      ...row,
      status: 'ONLINE',
      connectedInstanceId: 'other-orchestrator-replica',
      harnesses: ['claude-code'],
      defaultHarness: 'claude-code',
      workspaceName: 'crewaid-public',
    });
    expect(await service.resolveForDispatch(USER_A, created.connector.id)).toMatchObject({
      ok: false,
      code: 'CONNECTOR_ON_OTHER_INSTANCE',
    });

    // Connected on this instance, currently busy
    rows.set(created.connector.id, {
      ...rows.get(created.connector.id)!,
      connectedInstanceId: service.instanceId,
    });
    vi.mocked(host.isConnectedLocally).mockReturnValue(true);
    vi.mocked(host.isBusy).mockReturnValue(true);
    expect(await service.resolveForDispatch(USER_A, created.connector.id)).toMatchObject({
      ok: false,
      code: 'CONNECTOR_BUSY',
    });

    // Idle & ready
    vi.mocked(host.isBusy).mockReturnValue(false);
    const ready = await service.resolveForDispatch(USER_A, created.connector.id);
    expect(ready.ok).toBe(true);
    if (ready.ok) {
      expect(ready.connector.workspaceName).toBe('crewaid-public');
      expect(ready.connector.harnesses).toEqual(['claude-code']);
    }
  });
});
