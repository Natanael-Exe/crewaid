import type { ChatMiddleware, ModelMessage } from '@tanstack/ai';
import {
  composeStrategies,
  evictOldest,
  withCompaction,
  type CompactionContext,
  type CompactionInfo,
  type CompactionStrategy,
} from '@tanstack/ai-compaction';

/**
 * What one model call is sent of a TanStack thread's history.
 *
 * A TanStack run loads the whole canonical thread; this bounds the PROVIDER's
 * copy (`providerMessages`) and never the canonical one, so the transcript,
 * replay and every later run still read everything that was said. System
 * prompts are not messages, so the identity prefix and the memory-last order
 * are untouched. It is not a spending cap: it decides how much
 * history one call carries, never whether a run may continue.
 *
 * Strategy (only triggered once estimated tokens exceed `maxTokens`, 100k by
 * default):
 * 1. Deduplicate superseded `fs_read` outputs (re-read over the same/wider
 *    line range or modified later by a successful `fs_edit`/`fs_write`).
 * 2. Semantically clear bulky tool results older than the last 12, keeping
 *    short edit/write/stop receipts verbatim and retaining error tails on
 *    failed `shell` / `process_output` runs.
 * 3. Escalate by clearing remaining tool results down to the last 4 (first
 *    with semantic stubs, then collapsing retained failure tails and old
 *    receipts to one-line stubs).
 * 4. Fall back to `evictOldest` at a message boundary so no tool result is
 *    ever separated from its call.
 */

/** Tool results kept verbatim during Pass 2 semantic clearing. */
const KEEP_RECENT_TOOL_RESULTS = 12;

/** Tool results kept verbatim during Pass 3 escalation before `evictOldest`. */
const ESCALATE_KEEP_TOOL_RESULTS = 4;

/** Maximum length for compact change receipts kept verbatim during Pass 2. */
const MAX_PRESERVED_RECEIPT_CHARS = 600;

/** Trailing output preserved on failed `shell` / `process_output` stubs in Pass 2. */
const FAILURE_TAIL_CHARS = 400;

/** Maximum inline preview length for commands, paths, and patterns in stubs. */
const INLINE_PREVIEW_CHARS = 80;

/** Tools whose short confirmation receipts form the model's working change log. */
const PRESERVED_RECEIPT_TOOLS = new Set(['fs_edit', 'fs_write', 'process_stop']);

/** Marker separating a Pass 2 failure-stub header from its retained tail. */
const TAIL_MARKER = ' cleared; tail:\n';

/** Stable checkpoint identity — bumped whenever compaction output changes. */
const STRATEGY_KEY = 'crewaid-v2';

/**
 * An image's cost, roughly what providers charge for one at their default
 * resolution. Counting its base64 bytes instead would price a photo at
 * hundreds of thousands of tokens and evict it the moment it arrived.
 */
const IMAGE_TOKENS = 1_600;

/** Characters / 4 for text, a fixed price per image. */
export function estimateTokens(message: ModelMessage): number {
  let chars = 0;
  let images = 0;
  if (typeof message.content === 'string') chars += message.content.length;
  else if (Array.isArray(message.content))
    for (const part of message.content) {
      if (part.type === 'image') images += 1;
      else if (part.type === 'text') chars += part.content.length;
      else chars += JSON.stringify(part).length;
    }
  if (message.toolCalls !== undefined) chars += JSON.stringify(message.toolCalls).length;
  return Math.ceil(chars / 4) + images * IMAGE_TOKENS;
}

interface ToolCallMeta {
  readonly name: string;
  readonly args: Record<string, unknown> | null;
}

interface LineRange {
  readonly start: number;
  readonly end: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function indexToolCalls(messages: ReadonlyArray<ModelMessage>): Map<string, ToolCallMeta> {
  const index = new Map<string, ToolCallMeta>();
  for (const message of messages) {
    if (message.toolCalls === undefined) continue;
    for (const call of message.toolCalls) {
      index.set(call.id, {
        name: call.function.name,
        args: parseArgs(call.function.arguments),
      });
    }
  }
  return index;
}

function totalTokens(
  messages: ReadonlyArray<ModelMessage>,
  estimate: CompactionContext['estimate'],
): number {
  let sum = 0;
  for (const message of messages) sum += estimate(message);
  return sum;
}

function collectToolResultIndices(messages: ReadonlyArray<ModelMessage>): number[] {
  const indices: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role === 'tool') indices.push(i);
  }
  return indices;
}

function readStringArg(args: Record<string, unknown> | null, key: string): string | null {
  if (args === null) return null;
  const value = args[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function readPositiveIntArg(args: Record<string, unknown> | null, key: string): number | null {
  if (args === null) return null;
  const value = args[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null;
}

function normalizePath(rawPath: string): string {
  let normalized = rawPath.trim().replaceAll('\\', '/').replace(/\/+/g, '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  if (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized;
}

function previewInline(value: string, maxChars = INLINE_PREVIEW_CHARS): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, maxChars - 1)}…`;
}

function formatCharCount(chars: number): string {
  if (chars < 1_000) return `${String(chars)} chars`;
  return `${(chars / 1_000).toFixed(1)}k chars`;
}

function describeContentSize(content: ModelMessage['content']): string {
  if (typeof content === 'string') return formatCharCount(content.length);
  if (Array.isArray(content)) {
    let images = 0;
    let chars = 0;
    for (const part of content) {
      if (part.type === 'image') images += 1;
      else if (part.type === 'text') chars += part.content.length;
      else chars += JSON.stringify(part).length;
    }
    const parts: string[] = [];
    if (images > 0) parts.push(images === 1 ? '1 image' : `${String(images)} images`);
    if (chars > 0) parts.push(formatCharCount(chars));
    return parts.length > 0 ? parts.join(', ') : '0 chars';
  }
  return '0 chars';
}

function isClearedStub(content: ModelMessage['content']): boolean {
  if (typeof content !== 'string') return false;
  if (!content.startsWith('[earlier ') || !content.endsWith(']')) return false;
  const firstNewline = content.indexOf('\n');
  const firstLine = firstNewline === -1 ? content : content.slice(0, firstNewline);
  return firstLine.includes(' cleared');
}

function formatRangeSuffix(args: Record<string, unknown> | null): string {
  const start = readPositiveIntArg(args, 'startLine');
  const end = readPositiveIntArg(args, 'endLine');
  if (start === null && end === null) return '';
  if (start !== null && end !== null) return ` (lines ${String(start)}-${String(end)})`;
  if (start !== null) return ` (from line ${String(start)})`;
  return ` (lines 1-${String(end)})`;
}

const READ_FOOTER_RE = /\[lines (\d+)[–-](\d+) of [\d,]+(?: — [^\]]+)?\]$/;

function extractReadRange(args: Record<string, unknown> | null, text: string): LineRange {
  const footerMatch = READ_FOOTER_RE.exec(text.trimEnd());
  if (footerMatch !== null) {
    const start = Number(footerMatch[1]);
    const end = Number(footerMatch[2]);
    if (Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start) {
      return { start, end };
    }
  }
  const start = readPositiveIntArg(args, 'startLine') ?? 1;
  const end = readPositiveIntArg(args, 'endLine') ?? Number.POSITIVE_INFINITY;
  return { start, end };
}

function rangeCovers(later: LineRange, earlier: LineRange): boolean {
  return later.start <= earlier.start && later.end >= earlier.end;
}

/**
 * Whether a built-in's result is a refusal or a failure. Three spellings
 * reach the model: `tool refused: …`, `tool failed: …`, and — when the tool
 * caught a thrown error — `tool "<target>" failed: …`. Missing the last one
 * would count a failed re-read as a fresh read and clear the good one before it.
 */
function isRefusalOrFailure(toolName: string, text: string): boolean {
  if (text.startsWith(`${toolName} refused:`) || text.startsWith(`${toolName} failed:`)) {
    return true;
  }
  const firstLine = text.split('\n', 1)[0] ?? '';
  return firstLine.startsWith(`${toolName} "`) && firstLine.includes('" failed: ');
}

function isSuccessfulFsRead(text: string): boolean {
  return !isRefusalOrFailure('fs_read', text) && !text.startsWith('fs_read: ');
}

function isSuccessfulMutation(toolName: 'fs_edit' | 'fs_write', text: string): boolean {
  return !isRefusalOrFailure(toolName, text);
}

const EDITED_PATH_RE = /^edited (.+?) \(\d+ replacement/;
const WROTE_PATH_RE = /^wrote [\d,]+ bytes to (.+)$/;

function extractMutationPaths(
  toolName: 'fs_edit' | 'fs_write',
  args: Record<string, unknown> | null,
  text: string,
): string[] {
  const paths = new Set<string>();
  const argPath = readStringArg(args, 'path');
  if (argPath !== null) paths.add(normalizePath(argPath));
  const firstLine = text.split('\n', 1)[0] ?? '';
  const match =
    toolName === 'fs_edit' ? EDITED_PATH_RE.exec(firstLine) : WROTE_PATH_RE.exec(firstLine);
  if (match?.[1] !== undefined && match[1].trim() !== '') {
    paths.add(normalizePath(match[1]));
  }
  return [...paths];
}

function extractTail(text: string): string {
  const trimmed = text.trimEnd();
  if (trimmed.length <= FAILURE_TAIL_CHARS) return trimmed.trimStart();
  return trimmed.slice(trimmed.length - FAILURE_TAIL_CHARS).trimStart();
}

interface CommandStatus {
  readonly label: string | null;
  readonly failed: boolean;
}

const SHELL_EXIT_RE = /^exit (-?\d+)\b/;

function inspectShellResult(text: string): CommandStatus {
  const exitMatch = SHELL_EXIT_RE.exec(text);
  if (exitMatch?.[1] !== undefined) {
    const code = Number(exitMatch[1]);
    return { label: `exit ${exitMatch[1]}`, failed: code !== 0 };
  }
  if (text.startsWith('shell: the command was still running after')) {
    return { label: 'timed out', failed: true };
  }
  if (isRefusalOrFailure('shell', text)) {
    return { label: 'failed', failed: true };
  }
  return { label: null, failed: false };
}

const PROCESS_HEADER_RE = /^([^\s·]+) · (.+)$/;
const PROCESS_EXIT_RE = /^exited \(code (-?\d+)\)(?:, reason: (.+))?/;
const STARTED_PROCESS_RE = /^Started background process (\S+)/;
const STOPPED_PROCESS_RE = /^Stopped (\S+) · (.+)$/;

function inspectProcessOutput(
  args: Record<string, unknown> | null,
  text: string,
): { readonly processId: string | null; readonly status: CommandStatus } {
  const firstLine = text.split('\n', 1)[0] ?? '';
  const argId = readStringArg(args, 'processId');
  const headerMatch = PROCESS_HEADER_RE.exec(firstLine);
  const processId = argId ?? headerMatch?.[1] ?? null;
  const statusText = headerMatch?.[2] ?? '';

  if (text.startsWith('process_output failed:')) {
    return { processId, status: { label: 'failed', failed: true } };
  }
  const exitMatch = PROCESS_EXIT_RE.exec(statusText);
  if (exitMatch?.[1] !== undefined) {
    const code = Number(exitMatch[1]);
    const reason = exitMatch[2]?.trim();
    const label =
      reason !== undefined && reason !== ''
        ? `exit ${exitMatch[1]}, ${reason}`
        : `exit ${exitMatch[1]}`;
    const failed = code !== 0 || reason === 'timeout' || reason === 'error';
    return { processId, status: { label, failed } };
  }
  if (statusText.startsWith('running')) {
    return { processId, status: { label: 'running', failed: false } };
  }
  if (statusText.startsWith('exited')) {
    const failed = statusText.includes('timeout') || statusText.includes('error');
    return { processId, status: { label: previewInline(statusText, 40), failed } };
  }
  return { processId, status: { label: null, failed: false } };
}

function buildSemanticStub(
  meta: ToolCallMeta | undefined,
  content: ModelMessage['content'],
  options: { readonly includeFailureTail: boolean },
): string {
  const size = describeContentSize(content);
  const text = typeof content === 'string' ? content : null;

  if (meta === undefined) {
    return `[earlier tool output cleared (${size})]`;
  }

  const { name, args } = meta;

  switch (name) {
    case 'fs_read': {
      const target = readStringArg(args, 'path');
      const range = formatRangeSuffix(args);
      if (target === null) {
        return `[earlier fs_read output cleared (${size}) — re-read with fs_read if needed]`;
      }
      return `[earlier fs_read of ${previewInline(target)}${range} cleared (${size}) — re-read with fs_read if needed]`;
    }
    case 'fs_edit':
    case 'fs_write': {
      const target = readStringArg(args, 'path');
      return target === null
        ? `[earlier ${name} output cleared (${size})]`
        : `[earlier ${name} of ${previewInline(target)} cleared (${size})]`;
    }
    case 'fs_grep': {
      const pattern = readStringArg(args, 'pattern');
      const target = readStringArg(args, 'path');
      const glob = readStringArg(args, 'glob');
      const parts = ['earlier fs_grep'];
      if (pattern !== null) parts.push(`for ${JSON.stringify(previewInline(pattern, 50))}`);
      if (target !== null) parts.push(`in ${previewInline(target, 50)}`);
      if (glob !== null) parts.push(`glob ${JSON.stringify(previewInline(glob, 30))}`);
      return `[${parts.join(' ')} cleared (${size})]`;
    }
    case 'fs_glob': {
      const pattern = readStringArg(args, 'pattern');
      const target = readStringArg(args, 'path');
      const parts = ['earlier fs_glob'];
      if (pattern !== null) parts.push(`for ${JSON.stringify(previewInline(pattern, 50))}`);
      if (target !== null) parts.push(`in ${previewInline(target, 50)}`);
      return `[${parts.join(' ')} cleared (${size})]`;
    }
    case 'shell': {
      const command = readStringArg(args, 'command');
      const cmdPart =
        command === null ? '' : ` ${JSON.stringify(previewInline(command))}`;
      const status = text === null ? { label: null, failed: false } : inspectShellResult(text);
      const detail = status.label === null ? size : `${status.label}, ${size}`;
      const header = `[earlier shell${cmdPart} (${detail}) cleared`;
      if (options.includeFailureTail && status.failed && text !== null) {
        const tail = extractTail(text);
        if (tail !== '') return `${header}; tail:\n${tail}]`;
      }
      return `${header}]`;
    }
    case 'process_output': {
      const inspected =
        text === null
          ? { processId: readStringArg(args, 'processId'), status: { label: null, failed: false } }
          : inspectProcessOutput(args, text);
      const idPart =
        inspected.processId === null ? '' : ` ${previewInline(inspected.processId, 40)}`;
      const detail =
        inspected.status.label === null ? size : `${inspected.status.label}, ${size}`;
      const header = `[earlier process_output${idPart} (${detail}) cleared`;
      if (options.includeFailureTail && inspected.status.failed && text !== null) {
        const tail = extractTail(text);
        if (tail !== '') return `${header}; tail:\n${tail}]`;
      }
      return `${header}]`;
    }
    case 'process_start': {
      const firstLine = text?.split('\n', 1)[0] ?? '';
      const startedId = STARTED_PROCESS_RE.exec(firstLine)?.[1] ?? null;
      const command = readStringArg(args, 'command');
      const idPart = startedId === null ? '' : ` ${startedId}`;
      const cmdPart =
        command === null ? '' : ` ${JSON.stringify(previewInline(command, 60))}`;
      return `[earlier process_start${idPart}${cmdPart} cleared (${size})]`;
    }
    case 'process_stop': {
      const firstLine = text?.split('\n', 1)[0] ?? '';
      const stoppedMatch = STOPPED_PROCESS_RE.exec(firstLine);
      const processId = readStringArg(args, 'processId') ?? stoppedMatch?.[1] ?? null;
      const idPart = processId === null ? '' : ` ${previewInline(processId, 40)}`;
      return `[earlier process_stop${idPart} cleared (${size})]`;
    }
    default:
      return `[earlier ${name} output cleared (${size})]`;
  }
}

function collapseFailureTail(stub: string): string | null {
  const markerIndex = stub.indexOf(TAIL_MARKER);
  if (markerIndex === -1) return null;
  return `${stub.slice(0, markerIndex)} cleared]`;
}

function tryReplaceMessage(
  next: ModelMessage[],
  index: number,
  replacementContent: string,
  estimate: CompactionContext['estimate'],
): number {
  const current = next[index];
  if (current === undefined) return 0;
  if (current.content === replacementContent) return 0;
  const candidate: ModelMessage = { ...current, content: replacementContent };
  const saved = estimate(current) - estimate(candidate);
  if (saved <= 0) return 0;
  next[index] = candidate;
  return saved;
}

/**
 * Pass 1: deduplicate stale `fs_read` results whose file was re-read over the
 * same or wider line range, or modified by a later successful `fs_edit`/`fs_write`.
 * Clears oldest-first and stops as soon as estimated tokens fit within `maxTokens`.
 */
function dedupeSupersededReads(): CompactionStrategy {
  return (messages, ctx) => {
    const callsById = indexToolCalls(messages);

    interface ReadEvent {
      readonly index: number;
      readonly normPath: string;
      readonly displayPath: string;
      readonly rangeSuffix: string;
      readonly range: LineRange;
    }

    interface LaterEvent {
      readonly index: number;
      readonly kind: 'read' | 'mutate';
      readonly range?: LineRange;
    }

    const reads: ReadEvent[] = [];
    const laterByPath = new Map<string, LaterEvent[]>();
    const recordLater = (normPath: string, event: LaterEvent): void => {
      const existing = laterByPath.get(normPath);
      if (existing !== undefined) existing.push(event);
      else laterByPath.set(normPath, [event]);
    };

    for (let i = 0; i < messages.length; i += 1) {
      const message = messages[i];
      if (message === undefined || message.role !== 'tool' || message.toolCallId === undefined) {
        continue;
      }
      const meta = callsById.get(message.toolCallId);
      if (meta === undefined || typeof message.content !== 'string') continue;

      if (meta.name === 'fs_read') {
        const rawPath = readStringArg(meta.args, 'path');
        if (rawPath === null) continue;
        const normPath = normalizePath(rawPath);
        if (isClearedStub(message.content)) continue;
        if (!isSuccessfulFsRead(message.content)) continue;
        const range = extractReadRange(meta.args, message.content);
        reads.push({
          index: i,
          normPath,
          displayPath: previewInline(rawPath),
          rangeSuffix: formatRangeSuffix(meta.args),
          range,
        });
        recordLater(normPath, { index: i, kind: 'read', range });
      } else if (meta.name === 'fs_edit' || meta.name === 'fs_write') {
        if (!isSuccessfulMutation(meta.name, message.content)) continue;
        for (const normPath of extractMutationPaths(meta.name, meta.args, message.content)) {
          recordLater(normPath, { index: i, kind: 'mutate' });
        }
      }
    }

    if (reads.length === 0) return null;

    let runningTokens = totalTokens(messages, ctx.estimate);
    const next = [...messages];
    let changed = false;

    for (const read of reads) {
      if (runningTokens <= ctx.maxTokens) break;
      const candidates = laterByPath.get(read.normPath);
      if (candidates === undefined) continue;
      const superseded = candidates.some(
        (event) =>
          event.index > read.index &&
          (event.kind === 'mutate' ||
            (event.range !== undefined && rangeCovers(event.range, read.range))),
      );
      if (!superseded) continue;

      const stub = `[earlier fs_read of ${read.displayPath}${read.rangeSuffix} cleared (re-read or edited later)]`;
      const saved = tryReplaceMessage(next, read.index, stub, ctx.estimate);
      if (saved > 0) {
        runningTokens -= saved;
        changed = true;
      }
    }

    return changed ? next : null;
  };
}

/**
 * Pass 2: replace bulky tool outputs older than the last `KEEP_RECENT_TOOL_RESULTS`
 * with compact semantic stubs, preserving short change receipts (`fs_edit`,
 * `fs_write`, `process_stop`) verbatim and keeping error tails on failed
 * `shell` / `process_output` runs.
 */
function clearOlderToolResults(): CompactionStrategy {
  return (messages, ctx) => {
    const toolIndices = collectToolResultIndices(messages);
    if (toolIndices.length <= KEEP_RECENT_TOOL_RESULTS) return null;

    const clearBefore = toolIndices[toolIndices.length - KEEP_RECENT_TOOL_RESULTS] ?? 0;
    const callsById = indexToolCalls(messages);
    let runningTokens = totalTokens(messages, ctx.estimate);
    const next = [...messages];
    let changed = false;

    for (const index of toolIndices) {
      if (index >= clearBefore || runningTokens <= ctx.maxTokens) break;
      const message = next[index];
      if (message === undefined) continue;
      if (isClearedStub(message.content)) continue;

      const meta =
        message.toolCallId === undefined ? undefined : callsById.get(message.toolCallId);
      if (
        meta !== undefined &&
        PRESERVED_RECEIPT_TOOLS.has(meta.name) &&
        typeof message.content === 'string' &&
        message.content.length <= MAX_PRESERVED_RECEIPT_CHARS
      ) {
        continue;
      }

      const stub = buildSemanticStub(meta, message.content, { includeFailureTail: true });
      const saved = tryReplaceMessage(next, index, stub, ctx.estimate);
      if (saved > 0) {
        runningTokens -= saved;
        changed = true;
      }
    }

    return changed ? next : null;
  };
}

/**
 * Pass 3: when Pass 1 and Pass 2 are not enough, narrow the verbatim window
 * from 12 down to 4 tool results (using semantic stubs first), and if still
 * over budget collapse retained failure tails and old edit receipts into
 * one-line stubs before falling back to `evictOldest`.
 */
function escalateToolClearing(): CompactionStrategy {
  return (messages, ctx) => {
    const toolIndices = collectToolResultIndices(messages);
    if (toolIndices.length <= ESCALATE_KEEP_TOOL_RESULTS) return null;

    const clearBefore = toolIndices[toolIndices.length - ESCALATE_KEEP_TOOL_RESULTS] ?? 0;
    const callsById = indexToolCalls(messages);
    let runningTokens = totalTokens(messages, ctx.estimate);
    const next = [...messages];
    let changed = false;

    // 3a: semantically clear bulky results in the 5..12 recency band first.
    for (const index of toolIndices) {
      if (index >= clearBefore || runningTokens <= ctx.maxTokens) break;
      const message = next[index];
      if (message === undefined) continue;
      if (isClearedStub(message.content)) continue;

      const meta =
        message.toolCallId === undefined ? undefined : callsById.get(message.toolCallId);
      if (
        meta !== undefined &&
        PRESERVED_RECEIPT_TOOLS.has(meta.name) &&
        typeof message.content === 'string' &&
        message.content.length <= MAX_PRESERVED_RECEIPT_CHARS
      ) {
        continue;
      }

      const stub = buildSemanticStub(meta, message.content, { includeFailureTail: true });
      const saved = tryReplaceMessage(next, index, stub, ctx.estimate);
      if (saved > 0) {
        runningTokens -= saved;
        changed = true;
      }
    }

    // 3b: if still over budget, trim retained failure tails and old short receipts.
    if (runningTokens > ctx.maxTokens) {
      for (const index of toolIndices) {
        if (index >= clearBefore || runningTokens <= ctx.maxTokens) break;
        const message = next[index];
        if (message === undefined) continue;

        if (typeof message.content === 'string' && isClearedStub(message.content)) {
          const collapsed = collapseFailureTail(message.content);
          if (collapsed === null) continue;
          const saved = tryReplaceMessage(next, index, collapsed, ctx.estimate);
          if (saved > 0) {
            runningTokens -= saved;
            changed = true;
          }
          continue;
        }

        const meta =
          message.toolCallId === undefined ? undefined : callsById.get(message.toolCallId);
        const stub = buildSemanticStub(meta, message.content, { includeFailureTail: false });
        const saved = tryReplaceMessage(next, index, stub, ctx.estimate);
        if (saved > 0) {
          runningTokens -= saved;
          changed = true;
        }
      }
    }

    return changed ? next : null;
  };
}

export function providerCompaction(input: {
  readonly maxTokens: number;
  readonly onCompact?: (info: CompactionInfo) => void;
}): ChatMiddleware {
  return withCompaction({
    maxTokens: input.maxTokens,
    estimateTokens,
    strategy: composeStrategies(
      dedupeSupersededReads(),
      clearOlderToolResults(),
      escalateToolClearing(),
      evictOldest({
        marker: (count) => `[${String(count)} earlier message(s) omitted to save context.]`,
      }),
    ),
    strategyKey: STRATEGY_KEY,
    ...(input.onCompact === undefined ? {} : { onCompact: input.onCompact }),
  });
}
