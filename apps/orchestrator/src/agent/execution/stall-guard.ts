import { createHash } from 'node:crypto';
import type { ModelMessage } from '@tanstack/ai';

/**
 * The loop's progress watch.
 *
 * Before this guard the step ceiling was the only stop condition a run had,
 * so a model that repeated one fruitless call — scrolling a page that would
 * not move, re-reading a refusal, re-capturing a screen that cannot answer —
 * spent its whole chain budget before anything noticed.
 *
 * The scan reads the exchanges the CURRENT turn has made — everything after
 * the newest `user` row, so an earlier instruction's history cannot pre-load a
 * verdict — and decides from their shape alone whether the turn has stopped
 * making progress. Two signals, deliberately different:
 *
 * - the same observation, arguments AND result, repeated: a successful
 * action's acknowledgement cannot establish progress. Scrolling always
 * answers "Scrolled down 3.", even when the page moved. Only read tools and
 * failures enter this comparison, using the full arguments and result;
 * - the same tool failing over and over, any arguments: a tool that cannot
 * work (its sandbox, its server, its credential) is not going to start.
 *
 * The caller owns the policy — when to warn, when to stop, what a person is
 * told — which is what keeps this module a pure function fixtures can pin.
 */

/** How many of the current turn's tool exchanges the scan reads. */
export const STALL_WINDOW = 32;
/** Identical call+result repeats that earn the model a warning. */
export const STALL_REPEAT_WARN = 3;
/** Identical call+result repeats that end the turn's tool work. */
export const STALL_REPEAT_BLOCK = 5;
/** Failures of the same tool, any arguments, that end the turn's tool work. */
export const STALL_TOOL_FAILURE_BLOCK = 8;

/** What the scan found, as one verdict for the whole window. */
export type StallScan =
  | { readonly worst: 'none' }
  | {
      readonly worst: 'warn' | 'block';
      readonly tool: string;
      readonly repeats: number;
      readonly why: 'same-result' | 'same-tool-failures';
    };

/** The scan's block verdict, carried on the outcome for the service to act on. */
export type StallDetail = {
  readonly repeats: number;
  readonly why: 'same-result' | 'same-tool-failures';
  readonly tool: string;
};

type Exchange = {
  readonly name: string;
  readonly argsKey: string;
  readonly resultKey: string;
  readonly failed: boolean;
};

/** Key order cannot matter to "the same arguments" — `{"a":1,"b":2}` == `{"b":2,"a":1}`. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function canonicalArgs(raw: string | undefined): string {
  if (raw === undefined) return '';
  try {
    return fingerprint(stableStringify(JSON.parse(raw)));
  } catch {
    /* A call whose arguments never parsed is fingerprinted as sent. */
    return fingerprint(raw);
  }
}

/**
 * Full-content identity without retaining large screenshot strings in keys.
 * Equal-length screenshots commonly share their PNG/base64 header.
 */
function fingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function resultFingerprint(name: string, content: string): string {
  // Captures have a new evidence filename every time. Compare their pixels'
  // encoded bytes, not that filename, while retaining the full result for
  // other tools.
  if (name === 'capture_screen' || name === 'screenshot') {
    try {
      const value: unknown = JSON.parse(content);
      if (
        value !== null &&
        typeof value === 'object' &&
        'base64' in value &&
        typeof value.base64 === 'string'
      )
        return fingerprint(value.base64);
    } catch {
      /* Text failures still use the full result. */
    }
  }
  return fingerprint(content);
}

const FAILURE_PATTERN =
  /^(?:TOOL_FAILED|TOOL_OUTPUT_UNAVAILABLE|POLICY_DENIED|APPROVAL_STALE|GRANT_REVOKED|SEAT_UNAVAILABLE)\b/i;

function looksLikeFailure(name: string, content: string): boolean {
  let text = content;
  try {
    const value: unknown = JSON.parse(content);
    if (typeof value === 'string') text = value;
    else if (value !== null && typeof value === 'object')
      return (
        ('error' in value && typeof value.error === 'string') ||
        ('isError' in value && value.isError === true)
      );
  } catch {
    /* Plain tool text needs no JSON envelope. */
  }
  // A successful test report may say "0 failed". Only the tool's explicit
  // failure/refusal prefix or a server refusal code counts as a failure.
  return (
    FAILURE_PATTERN.test(text) ||
    text.startsWith(`${name} failed`) ||
    text.startsWith(`${name} refused`)
  );
}

export function scanForStall(
  messages: readonly ModelMessage[],
  window: number = STALL_WINDOW,
  observationTools: ReadonlySet<string> = new Set(['capture_screen']),
): StallScan {
  let lastUser = -1;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message !== undefined && message.role === 'user') lastUser = index;
  }
  const calls = new Map<string, { readonly name: string; readonly argsKey: string }>();
  const exchanges: Exchange[] = [];
  for (let index = lastUser + 1; index < messages.length; index++) {
    const message = messages[index];
    if (message === undefined) continue;
    for (const call of message.toolCalls ?? [])
      calls.set(call.id, {
        name: call.function.name,
        argsKey: canonicalArgs(call.function.arguments),
      });
    if (message.role !== 'tool' || typeof message.content !== 'string') continue;
    const call = message.toolCallId === undefined ? undefined : calls.get(message.toolCallId);
    if (call === undefined) continue;
    exchanges.push({
      name: call.name,
      argsKey: call.argsKey,
      resultKey: resultFingerprint(call.name, message.content),
      failed: looksLikeFailure(call.name, message.content),
    });
  }
  const identical = new Map<string, { readonly signature: string; readonly repeats: number }>();
  const toolFailures = new Map<string, number>();
  for (const exchange of exchanges.slice(-window)) {
    if (exchange.failed || observationTools.has(exchange.name)) {
      const signature = `${exchange.argsKey}|${exchange.resultKey}`;
      const previous = identical.get(exchange.name);
      identical.set(exchange.name, {
        signature,
        repeats: previous?.signature === signature ? previous.repeats + 1 : 1,
      });
    } else identical.delete(exchange.name);
    if (exchange.failed)
      toolFailures.set(exchange.name, (toolFailures.get(exchange.name) ?? 0) + 1);
    else toolFailures.delete(exchange.name);
  }
  let worstSameResult: { readonly tool: string; readonly repeats: number } | undefined;
  for (const [tool, { repeats: count }] of identical) {
    if (worstSameResult === undefined || count > worstSameResult.repeats)
      worstSameResult = { tool, repeats: count };
  }
  let worstToolFailure: { readonly tool: string; readonly repeats: number } | undefined;
  for (const [tool, count] of toolFailures) {
    if (worstToolFailure === undefined || count > worstToolFailure.repeats)
      worstToolFailure = { tool, repeats: count };
  }
  if (worstSameResult !== undefined && worstSameResult.repeats >= STALL_REPEAT_BLOCK)
    return { worst: 'block', ...worstSameResult, why: 'same-result' };
  if (worstToolFailure !== undefined && worstToolFailure.repeats >= STALL_TOOL_FAILURE_BLOCK)
    return { worst: 'block', ...worstToolFailure, why: 'same-tool-failures' };
  if (worstSameResult !== undefined && worstSameResult.repeats >= STALL_REPEAT_WARN)
    return { worst: 'warn', ...worstSameResult, why: 'same-result' };
  return { worst: 'none' };
}

/** What the MODEL is told when a repeat is first noticed — a redirect, not a stop. */
export function stallWarnCopy(repeats: number): string {
  return (
    `[SYSTEM NOTICE] You have now made the same tool call ${repeats} times with the same arguments ` +
    'and it returned the same result. That is not progress. Change approach: act differently, look at ' +
    'the screen or page another way, or move on to the next step of the task.'
  );
}

/** What the MODEL is told when the repeats end its tool work — it writes its way out. */
export function stallBlockCopy(repeats: number): string {
  return (
    `[SYSTEM NOTICE] You have repeated the same tool call ${repeats} times with the same result; ` +
    'this turn is no longer making progress. Do not call that tool again. Write your final answer now ' +
    'from what you have already gathered, or report plainly what is blocking you — including the last ' +
    'thing you saw — and end your reply.'
  );
}

/** The same stop, for a tool that failed repeatedly under any arguments. */
export function stallToolFailureBlockCopy(tool: string, failures: number): string {
  return (
    `[SYSTEM NOTICE] The ${tool} tool has failed ${failures} times this turn and is not going to ` +
    'start working. Do not call it again. Write your final answer from what you have, or report ' +
    'plainly that the tool is unavailable and what the operator should do, then end your reply.'
  );
}

/**
 * What the PERSON is told when a stall stop ended the turn (the split:
 * the operator reads what happened and what to do, not the machinery's name).
 */
export function stallNoticeCopy(detail: StallDetail): string {
  const what =
    detail.why === 'same-result'
      ? `it repeated the same action ${detail.repeats} times without progress`
      : `the ${detail.tool} tool failed ${detail.repeats} times in a row`;
  return `Paused — ${what}. Send a message to carry on, and consider a different instruction if it keeps happening.`;
}
