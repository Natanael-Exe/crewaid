import 'reflect-metadata';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Queue, Worker, type Job } from 'bullmq';

import {
  BullSkillCompileQueue,
  SKILL_COMPILE_JOB,
  UNCONFIGURED_QUEUE,
  describeQueueConfig,
  queueRedisUrl,
  readWorkerEnabled,
  redisConnection,
} from '../src/skills/skill-compile.queue.js';
import {
  SkillCompileProcessor,
  type SkillCompileJobData,
} from '../src/skills/skill-compile.processor.js';
import type { SkillCompileService } from '../src/skills/skill-compile.service.js';

/**
 * M3-BE-06 — §6/M3's "BullMQ job `skill.compile` runs on stop".
 */

const REDIS_URL = process.env['REDIS_URL'];

describe('the queue a deployment without Redis gets', () => {
  it('refuses rather than dropping the job', async () => {
    // Settling READY with no skill would report success for work that never
    // happened; §6's other outcome is "a FAILED recording with a readable
    // error", and this is that error.
    await expect(UNCONFIGURED_QUEUE.enqueue('rec-1')).rejects.toThrow(/REDIS_URL is not set/);
  });

  it('names the file an operator has to edit', async () => {
    await expect(UNCONFIGURED_QUEUE.enqueue('rec-1')).rejects.toThrow(/\.env\.example/);
  });

  it('is what an unset or blank REDIS_URL selects', () => {
    expect(queueRedisUrl(undefined)).toBeNull();
    expect(queueRedisUrl('')).toBeNull();
    expect(queueRedisUrl('   ')).toBeNull();
    expect(queueRedisUrl('redis://localhost:6379')).toBe('redis://localhost:6379');
  });
});

/**
 * The key the shared reader is asked about. M7 gave `readWorkerEnabled` a
 * `key` parameter so a second queue's failure names its own variable; these
 * cases still pin this queue's, including that the error quotes it.
 */
const KEY = 'SKILL_COMPILE_WORKER';

describe('SKILL_COMPILE_WORKER — whether this process consumes', () => {
  it('consumes by default, because an orchestrator on its own has to', () => {
    expect(readWorkerEnabled(KEY, undefined)).toBe(true);
    expect(readWorkerEnabled(KEY, '')).toBe(true);
    expect(readWorkerEnabled(KEY, 'true')).toBe(true);
  });

  it('can be turned off, which is how the test suite stays out of the queue', () => {
    expect(readWorkerEnabled(KEY, 'false')).toBe(false);
  });

  it('refuses a value that is neither, rather than guessing', () => {
    // A typo that silently read as "off" would leave recordings queued forever
    // with nothing consuming them, which looks exactly like a stuck compile.
    expect(() => readWorkerEnabled(KEY, '0')).toThrow(/must be 'true' or 'false'/);
    expect(() => readWorkerEnabled(KEY, 'no')).toThrow(/SKILL_COMPILE_WORKER/);
  });

  it('reports both halves of the configuration together', () => {
    expect(
      describeQueueConfig({ REDIS_URL: 'redis://h:1', SKILL_COMPILE_WORKER: 'false' }),
    ).toEqual({ redisUrl: 'redis://h:1', workerEnabled: false });
    expect(describeQueueConfig({})).toEqual({ redisUrl: null, workerEnabled: true });
  });
});

describe('SkillsModule — what the flags actually wire', () => {
  /**
   * Re-import the module under a given environment.
   *
   * The conditions are read at module DEFINITION, because they select which
   * providers exist rather than how one behaves — so this is the only way to
   * see them decide anything. Class identities differ across a module reset,
   * hence the comparison by name.
   */
  async function providersOf(env: Record<string, string | undefined>): Promise<string[]> {
    const saved = { ...process.env };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
    try {
      const loaded = (await import('../src/skills/skills.module.js')) as Record<string, unknown>;
      const module = loaded['SkillsModule'] as object;
      const providers = (Reflect.getMetadata('providers', module) ?? []) as unknown[];
      return providers.map((provider) =>
        typeof provider === 'function'
          ? provider.name
          : String((provider as { provide: string }).provide),
      );
    } finally {
      process.env = saved;
      vi.resetModules();
    }
  }

  /**
   * The modules `SkillsModule` imports under a given environment, by name.
   *
   * A `BullModule.registerQueue(...)` entry arrives as `{module: BullModule,
   * …}` — a dynamic module wrapper rather than the class — so this unwraps it
   * the same way `providersOf` reads named token providers, or the queue
   * branch would be invisible to a name list.
   */
  async function importsOf(env: Record<string, string | undefined>): Promise<string[]> {
    const saved = { ...process.env };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
    try {
      const loaded = (await import('../src/skills/skills.module.js')) as Record<string, unknown>;
      const imports = (Reflect.getMetadata('imports', loaded['SkillsModule'] as object) ??
        []) as unknown[];
      return imports.map((entry) => {
        const target = typeof entry === 'function' ? entry : (entry as { module: unknown }).module;
        return (target as { name?: string }).name ?? String(target);
      });
    } finally {
      process.env = saved;
      vi.resetModules();
    }
  }

  it('runs a worker when there is a queue and nothing says otherwise', async () => {
    const names = await providersOf({
      REDIS_URL: 'redis://localhost:6379',
      SKILL_COMPILE_WORKER: undefined,
    });

    expect(names).toContain('SkillCompileProcessor');
    expect(names).toContain('BullSkillCompileQueue');
  });

  it('registers no processor when the worker is turned off', async () => {
    const names = await providersOf({
      REDIS_URL: 'redis://localhost:6379',
      SKILL_COMPILE_WORKER: 'false',
    });

    // This is the guard that keeps thirteen application-booting suites from
    // consuming each other's compile jobs off one shared Redis. Reading the
    // flag correctly is not the same as acting on it.
    expect(names).not.toContain('SkillCompileProcessor');
    expect(names).toContain('BullSkillCompileQueue');
  });

  it('registers neither when there is no queue to work against', async () => {
    const names = await providersOf({ REDIS_URL: undefined, SKILL_COMPILE_WORKER: 'true' });

    // A worker without a queue would open a Redis connection that retries
    // forever in a deployment that never asked for one.
    expect(names).not.toContain('SkillCompileProcessor');
    expect(names).not.toContain('BullSkillCompileQueue');
    expect(names).toContain('SKILL_COMPILE_QUEUE');
  });

  it('imports BullModule only when there is a queue', async () => {
    const withoutQueue = await importsOf({ REDIS_URL: undefined });
    const withQueue = await importsOf({ REDIS_URL: 'redis://localhost:6379' });

    // SandboxModule rode in with M3-BE-09: the run path reaches the bot's
    // computer through the one entry point §16 gives every caller, so it is
    // part of the module whether or not a queue exists. AttachmentsModule
    // rode in with M5-BE-06's `attach_file`, and is listed explicitly even
    // though it is @Global — a global provider only exists once its module is
    // LOADED, so a suite importing SkillsModule alone would fail to resolve
    // it at boot.
    // ModelsModule rode in with V1-06: the compiler resolves its model per
    // recording OWNER now (D-086), so it needs the service rather than the
    // module-level `resolveModel` it used to call from anywhere.
    expect(withoutQueue).toEqual([
      'ToolPolicyModule',
      'SeatControlModule',
      'PrismaModule',
      'BotsModule',
      'SandboxModule',
      'ModelsModule',
      'AttachmentsModule',
    ]);
    expect(withQueue).toContain('BullModule');
    expect(withoutQueue).not.toContain('BullModule');
  });
});

describe('the connection BullMQ is given', () => {
  it('disables the per-request retry cap a blocking worker cannot survive', () => {
    // With ioredis's default, a reconnect aborts the blocking command a worker
    // sits on and the worker stops consuming without saying so.
    expect(redisConnection('redis://h:1')).toEqual({
      url: 'redis://h:1',
      maxRetriesPerRequest: null,
    });
  });
});

describe('SkillCompileProcessor — one job', () => {
  it('hands the recording id to the compiler', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const processor = new SkillCompileProcessor({ run } as unknown as SkillCompileService);

    await processor.process({ data: { recordingId: 'rec-7' } } as Job<SkillCompileJobData>);

    expect(run).toHaveBeenCalledWith('rec-7');
  });

  it('settles the row a failed job names, with the machinery reason (D-044)', async () => {
    const settleAbandoned = vi.fn().mockResolvedValue(undefined);
    const processor = new SkillCompileProcessor({
      run: vi.fn(),
      settleAbandoned,
    } as unknown as SkillCompileService);
    const logged: string[] = [];
    vi.spyOn(
      processor as unknown as { logger: { error: (m: string) => void } },
      'logger',
      'get',
    ).mockReturnValue({ error: (m: string) => logged.push(m) });

    await processor.onFailed(
      { id: 'rec-7', data: { recordingId: 'rec-7' } } as Job<SkillCompileJobData>,
      new Error('job stalled more than allowable limit'),
    );

    // A stalled job past its allowance, a worker lost mid-job: `run` never
    // sees these, so without the settlement the row would sit COMPILING with
    // no error at all (§6's other outcome is "a FAILED recording with a
    // readable error").
    expect(logged[0]).toContain('rec-7');
    expect(settleAbandoned).toHaveBeenCalledWith('rec-7', 'job stalled more than allowable limit');
  });

  it('writes nothing for a failure it cannot attribute', async () => {
    const settleAbandoned = vi.fn().mockResolvedValue(undefined);
    const processor = new SkillCompileProcessor({
      run: vi.fn(),
      settleAbandoned,
    } as unknown as SkillCompileService);
    const logged: string[] = [];
    vi.spyOn(
      processor as unknown as { logger: { error: (m: string) => void } },
      'logger',
      'get',
    ).mockReturnValue({ error: (m: string) => logged.push(m) });

    // A job object that never arrived — there is no recording id to settle.
    await processor.onFailed(undefined, new Error('connection reset'));
    processor.onError(new Error('connection reset'));

    expect(logged[0]).toContain('unknown');
    expect(logged[1]).toContain('connection reset');
    expect(settleAbandoned).not.toHaveBeenCalled();
  });
});

/**
 * The real round trip.
 *
 * Owner: M3-BE-06. Skipped without REDIS_URL, which `infra/compose` provides
 * locally and `ci.yml` now exports for the Test step — the redis service had
 * been running there since M0 with nothing naming it, which would have left
 * this a dormant guard (D-017). The worker is built here rather than taken
 * from Nest because `vitest.config.mts` deliberately keeps `@Processor` out of
 * every test context.
 */
describe.skipIf(REDIS_URL === undefined || REDIS_URL === '')(
  'the BullMQ queue (real redis)',
  () => {
    const opened: { close: () => Promise<void> }[] = [];

    afterAll(async () => {
      for (const closeable of opened) await closeable.close().catch(() => undefined);
    });

    /**
     * A queue, optionally under a name of its own.
     *
     * Each case uses an isolated name so other workers cannot consume its
     * jobs and one case cannot race another.
     */
    function realQueue(name: string = SKILL_COMPILE_JOB): {
      queue: Queue;
      port: BullSkillCompileQueue;
    } {
      const queue = new Queue(name, { connection: redisConnection(REDIS_URL!) });
      opened.push(queue);
      return { queue, port: new BullSkillCompileQueue(queue) };
    }

    /** A queue name no other case — and no real orchestrator — is working. */
    function isolatedName(prefix: string): string {
      return `${SKILL_COMPILE_JOB}.test.${prefix}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
    }

    it('hands a recording id to a worker', async () => {
      const seen: string[] = [];
      const name = isolatedName('worker');
      const worker = new Worker<SkillCompileJobData>(
        name,
        (job) => {
          seen.push(job.data.recordingId);
          return Promise.resolve();
        },
        { connection: redisConnection(REDIS_URL!), concurrency: 1 },
      );
      opened.push(worker);
      const { port } = realQueue(name);

      const recordingId = `rec-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      await port.enqueue(recordingId);

      await vi.waitFor(() => expect(seen).toContain(recordingId), { timeout: 15_000 });
    }, 30_000);

    it('queues one job per recording, however many stops ask for it', async () => {
      const { queue, port } = realQueue(isolatedName('dedupe'));

      const recordingId = `dup-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      await port.enqueue(recordingId);
      await port.enqueue(recordingId);
      await port.enqueue(recordingId);

      // The recording id IS the job id, so a retried stop — or two stops
      // racing — cannot compile the same trace three times and bill for it
      // three times.
      const job = await queue.getJob(recordingId);
      expect(job?.data).toEqual({ recordingId });
      expect(await queue.getWaitingCount()).toBe(1);
      await queue.obliterate({ force: true }).catch(() => undefined);
    }, 30_000);

    /**
     * The other half of that dedupe, and the one a default configuration gets
     * wrong: it has to END when the job does.
     *
     * BullMQ keeps a finished job's hash unless told otherwise, and an `add`
     * for an id that still exists writes nothing and resolves. That turns
     * `recoverStrandedCompilations` into a no-op for exactly the rows it
     * exists to rescue — a recording left `COMPILING` because a settle failed
     * after its job had finished — and the pass would report those rows as
     * re-queued. Nothing else in the system notices: the row simply stays
     * `COMPILING` with no error, through every restart.
     */
    it('lets a finished recording be queued again, which is what recovery does', async () => {
      const name = isolatedName('requeue');
      const seen: string[] = [];
      const worker = new Worker<SkillCompileJobData>(
        name,
        (job) => {
          seen.push(job.data.recordingId);
          return Promise.resolve();
        },
        { connection: redisConnection(REDIS_URL!), concurrency: 1 },
      );
      opened.push(worker);
      const { queue, port } = realQueue(name);

      const recordingId = `stranded-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      await port.enqueue(recordingId);
      await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 15_000 });

      // Entering the processor does not mean Redis has committed completion
      // and removed the job. Re-enqueueing before that still correctly dedupes.
      await vi.waitFor(async () => expect(await queue.getJob(recordingId)).toBeUndefined(), {
        timeout: 15_000,
      });

      // The compile ran but the row never left COMPILING, so the boot pass
      // asks for it again. Without the retention this must actually run.
      await port.enqueue(recordingId);

      await vi.waitFor(() => expect(seen).toEqual([recordingId, recordingId]), { timeout: 15_000 });
      await queue.obliterate({ force: true }).catch(() => undefined);
    }, 45_000);
  },
);
