import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';

import { SINGLETON_USER_ID } from '../src/auth/singleton-user.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ClickCorrelatorService } from '../src/recordings/click-correlator.service.js';

/**
 * M4-QA-02 (durable layer) — the "ids set / ids unset" side of "≤150 ms
 * merges, others don't".
 *
 * The unit suite (m4-qa-02-correlator-window.test.ts) proves the judgement in
 * memory; this suite proves what the recording's rows look like after the
 * real `ClickCorrelatorService` runs against a real PostgreSQL: for every dt
 * on the task's ladder the pair's `correlatedWithId` is set on BOTH rows
 * (each naming the other) — and for every refused case it stays NULL on both
 * sides. QA-authored trace and QA-pinned expectations; the M4-BE-05 suites
 * share none of this fixture.
 *
 * Deterministic by construction: `tsOffsetMs` values are written, not slept —
 * the timing under test is the trace's own stamps, not wall-clock sampling.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const RUN = randomUUID().slice(0, 8);

interface FixtureRow {
  readonly id: string;
  readonly tsOffsetMs: number;
  readonly layer: 'X11' | 'CDP';
  readonly type: string;
  readonly payload: Prisma.InputJsonObject;
}

/** A press and its release 40 ms later, at one desktop spot. */
function gesture(prefix: string, ts: number, x: number, y: number): FixtureRow[] {
  return [
    {
      id: `${prefix}-press`,
      tsOffsetMs: ts,
      layer: 'X11',
      type: 'pointer',
      payload: { x, y, buttonMask: 1 },
    },
    {
      id: `${prefix}-release`,
      tsOffsetMs: ts + 40,
      layer: 'X11',
      type: 'pointer',
      payload: { x, y, buttonMask: 0 },
    },
  ];
}

/** One CDP click report at a desktop spot (dpr 1: screen coords = desktop coords). */
function click(prefix: string, ts: number, x: number, y: number): FixtureRow {
  return {
    id: `${prefix}-click`,
    tsOffsetMs: ts,
    layer: 'CDP',
    type: 'click',
    payload: {
      screenX: x,
      screenY: y,
      dpr: 1,
      button: 0,
      url: 'https://qa.example/',
      clientX: 1,
      clientY: 2,
    },
  };
}

interface Scenario {
  readonly label: string;
  readonly rows: readonly FixtureRow[];
  /** Rows that MUST end up correlatedWithId — each pair is mutual. */
  readonly setPairs: readonly (readonly [x11Id: string, cdpId: string])[];
}

/**
 * The ladder the task names (0/100/200/500), the exact [0,150] edges, and the
 * refusals the spec demands alongside them. Every scenario owns a distinct
 * desktop spot, so no report can pair across scenarios; the times interleave
 * globally, which is exactly the real trace's situation.
 */
function scenarios(): readonly Scenario[] {
  return [
    {
      label: 'dt=0 ms',
      rows: [...gesture('qa02-a', 1000, 100, 100), click('qa02-a', 1000, 100, 100)],
      setPairs: [['qa02-a-press', 'qa02-a-click']],
    },
    {
      label: 'dt=100 ms',
      rows: [...gesture('qa02-b', 1100, 200, 100), click('qa02-b', 1200, 200, 100)],
      setPairs: [['qa02-b-press', 'qa02-b-click']],
    },
    {
      label: 'dt=150 ms (the inclusive edge)',
      rows: [...gesture('qa02-c', 1200, 300, 100), click('qa02-c', 1350, 300, 100)],
      setPairs: [['qa02-c-press', 'qa02-c-click']],
    },
    {
      label: 'dt=151 ms (one past)',
      rows: [...gesture('qa02-d', 1300, 400, 100), click('qa02-d', 1451, 400, 100)],
      setPairs: [],
    },
    {
      label: 'dt=200 ms',
      rows: [...gesture('qa02-e', 1400, 500, 100), click('qa02-e', 1600, 500, 100)],
      setPairs: [],
    },
    {
      label: 'dt=500 ms',
      rows: [...gesture('qa02-f', 1500, 600, 100), click('qa02-f', 2000, 600, 100)],
      setPairs: [],
    },
    {
      label: 'dt=-30 ms (report before the press)',
      rows: [...gesture('qa02-g', 2200, 700, 100), click('qa02-g', 2170, 700, 100)],
      setPairs: [],
    },
    {
      label: 'in window but elsewhere',
      rows: [...gesture('qa02-h', 2300, 800, 100), click('qa02-h', 2330, 1180, 730)],
      setPairs: [],
    },
    {
      label: 'tolerance edge (2, 2) px',
      rows: [...gesture('qa02-i', 2400, 900, 100), click('qa02-i', 2430, 902, 102)],
      setPairs: [['qa02-i-press', 'qa02-i-click']],
    },
    {
      label: 'two presses in window — the newest wins',
      rows: [
        ...gesture('qa02-j1', 2500, 1000, 100),
        ...gesture('qa02-j2', 2600, 1000, 100),
        click('qa02-j2', 2640, 1000, 100),
      ],
      setPairs: [['qa02-j2-press', 'qa02-j2-click']],
    },
    {
      label: 'two reports, one press — the first pairs',
      rows: [
        ...gesture('qa02-k', 2700, 1100, 100),
        click('qa02-k', 2740, 1100, 100),
        { ...click('qa02-k', 2800, 1100, 100), id: 'qa02-k-click2' },
      ],
      setPairs: [['qa02-k-press', 'qa02-k-click']],
    },
  ];
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'M4-QA-02 click correlation ladder (real service, real database)',
  () => {
    let prisma: PrismaService;
    let botId: string;
    let recordingId: string;

    beforeAll(async () => {
      prisma = new PrismaService();
      await prisma.$connect();
      await prisma.user.upsert({
        where: { id: SINGLETON_USER_ID },
        create: {
          id: SINGLETON_USER_ID,
          name: 'Test User',
          email: `${SINGLETON_USER_ID}@test.invalid`,
        },
        update: {},
      });
      const bot = await prisma.bot.create({
        data: {
          userId: SINGLETON_USER_ID,
          name: `m4qa02-${RUN}`,
          role: 'QA fixture',
          avatarColor: '#123456',
          systemPrompt: 'x',
        },
      });
      botId = bot.id;
      const recording = await prisma.recording.create({
        data: { botId, intent: 'M4-QA-02 boundary trace' },
      });
      recordingId = recording.id;
      const data = scenarios().flatMap((scenario) =>
        scenario.rows.map((row) => ({ ...row, recordingId })),
      );
      await prisma.recordingEvent.createMany({ data });
    }, 30_000);

    afterAll(async () => {
      await prisma?.bot.deleteMany({ where: { id: botId } }).catch(() => undefined);
      await prisma?.$disconnect().catch(() => undefined);
    }, 30_000);

    it('marks both sides of every provable pair and nothing else', async () => {
      const all = scenarios();
      const expectedPairs = all.flatMap((scenario) =>
        scenario.setPairs.map(([x11Id, cdpId]) => ({ x11Id, cdpId })),
      );

      const service = new ClickCorrelatorService(prisma);
      await expect(service.correlate(recordingId)).resolves.toBe(expectedPairs.length);

      const rows = await prisma.recordingEvent.findMany({ where: { recordingId } });
      // Fixture-shape guards: the trace is exactly what this suite wrote.
      expect(rows).toHaveLength(36);
      const releases = rows.filter(
        (row) =>
          row.layer === 'X11' && (row.payload as Record<string, unknown>)['buttonMask'] === 0,
      );
      expect(releases).toHaveLength(12);

      const linkOf = new Map(rows.map((row) => [row.id, row.correlatedWithId]));
      const problems: string[] = [];

      // Every expected pair: BOTH rows name each other — the mutual link that
      // lets the compiler (M4-BE-06) drop one layer's row.
      const setIds = new Set<string>();
      for (const { x11Id, cdpId } of expectedPairs) {
        setIds.add(x11Id);
        setIds.add(cdpId);
        if (linkOf.get(x11Id) !== cdpId) {
          problems.push(`${x11Id} should point at ${cdpId}, is ${String(linkOf.get(x11Id))}`);
        }
        if (linkOf.get(cdpId) !== x11Id) {
          problems.push(`${cdpId} should point at ${x11Id}, is ${String(linkOf.get(cdpId))}`);
        }
      }

      // Everything else — refused pairs, releases, the older press, the
      // second report — stays exactly as captured.
      for (const row of rows) {
        if (!setIds.has(row.id) && row.correlatedWithId !== null) {
          problems.push(`${row.id} should stay NULL, is ${String(row.correlatedWithId)}`);
        }
      }

      expect(problems).toEqual([]);
      expect(setIds.size).toBe(expectedPairs.length * 2);
    }, 30_000);

    it('re-running the pass is idempotent: the same pairs, written the same way', async () => {
      const service = new ClickCorrelatorService(prisma);
      await expect(service.correlate(recordingId)).resolves.toBe(6);

      const readback = async (): Promise<string[]> =>
        (
          await prisma.recordingEvent.findMany({
            where: { recordingId },
            orderBy: { id: 'asc' },
            select: { id: true, correlatedWithId: true },
          })
        ).map((row) => `${row.id}:${row.correlatedWithId ?? 'null'}`);

      const before = await readback();
      await service.correlate(recordingId);
      expect(await readback()).toEqual(before);
    }, 30_000);
  },
);
