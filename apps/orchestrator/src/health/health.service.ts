import { Inject, Injectable } from '@nestjs/common';
import type { HealthResponse } from '@crewaid/shared';

import { PrismaService } from '../prisma/prisma.service.js';
import { SandboxHealthService } from '../sandbox/sandbox-health.service.js';
import { SANDBOX_PROVIDER, type SandboxProvider } from '../sandbox/sandbox.provider.js';
import { readEdition } from '../common/edition.config.js';
import { checkRedis } from './redis-health.js';

/**
 * Readiness for `GET /health`.
 *
 * The route this feeds stays a LIVENESS endpoint first: it answers 200
 * whenever the process can answer, and a downstream failure is reported in
 * the body, never as a failed probe (the M1 ruling, kept: a database outage
 * must not make a supervisor restart the orchestrator). What CC-02 adds is
 * the readiness half of the same response — `db`, `redis`, `docker`, and one
 * entry per sandbox — assembled here, bounded, and never thrown.
 */

/**
 * One bound for every probe the read awaits — including the per-sandbox
 * snapshot, whose internal round trips carry no deadline of their own. The
 * snapshot is therefore bounded AS A WHOLE: when its bound trips, its
 * in-flight reads are abandoned (not cancelled) and the route answers without
 * them, so the whole read settles within one bound however a dependency
 * wedges.
 */
export const HEALTH_PROBE_TIMEOUT_MS = 3_000;

@Injectable()
export class HealthService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SANDBOX_PROVIDER) private readonly provider: SandboxProvider,
    @Inject(SandboxHealthService) private readonly sandboxes: SandboxHealthService,
  ) {}

  /** `userId` is the signed-in caller, whose bots alone `sandboxes` lists. */
  async read(userId: string | null): Promise<HealthResponse> {
    // Independent probes, one round of latency. Each answers false instead of
    // throwing, so the response is built even when every dependency is down.
    const [db, redis, docker, sandboxes] = await Promise.all([
      this.checkDb(),
      checkRedis(process.env['REDIS_URL']),
      this.checkDocker(),
      userId === null ? Promise.resolve([]) : this.sandboxEntries(userId),
    ]);

    return {
      status: statusOf(db, redis, docker),
      // What a self-hosted desktop compares itself against. The image
      // bakes it in at release; a local build has none and says so.
      version: process.env['CREWAID_VERSION'] || 'dev',
      edition: readEdition(process.env),
      db,
      redis,
      docker,
      sandboxes,
    };
  }

  private async checkDb(): Promise<boolean> {
    try {
      await withTimeout(Promise.resolve(this.prisma.$queryRaw`SELECT 1`), HEALTH_PROBE_TIMEOUT_MS);
      return true;
    } catch {
      return false;
    }
  }

  private async checkDocker(): Promise<boolean> {
    try {
      // The daemon answering is the fact being checked, and
      // `listManagedSessions` is the provider's existing round trip to it —
      // it rejects only when Docker itself is unreachable. A second daemon
      // surface for one boolean would be a wider contract than the question
      // needs.
      await withTimeout(
        Promise.resolve(this.provider.listManagedSessions()),
        HEALTH_PROBE_TIMEOUT_MS,
      );
      return true;
    } catch {
      return false;
    }
  }

  private async sandboxEntries(userId: string): Promise<HealthResponse['sandboxes']> {
    try {
      // Raced against the same bound as the other probes: the snapshot reads
      // the database and live-probes every RUNNING sandbox, and none of those
      // round trips carries a deadline of its own — a wedged daemon or a
      // stalled Postgres would otherwise hold the route open indefinitely.
      return await withTimeout(this.sandboxes.snapshot(userId), HEALTH_PROBE_TIMEOUT_MS);
    } catch {
      // Two ways here: the snapshot threw (an unreachable database is already
      // `db: false`) or it blew the bound. Either way the list degrades to
      // empty rather than failing the whole route.
      return [];
    }
  }
}

/**
 * The REST status ladder:
 *
 * down — Postgres is unreachable. Every REST route reads it, so the
 * orchestrator cannot serve; this is not degradation.
 * degraded — the process serves, but Redis or Docker is not answering.
 * ok — all three answer.
 *
 * Sandbox rows deliberately do NOT move this value. A stopped or sick bot is
 * per-bot information (`sandboxes[].healthy`) — one bad sandbox is what the
 * fleet looks like mid-repair, not a statement about the orchestrator.
 */
function statusOf(db: boolean, redis: boolean, docker: boolean): HealthResponse['status'] {
  if (!db) return 'down';
  return redis && docker ? 'ok' : 'degraded';
}

/**
 * Bound one probe.
 *
 * Exported because the bound is a guard of its own: the suite drives it with
 * a clock it controls. Waiting out the real 3 s would measure the suite, not
 * the bound.
 */
export function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
