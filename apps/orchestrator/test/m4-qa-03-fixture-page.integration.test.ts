import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

import { PrismaService } from '../src/prisma/prisma.service.js';
import { ScreenService } from '../src/screen/screen.service.js';
import { TurnEventBus } from '../src/agent/turn-event.bus.js';
import { SkillCompileService } from '../src/skills/skill-compile.service.js';
import { parseTrace } from './m4-qa-03-emission-oracle.js';
import { oracleModel } from './m4-qa-03-oracle-model.js';
import { FIXTURE_ORIGIN } from './m4-qa-03-fixture-page.js';
import {
  ARM_MS,
  BOOT_MS,
  FakeClient,
  FixtureSandbox,
  USER_ID,
  calibrate,
  coordinateClicksIn,
  noPairMessage,
  recordOneCorrelatedClick,
  saveEvidence,
  until,
  type Calibration,
} from './m4-qa-0304-harness.js';
import type { MockLanguageModelV4 as LanguageModel } from './model-resolution-fake.js';
import type { ResolvedTextModel } from '../src/models/model-resolution.service.js';
import { resolvedTextModelOf } from './model-resolution-fake.js';
import { ModelResolutionService } from '../src/models/model-resolution.service.js';

/**
 * M4-QA-03 — §6/M4's required integration test, as a test:
 *
 *   "Integration: record against a locally served fixture page, assert the
 *    compiled script has no coordinate clicks."
 *
 * Real Docker, real Chrome, a real HTTP origin served from inside the sandbox,
 * a real click through the product's own §4.3 input path, the real correlator
 * (it runs inside `stop`), and the real `SkillCompileService`. The one thing
 * stubbed is the model — through the same `resolveModel` seam M3-QA-05 uses —
 * and it is stubbed with a mechanical reader of the emission rules rather than
 * a canned answer, so "no coordinate clicks" is a statement about the trace the
 * product built. `m4-qa-03-compiled-script.test.ts` pins that reader and shows
 * the assertion failing on each regression it is meant to catch.
 *
 * @skip-reason: needs a Docker daemon, a built crewaid/sandbox image, a real
 * database and Redis; set CREWAID_DOCKER_TESTS=1 with DATABASE_URL and REDIS_URL
 * to run (Natanael). All three are declared in turbo.json's globalEnv so
 * Turbo's strict env mode cannot strip a gate and turn this into a dormant
 * guard (D-017).
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const DOCKER_TESTS = process.env['CREWAID_DOCKER_TESTS'];
const SKIP =
  DATABASE_URL === undefined ||
  DATABASE_URL === '' ||
  DOCKER_TESTS === undefined ||
  DOCKER_TESTS === '';

const TEST_MS = 300_000;

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

describe.skipIf(SKIP)(
  'M4-QA-03 — a recording against a served fixture page compiles with no coordinate clicks',
  () => {
    let sandbox: FixtureSandbox;
    let calibration: Calibration;

    beforeAll(async () => {
      sandbox = await FixtureSandbox.boot('m4qa03', randomUUID().slice(0, 8));
      calibration = await calibrate(sandbox);
    }, BOOT_MS);

    afterAll(async () => {
      await sandbox?.teardown();
    }, BOOT_MS);

    it(
      'records one browser click on the served page and compiles it to a page call, never a pixel',
      async () => {
        const screens = sandbox.app.get(ScreenService);
        const prisma = sandbox.app.get(PrismaService);

        const client = new FakeClient();
        await screens.subscribe(USER_ID, client as unknown as WebSocket, sandbox.botId);
        await until(async () => client.sends > 0, ARM_MS, 'the first §4.3 screen frame');

        const recorded = await recordOneCorrelatedClick(
          sandbox,
          client,
          calibration,
          'buy the ultimate plan on the pricing page',
        );
        expect(recorded, noPairMessage(recorded?.latencies ?? [])).not.toBeNull();

        // ── compile, for real, with the rules as the model ──────────────────
        const { model, calls } = oracleModel({ name: 'buy_the_ultimate_plan' });
        resolveModel.mockReturnValue(model);
        const compiler = new SkillCompileService(prisma, new TurnEventBus(), models());
        await compiler.run(recorded!.recordingId);

        const recording = await prisma.recording.findUniqueOrThrow({
          where: { id: recorded!.recordingId },
        });
        expect(recording.state, `compile failed: ${recording.error ?? ''}`).toBe('READY');

        const skills = await prisma.skill.findMany({
          where: { sourceRecordingId: recorded!.recordingId },
        });
        expect(skills).toHaveLength(1);
        const script = String(skills[0]!.script);
        const emitted = calls[0]!.emission;
        const lines = parseTrace(calls[0]!.trace);
        const selectors = [
          ...script.replace(/\\"/g, '"').matchAll(/ctx\.page\.click\("(.+?)"\)/g),
        ].map((match) => match[1]!);

        // Written BEFORE the assertions: a failure here is about what the
        // product produced, and the artefact saying what that was must survive
        // the failure.
        saveEvidence(
          'qa03-compiled.json',
          JSON.stringify(
            {
              recordingId: recorded!.recordingId,
              correlationDtMs: recorded!.dt,
              latenciesMs: recorded!.latencies,
              origin: FIXTURE_ORIGIN,
              pressRowId: recorded!.press.id,
              clickRowId: recorded!.click.id,
              rowTypes: recorded!.rows.map((row) => `${row.layer}:${row.type}`),
              traceTypes: lines.map((line) => String(line['type'])),
              selectors,
              script,
              steps: emitted.steps,
              coordinateClicks: emitted.coordinateClicks,
            },
            null,
            2,
          ),
        );
        saveEvidence('qa03-trace.ndjson', calls[0]!.trace);

        // ── §6/M4's required assertion ──────────────────────────────────────
        expect(coordinateClicksIn(script), `the compiled script drives pixels: ${script}`).toEqual(
          [],
        );
        // ...and it is not empty-therefore-passing: the action IS in there, as
        // a page call naming the element the page itself named.
        expect(script).toContain('ctx.page.click');
        const pageClicks = emitted.steps.filter((step) => step.form === 'ctx.page.click');
        // Exactly one: the recording holds exactly one interaction, and it
        // compiled to exactly one page call.
        expect(pageClicks).toHaveLength(1);
        expect(selectors.length).toBe(pageClicks.length);
        // Every selector is one the shipped resolver can run: a plain
        // document-level query, never the ladder's engine-syntax rung.
        for (const selector of selectors) expect(selector).not.toContain('text=');
        expect(selectors, `no #buy page click in: ${script}`).toContain('[data-testid="buy"]');

        // ── why it has none: the model was shown one row, not two ───────────
        const clickLines = lines.filter((line) => line['type'] === 'click');
        const pressLines = lines.filter(
          (line) => line['type'] === 'pointer' && line['buttonMask'] === 1,
        );
        expect(pressLines, 'a raw X11 press survived the fold').toEqual([]);
        expect(clickLines).toHaveLength(1);
        expect(calls[0]!.trace).not.toContain('text=');

        // The navigation the recording began with reached the model as a real
        // wait condition (M4-BE-04), not as a duration.
        expect(lines.some((line) => line['type'] === 'navigate')).toBe(true);
        expect(script).toContain("ctx.page.waitForLoadState('load')");
        // §6/M4: "Waits are page waits ... never coordinate-blind delays."
        expect(script).not.toContain('sleep');
        expect(script).not.toContain('setTimeout');

        console.log(
          `M4-QA-03: served ${FIXTURE_ORIGIN}, click correlated at dt=${recorded!.dt}ms, ` +
            `compiled to ${emitted.steps.length} step(s), 0 coordinate clicks, ` +
            `selector ${selectors.join(' + ')}`,
        );
      },
      TEST_MS,
    );
  },
);
