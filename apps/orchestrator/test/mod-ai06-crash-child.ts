import 'reflect-metadata';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RunLeaseService } from '../src/agent/persistence/run-lease.js';
import { produceOwned, type OwnedResume, type OwnedThread } from './mod-ai06-owned-harness.js';
import type { RunLease } from '../src/agent/persistence/run-lease.js';

/**
 * MOD-AI-06's crash child: an owned continuation in a process the parent can
 * SIGKILL. It prints its marker from inside the approved tool — after the
 * durable dispatch marker is written and before any outcome exists — and then
 * holds still, so the kill lands exactly where an effect may or may not have
 * happened. Nothing runs on the way out: no abort, no close, no release.
 *
 *   tsx test/mod-ai06-crash-child.ts '<json: { thread, lease, resume, leaseMs, heartbeatMs }>'
 */
export const DISPATCH_MARKER = 'MOD-AI-06-DISPATCHED';

async function main(): Promise<void> {
  const input = JSON.parse(process.argv[2] ?? '') as {
    thread: OwnedThread;
    lease: RunLease;
    resume?: OwnedResume;
    leaseMs: number;
    heartbeatMs: number;
    mode?: 'ASK' | 'FULL';
    ledger?: boolean;
  };
  const prisma = new PrismaService();
  await prisma.$connect();
  const leases = new RunLeaseService(prisma, {
    leaseMs: input.leaseMs,
    heartbeatMs: input.heartbeatMs,
  });
  const outcome = await produceOwned(
    prisma,
    input.thread,
    input.lease,
    () => {
      process.stdout.write(`${DISPATCH_MARKER} pid=${process.pid}\n`);
      return new Promise<never>(() => undefined);
    },
    input.resume,
    {
      leases,
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      ...(input.ledger === undefined ? {} : { ledger: input.ledger }),
    },
  );
  // Reaching here means the tool never ran: say why, for the parent's failure message.
  process.stderr.write(`producer finished without dispatching: ${JSON.stringify(outcome)}\n`);
  process.exit(2);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
