import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

import { PrismaService } from '../src/prisma/prisma.service.js';
import { ScreenService } from '../src/screen/screen.service.js';
import { RecordingsService } from '../src/recordings/recordings.service.js';
import { CdpAttachService } from '../src/recordings/cdp-attach.service.js';
import { TurnEventBus } from '../src/agent/turn-event.bus.js';
import { SkillCompileService } from '../src/skills/skill-compile.service.js';
import { oracleModel } from './m4-qa-03-oracle-model.js';
import {
  FIXTURE_BREAKPOINT_PX,
  FIXTURE_ORIGIN,
  QA04_NARROW_PX,
  QA04_WIDE_PX,
} from './m4-qa-03-fixture-page.js';
import {
  ARM_MS,
  BOOT_MS,
  BUY_CENTRE_EXPRESSION,
  FakeClient,
  FixtureSandbox,
  USER_ID,
  calibrate,
  coordinateClicksIn,
  drivePage,
  noPairMessage,
  readJson,
  recordOneCorrelatedClick,
  saveEvidence,
  sleep,
  until,
  type BuyRect,
  type Calibration,
  type DrivenPage,
} from './m4-qa-0304-harness.js';
import type { MockLanguageModelV4 as LanguageModel } from './model-resolution-fake.js';
import type { ResolvedTextModel } from '../src/models/model-resolution.service.js';
import { resolvedTextModelOf } from './model-resolution-fake.js';
import { ModelResolutionService } from '../src/models/model-resolution.service.js';

/**
 * M4-QA-04 — §6/M4's other required integration test, as a test:
 *
 *   "Integration: layout-shift robustness — run the skill against the fixture
 *    at 1280 px and at 900 px, both succeed."
 *
 * and the acceptance criterion behind it: "A skill generated from a browser
 * task still succeeds after layout shift, verified with a fixture page at two
 * viewport widths."
 *
 * The skill is not written here. It is COMPILED, by the same chain QA-03
 * asserts about — recorded through the §4.3 input path, correlated, folded,
 * and emitted by the rules — and then run, unmodified, through the sandbox
 * bridge at each width. What the milestone claims is that selector-driven
 * replay survives a layout the recording never saw, so the fixture is built to
 * move `#buy` a long way: the rail is a flex row above the breakpoint and a
 * block stack below it, and the two required widths sit on opposite sides.
 *
 * ── WHY THE VIEWPORT MOVES AND THE SCREEN DOES NOT ──────────────────────────
 *
 * R8 fixes a sandbox's resolution for its entire lifetime — "never
 * renegotiated" — so the two widths cannot be two screens. They are two
 * VIEWPORTS, set with `Emulation.setDeviceMetricsOverride`, which is what
 * Playwright's own `setViewportSize` does underneath and exactly the axis the
 * criterion names. The skill is unaffected either way: `ctx.page` resolves a
 * selector and dispatches at the element's centre in CSS pixels, so it never
 * consults the framebuffer at all — which is the property under test.
 *
 * ── WHAT MAKES "BOTH SUCCEED" MEAN SOMETHING ────────────────────────────────
 *
 * A skill that did nothing would also "succeed". So each run is judged by the
 * PAGE: `#buy`'s own handler increments a counter and appends `#receipt`, and
 * the run is a pass only when the counter moved and the receipt exists. And
 * the layout shift is measured, not assumed — the suite records where `#buy`
 * actually is at each width and fails if it did not move — with the contrast
 * stated directly: a click at the WIDE centre, replayed at the narrow width,
 * lands on something else. That is the failure the milestone bought selectors
 * to avoid, demonstrated on the same page in the same run.
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

const TEST_MS = 360_000;

/**
 * How far `#buy` must move between the two widths for the run to be evidence.
 *
 * Not a tolerance — a floor. The fixture's own geometry puts the shift in the
 * hundreds of pixels on both axes; anything close to this number would mean
 * the page did not reflow and the suite would be asserting nothing.
 */
const MIN_SHIFT_PX = 200;

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

/** What one width's replay produced, for the assertions and the artefact. */
interface WidthResult {
  readonly widthPx: number;
  readonly innerWidth: number;
  readonly rect: BuyRect;
  readonly ok: boolean;
  readonly detail: string | undefined;
  readonly buyCount: number;
  readonly receipt: boolean;
}

describe.skipIf(SKIP)(
  'M4-QA-04 — a compiled browser skill survives the layout shift between 1280 px and 900 px',
  () => {
    let sandbox: FixtureSandbox;
    let calibration: Calibration;

    beforeAll(async () => {
      sandbox = await FixtureSandbox.boot('m4qa04', randomUUID().slice(0, 8));
      calibration = await calibrate(sandbox);
    }, BOOT_MS);

    afterAll(async () => {
      await sandbox?.teardown();
    }, BOOT_MS);

    it(
      'compiles a recorded click and replays it at both required widths, on a page that moved',
      async () => {
        const screens = sandbox.app.get(ScreenService);
        const prisma = sandbox.app.get(PrismaService);
        const recordings = sandbox.app.get(RecordingsService);
        const cdp = sandbox.app.get(CdpAttachService);

        const client = new FakeClient();
        await screens.subscribe(USER_ID, client as unknown as WebSocket, sandbox.botId);
        await until(async () => client.sends > 0, ARM_MS, 'the first §4.3 screen frame');

        // ── record and compile: the skill under test is a compiled one ──────
        const recorded = await recordOneCorrelatedClick(
          sandbox,
          client,
          calibration,
          'buy the ultimate plan on the pricing page',
        );
        expect(recorded, noPairMessage(recorded?.latencies ?? [])).not.toBeNull();

        const { model } = oracleModel({ name: 'buy_the_ultimate_plan' });
        resolveModel.mockReturnValue(model);
        await new SkillCompileService(prisma, new TurnEventBus(), models()).run(
          recorded!.recordingId,
        );
        const skills = await prisma.skill.findMany({
          where: { sourceRecordingId: recorded!.recordingId },
        });
        expect(skills).toHaveLength(1);
        const script = String(skills[0]!.script);
        // The premise QA-03 establishes, restated here so this suite fails for
        // its own reason if it ever stops holding: the skill being replayed is
        // selector-driven, which is the only reason a layout shift is
        // survivable at all.
        expect(coordinateClicksIn(script), `the compiled skill drives pixels: ${script}`).toEqual(
          [],
        );
        expect(script).toContain('ctx.page.click');

        // ── one open CDP session for the whole replay ───────────────────────
        //
        // `Emulation.setDeviceMetricsOverride` lives on the session that set
        // it, so the connection has to outlive each bridge run. A recording
        // held open is how this codebase keeps one, and its own rows are never
        // read: what this suite measures is the page and the bridge's answer.
        const replay = await recordings.start(USER_ID, sandbox.botId, {
          intent: 'layout-shift replay (rows unused)',
        });
        const results: WidthResult[] = [];
        let wideCentre: BuyRect | null = null;
        let narrowMissCount = { before: 0, after: 0 };

        try {
          const connection = await cdp.connectionFor(sandbox.botId, replay.recordingId);
          if (connection === null) throw new Error('the replay CDP attach never completed');
          const page: DrivenPage = await drivePage(connection);

          /** Set the viewport, load a fresh document, and report where #buy is. */
          const atWidth = async (widthPx: number, tag: string): Promise<BuyRect> => {
            await connection.send(
              'Emulation.setDeviceMetricsOverride',
              { width: widthPx, height: 800, deviceScaleFactor: 0, mobile: false },
              page.session,
            );
            // A fresh document each time: `no-store` means a real fetch, so the
            // counters start at zero and a pass cannot be inherited from the
            // width before it.
            await page.navigate(`${FIXTURE_ORIGIN}/?width=${widthPx}&t=${tag}`);
            await until(
              async () =>
                (await page.evaluate("document.getElementById('buy') !== null")) === true &&
                Number(await page.evaluate('window.innerWidth')) === widthPx,
              ARM_MS,
              `the fixture to be laid out at ${widthPx}px`,
            );
            // One frame for the reflow to settle before it is measured.
            await sleep(300);
            return readJson<BuyRect>(page, BUY_CENTRE_EXPRESSION);
          };

          for (const widthPx of [QA04_WIDE_PX, QA04_NARROW_PX]) {
            const rect = await atWidth(widthPx, randomUUID().slice(0, 6));
            if (widthPx === QA04_WIDE_PX) wideCentre = rect;

            const outcome = await sandbox.bridgeSkill(script);
            // The page is the judge, not the runner's exit code.
            await until(
              async () => Number(await page.evaluate('window.__qa.buy')) >= 1,
              20_000,
              `the replay at ${widthPx}px to land on #buy`,
            ).catch(() => undefined);

            results.push({
              widthPx,
              innerWidth: Number(await page.evaluate('window.innerWidth')),
              rect,
              ok: outcome.ok,
              detail: outcome.detail,
              buyCount: Number(await page.evaluate('window.__qa.buy')),
              receipt:
                (await page.evaluate("document.getElementById('receipt') !== null")) === true,
            });
          }

          // ── the contrast: the recorded pixel is wrong at the new width ────
          //
          // Same page, same run: a click at the WIDE centre, dispatched while
          // the narrow layout is up, must not reach #buy. This is what the
          // compiled skill would have done had M4 emitted coordinates, and it
          // is why "both succeed" above is a result rather than a tautology.
          narrowMissCount.before = Number(await page.evaluate('window.__qa.buy'));
          for (const type of ['mousePressed', 'mouseReleased'] as const) {
            await connection.send(
              'Input.dispatchMouseEvent',
              {
                type,
                x: wideCentre!.x,
                y: wideCentre!.y,
                button: 'left',
                buttons: type === 'mousePressed' ? 1 : 0,
                clickCount: 1,
              },
              page.session,
            );
          }
          await sleep(500);
          narrowMissCount.after = Number(await page.evaluate('window.__qa.buy'));
        } finally {
          await recordings.stop(USER_ID, replay.recordingId).catch(() => undefined);
        }

        const wide = results.find((result) => result.widthPx === QA04_WIDE_PX)!;
        const narrow = results.find((result) => result.widthPx === QA04_NARROW_PX)!;
        const shift = {
          dx: Math.abs(wide.rect.x - narrow.rect.x),
          dy: Math.abs(wide.rect.y - narrow.rect.y),
        };

        saveEvidence(
          'qa04-layout-shift.json',
          JSON.stringify(
            {
              recordingId: recorded!.recordingId,
              correlationDtMs: recorded!.dt,
              script,
              breakpointPx: FIXTURE_BREAKPOINT_PX,
              results,
              shift,
              recordedWideCentre: wideCentre,
              coordinateReplayAtNarrow: narrowMissCount,
            },
            null,
            2,
          ),
        );

        // ── 1. the page really did reflow ───────────────────────────────────
        expect(wide.innerWidth).toBe(QA04_WIDE_PX);
        expect(narrow.innerWidth).toBe(QA04_NARROW_PX);
        expect(
          shift.dx,
          `#buy barely moved horizontally (${JSON.stringify(shift)}); the fixture did not reflow, ` +
            'so this run proves nothing about layout shift',
        ).toBeGreaterThan(MIN_SHIFT_PX);
        expect(shift.dy, `#buy barely moved vertically (${JSON.stringify(shift)})`).toBeGreaterThan(
          MIN_SHIFT_PX,
        );

        // ── 2. §6/M4's required assertion: both widths succeed ──────────────
        for (const result of results) {
          expect(
            result.ok,
            `the compiled skill failed at ${result.widthPx}px: ${result.detail ?? 'no detail'}`,
          ).toBe(true);
          // Judged by the page, not by the runner: the click LANDED on #buy.
          expect(result.buyCount, `nothing was clicked at ${result.widthPx}px`).toBe(1);
          expect(result.receipt, `no receipt appeared at ${result.widthPx}px`).toBe(true);
        }

        // ── 3. the contrast that makes it a result ──────────────────────────
        expect(
          narrowMissCount.after,
          "a click at the wide layout's coordinates still reached #buy at 900px — the fixture " +
            'does not move it far enough for this suite to mean anything',
        ).toBe(narrowMissCount.before);

        console.log(
          `M4-QA-04: compiled skill replayed at ${QA04_WIDE_PX}px and ${QA04_NARROW_PX}px, both ok; ` +
            `#buy moved (${Math.round(shift.dx)}, ${Math.round(shift.dy)}) px; ` +
            `the recorded pixel missed at ${QA04_NARROW_PX}px`,
        );
      },
      TEST_MS,
    );
  },
);
