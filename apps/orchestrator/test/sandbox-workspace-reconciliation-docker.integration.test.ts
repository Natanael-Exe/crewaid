import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { computerId } from './computer-fixtures.js';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import {
  DockerSandboxProvider,
  SANDBOX_LABELS,
  workspaceVolumeNameFor,
} from '@crewaid/sandbox-docker';

import { privateComputerBot } from './computer-fixtures.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SandboxReconciliationService } from '../src/sandbox/sandbox-reconciliation.service.js';
import { SandboxService } from '../src/sandbox/sandbox.service.js';

/**
 * M2-QA-08 joins the real daemon to the real durable rows.
 *
 * The provider suite proves Docker inventory and workspace preservation, while
 * sandbox-reconciliation.integration.test.ts proves the database transitions
 * with a fake provider. Neither catches a disagreement at their seam. This
 * sequence creates that disagreement deliberately: provision without a row,
 * request teardown only in the row, and lose a recorded runtime while its
 * workspace survives.
 *
 * One bot carries the sequence because the state inherited by each phase is
 * the assertion. A fresh fixture per test would replace partial provisioning
 * and teardown with three unrelated happy paths.
 *
 * @skip-reason: needs a Docker daemon, a built crewaid/sandbox image and a real
 * database; set CREWAID_DOCKER_TESTS=1 with DATABASE_URL to run (Natanael).
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const DOCKER_TESTS = process.env['CREWAID_DOCKER_TESTS'];
const SKIP =
  DATABASE_URL === undefined ||
  DATABASE_URL === '' ||
  DOCKER_TESTS === undefined ||
  DOCKER_TESTS === '';
const IMAGE = process.env['SANDBOX_IMAGE'] ?? 'crewaid/sandbox:dev';
const USER_ID = 'usr_crewaid_singleton_v1';
const BOT_PREFIX = 'm2qa08-docker';
const BOOT_MS = 120_000;
const run = promisify(execFile);

async function containersFor(sessionId: string): Promise<string[]> {
  const { stdout } = await run('docker', [
    'ps',
    '-aq',
    '--no-trunc',
    '--filter',
    `label=${SANDBOX_LABELS.sessionId}=${sessionId}`,
  ]);
  return stdout.trim() === '' ? [] : stdout.trim().split('\n');
}

async function isRunning(containerId: string): Promise<boolean> {
  const { stdout } = await run('docker', ['inspect', '-f', '{{.State.Running}}', containerId]);
  return stdout.trim() === 'true';
}

describe.skipIf(SKIP)('M2-QA-08 workspace reconciliation (real Docker, real db)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let reconciliation: SandboxReconciliationService;
  let lifecycle: SandboxService;
  let provider: DockerSandboxProvider;
  let botId = '';
  let containerId = '';
  const network = `crewaid-qa08-${randomUUID().slice(0, 8)}`;
  const previousEnvironment = new Map<string, string | undefined>();
  let supervisor: { close(): Promise<void> } | null = null;
  const configuredEnvironment: Record<string, string> = {
    SANDBOX_HEALTH_INTERVAL_MS: '0',
    SANDBOX_IDLE_STOP_MS: '0',
    SANDBOX_IMAGE: IMAGE,
    SANDBOX_MAX_RUNNING: '1000',
    SANDBOX_NETWORK: network,
    SANDBOX_RECONCILE_ON_BOOT: 'false',
  };

  beforeAll(async () => {
    for (const [key, value] of Object.entries(configuredEnvironment)) {
      previousEnvironment.set(key, process.env[key]);
      process.env[key] = value;
    }
    // D-200: a supervisor configured for this suite's own network.
    for (const key of ['SANDBOX_SUPERVISOR_URL', 'SANDBOX_SUPERVISOR_SECRET']) {
      previousEnvironment.set(key, process.env[key]);
    }
    supervisor = await (
      await import('@crewaid/sandbox-supervisor')
    ).useTestSupervisor({ SANDBOX_NETWORK: network, SANDBOX_IMAGE: IMAGE });

    const { Test } = await import('@nestjs/testing');
    const moduleRef = await Test.createTestingModule({
      imports: [(await import('../src/sandbox/sandbox.module.js')).SandboxModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    reconciliation = app.get(SandboxReconciliationService);
    lifecycle = app.get(SandboxService);
    await prisma.user.upsert({
      where: { id: USER_ID },
      create: { id: USER_ID, name: 'Test User', email: `${USER_ID}@test.invalid` },
      update: {},
    });
    const bot = await privateComputerBot(prisma, app.get(SANDBOX_PROVIDER), USER_ID, {
      name: `${BOT_PREFIX}-${randomUUID().slice(0, 8)}`,
      role: 'R',
      avatarColor: '#123456',
      systemPrompt: 'x',
    });
    botId = bot.id;
    // Bot creation now persists a STOPPED intent; leave a stale lease to model this crash fixture.
    await prisma.sandbox.update({
      where: { id: await computerId(prisma, botId) },
      data: { state: 'STARTING', lastStartedAt: new Date(0) },
    });

    // Simulate a crash after Docker provisioned the runtime and workspace but
    // before SandboxService persisted the session on its computer row.
    provider = new DockerSandboxProvider({ image: IMAGE, network });
    const provisioned = await provider.createSession({ sessionId: botId, identity: botId });
    containerId = provisioned.containerId;
    await provisioned.writeTextFile({
      path: '/home/bot/recovery-proof.txt',
      content: 'preserve me\n',
    });
    await expect(
      prisma.sandbox.findFirst({ where: { bots: { some: { id: botId } } } }),
    ).resolves.toMatchObject({ state: 'STARTING', sessionId: null });
  }, BOOT_MS);

  afterAll(async () => {
    if (botId !== '') {
      for (const id of await containersFor(botId).catch(() => [])) {
        await run('docker', ['rm', '-f', id]).catch(() => undefined);
      }
      await run('docker', ['volume', 'rm', '--force', workspaceVolumeNameFor(botId)]).catch(
        () => undefined,
      );
      await prisma?.bot.deleteMany({ where: { id: botId } }).catch(() => undefined);
    }
    await run('docker', ['network', 'rm', network]).catch(() => undefined);
    await app?.close();
    await supervisor?.close();
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }, BOOT_MS);

  it(
    'adopts a provisioned-but-unrecorded runtime and its existing workspace',
    async () => {
      await reconciliation.sweep();

      await expect(
        prisma.sandbox.findFirstOrThrow({ where: { bots: { some: { id: botId } } } }),
      ).resolves.toMatchObject({
        state: 'RUNNING',
        sessionId: botId,
        containerId,
      });
      expect(await containersFor(botId)).toEqual([containerId]);
      const adopted = await provider.attachSession({ sessionId: botId });
      expect(adopted).not.toBeNull();
      await expect(adopted!.readTextFile({ path: '/home/bot/recovery-proof.txt' })).resolves.toBe(
        'preserve me\n',
      );
    },
    BOOT_MS,
  );

  it(
    'finishes a partially persisted teardown by stopping, not deleting, the runtime',
    async () => {
      await prisma.sandbox.update({
        where: { id: await computerId(prisma, botId) },
        data: { state: 'STOPPED' },
      });
      expect(await isRunning(containerId)).toBe(true);

      await reconciliation.sweep();

      expect(await containersFor(botId)).toEqual([containerId]);
      expect(await isRunning(containerId)).toBe(false);
      await expect(
        prisma.sandbox.findFirstOrThrow({ where: { bots: { some: { id: botId } } } }),
      ).resolves.toMatchObject({
        state: 'STOPPED',
        containerId,
      });

      // The normal lifecycle can resume the exact stopped runtime after the
      // reconciler completes the interrupted teardown.
      expect((await lifecycle.start(USER_ID, botId)).state).toBe('RUNNING');
      expect(await containersFor(botId)).toEqual([containerId]);
      expect(await isRunning(containerId)).toBe(true);
    },
    BOOT_MS,
  );

  it(
    'surfaces a missing runtime without silently creating a fresh desktop',
    async () => {
      const lostContainerId = containerId;
      await run('docker', ['rm', '-f', lostContainerId]);
      expect(await containersFor(botId)).toEqual([]);

      await reconciliation.sweep();

      // This assertion happens before any explicit recovery request. Merely
      // observing the mismatch must not turn the preserved volume into a new
      // desktop that looks healthy but may have lost the operator's context.
      expect(await containersFor(botId)).toEqual([]);
      const missing = await prisma.sandbox.findFirstOrThrow({
        where: { bots: { some: { id: botId } } },
      });
      expect(missing.state).toBe('UNHEALTHY');
      expect(missing.containerId).toBeNull();
      expect(missing.lastError).toMatch(/runtime .* is missing.*workspace .* was preserved/i);
      const volume = await provider.inspectWorkspace({ botId });
      expect(volume).toEqual({
        exists: true,
        ok: true,
        volumeName: workspaceVolumeNameFor(botId),
      });

      // An explicit start is the recovery selection. It creates a new runtime
      // over the same workspace and proves the preserved file was not merely a
      // surviving volume label.
      expect((await lifecycle.start(USER_ID, botId)).state).toBe('RUNNING');
      const [recoveredContainerId] = await containersFor(botId);
      expect(recoveredContainerId).toBeTypeOf('string');
      expect(recoveredContainerId).not.toBe(lostContainerId);
      containerId = recoveredContainerId!;
      const recovered = await provider.attachSession({ sessionId: botId });
      expect(recovered).not.toBeNull();
      await expect(recovered!.readTextFile({ path: '/home/bot/recovery-proof.txt' })).resolves.toBe(
        'preserve me\n',
      );
    },
    BOOT_MS * 2,
  );
});
