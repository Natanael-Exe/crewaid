/**
 * The skill executor — runs ONE compiled, model-generated skill
 * module and reports what happened.
 *
 * Skill scripts are model-generated and therefore untrusted. This is
 * the only module in the repo that evaluates skill source, and it ships INTO
 * the bot container (infra/sandbox-image) where the container itself is the
 * trust boundary: the agent-bridge invokes it over `POST /skill/run` and never
 * executes a script in the orchestrator process. `apps/orchestrator` must not
 * import it to run a script locally — CC-06's lint rules keep that door shut.
 *
 * Everything the executor needs from the outside world arrives through two
 * ports (`SkillHost` and `SkillModuleLoader`). That is what lets it unit-test
 * without a desktop, a container, or a Node import hook — and what keeps the
 * real OS calls (xdotool/scrot) and the real `import()` in one visible place
 * each (host.ts, loader.ts).
 */
import type { BrowserPage } from './browser.js';
import { createUnavailablePage } from './browser.js';
import type { SkillContext, SkillModule } from './index.js';

/**
 * The sandbox capabilities a skill context needs, behind one narrow seam.
 *
 * `delay` and `now` are part of the port rather than module calls so the
 * `waitFor` poll loop is testable without real time passing.
 */
export interface SkillHost {
  /** Run one desktop command to completion. Rejects with a bounded message. */
  runCommand(program: string, args: readonly string[]): Promise<void>;
  /** Capture the current framebuffer as a validated PNG buffer. */
  captureScreenshot(): Promise<Buffer>;
  /** Wait between `waitFor` polls. */
  delay(ms: number): Promise<void>;
  /** Monotonic milliseconds. */
  now(): number;
}

/**
 * Loads the skill module from its source.
 *
 * Injected so unit tests never evaluate untrusted source in-process, and so
 * the executor itself stays free of filesystem and module-system concerns.
 */
export type SkillModuleLoader = (source: string) => Promise<SkillModule<unknown>>;

/**
 * The failure codes a run can carry.
 *
 * Every one of these is an outcome OF a valid request. Transport-level
 * failures — a malformed body, an oversized request, a runner that crashed
 * before producing an outcome — never reach this module; the bridge answers
 * those itself.
 */
export type SkillRunFailureCode = 'SKILL_EXECUTION_FAILED' | 'SKILL_RESULT_TOO_LARGE';

export interface SkillRunSuccess {
  readonly ok: true;
  /** Exactly what JSON can carry — the script's return value round-tripped through JSON. */
  readonly result: unknown;
  readonly logs: readonly string[];
  readonly durationMs: number;
}

export interface SkillRunFailure {
  readonly ok: false;
  readonly code: SkillRunFailureCode;
  readonly detail: string;
  readonly logs: readonly string[];
  readonly durationMs: number;
}

export type SkillRunOutcome = SkillRunSuccess | SkillRunFailure;

/** `waitFor` poll interval. */
export const WAIT_POLL_MS = 250;

/**
 * Bounds on what one run may report. A chatty or confused script must fail
 * its own run, not grow the bridge's response without limit.
 */
export const MAX_LOG_ENTRIES = 500;
export const MAX_LOG_CHARS = 2_000;
export const MAX_RESULT_BYTES = 256 * 1024;
export const MAX_DETAIL_CHARS = 2_000;

/**
 * Build the `SkillContext` the M3 compiler generates against,
 * with M4-BE-06's browser half.
 *
 * The mapping is the contract: `click`/`doubleClick`/`type`/`key` drive real
 * input through the host; `screenshot` returns PNG bytes; `waitFor` is the
 * ONLY sanctioned wait — the compiler prompt forbids `sleep(n)`, so a skill
 * that must wait states a predicate instead of a duration.
 *
 * `page` arrives already built rather than being constructed here: the real
 * one needs a CDP connection and a Chrome (composition-root concerns, owned
 * by `runner.ts`), while pure unit contexts get `createUnavailablePage()` —
 * a call that fails loudly beats an undefined property. The same rule as
 * `host` and `loadModule`: everything the executor cannot test is injected.
 */
export function createSkillContext(
  host: SkillHost,
  onLog: (message: string) => void,
  page: BrowserPage = createUnavailablePage(),
): SkillContext {
  return {
    page,
    async click(x: number, y: number): Promise<void> {
      await host.runCommand('xdotool', ['mousemove', '--sync', String(x), String(y), 'click', '1']);
    },
    async doubleClick(x: number, y: number): Promise<void> {
      await host.runCommand('xdotool', [
        'mousemove',
        '--sync',
        String(x),
        String(y),
        'click',
        '--repeat',
        '2',
        '--delay',
        '100',
        '1',
      ]);
    },
    async type(text: string): Promise<void> {
      // `--` so a string starting with `-` is text, never an option.
      await host.runCommand('xdotool', ['type', '--clearmodifiers', '--delay', '12', '--', text]);
    },
    async key(combo: string): Promise<void> {
      await host.runCommand('xdotool', ['key', '--clearmodifiers', '--', combo]);
    },
    async screenshot(): Promise<Buffer> {
      return host.captureScreenshot();
    },
    async waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
      // The predicate is evaluated once even for a zero timeout: "is the
      // condition already true" is a question worth answering before failing.
      const deadline = host.now() + Math.max(0, timeoutMs);
      for (;;) {
        if (await predicate()) return;
        const remaining = deadline - host.now();
        if (remaining <= 0) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
        await host.delay(Math.min(WAIT_POLL_MS, remaining));
      }
    },
    log(message: string): void {
      onLog(String(message));
    },
  };
}

/**
 * Run one skill module and reduce the outcome to JSON-safe data.
 *
 * Never throws for anything a script can do: a module that fails to load, a
 * `run` that throws, and a value JSON cannot carry are all `ok: false`
 * outcomes with a bounded `detail`. The caller (the runner) reserves a
 * non-zero exit for infrastructure failures — no workspace, unreadable stdin —
 * that mean no outcome could be produced at all.
 */
export async function runSkill(
  source: string,
  params: unknown,
  deps: { host: SkillHost; loadModule: SkillModuleLoader; page?: BrowserPage },
): Promise<SkillRunOutcome> {
  const { host } = deps;
  const startedAt = host.now();
  const logs: string[] = [];

  const fail = (code: SkillRunFailureCode, detail: string): SkillRunFailure => ({
    ok: false,
    code,
    detail: clip(detail, MAX_DETAIL_CHARS),
    logs,
    durationMs: elapsed(host, startedAt),
  });

  const context = createSkillContext(
    host,
    (message) => {
      if (logs.length < MAX_LOG_ENTRIES) logs.push(clip(message, MAX_LOG_CHARS));
    },
    deps.page,
  );

  let module: SkillModule<unknown>;
  try {
    module = await deps.loadModule(source);
  } catch (error) {
    return fail(
      'SKILL_EXECUTION_FAILED',
      `the skill module could not be loaded: ${messageOf(error)}`,
    );
  }

  let value: unknown;
  try {
    value = await module(context, params);
  } catch (error) {
    return fail('SKILL_EXECUTION_FAILED', messageOf(error));
  }

  let encoded: string;
  try {
    const json = JSON.stringify(value === undefined ? null : value);
    // JSON.stringify returns undefined for values JSON cannot carry at all
    // (a function, a symbol). The run happened; it just carries no result.
    encoded = json === undefined ? 'null' : json;
  } catch (error) {
    return fail(
      'SKILL_EXECUTION_FAILED',
      `the result is not JSON-serializable: ${messageOf(error)}`,
    );
  }

  const bytes = Buffer.byteLength(encoded, 'utf8');
  if (bytes > MAX_RESULT_BYTES) {
    return fail(
      'SKILL_RESULT_TOO_LARGE',
      `the result is ${bytes} bytes; the cap is ${MAX_RESULT_BYTES} bytes`,
    );
  }

  return {
    ok: true,
    // Parsed back on purpose: `result` is exactly the JSON value that travels
    // — dates are strings, NaN is null, and nothing unreachable is implied.
    result: JSON.parse(encoded) as unknown,
    logs,
    durationMs: elapsed(host, startedAt),
  };
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function elapsed(host: SkillHost, startedAt: number): number {
  return Math.max(0, Math.round(host.now() - startedAt));
}
