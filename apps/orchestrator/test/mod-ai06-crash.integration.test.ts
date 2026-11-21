/**
 * A real process death inside an approved tool, then scoped recovery. The
 * child is SIGKILLed after its dispatch marker is durable, so nothing it could
 * have run on the way out can explain the outcome; recovery must reclaim only
 * the expired run, rebuild its resume input from rows, and never repeat the
 * possibly-committed effect.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Json } from '@crewaid/shared';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';
import { admitOwnedToolResumeBatch } from '../src/agent/persistence/owned-resume-admission.js';
import {
  readAdmittedResume,
  recoverExpiredRuns,
} from '../src/agent/persistence/owned-tanstack-persistence.js';
import { RunLeaseService, type RunLease } from '../src/agent/persistence/run-lease.js';
import { ResolutionSchema } from '../src/agent/policy/proposal-store.js';
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

describe.skipIf(!DATABASE_URL)('MOD-AI-06 process crash and scoped recovery (real db)', () => {
  const prisma = new PrismaService();
  let owner: SignedInUser;
  beforeAll(async () => {
    await prisma.$connect();
    owner = await signIn(prisma, { label: 'ownedcrash' });
  });
  afterAll(async () => {
    await signOutAndDelete(prisma, owner.userId);
    await prisma.$disconnect();
  });

  it('a worker killed inside an approved tool is recovered without repeating it', async () => {
    const t = await ownedThread(prisma, owner.userId);
    expect((await produceOwned(prisma, t, t.first, async () => 'never')).status).toBe(
      'interrupted',
    );
    const [proposal] = await prisma.runInterrupt.findMany({ where: { runId: t.first.runId } });
    if (proposal?.nativeInterruptId == null) throw new Error('fixture: no native interrupt');
    const batch = [
      {
        interruptId: proposal.nativeInterruptId,
        status: 'resolved' as const,
        payload: { approved: true, editedArgs: { to: 'edited@example.test' } },
      },
    ];
    const scope = {
      userId: owner.userId,
      botId: t.botId,
      threadId: t.threadId,
      parentRunId: t.first.runId,
    };
    // The default lease covers the child's start, which is slow under a full
    // suite; its heartbeat then renews on LEASE_MS, so expiry after the kill is quick.
    const { lease } = await admitOwnedToolResumeBatch(prisma, scope, batch);

    // A healthy owner elsewhere: recovery must leave it exactly as it is.
    const healthy = await ownedThread(prisma, owner.userId);
    const healthyBefore = await prisma.agentTurn.findUniqueOrThrow({
      where: { id: healthy.first.runId },
    });

    // `pnpm exec tsx` is three processes deep; a group of its own lets the
    // kill reach the node process that actually holds the run.
    const child = spawn(
      'pnpm',
      [
        'exec',
        'tsx',
        CHILD,
        JSON.stringify({
          thread: t,
          lease,
          resume: { parentRunId: t.first.runId, batch },
          leaseMs: LEASE_MS,
          heartbeatMs: 300,
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

    // Verified before the kill, so the kill cannot be what wrote it.
    const marked = await prisma.runInterrupt.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(ResolutionSchema.parse(marked.response).dispatchedAt).toBeDefined();
    expect(ResolutionSchema.parse(marked.response).outcome).toBeUndefined();
    expect(marked.nativeStatus).toBe('pending');
    // The heartbeat kept the lease alive past its own length while the tool hung.
    await new Promise((resolve) => setTimeout(resolve, LEASE_MS + 200));
    expect(
      (await prisma.agentTurn.findUniqueOrThrow({ where: { id: lease.runId } })).workerId,
    ).toBe(lease.workerId);

    if (child.pid === undefined) throw new Error('child has no pid');
    process.kill(-child.pid, 'SIGKILL');
    await exited;
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 2_000 });

    // A kill writes nothing: the run is still the dead worker's, until it expires.
    const dead = await prisma.agentTurn.findUniqueOrThrow({ where: { id: lease.runId } });
    expect(dead).toMatchObject({ status: 'running', workerId: lease.workerId });
    await vi.waitFor(
      async () => {
        const row = await prisma.agentTurn.findUniqueOrThrow({ where: { id: lease.runId } });
        expect(row.leaseExpiresAt!.getTime()).toBeLessThan(Date.now());
      },
      { timeout: LEASE_MS + 2_000, interval: 100 },
    );

    const action = vi.fn(async (_args: Json) => 'repeated');
    const outcomes: string[] = [];
    let ours: RunLease | undefined;
    const result = await recoverExpiredRuns({
      leases: new RunLeaseService(prisma),
      resume: async (claimed) => {
        // Other suites' abandoned runs are candidates too; this test drives only its own.
        if (claimed.runId !== lease.runId) return;
        ours = claimed;
        const admitted = await readAdmittedResume(prisma, claimed);
        expect(admitted).toEqual({ parentRunId: t.first.runId, batch });
        outcomes.push(
          (await produceOwned(prisma, t, claimed, action, admitted ?? undefined)).status,
        );
      },
    });
    expect(result.recovered).toBeGreaterThanOrEqual(1);
    expect(ours?.epoch).toBe(lease.epoch + 1);
    expect(outcomes).toEqual(['completed']);
    // The effect may have happened before the kill: recovery never runs it again.
    expect(action).not.toHaveBeenCalled();
    const settled = await prisma.runInterrupt.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(settled.nativeStatus).toBe('resolved');
    expect(await prisma.agentTurn.findUniqueOrThrow({ where: { id: lease.runId } })).toMatchObject({
      status: 'completed',
      workerId: null,
      activeKey: null,
    });
    // The model was told the call will not be repeated, not that it failed or ran.
    const transcript = await prisma.message.findMany({
      where: { conversationId: t.threadId },
      orderBy: { sequence: 'asc' },
    });
    expect(JSON.stringify(transcript.map((row) => row.parts))).toContain('already dispatched');

    expect(
      await prisma.agentTurn.findUniqueOrThrow({ where: { id: healthy.first.runId } }),
    ).toMatchObject({
      status: 'running',
      workerId: healthyBefore.workerId,
      driverEpoch: healthyBefore.driverEpoch,
    });
  }, 60_000);
});
