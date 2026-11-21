/**
 * `@crewaid/skill-runtime` — the skill script executor, shipped INTO the sandbox.
 *
 * Skill scripts are model-generated and therefore untrusted. This
 * package is the thing that runs them, which is exactly why it executes inside
 * the bot container via the agent-bridge `POST /skill/run` endpoint and never
 * in the orchestrator process. `apps/orchestrator` must not import this
 * package's executor to run a script locally.
 *
 * The `SkillContext` interface below is the contract the M3 compiler generates
 * against, extended with the browser half the Playwright
 * emission targets (`page`, M4-BE-06). Field names are contractual.
 */

import type { BrowserPage } from './browser.js';

export interface SkillContext {
  click(x: number, y: number): Promise<void>;
  doubleClick(x: number, y: number): Promise<void>;
  type(text: string): Promise<void>;
  /** e.g. "ctrl+c", "Return". */
  key(combo: string): Promise<void>;
  screenshot(): Promise<Buffer>;
  /**
   * PRD §6/M3 timing rule: every wait is an explicit predicate. The compiler
   * prompt forbids `sleep(n)` — a gap in a recorded trace is evidence that a
   * wait is needed, not evidence of its duration.
   */
  waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void>;
  log(msg: string): void;
  /**
   * The sandbox browser's page — what the compiler emits
   * `ctx.page.click('<selector>')` and its siblings against. Present in every
   * run; it connects lazily on first use, so a skill that never drove a
   * browser never opens a socket.
   */
  page: BrowserPage;
}

/** The shape every compiled skill module default-exports. */
export type SkillModule<TParams = unknown> = (
  ctx: SkillContext,
  params: TParams,
) => Promise<unknown>;

// The executor side. `executor.ts` holds the logic; `host.ts` the
// real desktop commands; `loader.ts` the real module import; `runner.ts` the
// in-container CLI the bridge spawns; Playwright owns browser mechanics.
export {
  createSkillContext,
  runSkill,
  MAX_DETAIL_CHARS,
  MAX_LOG_CHARS,
  MAX_LOG_ENTRIES,
  MAX_RESULT_BYTES,
  WAIT_POLL_MS,
} from './executor.js';
export type {
  SkillHost,
  SkillModuleLoader,
  SkillRunFailure,
  SkillRunFailureCode,
  SkillRunOutcome,
  SkillRunSuccess,
} from './executor.js';
export {
  createDesktopHost,
  COMMAND_TIMEOUT_MS,
  SCREENSHOT_TIMEOUT_MS,
  MAX_SCREENSHOT_BYTES,
} from './host.js';
export type { CommandExecutor, DesktopHostOptions } from './host.js';
export { loadModuleFromSource } from './loader.js';
export {
  createBrowserPage,
  createUnavailablePage,
  PAGE_DEFAULT_TIMEOUT_MS,
  PAGE_MAX_TIMEOUT_MS,
} from './browser.js';
export type {
  BrowserPage,
  BrowserScope,
  ConnectBrowser,
  LoadState,
  PageActionOptions,
  WaitForSelectorOptions,
} from './browser.js';
