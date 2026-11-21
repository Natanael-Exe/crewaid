import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SkillCompileService } from '../src/skills/skill-compile.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { TurnEventBus } from '../src/agent/turn-event.bus.js';
import { emitScript, selectorOf, parseTrace } from './m4-qa-03-emission-oracle.js';
import { oracleModel, traceTextOf } from './m4-qa-03-oracle-model.js';
import type { MockLanguageModelV4 as LanguageModel } from './model-resolution-fake.js';
import type { ResolvedTextModel } from '../src/models/model-resolution.service.js';
import { resolvedTextModelOf } from './model-resolution-fake.js';
import { ModelResolutionService } from '../src/models/model-resolution.service.js';

/**
 * M4-QA-03 — the deterministic substrate: a browser recording compiles to a
 * script with ZERO coordinate clicks, and the claim is one that can fail.
 *
 * §6/M4's required test names a real recording against a served page, and the
 * docker suite beside this one is that. This file is what makes that suite
 * readable evidence rather than a single green tick: it pins the oracle
 * against traces whose right answer is written down, then runs the REAL
 * `SkillCompileService` over rows shaped exactly as the correlator leaves them,
 * and then shows the assertion failing on each of the two regressions that
 * would put a coordinate click back in a browser task's script.
 *
 * It needs no Docker and no database, so it runs in CI on every change — which
 * is the point. The docker suite proves the property against a real Chrome
 * once; this one keeps proving it.
 *
 * ── WHAT "ZERO COORDINATE CLICKS" RESTS ON ──────────────────────────────────
 *
 * Three product behaviours, none of them the model's:
 *
 *   1. M4-BE-05 wrote `correlatedWithId` on both rows of a click that happened
 *      in the browser.
 *   2. M4-BE-06's `foldCorrelated` collapsed that pair into ONE row, so the
 *      raw X11 press is not in the trace to be emitted from.
 *   3. M4-BE-06's `constrainToResolver` left that row with a candidate the
 *      shipped `ctx.page` resolver can execute, so the row still names its
 *      element and does not fall back to its coordinates.
 *
 * Break any one of them and a coordinate click appears. The falsification
 * section at the bottom breaks each one and shows exactly that.
 */

/**
 * V1-06: the model stub moved from `model-registry.js`'s `resolveModel` export
 * to `ModelResolutionService.resolve` — D-086 made resolution owner-scoped, so
 * it is a service that reads rows rather than a module-level function.
 *
 * The seam keeps its shape on purpose: cases still say
 * `resolveModel.mockReturnValue(model)`, and `resolvedTextModelOf` wraps whatever
 * that returns in the envelope the real service produces. `importActual`
 * preserves the module's error classes, which callers branch on.
 */
const { resolveModel } = vi.hoisted(() => ({ resolveModel: vi.fn() }));
vi.mock('../src/models/model-resolution.service.js', async () => ({
  ...(await vi.importActual<object>('../src/models/model-resolution.service.js')),
  ModelResolutionService: class {
    resolveText = (): Promise<ResolvedTextModel> =>
      Promise.resolve(resolvedTextModelOf(resolveModel() as LanguageModel));
    setAddressResolverForTests = (): void => {};
  },
}));

/**
 * The mocked `ModelResolutionService` (see the `vi.mock` above). Constructed
 * per use rather than shared: it is stateless, and a shared instance is one
 * more thing a case could accidentally come to depend on.
 */
function models(): ModelResolutionService {
  // The mock class ignores both arguments; the real one needs them. Passing
  // them explicitly keeps the call site honest about that.
  return new ModelResolutionService(undefined as never, undefined as never);
}

/** The fixture page's own selectors, as the recorder would have found them. */
const BUY_LADDER = [
  { kind: 'testid', selector: '[data-testid="buy"]', unique: true },
  { kind: 'id', selector: '#buy', unique: true },
  { kind: 'css', selector: '#last-card > button', unique: true },
  // Text uniqueness was measured by the recorder, not the native selector
  // engine. It remains outside the automatically emitted candidate set.
  { kind: 'text', selector: 'text="Buy now"', unique: true },
];

/** Where the click landed on the desktop, in framebuffer pixels. */
const CLICK_AT = { x: 1113, y: 342 };

interface FixtureEvent {
  id?: string;
  tsOffsetMs: number;
  layer?: string;
  type: string;
  payload: unknown;
  screenshotKey: string | null;
  correlatedWithId?: string | null;
}

/**
 * A browser recording as the correlator leaves it: the page was loaded, then
 * one click that both layers saw and M4-BE-05 proved was one action.
 *
 * `correlated` is what the falsification section turns off; `ladder` is what
 * it narrows to rungs without complete target evidence.
 */
function browserRecording(
  options: { correlated?: boolean; ladder?: typeof BUY_LADDER } = {},
): FixtureEvent[] {
  const correlated = options.correlated ?? true;
  const ladder = options.ladder ?? BUY_LADDER;
  return [
    {
      id: 'nav-1',
      tsOffsetMs: 200,
      layer: 'CDP',
      type: 'navigate',
      payload: { url: 'http://127.0.0.1:7171/' },
      screenshotKey: null,
    },
    {
      id: 'load-1',
      tsOffsetMs: 460,
      layer: 'CDP',
      type: 'load',
      payload: { url: 'http://127.0.0.1:7171/' },
      screenshotKey: null,
    },
    {
      id: 'press-1',
      tsOffsetMs: 1_000,
      layer: 'X11',
      type: 'pointer',
      payload: { x: CLICK_AT.x, y: CLICK_AT.y, buttonMask: 1 },
      screenshotKey: 'crop-1',
      correlatedWithId: correlated ? 'click-1' : null,
    },
    {
      id: 'release-1',
      tsOffsetMs: 1_040,
      layer: 'X11',
      type: 'pointer',
      payload: { x: CLICK_AT.x, y: CLICK_AT.y, buttonMask: 0 },
      screenshotKey: null,
      correlatedWithId: null,
    },
    {
      id: 'click-1',
      tsOffsetMs: 1_090,
      layer: 'CDP',
      type: 'click',
      payload: {
        url: 'http://127.0.0.1:7171/',
        tag: 'BUTTON',
        id: 'buy',
        testid: 'buy',
        screenX: CLICK_AT.x,
        screenY: CLICK_AT.y,
        dpr: 1,
        candidates: ladder,
      },
      screenshotKey: null,
      correlatedWithId: correlated ? 'press-1' : null,
    },
  ];
}

/**
 * The compile service over a fake client — the same seam `skill-compile.test.ts`
 * uses, written out here rather than imported because a QA substrate that
 * shares a harness with the suite it is checking shares that harness's
 * blind spots.
 */
function compileOver(events: FixtureEvent[]) {
  const row = {
    id: 'rec-1',
    botId: 'bot-1',
    state: 'COMPILING',
    intent: 'buy the ultimate plan',
    warning: null as string | null,
    error: null as string | null,
    endedAt: new Date('2026-09-12T09:00:00Z'),
  };
  const skills: Record<string, unknown>[] = [];
  const client = {
    recording: {
      findUnique: vi.fn(() => Promise.resolve({ ...row, bot: { modelId: 'default' } })),
      updateMany: vi.fn(({ where, data }: { where: typeof row; data: Partial<typeof row> }) => {
        if (where.state !== undefined && row.state !== where.state) {
          return Promise.resolve({ count: 0 });
        }
        Object.assign(row, data);
        return Promise.resolve({ count: 1 });
      }),
    },
    recordingEvent: { findMany: vi.fn(() => Promise.resolve(events)) },
    sandbox: { findFirst: vi.fn(() => Promise.resolve({ widthPx: 1280, heightPx: 800 })) },
    skill: {
      findFirst: vi.fn(() => Promise.resolve(null)),
      create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        const skill = { id: `skill-${skills.length + 1}`, ...data };
        skills.push(skill);
        return Promise.resolve(skill);
      }),
    },
  };
  const prisma = {
    ...client,
    $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(client)),
  } as unknown as PrismaService;
  const bus = {
    emitRecordingState: vi.fn(),
    emitSkillCompiled: vi.fn(),
  } as unknown as TurnEventBus;
  return { service: new SkillCompileService(prisma, bus, models()), row, skills };
}

/** Every coordinate click in a script, found the way a reader would. */
function coordinateClicksIn(script: string): readonly string[] {
  return script.match(/ctx\.click\([^)]*\)/g) ?? [];
}

let artifactDir: string;

beforeEach(async () => {
  artifactDir = await mkdtemp(path.join(tmpdir(), 'crewaid-qa03-'));
  process.env['ARTIFACT_DIR'] = artifactDir;
  resolveModel.mockReset();
});

afterEach(() => {
  delete process.env['ARTIFACT_DIR'];
  vi.restoreAllMocks();
});

// ───────────────────────────────────────────────────────────────────────────
// 1. The oracle, pinned before it is trusted to judge anything.
// ───────────────────────────────────────────────────────────────────────────

describe('M4-QA-03 — the emission oracle reads the legend the way the legend reads', () => {
  it('names the element by the first unique rung, not the first rung', () => {
    const line = {
      candidates: [
        { kind: 'testid', selector: '[data-testid="a"]', unique: false },
        { kind: 'id', selector: '#b', unique: true },
      ],
    };

    // The legend: "the first candidate with `unique`:true names the element".
    expect(selectorOf(line)).toBe('#b');
  });

  it('falls to the first rung when the ladder has no unique one, and to null with no ladder', () => {
    expect(selectorOf({ candidates: [{ kind: 'css', selector: 'button', unique: false }] })).toBe(
      'button',
    );
    expect(selectorOf({ x: 1, y: 2 })).toBeNull();
    expect(selectorOf({ candidates: [] })).toBeNull();
  });

  it('emits a page click for a click with a ladder and a coordinate click for one without', () => {
    const withLadder = emitScript(
      JSON.stringify({ ms: 10, type: 'click', candidates: BUY_LADDER, x: 5, y: 6 }),
    );
    const without = emitScript(JSON.stringify({ ms: 10, type: 'click', x: 5, y: 6 }));

    expect(withLadder.steps.map((step) => step.form)).toEqual(['ctx.page.click']);
    expect(withLadder.coordinateClicks).toEqual([]);
    expect(without.steps.map((step) => step.form)).toEqual(['ctx.click']);
    expect(without.coordinateClicks).toHaveLength(1);
    expect(without.script).toContain('await ctx.click(5, 6);');
  });

  it('emits a coordinate click for a raw X11 press, and nothing for its release', () => {
    const emission = emitScript(
      [
        JSON.stringify({ ms: 10, type: 'pointer', x: 7, y: 8, buttonMask: 1 }),
        JSON.stringify({ ms: 40, type: 'pointer', x: 7, y: 8, buttonMask: 0 }),
      ].join('\n'),
    );

    // The legend: a press and a release at the same point are one click.
    expect(emission.steps.map((step) => step.form)).toEqual(['ctx.click']);
  });

  it('turns a navigate/load pair into one load wait, and emits nothing for a submit', () => {
    const emission = emitScript(
      [
        JSON.stringify({ ms: 10, type: 'navigate', url: 'http://x/' }),
        JSON.stringify({ ms: 90, type: 'load', url: 'http://x/' }),
        JSON.stringify({ ms: 95, type: 'submit' }),
      ].join('\n'),
    );

    expect(emission.steps.map((step) => step.form)).toEqual(['ctx.page.waitForLoadState']);
  });

  it('fills a field row by its ladder and its recorded value', () => {
    const emission = emitScript(
      JSON.stringify({
        ms: 10,
        type: 'input',
        value: 'otters',
        candidates: [{ kind: 'id', selector: '#query', unique: true }],
      }),
    );

    expect(emission.script).toContain(`await ctx.page.fill("#query", "otters");`);
  });

  it('refuses a trace line that is not a JSON object rather than skipping it', () => {
    // A renderer that stopped producing compact JSON would otherwise read as
    // an empty script, which is indistinguishable from a trace with no steps.
    expect(() => parseTrace('not json')).toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. The claim: a browser recording compiles to zero coordinate clicks.
// ───────────────────────────────────────────────────────────────────────────

describe('M4-QA-03 — a browser recording compiles with no coordinate clicks', () => {
  it('emits one page click for the correlated action, and a load wait for the navigation', async () => {
    const { service, row, skills } = compileOver(browserRecording());
    const { model, calls } = oracleModel();
    resolveModel.mockReturnValue(model);

    await service.run('rec-1');

    expect(row.state).toBe('READY');
    expect(skills).toHaveLength(1);
    const script = String(skills[0]!['script']);

    // §6/M4's acceptance criterion, as an assertion about the artefact.
    expect(coordinateClicksIn(script)).toEqual([]);
    expect(script).toContain(`await ctx.page.click("[data-testid=\\"buy\\"]");`);
    expect(script).toContain(`await ctx.page.waitForLoadState('load');`);

    // ...and the forms the rules name, in trace order, with nothing else.
    expect(calls[0]!.emission.steps.map((step) => step.form)).toEqual([
      'ctx.page.waitForLoadState',
      'ctx.page.click',
    ]);
  });

  it('shows the model ONE row for the action, at the press offset, with no raw press beside it', async () => {
    const { service } = compileOver(browserRecording());
    const { model, calls } = oracleModel();
    resolveModel.mockReturnValue(model);

    await service.run('rec-1');

    const lines = parseTrace(calls[0]!.trace);
    const clicks = lines.filter((line) => line['type'] === 'click');
    const presses = lines.filter((line) => line['type'] === 'pointer' && line['buttonMask'] === 1);

    // "The compiler must not emit both" — it cannot, because it is shown one.
    expect(clicks).toHaveLength(1);
    expect(presses).toEqual([]);
    // The merged row sits where the press was, carrying the press's position.
    expect(clicks[0]).toMatchObject({ ms: 1_000, x: CLICK_AT.x, y: CLICK_AT.y });
  });

  it('emits CSS evidence rather than unproven native text uniqueness', async () => {
    const { service } = compileOver(browserRecording());
    const { model, calls } = oracleModel();
    resolveModel.mockReturnValue(model);

    await service.run('rec-1');

    expect(calls[0]!.trace).not.toContain('text=');
    const kinds = (
      parseTrace(calls[0]!.trace).find((line) => line['type'] === 'click')!['candidates'] as Array<{
        kind: string;
      }>
    ).map((candidate) => candidate.kind);
    expect(kinds).toEqual(['testid', 'id', 'css']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. Falsification — each product behaviour the claim rests on, removed.
//
// A green assertion is evidence only if the red one is reachable. Each case
// here is a minimal, realistic regression in a different one of the three
// behaviours above, and each puts a coordinate click back in the script.
// ───────────────────────────────────────────────────────────────────────────

describe('M4-QA-03 — the claim fails when the product behaviour it rests on does', () => {
  it('FALSIFY correlation: an uncorrelated pair emits BOTH layers for one action', async () => {
    const { service, skills } = compileOver(browserRecording({ correlated: false }));
    const { model } = oracleModel();
    resolveModel.mockReturnValue(model);

    await service.run('rec-1');
    const script = String(skills[0]!['script']);

    // The M4-BE-05 regression: nothing proved the two rows were one action, so
    // the fold has no pair to collapse and the model is shown both.
    expect(coordinateClicksIn(script)).toEqual([`ctx.click(${CLICK_AT.x}, ${CLICK_AT.y})`]);
    expect(script).toContain('ctx.page.click');
  });

  it('FALSIFY the resolver fence: a ladder of only unrunnable rungs falls back to pixels', async () => {
    const { service, skills } = compileOver(
      browserRecording({
        ladder: [
          { kind: 'text', selector: 'text="Buy now"', unique: true },
          // A rung generated inside a shadow root: real, recorded, and
          // not tied to a demonstrated shadow host.
          { kind: 'id', selector: '#buy', unique: true, shadow: true } as never,
        ],
      }),
    );
    const { model } = oracleModel();
    resolveModel.mockReturnValue(model);

    await service.run('rec-1');
    const script = String(skills[0]!['script']);

    // Nothing left names the element, so the row is a coordinate click — the
    // honest emission, and the one QA-03 says a browser task must not need.
    expect(coordinateClicksIn(script)).toEqual([`ctx.click(${CLICK_AT.x}, ${CLICK_AT.y})`]);
    expect(script).not.toContain('ctx.page.click');
  });

  it('FALSIFY the assertion itself: a script the rules did not write is caught', async () => {
    const { service, skills } = compileOver(browserRecording());
    // A model that ignores the rules and clicks the pixels anyway. The trace
    // was right; the answer was not. The assertion must still fail, or it is
    // measuring the trace under the name of the script.
    const { model } = oracleModel({
      rewrite: () =>
        `export default async function run(ctx) {\n  await ctx.click(${CLICK_AT.x}, ${CLICK_AT.y});\n}`,
    });
    resolveModel.mockReturnValue(model);

    await service.run('rec-1');

    expect(coordinateClicksIn(String(skills[0]!['script']))).toHaveLength(1);
  });

  it('CONTROL: a desktop recording still compiles to coordinate clicks, as it must', async () => {
    // The claim is about BROWSER tasks. A task outside the browser has no
    // selectors to name anything with, and turning its clicks into page calls
    // would be the real defect — so the same pipeline must keep emitting
    // coordinates here.
    const { service, skills } = compileOver([
      {
        id: 'p1',
        tsOffsetMs: 300,
        layer: 'X11',
        type: 'pointer',
        payload: { x: 220, y: 180, buttonMask: 1 },
        screenshotKey: null,
      },
      {
        id: 'r1',
        tsOffsetMs: 340,
        layer: 'X11',
        type: 'pointer',
        payload: { x: 220, y: 180, buttonMask: 0 },
        screenshotKey: null,
      },
    ]);
    const { model } = oracleModel();
    resolveModel.mockReturnValue(model);

    await service.run('rec-1');

    expect(coordinateClicksIn(String(skills[0]!['script']))).toEqual(['ctx.click(220, 180)']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. The stub's own reader, pinned: a trace it cannot find is not a pass.
// ───────────────────────────────────────────────────────────────────────────

describe('M4-QA-03 — the oracle model reads the real prompt, not a heading', () => {
  it('carves the trace out by line shape and ignores the prose around it', () => {
    const text = [
      'Intent: buy the ultimate plan',
      'The trace is one JSON object per line, in order, where:',
      '  - "ms" is milliseconds since the recording started.',
      '{"ms":0,"type":"navigate","url":"http://127.0.0.1:7171/"}',
      '{"ms":90,"type":"load","url":"http://127.0.0.1:7171/"}',
      'Screen: 1280x800',
    ].join('\n');

    expect(traceTextOf(text).split('\n')).toHaveLength(2);
    expect(emitScript(traceTextOf(text)).steps.map((step) => step.form)).toEqual([
      'ctx.page.waitForLoadState',
    ]);
  });

  it('an empty trace is an empty script, never a silent pass', () => {
    // If `traceTextOf` ever stopped matching, every assertion above would go
    // green on a script with nothing in it. This is the pin that says so.
    const emission = emitScript(traceTextOf('no trace here at all'));
    expect(emission.steps).toEqual([]);
    expect(emission.script).not.toContain('await');
  });
});
