import type { ToolSet } from './tool-contract.js';

/**
 * The seam between what a tool RETURNS and what the model READS.
 *
 * "Tool results over 100 KB are truncated with an explicit marker
 * before reaching the model." The obvious way to satisfy that sentence is to
 * cut the string inside `execute`, and every tool that has needed a bound so
 * far has done exactly that. It is the wrong place, and the task that owns
 * this seam says so in three words: *project, do not mangle*.
 *
 * WHY THE CUT CANNOT LIVE IN `execute`
 *
 * A tool's return value is not only the model's. The SDK's `tool-result`
 * `toModelOutput` projects a tool's raw result into the model-facing shape
 * (for example, `screenshot` returns `{ bytes, base64 }` and projects an image
 * part) without truncating what is persisted in the transcript.
 *
 * Applying the output cap in the registry guarantees built-in tools, MCP
 * plugins, and compiled skills all share the same ceiling.
 * compiled skill printed — neither can be trusted to have read this file. So
 * `ToolRegistry.toolSetFor` runs every definition through `capToolOutput`
 * below, composing with the tool's own `toModelOutput` rather than replacing
 * it. The per-tool bounds in `computer-tools.ts` stay: they are far lower
 * than 100 KB on purpose, because `shell` and `fs_read` can be pointed at a
 * whole log deliberately, and this is the floor under them rather than a
 * replacement for them.
 */

/**
 * One tool as the registry holds it.
 *
 * `ToolSet[string]` rather than a bare `Tool`: unparameterised, `Tool`
 * resolves to `Tool<never, never, any>`, and under `exactOptionalPropertyTypes`
 * the SDK's real union — four instantiations intersected with an
 * `outputSchema`/`execute` exclusivity pair — is not assignable to it. Taking
 * the element type of the collection this function is for keeps the whole
 * union and needs no `any`.
 */
type RegisteredDefinition = ToolSet[string];

/**
 * The ceiling on one tool result, in bytes of UTF-8.
 *
 * "100 KB" read as 1024-based, matching `MAX_WRITE_BYTES` in
 * `computer-tools.ts`, which spells the same unit `1024 * 1024`. The
 * difference from 100,000 is 2.4% and no behaviour turns on it; consistency
 * within the codebase is worth more than picking the other reading.
 */
export const MODEL_RESULT_MAX_BYTES = 100 * 1024;

/**
 * What the model is told in place of the bytes it did not get.
 *
 * "Explicit" in §6/M5 is doing work: a result that simply stops reads to a
 * model as a file that ends there, and it will go on to reason about a
 * truncated log as though it were the whole one. So the marker names the kept
 * size and the original, and it is a sentence rather than an ellipsis.
 */
function marker(keptBytes: number, totalBytes: number): string {
  return (
    `\n\n[truncated: ${keptBytes.toLocaleString('en-US')} of ` +
    `${totalBytes.toLocaleString('en-US')} bytes shown. The rest was not sent to you — ` +
    `do not treat this as the end of the output.]`
  );
}

/**
 * Cut a string to a byte budget without splitting a character in half.
 *
 * `Buffer.subarray.toString('utf8')` decodes a severed multi-byte sequence
 * to U+FFFD, so a naive cut can hand the provider a replacement character
 * that was never in the source. The trailing one is dropped when the cut
 * created it — checked against the source rather than assumed, because a
 * string may legitimately contain U+FFFD and silently eating a real one would
 * be the same class of mistake this function exists to avoid.
 */
function cutToBytes(value: string, budget: number): { text: string; totalBytes: number } {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= budget) return { text: value, totalBytes: buffer.byteLength };
  let text = buffer.subarray(0, budget).toString('utf8');
  if (text.endsWith('�') && !value.startsWith(text)) text = text.slice(0, -1);
  return { text, totalBytes: buffer.byteLength };
}

/** A string capped to the budget, with the marker appended when it was cut. */
function capText(value: string, budget: number): string {
  const { text, totalBytes } = cutToBytes(value, budget);
  if (text === value) return value;
  return text + marker(Buffer.byteLength(text, 'utf8'), totalBytes);
}

/**
 * The SDK's own default projection, replicated so the cap has something to
 * apply to when a tool declares no `toModelOutput` of its own.
 *
 * Kept deliberately in step with `createToolModelOutput` in `ai@7.0.89`:
 * a string becomes text, `undefined` becomes JSON `null`, everything else
 * becomes JSON. If a future SDK changes that mapping this function is the one
 * place it has to be re-read — which is the argument for it being one
 * function rather than an assumption spread across the wrapper.
 */
function defaultModelOutput(output: unknown): ToolResultOutput {
  if (typeof output === 'string') return { type: 'text', value: output };
  return { type: 'json', value: (output ?? null) as JsonValue };
}

/**
 * Serialize a value to measure it, and answer `undefined` when JSON cannot.
 *
 * `JSON.stringify` throws on a BigInt, on a cycle, and on a getter that
 * throws — all of which can arrive from a tool whose output shape is not ours
 * to choose (M6's MCP tools are the reason this cap is in the registry at
 * all). Measuring is the only thing in this file that can fail, and a result
 * that cannot be measured is not a reason to fail the turn that produced it:
 * the caller hands such a value on exactly as the SDK would have, so the
 * failure, if there is one, stays where it was before this cap existed.
 */
function measure(value: unknown): string | undefined {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return undefined;
  }
}

/** The JSON a `ToolResultOutput` may carry. Structural, not `@ai-sdk`'s alias. */
type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };

/**
 * The shape `toModelOutput` returns, narrowed to the variants this cap knows
 * how to bound.
 *
 * Declared here rather than imported because `ToolResultOutput` is exported
 * from `@ai-sdk/provider-utils`, which the orchestrator does not depend on
 * directly — `ai` re-exports the value-level `tool` but the type would be a
 * second package in `package.json` for one alias. The variants below are read
 * off that union at `@ai-sdk/provider-utils@5.0.35`; an upstream addition
 * lands in `default:` and is passed through untouched, which is the safe
 * direction for a function whose job is to shrink things.
 */
type ToolResultOutput =
  | { type: 'text'; value: string }
  | { type: 'error-text'; value: string }
  | { type: 'json'; value: JsonValue }
  | { type: 'error-json'; value: JsonValue }
  | { type: 'content'; value: ContentItem[] }
  | { type: 'execution-denied'; reason?: string };

type ContentItem = { type: 'text'; text: string } | { type: 'file'; [key: string]: unknown };

/**
 * Bound one projected result to `MODEL_RESULT_MAX_BYTES`.
 *
 * Exported for the unit test and for any caller that has a `ToolResultOutput`
 * in hand; the registry reaches it through `withCappedOutput` below.
 *
 * Each variant is bounded in the terms the provider will read it in:
 *
 * - `text` / `error-text` — cut the string.
 * - `json` / `error-json` — a cut JSON document is not JSON, so an oversized
 *   one is re-typed to the text variant OF ITS OWN POLARITY, carrying the
 *   serialized prefix. Handing the provider a `json` output whose value is a
 *   broken fragment would be a lie about the shape, and the model reads it as
 *   text either way. Dropping the error half would be a second lie: `text`
 *   and `error-text` are one string each to a provider that only reads
 *   `value`, but Anthropic sets `is_error: true` on the error variants and
 *   nothing on `text`, so an oversize error re-typed to `text` would report a
 *   failed call to the model as a successful one.
 * - `content` — cut the text items and leave file items whole. A PNG cut to
 *   100 KB is not a smaller picture, it is a corrupt one; `screenshot`'s
 *   image is bounded by the screen and is the case this preserves.
 * - anything else — passed through. `execution-denied` carries a reason we
 *   wrote, and an unknown future variant is not ours to reshape.
 */
export function capToolOutput(
  output: ToolResultOutput,
  budget: number = MODEL_RESULT_MAX_BYTES,
): ToolResultOutput {
  switch (output.type) {
    case 'text':
    case 'error-text': {
      const capped = capText(output.value, budget);
      return capped === output.value ? output : { type: output.type, value: capped };
    }
    case 'json':
    case 'error-json': {
      const serialized = measure(output.value);
      if (serialized === undefined) return output;
      if (Buffer.byteLength(serialized, 'utf8') <= budget) return output;
      return {
        type: output.type === 'error-json' ? 'error-text' : 'text',
        value: capText(serialized, budget),
      };
    }
    case 'content': {
      // The budget is the whole result's, not each item's: a result of fifty
      // text items is as expensive as one long one, so the remaining budget
      // is carried across items and an item that arrives with none left is
      // dropped to its marker rather than sent whole.
      let remaining = budget;
      const value = output.value.map((item): ContentItem => {
        if (item.type !== 'text') return item;
        const capped = capText(item.text, Math.max(remaining, 0));
        remaining -= Buffer.byteLength(item.text, 'utf8');
        return capped === item.text ? item : { type: 'text', text: capped };
      });
      return { type: 'content', value };
    }
    default:
      return output;
  }
}

/**
 * One tool definition with the cap composed onto its model-facing projection.
 *
 * Composition, not replacement: `screenshot`'s own `toModelOutput` still runs
 * and still produces its image part, and the cap bounds what that produced.
 * A tool that declares none gets the SDK's default mapping first so there is
 * a `ToolResultOutput` to bound at all.
 *
 * The returned object is a shallow copy with exactly one member changed.
 * `toModelOutput` is a server-side callback the SDK invokes when it builds the
 * next step's messages — it is never serialized into the tool definition the
 * provider validates — so this adds nothing to the model's view of the tool,
 * which is the invariant `tool-registry.test.ts` guards.
 */
export function withCappedOutput(definition: RegisteredDefinition): RegisteredDefinition {
  const own = (definition as { toModelOutput?: unknown }).toModelOutput;
  const project =
    typeof own === 'function'
      ? (own as (options: { toolCallId: string; input: unknown; output: unknown }) => unknown)
      : undefined;

  const toModelOutput = async (options: {
    toolCallId: string;
    input: unknown;
    output: unknown;
  }): Promise<ToolResultOutput> => {
    const projected =
      project === undefined
        ? defaultModelOutput(options.output)
        : ((await project(options)) as ToolResultOutput);
    return capToolOutput(projected);
  };

  return { ...definition, toModelOutput };
}

/** Every definition in a tool set, capped. The registry's one call site. */
export function withCappedOutputs(set: ToolSet): ToolSet {
  const capped: ToolSet = {};
  for (const [name, definition] of Object.entries(set)) {
    capped[name] = withCappedOutput(definition);
  }
  return capped;
}
