/**
 * D-197: a real process death inside a call the policy allowed by itself — no
 * approval, so no proposal row — then scoped recovery. The dispatch ledger and
 * the pre-dispatch save are the only durable trace; recovery must answer the
 * same pending call from them and never run the tool again.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Json } from '@crewaid/shared';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';
import { recoverExpiredRuns } from '../src/agent/persistence/owned-tanstack-persistence.js';
import { RunLeaseService } from '../src/agent/persistence/run-lease.js';
import { ownedThread, produceOwned } from './mod-ai06-owned-harness.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const CHILD = fileURLToPath(new URL('./mod-ai06-crash-child.ts', import.meta.url));
const ORCHESTRATOR_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DISPATCH_MARKER = 'MOD-AI-06-DISPATCHED';
const LEASE_MS = 2_000;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!DATABASE_URL)('MOD-DU-02 crash inside an unapproved write (real db)', () => {
  const prisma = new PrismaService();
  let owner: SignedInUser;
  beforeAll(async () => {
    await prisma.$connect();
    owner = await signIn(prisma, { label: 'du02crash' });
  });
  afterAll(async () => {
    await signOutAndDelete(prisma, owner.userId);
    await prisma.$disconnect();
  });

  it('a worker killed inside an allowed write is recovered without repeating it', async () => {
    const t = await ownedThread(prisma, owner.userId);
    const lease = t.first;
    const healthy = await ownedThread(prisma, owner.userId);
    const healthyBefore = await prisma.agentTurn.findUniqueOrThrow({
      where: { id: healthy.first.runId },
    });

    const child = spawn(
      'pnpm',
      [
        'exec',
        'tsx',
        CHILD,
        JSON.stringify({
          thread: t,
          lease,
          leaseMs: LEASE_MS,
          heartbeatMs: 300,
          mode: 'FULL',
          ledger: true,
        }),
      ],
      {
        cwd: ORCHESTRATOR_ROOT,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await vi.waitFor(
      () => {
        if (child.exitCode !== null)
          throw new Error(
            `child exited early (${child.exitCode}): ${stderr.slice(-2000)} ${stdout.slice(-2000)}`,
          );
        expect(stdout).toContain(DISPATCH_MARKER);
      },
      { timeout: 30_000, interval: 100 },
    );
    const pid = Number(/pid=(\d+)/.exec(stdout)?.[1]);

    // Durable before the kill: the reservation, and the call itself in the thread.
    const reserved = await prisma.toolDispatch.findMany({ where: { conversationId: t.threadId } });
    expect(reserved).toHaveLength(1);
    expect(reserved[0]).toMatchObject({ runId: lease.runId, status: 'DISPATCHED' });
    const pendingCall = reserved[0]!.toolCallId;
    const saved = await prisma.message.findMany({ where: { conversationId: t.threadId } });
    expect(JSON.stringify(saved)).toContain(pendingCall);
    // No approval was asked, so there is no proposal to carry the marker.
    expect(await prisma.runInterrupt.count({ where: { runId: lease.runId } })).toBe(0);

    // The child's heartbeat renews on LEASE_MS, so expiry after the kill is quick.
    await new Promise((resolve) => setTimeout(resolve, LEASE_MS + 200));
    expect(
      (await prisma.agentTurn.findUniqueOrThrow({ where: { id: lease.runId } })).workerId,
    ).toBe(lease.workerId);

    if (child.pid === undefined) throw new Error('child has no pid');
    process.kill(-child.pid, 'SIGKILL');
    await exited;
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 2_000 });
    await vi.waitFor(
      async () => {
        const row = await prisma.agentTurn.findUniqueOrThrow({ where: { id: lease.runId } });
        expect(row.leaseExpiresAt!.getTime()).toBeLessThan(Date.now());
      },
      { timeout: LEASE_MS + 2_000, interval: 100 },
    );

    const action = vi.fn(async (_args: Json) => 'repeated');
    const outcomes: string[] = [];
    await recoverExpiredRuns({
      leases: new RunLeaseService(prisma),
      resume: async (claimed) => {
        if (claimed.runId !== lease.runId) return;
        outcomes.push(
          (
            await produceOwned(prisma, t, claimed, action, undefined, {
              mode: 'FULL',
              ledger: true,
            })
          ).status,
        );
      },
    });
    expect(outcomes).toEqual(['completed']);
    // The write may have happened before the kill: recovery never runs it again.
    expect(action).not.toHaveBeenCalled();
    const settled = await prisma.toolDispatch.findMany({ where: { conversationId: t.threadId } });
    expect(settled).toEqual([
      expect.objectContaining({ toolCallId: pendingCall, status: 'UNCERTAIN' }),
    ]);
    const transcript = await prisma.message.findMany({
      where: { conversationId: t.threadId },
      orderBy: { sequence: 'asc' },
    });
    expect(JSON.stringify(transcript)).toContain('OUTCOME_UNKNOWN');

    expect(
      await prisma.agentTurn.findUniqueOrThrow({ where: { id: healthy.first.runId } }),
    ).toMatchObject({
      status: 'running',
      workerId: healthyBefore.workerId,
      driverEpoch: healthyBefore.driverEpoch,
    });
  }, 60_000);
});
