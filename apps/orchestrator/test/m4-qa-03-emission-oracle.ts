/**
 * M4-QA-03 from-spec emission oracle — an INDEPENDENT re-derivation of what a
 * compiler is instructed to write for each trace row, for the QA suite's
 * cross-substrate comparison.
 *
 * ── WHY AN ORACLE AND NOT A CANNED ANSWER ───────────────────────────────────
 *
 * §6/M4's required test is "record against a locally served fixture page,
 * assert the compiled script has no coordinate clicks". Compiling needs a
 * model, and the repo's compile integration tests stub it (M3-QA-05, per
 * §6/M3's own "Integration with a stubbed model"). A stub returning a canned
 * script would make the assertion vacuous — it would assert what the fixture
 * author typed.
 *
 * So the stub is this: a mechanical reader of the trace the service actually
 * rendered, applying the emission rules the system prompt states, and nothing
 * else. "Zero coordinate clicks" then says something about the TRACE — that
 * every browser interaction reached the model as one row naming its element —
 * which is exactly the property M4-BE-05's correlator and M4-BE-06's fold and
 * resolver fence exist to produce. A regression in any of them puts a raw
 * `pointer` press or a candidate-less `click` back in the trace, and this
 * oracle emits `ctx.click(x, y)` for it, and the assertion fails.
 *
 * ── THE DISCIPLINE ──────────────────────────────────────────────────────────
 *
 * Written from the prompt text (`SKILL_SYSTEM_PROMPT`'s emission rules and
 * `TRACE_LEGEND`'s vocabulary, both in `skill-compile.contract.ts` /
 * `skill-compile.service.ts`) and NOT from `compile-input.ts`. The rules below
 * are transcribed by hand as literals; nothing is imported from the product,
 * so a product-side change to a row name, a field name or the selection rule
 * must break the comparison rather than travel through it.
 *
 * Its shape is deliberately different from the product's, too: the product
 * decides what a row IS while rendering it, whereas this reads finished JSON
 * lines back and decides what a row MEANS — so a renderer that quietly stopped
 * emitting a field cannot agree with itself.
 */

/**
 * The forms §6/M4's rules name, and the only ones this oracle can produce.
 *
 * `ctx.click` is the one under test: it is the coordinate click the milestone
 * says must not appear for a browser interaction.
 */
export type Qa03Form =
  | 'ctx.page.click'
  | 'ctx.page.fill'
  | 'ctx.page.waitForLoadState'
  | 'ctx.click'
  | 'ctx.type'
  | 'ctx.key';

export interface Qa03Step {
  readonly form: Qa03Form;
  /** The line as it would appear in a script body. */
  readonly code: string;
  /** The trace offset the step came from, so a failure names the row. */
  readonly ms: number;
}

export interface Qa03Emission {
  readonly steps: readonly Qa03Step[];
  /** A runnable ESM module, the shape §6/M3's target interface expects. */
  readonly script: string;
  /** Every coordinate click the rules produced; empty is the QA-03 claim. */
  readonly coordinateClicks: readonly Qa03Step[];
}

/** One parsed line of the rendered trace. */
type Line = Record<string, unknown>;

/**
 * The row kinds the legend names. Written as literals rather than imported
 * from `CDP_EVENT_TYPES` / the X11 vocabulary: a renamed row type is a
 * contract change this oracle must notice, not inherit.
 */
const CDP_CLICK = 'click';
const CDP_INPUT = 'input';
const CDP_CHANGE = 'change';
const CDP_NAVIGATE = 'navigate';
const CDP_LOAD = 'load';
const CDP_SUBMIT = 'submit';
const X11_POINTER = 'pointer';
const X11_TYPE = 'type';
const X11_KEY = 'key';

/**
 * The button-mask bits that mean a click button is down (RFC 6143 §7.5.5).
 * A press is a row whose mask has one set; the release that follows carries 0
 * and is the same action's other half, never a step of its own — the legend
 * says so, and the coalescer writes the pair.
 */
const CLICK_BUTTON_BITS = 0b111;

/**
 * Parse the rendered trace back into lines.
 *
 * The renderer's contract is one JSON object per line (§6/M3's "compact
 * JSON"), so anything that is not parseable as an object is a defect in what
 * the model was shown, and is surfaced rather than skipped.
 */
export function parseTrace(traceText: string): readonly Line[] {
  const lines: Line[] = [];
  for (const raw of traceText.split('\n')) {
    if (raw.trim() === '') continue;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`a trace line is not a JSON object: ${raw}`);
    }
    lines.push(parsed as Line);
  }
  return lines;
}

/**
 * The selector a row's ladder names, per the legend: "the first candidate with
 * `unique`:true names the element".
 *
 * A ladder with no unique rung still names the element better than a
 * coordinate does — the legend orders the rungs best-first — so the first
 * rung is the fallback. Null means the row carries no ladder at all, which is
 * the legend's own signal to use the raw-input form.
 */
export function selectorOf(line: Line): string | null {
  const candidates = line['candidates'];
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const rungs = candidates.filter(
    (entry): entry is { kind: string; selector: string; unique: boolean } =>
      entry !== null &&
      typeof entry === 'object' &&
      typeof (entry as { selector?: unknown }).selector === 'string',
  );
  if (rungs.length === 0) return null;
  const unique = rungs.find((rung) => rung.unique === true);
  return (unique ?? rungs[0]!).selector;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function ms(line: Line): number {
  return num(line['ms']) ?? 0;
}

/**
 * Apply the prompt's emission rules to a rendered trace.
 *
 * One pass, in trace order, because the rules are per-row with exactly two
 * exceptions the prompt names: a `navigate`/`load` pair becomes ONE
 * `waitForLoadState` (the load is the navigate's completion, not a second
 * step), and a `pointer` release is folded into the press beside it (the
 * legend: "a press and a release at the same point" is one click). `submit`
 * emits nothing — the legend calls it "the consequence of the step before
 * it".
 */
export function emitScript(traceText: string): Qa03Emission {
  const lines = parseTrace(traceText);
  const steps: Qa03Step[] = [];
  let pendingNavigate = false;

  for (const line of lines) {
    const type = str(line['type']);
    const at = ms(line);

    if (type === CDP_NAVIGATE) {
      // Held: the wait is emitted when its load arrives. A navigate with no
      // load never became a document, and a wait for one would hang.
      pendingNavigate = true;
      continue;
    }
    if (type === CDP_LOAD) {
      if (pendingNavigate) {
        steps.push({
          form: 'ctx.page.waitForLoadState',
          code: `await ctx.page.waitForLoadState('load');`,
          ms: at,
        });
        pendingNavigate = false;
      }
      continue;
    }
    if (type === CDP_SUBMIT) continue;

    if (type === CDP_CLICK) {
      const selector = selectorOf(line);
      if (selector !== null) {
        steps.push({
          form: 'ctx.page.click',
          code: `await ctx.page.click(${JSON.stringify(selector)});`,
          ms: at,
        });
        continue;
      }
      // No ladder: the legend says drive it at its x/y, "the same as any other
      // coordinate click". This is the branch QA-03 asserts is never taken for
      // a browser task.
      const x = num(line['x']);
      const y = num(line['y']);
      steps.push({
        form: 'ctx.click',
        code:
          x === null || y === null
            ? `await ctx.click(/* no position */);`
            : `await ctx.click(${x}, ${y});`,
        ms: at,
      });
      continue;
    }

    if (type === CDP_INPUT || type === CDP_CHANGE) {
      const selector = selectorOf(line);
      if (selector !== null) {
        steps.push({
          form: 'ctx.page.fill',
          code: `await ctx.page.fill(${JSON.stringify(selector)}, ${JSON.stringify(str(line['value']))});`,
          ms: at,
        });
      }
      // A field row with no ladder names nothing to fill; its keystrokes are
      // already in the trace as the X11 `type` rows the legend points at.
      continue;
    }

    if (type === X11_POINTER) {
      const mask = num(line['buttonMask']) ?? 0;
      if ((mask & CLICK_BUTTON_BITS) === 0) continue; // the release half
      const x = num(line['x']);
      const y = num(line['y']);
      steps.push({
        form: 'ctx.click',
        code:
          x === null || y === null
            ? `await ctx.click(/* no position */);`
            : `await ctx.click(${x}, ${y});`,
        ms: at,
      });
      continue;
    }

    if (type === X11_TYPE) {
      steps.push({
        form: 'ctx.type',
        code: `await ctx.type(${JSON.stringify(str(line['text']))});`,
        ms: at,
      });
      continue;
    }

    if (type === X11_KEY) {
      steps.push({
        form: 'ctx.key',
        code: `await ctx.key(${JSON.stringify(str(line['name']))});`,
        ms: at,
      });
      continue;
    }
  }

  const body = steps.map((step) => `  ${step.code}`).join('\n');
  const script = ['export default async function run(ctx) {', body, "  return 'done';", '}']
    .filter((part) => part !== '')
    .join('\n');

  return {
    steps,
    script,
    coordinateClicks: steps.filter((step) => step.form === 'ctx.click'),
  };
}
