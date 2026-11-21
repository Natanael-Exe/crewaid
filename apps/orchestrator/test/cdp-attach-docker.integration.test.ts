import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { SANDBOX_LABELS } from '@crewaid/sandbox-docker';

import { privateComputerBot } from './computer-fixtures.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SandboxService } from '../src/sandbox/sandbox.service.js';
import { RecordingsService } from '../src/recordings/recordings.service.js';
import { SeatService } from '../src/sandbox/seat.service.js';
import { CdpAttachService } from '../src/recordings/cdp-attach.service.js';
import type { CdpConnection } from '../src/recordings/cdp-connection.js';

/**
 * M4-BE-01 — the CDP attach against a REAL sandbox: real Docker, real
 * container, real Chrome behind the image's CDP relay.
 *
 * ── WHY THIS EXISTS WHEN `cdp-attach.test.ts` ALREADY PASSES ────────────────
 *
 * The fake-backed suite proves the lifecycle: when the service attaches, what
 * it does with headers, how it degrades. What it cannot prove is the other
 * half, because in every case the fake is standing exactly where the doubt is:
 *
 *   - Whether `getPortEndpoint(9222)` on a real session resolves to a port
 *     where Chrome actually answers — through Docker's port mapping and the
 *     `socat` relay the image puts in front of the debugger.
 *   - Whether the debugger URL Chrome reports is one this process can reach,
 *     and whether the connection still works when it is not (the relay
 *     forwards the `Host` header it was reached by; that is nobody's
 *     contract, which is why the attach pins the address it connects to).
 *   - Whether the headers a provider scopes to that URL survive the trip.
 *
 * The single assertion a fake cannot make is `Browser.getVersion` returning
 * the sandbox's own Chrome: it is the one fact that requires every one of
 * those to be true.
 *
 * @skip-reason: needs a Docker daemon, a built crewaid/sandbox image and a real
 * database; set CREWAID_DOCKER_TESTS=1 with DATABASE_URL to run (Natanael). Both
 * are declared in turbo.json globalEnv so Turbo's strict env mode cannot strip
 * a gate and turn this into a dormant guard (D-017).
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const DOCKER_TESTS = process.env['CREWAID_DOCKER_TESTS'];
const SKIP =
  DATABASE_URL === undefined ||
  DATABASE_URL === '' ||
  DOCKER_TESTS === undefined ||
  DOCKER_TESTS === '';

const USER_ID = 'usr_crewaid_singleton_v1';
const BOT_PREFIX = 'm4be01cdp';
/** One cold boot of a full XFCE desktop, plus room for a slow host. */
const BOOT_MS = 120_000;

const run = promisify(execFile);

/** Every container carrying this bot's session label, running or not. */
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

describe.skipIf(SKIP)('M4-BE-01 Chrome CDP attach (real Docker, real Chrome)', () => {
  let app: INestApplication;
  let botId: string;

  /** A completed attach, or a failure whose reason is in the log above it. */
  async function attached(cdp: CdpAttachService, recordingId: string): Promise<CdpConnection> {
    const connection = await cdp.connectionFor(botId, recordingId);
    if (connection === null) {
      throw new Error(
        'the CDP attach never completed — see the CdpAttachService warning earlier in this run',
      );
    }
    return connection;
  }

  beforeAll(async () => {
    const { Test } = await import('@nestjs/testing');
    const moduleRef = await Test.createTestingModule({
      // The real module graph with the REAL provider: the whole point is that
      // nothing between the lifecycle and Chrome is substituted.
      imports: [(await import('../src/recordings/recordings.module.js')).RecordingsModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const prisma = app.get(PrismaService);
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
  }, BOOT_MS);

  afterAll(async () => {
    // A desktop left running outlives the test run and the database row that
    // named it. Removing the container first is required: Docker refuses to
    // remove a volume still attached to one, even a stopped one.
    for (const id of await containersFor(botId).catch(() => [])) {
      await run('docker', ['rm', '-f', id]).catch(() => undefined);
    }
    await run('docker', ['volume', 'rm', '--force', `crewaid-workspace-${botId}`]).catch(
      () => undefined,
    );
    await app
      ?.get(PrismaService)
      .bot.deleteMany({ where: { id: botId } })
      .catch(() => undefined);
    await app?.close();
  }, BOOT_MS);

  it(
    'attaches to the sandbox Chrome for the recording, proves it, and detaches on stop',
    async () => {
      // The recording's ensure-ready wakes this; starting it first keeps the
      // cold boot out of the attach window under test.
      const computer = await app.get(SandboxService).start(USER_ID, botId);

      // D-060: a browser lives in the bot's SEAT, and a recording deliberately
      // never creates one — it would put a desktop on the machine as a side
      // effect of observing it. So the seat has to exist before the attach, the
      // way it does in life: a bot that has been looked at or has used a
      // browser tool already has one.
      await app.get(SeatService).ensureSeat(botId, botId, {
        widthPx: computer.widthPx,
        heightPx: computer.heightPx,
      });

      const recordings = app.get(RecordingsService);
      const cdp = app.get(CdpAttachService);
      const { recordingId } = await recordings.start(USER_ID, botId, {
        intent: 'open a page in the browser',
      });

      const connection = await attached(cdp, recordingId);

      // The one fact no fake can produce: an answer from the sandbox's own
      // Chrome, over the endpoint the provider resolved and the relay in
      // front of it.
      const version = await connection.send('Browser.getVersion');
      expect(String(version['product'])).toMatch(/Chrome\//);
      expect(version['protocolVersion']).toBe('1.3');

      const status = await recordings.stop(USER_ID, recordingId);

      // Detached as part of stopping, before the row was settled: the socket
      // must not outlive the recording it was opened for.
      expect(connection.closed).toBe(true);
      expect(await cdp.connectionFor(botId, recordingId)).toBeNull();
      expect(status.id).toBe(recordingId);
    },
    BOOT_MS,
  );
});
