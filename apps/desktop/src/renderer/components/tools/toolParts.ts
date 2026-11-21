import { PluginBridgeCallSchema, USE_PLUGIN_TOOL } from '@crewaid/shared';

import { partField, type AnyPart } from '../PartRenderer';
import { t } from '../../i18n/i18n';

/**
 * Turning the AI SDK's tool parts into rows a person can read.
 *
 * The wire shape and the readable shape disagree about one thing, and it is
 * the whole reason this module exists: **one action is several parts.** A
 * single `browser_navigate` produces a `tool-call`, possibly a
 * `tool-approval-request` and its response, and finally a `tool-result`,
 * `tool-error` or `tool-output-denied` — each a separate entry in
 * `Message.parts`, and under M5-BE-09 the last of them can arrive in a
 * different agent round from the first.
 *
 * Rendered one at a time, that reads as four rows for one action, three of
 * which repeat the tool's name and arguments. Folded, it is one row that
 * starts as "running" and settles.
 *
 * The fold happens here — in the view translation, beside `toParts` — rather
 * than in the transcript or in the part registry. The transcript renders
 * `parts.map(renderPart)` and must not learn what a tool is (PRD M1
 * acceptance), and the registry resolves one part at a time by `type`, so
 * neither can see a sibling. Nothing about the persisted parts changes: this
 * is a projection for display, and `Message.parts` still holds exactly what
 * the SDK emitted.
 */

/** How a tool call ended, or that it has not. */
export type ToolCallStatus = 'running' | 'awaiting-approval' | 'ok' | 'error' | 'denied';

/**
 * One action, as a row renders it: the call, plus whatever has settled it.
 *
 * `type` stays `'tool-call'` so the part registry resolves it the same way it
 * resolves anything else — the fold adds a field, it does not introduce a
 * part type the registry would have to learn about.
 */
export interface FoldedToolPart {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  input: unknown;
  status: ToolCallStatus;
  /** The tool's return value, once there is one. */
  output?: unknown;
  /** Operator-facing failure text for `error`, or the reason for `denied`. */
  detail?: string;
  /** True once a human was asked, whatever they answered. */
  asked?: boolean;
  [key: string]: unknown;
}

/** One quiet transcript disclosure containing all actions from one reply. */
export interface ToolActivityPart {
  type: 'tool-activity';
  calls: FoldedToolPart[];
  [key: string]: unknown;
}

export function isFoldedToolPart(part: AnyPart): part is FoldedToolPart {
  return (
    part.type === 'tool-call' &&
    typeof partField(part, 'toolName') === 'string' &&
    typeof partField(part, 'status') === 'string'
  );
}

// The narrowing lives beside the union it narrows (`PartRenderer`), and is
// re-exported here because every call site in this folder reads parts through
// it. Two copies of the same cast is how one of them ends up subtly different.
export { partField } from '../PartRenderer';

const OUTCOME_TYPES = new Set(['tool-result', 'tool-error', 'tool-output-denied']);
const APPROVAL_TYPES = new Set(['tool-approval-request', 'tool-approval-response']);

/**
 * The call a part belongs to.
 *
 * Approval parts nest the call they are about (`toolCall.toolCallId`) while
 * every other tool part carries `toolCallId` at the top level. Both shapes are
 * read rather than one, because the SDK uses both and a fold that understood
 * only the flat one would silently stop pairing approvals.
 */
function toolCallIdOf(part: AnyPart): string | undefined {
  const flat = partField(part, 'toolCallId');
  if (typeof flat === 'string') return flat;
  const nested = partField(part, 'toolCall');
  if (typeof nested === 'object' && nested !== null) {
    const id = (nested as { toolCallId?: unknown }).toolCallId;
    if (typeof id === 'string') return id;
  }
  return undefined;
}

function isToolCall(part: AnyPart): boolean {
  return part.type === 'tool-call' && typeof partField(part, 'toolName') === 'string';
}

/**
 * The message a failed tool gives an operator.
 *
 * The SDK's `error` is whatever the tool threw, so it is a string when a tool
 * did not exist and an Error-shaped object when one ran and failed — measured
 * both ways. Anything else degrades to a fixed sentence rather than to
 * `[object Object]`, which is the failure mode of reaching for `String(err)`.
 */
export function errorTextOf(error: unknown): string {
  if (typeof error === 'string' && error !== '') return error;
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') return message;
  }
  return t('tools.failedGeneric');
}

/**
 * Group each tool call with the parts that settle it, in place.
 *
 * A folded row keeps the POSITION of its `tool-call`, so the text the bot
 * wrote before and after a tool stays where it was said. The settling parts
 * are removed from their own positions — under M5-BE-09 a result can arrive
 * in a later round, so leaving it where it landed would print the answer
 * after a paragraph that was written before the question.
 *
 * Total by construction. An outcome whose call is not in this message — a
 * history page that starts mid-turn — is left exactly as it was, so it
 * renders through the registry rather than disappearing.
 */
function rowFor(
  folded: ReadonlyMap<string, FoldedToolPart>,
  part: AnyPart,
): FoldedToolPart | undefined {
  const id = toolCallIdOf(part);
  return id === undefined ? undefined : folded.get(id);
}

/**
 * What a row says a call was, which is not always what the call was named.
 *
 * The door is not the tool
 *
 * Every plugin tool reaches a model through `use_plugin_tool`, with the tool
 * it actually runs named in the call's own arguments. Rendered literally, a
 * bot that files a GitHub issue shows the operator "Use plugin tool" and a
 * JSON blob — the name of a mechanism this build invented, where MCP plugins wants
 * the name of the thing acting on their account. Every plugin call in the
 * transcript would read the same, which is also the one place a person goes
 * to see what a bot has been doing.
 *
 * So the row shows the tool and the arguments the operator was asked to
 * approve — the same pair `pendingApprovalsIn` recovers on the orchestrator
 * side, off the same payload, so the prompt and the transcript cannot describe
 * one call two ways.
 *
 * ⚠️ THE WIRE SHAPE IS UNTOUCHED, and deliberately: the part IS what the model
 * produced, and rewriting it would put a call in the history the SDK never
 * made. This is a view translation, which is what this module is for.
 *
 * A payload that will not parse falls back to the door's own name rather than
 * hiding the row. A call happened either way, and a transcript that silently
 * drops one is worse than a transcript with an ugly name in it.
 */
function shownCall(toolName: string, input: unknown): { toolName: string; input: unknown } {
  if (toolName !== USE_PLUGIN_TOOL) return { toolName, input };
  const parsed = PluginBridgeCallSchema.safeParse(input);
  if (!parsed.success) return { toolName, input };
  return { toolName: parsed.data.tool, input: parsed.data.arguments ?? {} };
}

export function foldToolParts(parts: readonly AnyPart[]): AnyPart[] {
  const folded = new Map<string, FoldedToolPart>();

  // First pass: every call becomes a row, in the order the calls were made.
  for (const part of parts) {
    if (!isToolCall(part)) continue;
    const id = toolCallIdOf(part);
    if (id === undefined || folded.has(id)) continue;
    const shown = shownCall(String(partField(part, 'toolName')), partField(part, 'input'));
    const row: FoldedToolPart = {
      type: 'tool-call',
      toolCallId: id,
      toolName: shown.toolName,
      input: shown.input,
      status: 'running',
    };
    // An invalid call — a tool nobody registered — carries its own error and
    // never produces a separate outcome part, so the row settles here.
    if (partField(part, 'invalid') === true) {
      row.status = 'error';
      row.detail = errorTextOf(partField(part, 'error'));
    }
    folded.set(id, row);
  }

  // Second pass: the approval exchange. The question first and the answer
  // after it, whatever order the parts arrived in, so an answered call never
  // reads as still waiting. A yes leaves the call running until its outcome
  // lands: the operator has nothing left to do, and the tool is next.
  for (const part of parts) {
    if (part.type !== 'tool-approval-request') continue;
    const row = rowFor(folded, part);
    if (row === undefined) continue;
    row.asked = true;
    row.status = 'awaiting-approval';
  }
  for (const part of parts) {
    if (part.type !== 'tool-approval-response') continue;
    const row = rowFor(folded, part);
    if (row === undefined) continue;
    row.asked = true;
    if (partField(part, 'approved') === false) {
      row.status = 'denied';
      const reason = partField(part, 'reason');
      if (typeof reason === 'string' && reason !== '') row.detail = reason;
    } else if (row.status === 'awaiting-approval') {
      row.status = 'running';
    }
  }

  // Third pass: the outcome, which always wins over an approval state — by the
  // time a tool has run or been refused, the question has been answered.
  // A separate pass rather than a branch in the one above, so the precedence
  // is in the structure instead of in the order the parts happen to arrive.
  // They do arrive in order today, which is exactly what would make a merged
  // pass look correct until the day something reordered them: M5-BE-09's
  // resumed round already contributes an outcome to the FRONT of its round's
  // parts, one agent stream after the request it answers.
  for (const part of parts) {
    if (!OUTCOME_TYPES.has(part.type)) continue;
    const row = rowFor(folded, part);
    if (row === undefined) continue;
    if (part.type === 'tool-result') {
      row.status = 'ok';
      row.output = partField(part, 'output');
    } else if (part.type === 'tool-error') {
      row.status = 'error';
      row.detail = errorTextOf(partField(part, 'error'));
    } else if (part.type === 'tool-output-denied') {
      row.status = 'denied';
    }
  }

  const settled = new Set<string>();
  const result: AnyPart[] = [];
  for (const part of parts) {
    const id = toolCallIdOf(part);
    const row = id === undefined ? undefined : folded.get(id);
    if (row === undefined) {
      result.push(part);
      continue;
    }
    if (isToolCall(part)) {
      // The call's position is the row's position — but only for the first
      // one, so a duplicated id cannot print the same row twice.
      if (!settled.has(id as string)) {
        settled.add(id as string);
        result.push(row);
      }
      continue;
    }
    if (OUTCOME_TYPES.has(part.type) || APPROVAL_TYPES.has(part.type)) continue;
    result.push(part);
  }
  return result;
}

/**
 * Collapse a reply's action rows into one disclosure at the first action's
 * position. The rows remain complete and inspectable; only their default
 * presentation changes from an execution log into a conversation.
 */
export function groupToolActivity(parts: readonly AnyPart[]): AnyPart[] {
  const calls = parts.filter(isFoldedToolPart);
  if (calls.length === 0) return [...parts];

  const activity: ToolActivityPart = { type: 'tool-activity', calls };
  const grouped: AnyPart[] = [];
  let inserted = false;
  for (const part of parts) {
    if (!isFoldedToolPart(part)) {
      grouped.push(part);
      continue;
    }
    if (!inserted) {
      grouped.push(activity);
      inserted = true;
    }
  }
  return grouped;
}

/** Long values are elided for DISPLAY only; the part itself is untouched. */
export function truncateForDisplay(text: string, max: number): string {
  if (text.length <= max) return text;
  return t('tools.truncated', { text: text.slice(0, max), count: text.length });
}

/** JSON that cannot throw on a cycle or a BigInt the way `stringify` does. */
export function safeJson(value: unknown, space?: number): string {
  try {
    const json = JSON.stringify(value, null, space);
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * The arguments on one line.
 *
 * A single-argument tool — `browser_navigate({url})`, `shell({command})`,
 * `fs_read({path})` — reads best as the bare value: the tool's name has
 * already said what the value means. Anything else keeps its keys, because
 * two bare values in a row say nothing about which is which.
 */
export function summarizeInput(input: unknown, max = 120): string {
  if (input === undefined || input === null) return '';
  if (typeof input !== 'object' || Array.isArray(input)) {
    return truncateForDisplay(typeof input === 'string' ? input : safeJson(input), max);
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return '';
  const first = entries[0];
  if (entries.length === 1 && first !== undefined) {
    const [, value] = first;
    return truncateForDisplay(typeof value === 'string' ? value : safeJson(value), max);
  }
  return truncateForDisplay(
    entries
      .map(([key, value]) => `${key}=${typeof value === 'string' ? value : safeJson(value)}`)
      .join(' '),
    max,
  );
}

/**
 * The result on one line.
 *
 * First line only, because a `browser_read` of a real page is the whole
 * accessibility tree and a `shell` result is a transcript. §6/M5 caps what
 * reaches the MODEL at 100 KB (M5-BE-12); nothing caps what reaches the
 * transcript, so the row has to.
 */
export function summarizeOutput(output: unknown, max = 120): string {
  if (output === undefined) return '';
  const text = typeof output === 'string' ? output : safeJson(output);
  const firstLine = text.split('\n', 1)[0] ?? '';
  const elided = firstLine.length < text.length ? `${firstLine} …` : firstLine;
  return truncateForDisplay(elided, max);
}
