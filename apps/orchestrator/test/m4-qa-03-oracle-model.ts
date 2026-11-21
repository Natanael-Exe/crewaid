/**
 * M4-QA-03 — the oracle wired in as the model the compiler calls.
 *
 * The seam is the one M3-QA-05 uses: `resolveModel` is mocked, and what it
 * returns is an AI SDK `MockLanguageModelV4`. What is different here is what
 * the mock DOES. It does not answer with a fixture script; it reads the trace
 * out of the prompt the real `SkillCompileService` built and applies the
 * emission rules mechanically (`m4-qa-03-emission-oracle.ts`).
 *
 * That is what makes §6/M4's "assert the compiled script has no coordinate
 * clicks" a claim about the PRODUCT. The compiler's own contribution to that
 * property is entirely upstream of the model: which rows survive the fold,
 * which candidates survive the resolver fence, and therefore whether the model
 * is shown one row naming an element or two rows naming a pixel. A model that
 * obeys the rules exactly turns that input into the script, so a script with a
 * coordinate click in it can only have come from a trace that still had one to
 * emit.
 *
 * Keeping the rules in the oracle rather than here also means the assertion
 * has a second reader: `m4-qa-03-compiled-script.test.ts` runs the oracle over
 * hand-written traces where the right answer is known, so the oracle itself is
 * pinned before it is trusted to judge a recording.
 */

import { MockLanguageModelV4 } from './model-resolution-fake.js';

import { emitScript, type Qa03Emission, type Qa03Step } from './m4-qa-03-emission-oracle.js';

/**
 * One emitted step, said the way `CompiledSkillSchema` asks for it: plain
 * language, no coordinates, no selectors, no code.
 *
 * Deliberately not the `code` line with the punctuation filed off — the schema
 * says "what a person reads to check what the skill will do before approving
 * it", and a rendered `ctx.page.click('#submit')` is not that.
 */
function describeStep(step: Qa03Step): string {
  switch (step.form) {
    case 'ctx.page.click':
      return 'Click the element the recording clicked.';
    case 'ctx.page.fill':
      return 'Type the recorded text into the field.';
    case 'ctx.page.waitForLoadState':
      return 'Wait for the page to finish loading.';
    case 'ctx.click':
      return 'Click where the recording clicked on screen.';
    case 'ctx.type':
      return 'Type the recorded text.';
    case 'ctx.key':
      return 'Press the recorded key.';
  }
}

/** Everything one compile call asked for and answered, kept for assertions. */
export interface OracleCall {
  /** The full user-turn text the service sent. */
  readonly text: string;
  /** The trace lines carved out of it — what the oracle read. */
  readonly trace: string;
  /** What the rules produced from that trace. */
  readonly emission: Qa03Emission;
}

/**
 * The trace, as the model sees it inside the user turn.
 *
 * Selected by shape rather than by a heading: `renderTrace` writes `ms` first
 * on every line (§6/M3's compact JSON), and the surrounding prose has no lines
 * that start that way. Matching the heading instead would make this stub
 * depend on prompt wording that is allowed to change without the contract
 * changing — the same rule `skill-compile.test.ts`'s own reader follows.
 */
export function traceTextOf(userText: string): string {
  return userText
    .split('\n')
    .filter((line) => line.startsWith('{"ms"'))
    .join('\n');
}

/** The user turn's text, across the AI SDK's prompt parts. */
export function userTextOf(prompt: unknown): string {
  const messages = prompt as { role: string; content: unknown }[];
  const user = messages.find((message) => message.role === 'user');
  const parts = (user?.content ?? []) as { type: string; text?: string }[];
  return parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n');
}

export interface OracleModelOptions {
  /** The skill name the answer carries; snake_case, per §6's output schema. */
  readonly name?: string;
  /**
   * Rewrite the emitted script before answering. The falsification suite uses
   * it to prove the assertions fail when the script is wrong — a test whose
   * negative case cannot be produced is not evidence.
   */
  readonly rewrite?: (emission: Qa03Emission) => string;
}

/**
 * A model that compiles by the rules, and the log of what it was asked.
 *
 * `resolveModel` is not touched here — the caller owns that mock, because the
 * three suites that use this install it at different scopes.
 */
export function oracleModel(options: OracleModelOptions = {}): {
  readonly model: MockLanguageModelV4;
  readonly calls: OracleCall[];
} {
  const calls: OracleCall[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (generateOptions) => {
      const text = userTextOf(generateOptions.prompt);
      const trace = traceTextOf(text);
      const emission = emitScript(trace);
      calls.push({ text, trace, emission });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              name: options.name ?? 'replay_the_fixture',
              description: 'Replays the recorded fixture interaction.',
              params: [],
              // D-098 added `steps` to `CompiledSkillSchema` — the plain-
              // language list a person reads before approving a skill — and
              // this oracle was not updated with it, so every compile here
              // was rejected for a missing field and five cases had been
              // failing since. Derived from the emission rather than
              // hand-written, for the same reason the script is: a fixture
              // answer that does not follow from the trace would let the
              // oracle agree with a compiler that had stopped reading it.
              steps: emission.steps.map((step) => describeStep(step)),
              script: options.rewrite === undefined ? emission.script : options.rewrite(emission),
            }),
          },
        ],
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
  });
  return { model, calls };
}
