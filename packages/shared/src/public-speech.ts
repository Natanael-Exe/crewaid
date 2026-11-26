/**
 * Canonical public-speech projection and streaming output circuit-breaker.
 *
 * Keeps internal model reasoning tags, harness control directives, mid-text
 * leaked tool markup, and high-confidence degenerate repetition out of every
 * operator-facing surface (live SSE, replay, history, full-text search,
 * sidebar previews, copy, and saved message deliverables) while preserving
 * fenced code blocks, inline code spans, and legitimate long replies.
 */

import { stripModelControlTags } from './model-control-tags.js';

/** Splits text into protected fenced/inline code segments (odd indices) and prose (even indices). */
const CODE_SEGMENT_RE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g;

const REASONING_TAG_NAMES = [
  'think',
  'thought',
  'reasoning',
  'analysis',
  'internal_thought',
  'internal-thought',
] as const;

const REASONING_NAME_PATTERN = REASONING_TAG_NAMES.join('|');

const PAIRED_REASONING_RE = new RegExp(
  `<(${REASONING_NAME_PATTERN})(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1\\s*>`,
  'gi',
);

const UNTERMINATED_REASONING_RE = new RegExp(
  `<(${REASONING_NAME_PATTERN})(?:\\s[^>]*)?>[\\s\\S]*$`,
  'gi',
);

const ORPHAN_CLOSE_REASONING_RE = new RegExp(
  `^[\\s\\S]*?<\\/(?:${REASONING_NAME_PATTERN})\\s*>`,
  'i',
);

const STRAY_CLOSE_REASONING_RE = new RegExp(
  `<\\/(?:${REASONING_NAME_PATTERN})\\s*>`,
  'gi',
);

/**
 * Provider tool-call syntax when a model writes the call at the start of a reply.
 * Matches only at start of trimmed prose so explanations like
 * "Models write <tool_call> when they mean a call." are preserved.
 */
const START_TOOL_OPENERS = [
  '<tool_call>',
  '<tool_use>',
  '<function_calls>',
  '<invoke ',
  '<function=',
  '<|tool_call|>',
  '<|python_tag|>',
  '<｜tool▁calls▁begin｜>',
  '<|tool_calls_begin|>',
  '[TOOL_CALLS]',
] as const;

/** Native Crewaid tool names that must never appear as raw XML invocations in prose. */
const NATIVE_XML_TOOL_PATTERN =
  'fs_write|fs_read|fs_edit|fs_grep|fs_glob|send_message|attach_file|shell|board_read|board_add|board_update|present_visual|use_plugin_tool|find_plugin_tools|browser_[a-z_]+|task_[a-z_]+|goal_[a-z_]+|deliverable_[a-z_]+|memory_[a-z_]+';

/**
 * Structured leaked tool-call markup occurring anywhere outside fenced/inline code.
 * Carefully requires invocation structure (closing tag, JSON/XML arguments,
 * attributes, or provider sentinel) so prose mentioning a tag name does not trip it.
 */
const MID_TEXT_TOOL_MARKUP_RE = new RegExp(
  [
    // Provider tool-call blocks or payloaded openers
    '<tool_call(?:\\s[^>]*)?>[\\s\\S]*?<\\/tool_call\\s*>',
    '<tool_call(?:\\s[^>]*)?>\\s*[\\{\\[]',
    '<tool_use(?:\\s[^>]*)?>[\\s\\S]*?<\\/tool_use\\s*>',
    '<tool_use(?:\\s[^>]*)?>\\s*[\\{\\[]',
    '<function_calls(?:\\s[^>]*)?>[\\s\\S]*?(?:<\\/function_calls\\s*>|$)',
    '<invoke\\s+[^>]*>[\\s\\S]*?(?:<\\/invoke\\s*>|$)',
    '<function=[a-z0-9_.-]+[^>]*>[\\s\\S]*?(?:<\\/function\\s*>|$)',
    '<\\|tool_call\\|>[\\s\\S]*',
    '<\\|python_tag\\|>[\\s\\S]*',
    '<｜tool▁calls▁begin｜>[\\s\\S]*',
    '<\\|tool_calls_begin\\|>[\\s\\S]*',
    '\\[TOOL_CALLS\\]\\s*[\\{\\[][\\s\\S]*',
    // Native tool pseudo-XML invocations (self-closing, attributed, or paired)
    `<(?:${NATIVE_XML_TOOL_PATTERN})\\s+[^>]*\\/>`,
    `<(?:${NATIVE_XML_TOOL_PATTERN})\\s+[^>]*>[\\s\\S]*?(?:<\\/(?:${NATIVE_XML_TOOL_PATTERN})\\s*>|$)`,
    `<(${NATIVE_XML_TOOL_PATTERN})>[\\s\\S]*?<\\/\\1\\s*>`,
  ].join('|'),
  'gi',
);

export type CorruptOutputKind = 'leaked-tool-markup' | 'runaway-repetition';

export interface CorruptOutputMatch {
  readonly kind: CorruptOutputKind;
  readonly detail: string;
}

function proseOutsideCode(text: string): string {
  return text
    .split(CODE_SEGMENT_RE)
    .filter((_, index) => index % 2 === 0)
    .join('\n');
}

function normalizeClause(clause: string): string {
  return clause
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Detects high-confidence degenerate repetition in non-code prose — such as
 * Gideon's `Produce. Write. Emit. Go. Now. Ok.` meltdown — while leaving
 * legitimate long prose, lists, Markdown tables, and code blocks untouched.
 */
export function detectDegenerateRepetition(text: string): CorruptOutputMatch | null {
  const prose = proseOutsideCode(text);
  if (prose.length < 100) return null;

  // Rule 1: Consecutive short micro-sentence barrage (e.g. "Emit. Go. Now. Ok. Produce. Write.").
  const rawClauses = prose.split(/[.!?\n;]+/);
  let runCount = 0;
  const runFreq = new Map<string, number>();
  for (const raw of rawClauses) {
    const normalized = normalizeClause(raw);
    if (normalized === '') continue;
    const wordCount = normalized.split(' ').length;
    if (wordCount >= 1 && wordCount <= 3 && normalized.length <= 24) {
      runCount += 1;
      runFreq.set(normalized, (runFreq.get(normalized) ?? 0) + 1);
      if (runCount >= 18) {
        let maxSingle = 0;
        for (const count of runFreq.values()) {
          if (count > maxSingle) maxSingle = count;
        }
        if (runFreq.size <= Math.floor(runCount * 0.42) && maxSingle >= 4) {
          return { kind: 'runaway-repetition', detail: 'short-clause-barrage' };
        }
      }
    } else {
      runCount = 0;
      runFreq.clear();
    }
  }

  // Rule 2: Consecutive identical prose lines (>= 6 repeats of a non-trivial line).
  const lines = prose.split('\n');
  let prevLine = '';
  let sameLineCount = 0;
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed === '') continue;
    // Ignore markdown separators/table dividers.
    if (trimmed.length >= 8 && /[a-z]{2}/i.test(trimmed) && !/^[-|:=*_\s]+$/.test(trimmed)) {
      if (trimmed === prevLine) {
        sameLineCount += 1;
        if (sameLineCount >= 6) {
          return { kind: 'runaway-repetition', detail: 'identical-line-loop' };
        }
      } else {
        prevLine = trimmed;
        sameLineCount = 1;
      }
    } else {
      prevLine = '';
      sameLineCount = 0;
    }
  }

  // Extract normalized alphanumeric words for sliding-window & n-gram cycle checks.
  const words = prose.toLowerCase().match(/[a-z0-9]+/g);
  if (words === null || words.length < 24) return null;

  // Rule 3: Exact consecutive n-gram cycle repetition (1..12 words repeated >= 8 times).
  const maxPeriod = Math.min(12, Math.floor(words.length / 8));
  for (let period = 1; period <= maxPeriod; period += 1) {
    let matches = 0;
    for (let i = period; i < words.length; i += 1) {
      if (words[i] === words[i - period]) {
        matches += 1;
        const totalWords = matches + period;
        const cycles = Math.floor(totalWords / period);
        if (cycles >= 8 && totalWords >= 16) {
          // Ensure the repeating unit contains alphabetic text (not pure numeric table cells).
          const unit = words.slice(i - period + 1, i + 1);
          if (unit.some((word) => /[a-z]/.test(word))) {
            return { kind: 'runaway-repetition', detail: `ngram-cycle-${period}` };
          }
        }
      } else {
        matches = 0;
      }
    }
  }

  // Rule 4: Large low-diversity word window (120 consecutive words with < 14% unique words
  // and top-8 words accounting for >= 75% of the window).
  const WINDOW = 120;
  if (words.length >= WINDOW) {
    const counts = new Map<string, number>();
    for (let i = 0; i < WINDOW; i += 1) {
      const w = words[i]!;
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
    const isDegenerateWindow = (): boolean => {
      if (counts.size > 16) return false;
      const top = [...counts.values()].sort((a, b) => b - a).slice(0, 8);
      const topSum = top.reduce((sum, n) => sum + n, 0);
      return topSum >= WINDOW * 0.75;
    };
    if (isDegenerateWindow()) {
      return { kind: 'runaway-repetition', detail: 'low-diversity-window' };
    }
    for (let i = WINDOW; i < words.length; i += 1) {
      const leaving = words[i - WINDOW]!;
      const entering = words[i]!;
      const leftCount = (counts.get(leaving) ?? 1) - 1;
      if (leftCount <= 0) counts.delete(leaving);
      else counts.set(leaving, leftCount);
      counts.set(entering, (counts.get(entering) ?? 0) + 1);
      if ((i - WINDOW) % 10 === 0 && isDegenerateWindow()) {
        return { kind: 'runaway-repetition', detail: 'low-diversity-window' };
      }
    }
  }

  return null;
}

/**
 * Classifies whether a settled or in-flight assistant text contains corrupt
 * output that should abort/withdraw a reply: leaked tool-call markup outside
 * code or high-confidence degenerate repetition.
 */
export function detectCorruptPublicOutput(text: string): CorruptOutputMatch | null {
  if (text.trim() === '') return null;

  // Strip reasoning and control blocks before judging whether the remaining speech is corrupt.
  const withoutTags = stripReasoningAndControlTags(text);
  const trimmedStart = withoutTags.trimStart();
  if (START_TOOL_OPENERS.some((opener) => trimmedStart.startsWith(opener))) {
    return { kind: 'leaked-tool-markup', detail: 'start-tool-opener' };
  }

  // Check mid-text leaked tool markup strictly outside fenced/inline code.
  const segments = withoutTags.split(CODE_SEGMENT_RE);
  for (let index = 0; index < segments.length; index += 2) {
    const prose = segments[index] ?? '';
    MID_TEXT_TOOL_MARKUP_RE.lastIndex = 0;
    if (MID_TEXT_TOOL_MARKUP_RE.test(prose)) {
      return { kind: 'leaked-tool-markup', detail: 'mid-text-tool-markup' };
    }
  }

  return detectDegenerateRepetition(withoutTags);
}

function stripReasoningAndControlTags(text: string): string {
  const withoutControl = stripModelControlTags(text);
  const lower = withoutControl.toLowerCase();
  const hasReasoningHint = REASONING_TAG_NAMES.some(
    (name) => lower.includes(`<${name}`) || lower.includes(`</${name}`),
  );
  if (!hasReasoningHint) return withoutControl;

  let changed = false;
  const cleaned = withoutControl
    .split(CODE_SEGMENT_RE)
    .map((segment, index) => {
      if (index % 2 === 1) return segment;
      let next = segment;
      // 1. Remove paired <think>...</think> blocks.
      next = next.replace(PAIRED_REASONING_RE, () => {
        changed = true;
        return '';
      });
      // 2. If a stray closing </think> remains (split/missing opener), drop prefix up to it.
      if (ORPHAN_CLOSE_REASONING_RE.test(next)) {
        next = next.replace(ORPHAN_CLOSE_REASONING_RE, () => {
          changed = true;
          return '';
        });
      }
      // 3. Remove any additional stray closing reasoning tags.
      next = next.replace(STRAY_CLOSE_REASONING_RE, () => {
        changed = true;
        return '';
      });
      // 4. Remove unterminated <think>... to EOF.
      next = next.replace(UNTERMINATED_REASONING_RE, () => {
        changed = true;
        return '';
      });
      return next;
    })
    .join('');

  if (!changed) return withoutControl;
  return collapseWhitespace(cleaned);
}

function collapseWhitespace(text: string): string {
  return text
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[ \t]*\n+/, '')
    .replace(/\n+[ \t]*$/, '')
    .trim();
}

/**
 * Canonical projection from stored/raw assistant text to safe public speech.
 *
 * Used identically across live output, hydration, legacy history reads,
 * full-text search, sidebar previews, copy, and saved message deliverables:
 * - Preserves fenced code blocks and inline code spans intact.
 * - Strips model control tags and paired/split/unterminated reasoning tags.
 * - Strips leaked tool-call markup outside code.
 * - Suppresses corrupt runaway-repetition messages entirely so legacy
 *   meltdowns vanish from history, search, previews, copy, and deliverables.
 */
export function projectPublicSpeech(text: string): string {
  if (text === '') return '';

  const stripped = stripReasoningAndControlTags(text);
  if (stripped.trim() === '') return '';

  // High-confidence runaway repetition marks the entire message as corrupt output.
  if (detectDegenerateRepetition(stripped) !== null) return '';

  // Start-of-reply raw tool-call opener: entire reply was an unexecuted tool call.
  if (START_TOOL_OPENERS.some((opener) => stripped.trimStart().startsWith(opener))) {
    return '';
  }

  let removedMarkup = false;
  const cleaned = stripped
    .split(CODE_SEGMENT_RE)
    .map((segment, index) => {
      if (index % 2 === 1) return segment;
      MID_TEXT_TOOL_MARKUP_RE.lastIndex = 0;
      return segment.replace(MID_TEXT_TOOL_MARKUP_RE, () => {
        removedMarkup = true;
        return '';
      });
    })
    .join('');

  if (!removedMarkup) return stripped;
  return collapseWhitespace(cleaned);
}

export interface PublicOutputGuardStep {
  readonly emit: string;
  readonly corrupt: CorruptOutputMatch | null;
}

export interface PublicOutputGuard {
  readonly push: (delta: string) => PublicOutputGuardStep;
  readonly flush: () => PublicOutputGuardStep;
  readonly tripped: () => CorruptOutputMatch | null;
}

const STREAM_SUPPRESSED_OPEN_RE = new RegExp(
  `^<(budget:[a-z0-9_-]+|system[-_]reminder|${REASONING_NAME_PATTERN})(?:\\s[^>]*)?(\\/?)>`,
  'i',
);

const STREAM_SUPPRESSED_CLOSE_RE = new RegExp(
  `^<\\/(budget:[a-z0-9_-]+|system[-_]reminder|${REASONING_NAME_PATTERN})\\s*>`,
  'i',
);

const STREAM_OPENER_PREFIXES = [
  '<budget:',
  '</budget:',
  '<system-reminder',
  '</system-reminder',
  '<system_reminder',
  '</system_reminder',
  '<think',
  '</think',
  '<thought',
  '</thought',
  '<reasoning',
  '</reasoning',
  '<analysis',
  '</analysis',
  '<internal_thought',
  '</internal_thought',
  '<internal-thought',
  '</internal-thought',
  ...START_TOOL_OPENERS,
  '<fs_write',
  '<fs_read',
  '<fs_edit',
  '<fs_grep',
  '<fs_glob',
  '<send_message',
  '<attach_file',
  '<shell',
  '<board_read',
  '<board_add',
  '<board_update',
  '<present_visual',
  '<use_plugin_tool',
  '<find_plugin_tools',
  '<browser_',
  '<task_',
  '<goal_',
  '<deliverable_',
  '<memory_',
] as const;

const MAX_REASONING_BUFFER_CHARS = 16_384;
const MAX_UNCERTAIN_TAG_CHARS = 96;
const REPETITION_TAIL_LIMIT = 4096;

function isPotentialTagPrefix(fragment: string): boolean {
  const lower = fragment.toLowerCase();
  return STREAM_OPENER_PREFIXES.some(
    (opener) => opener.toLowerCase().startsWith(lower) || lower.startsWith(opener.toLowerCase()),
  );
}

/**
 * Counts consecutive trailing short 1–3 word clauses that already show repetition
 * so the streaming guard can hold uncertain output BEFORE it leaks to chat.
 */
function hasSuspiciousTrailingClauses(tailProse: string): boolean {
  const rawClauses = tailProse.split(/[.!?\n;]+/);
  let runCount = 0;
  const seen = new Map<string, number>();
  for (let i = rawClauses.length - 1; i >= 0; i -= 1) {
    const normalized = normalizeClause(rawClauses[i] ?? '');
    if (normalized === '') continue;
    const words = normalized.split(' ').length;
    if (words >= 1 && words <= 3 && normalized.length <= 24) {
      runCount += 1;
      seen.set(normalized, (seen.get(normalized) ?? 0) + 1);
      if (runCount >= 6) {
        let maxSingle = 0;
        for (const count of seen.values()) {
          if (count > maxSingle) maxSingle = count;
        }
        if (maxSingle >= 2 && seen.size <= Math.ceil(runCount * 0.7)) return true;
      }
      if (runCount >= 24) break;
    } else {
      break;
    }
  }
  return false;
}

/**
 * Stateful streaming guard for live assistant text:
 * - Suppresses control tags and paired/split/unterminated reasoning blocks across
 *   arbitrary chunk boundaries while keeping fenced and inline code untouched.
 * - Buffers uncertain `<...` / `[TOOL_CALLS` prefixes and suspicious short-clause
 *   repetition tails until classified.
 * - Signals `corrupt` immediately on leaked tool markup outside code or
 *   high-confidence runaway repetition so the orchestrator can abort & withdraw.
 */
export function createPublicOutputGuard(): PublicOutputGuard {
  let buffer = '';
  let activeSuppressedTag: string | null = null;
  let suppressedLen = 0;
  let inCodeFence = false;
  let codeFenceMarker = '```';
  let inInlineCode = false;
  let pendingRepeatHold = '';
  let recentProse = '';
  let hasEmitted = false;
  let corruptMatch: CorruptOutputMatch | null = null;

  const inspectCandidate = (chunk: string, final: boolean, isCode = false): string => {
    if (chunk === '' && !final) return '';

    // Inside code blocks/spans, emit immediately without repetition/markup checks.
    if (isCode || inCodeFence || inInlineCode) {
      let out = '';
      if (pendingRepeatHold !== '') {
        out += pendingRepeatHold;
        pendingRepeatHold = '';
      }
      out += chunk;
      if (out !== '') hasEmitted = true;
      return out;
    }

    const combinedTail = recentProse + pendingRepeatHold + chunk;

    // Check for leaked tool markup at the very start of speech or mid-text.
    if (!hasEmitted) {
      const trimmed = combinedTail.trimStart();
      if (START_TOOL_OPENERS.some((opener) => trimmed.startsWith(opener))) {
        corruptMatch = { kind: 'leaked-tool-markup', detail: 'start-tool-opener' };
        pendingRepeatHold = '';
        return '';
      }
    }

    MID_TEXT_TOOL_MARKUP_RE.lastIndex = 0;
    if (MID_TEXT_TOOL_MARKUP_RE.test(combinedTail)) {
      corruptMatch = { kind: 'leaked-tool-markup', detail: 'mid-text-tool-markup' };
      pendingRepeatHold = '';
      return '';
    }

    const rep = detectDegenerateRepetition(combinedTail);
    if (rep !== null) {
      corruptMatch = rep;
      pendingRepeatHold = '';
      return '';
    }

    // Hold suspicious short repetitive bursts until either normal prose resumes or it trips.
    if (!final && hasSuspiciousTrailingClauses(combinedTail) && pendingRepeatHold.length < 400) {
      pendingRepeatHold += chunk;
      return '';
    }

    const emitNow = pendingRepeatHold + chunk;
    pendingRepeatHold = '';
    recentProse = (recentProse + emitNow).slice(-REPETITION_TAIL_LIMIT);
    if (emitNow.trim() !== '') hasEmitted = true;
    return emitNow;
  };

  const drain = (final: boolean): PublicOutputGuardStep => {
    if (corruptMatch !== null) {
      buffer = '';
      pendingRepeatHold = '';
      return { emit: '', corrupt: corruptMatch };
    }

    let emitted = '';

    while (buffer.length > 0 && corruptMatch === null) {
      if (inCodeFence) {
        const closeAt = buffer.indexOf(codeFenceMarker);
        if (closeAt === -1) {
          if (final) {
            const piece = buffer;
            buffer = '';
            emitted += inspectCandidate(piece, true, true);
          } else {
            const safeEnd =
              buffer.endsWith('``') || buffer.endsWith('~~')
                ? buffer.length - 2
                : buffer.endsWith('`') || buffer.endsWith('~')
                  ? buffer.length - 1
                  : buffer.length;
            if (safeEnd === 0) break;
            const piece = buffer.slice(0, safeEnd);
            buffer = buffer.slice(safeEnd);
            emitted += inspectCandidate(piece, false, true);
          }
          break;
        }
        const piece = buffer.slice(0, closeAt + codeFenceMarker.length);
        buffer = buffer.slice(closeAt + codeFenceMarker.length);
        emitted += inspectCandidate(piece, false, true);
        inCodeFence = false;
        continue;
      }

      if (inInlineCode) {
        const tick = buffer.indexOf('`');
        const nl = buffer.indexOf('\n');
        const stop = tick === -1 ? nl : nl === -1 ? tick : Math.min(tick, nl);
        if (stop === -1) {
          const piece = buffer;
          buffer = '';
          emitted += inspectCandidate(piece, final, true);
          break;
        }
        const piece = buffer.slice(0, stop + 1);
        buffer = buffer.slice(stop + 1);
        emitted += inspectCandidate(piece, false, true);
        inInlineCode = false;
        continue;
      }

      if (activeSuppressedTag !== null) {
        const closeToken = `</${activeSuppressedTag}>`;
        const closeIdx = buffer.toLowerCase().indexOf(closeToken.toLowerCase());
        if (closeIdx !== -1) {
          let end = closeIdx + closeToken.length;
          if (buffer[end] === '\r' && buffer[end + 1] === '\n') end += 2;
          else if (buffer[end] === '\n') end += 1;
          buffer = buffer.slice(end);
          activeSuppressedTag = null;
          suppressedLen = 0;
          continue;
        }
        if (final) {
          // Drop unterminated reasoning/control blocks completely on EOF.
          buffer = '';
          activeSuppressedTag = null;
          suppressedLen = 0;
          break;
        }
        // Keep only the possible partial closing tag tail so memory stays bounded.
        const keep = closeToken.length;
        if (buffer.length > keep) {
          suppressedLen += buffer.length - keep;
          buffer = buffer.slice(-keep);
        }
        if (suppressedLen > MAX_REASONING_BUFFER_CHARS && !activeSuppressedTag.includes(':')) {
          // Still inside an unterminated reasoning block; keep discarding safely.
          suppressedLen = MAX_REASONING_BUFFER_CHARS;
        }
        break;
      }

      // Look for the earliest special trigger: '<', '[', '`', '~'.
      const nextSpecial = findNextSpecial(buffer);
      if (nextSpecial === -1) {
        const piece = buffer;
        buffer = '';
        emitted += inspectCandidate(piece, false);
        break;
      }

      if (nextSpecial > 0) {
        const before = buffer.slice(0, nextSpecial);
        buffer = buffer.slice(nextSpecial);
        emitted += inspectCandidate(before, false);
        continue;
      }

      // Buffer now starts with '`', '~', '[', or '<'.
      const ch = buffer[0];
      if (ch === '`' || ch === '~') {
        if (buffer.startsWith('```') || buffer.startsWith('~~~')) {
          const marker = buffer.slice(0, 3);
          buffer = buffer.slice(3);
          inCodeFence = true;
          codeFenceMarker = marker;
          emitted += inspectCandidate(marker, false, true);
          continue;
        }
        if (!final && (buffer === '`' || buffer === '``' || buffer === '~' || buffer === '~~')) {
          break;
        }
        const single = buffer[0]!;
        buffer = buffer.slice(1);
        if (single === '`') {
          inInlineCode = true;
          emitted += inspectCandidate(single, false, true);
        } else {
          emitted += inspectCandidate(single, false);
        }
        continue;
      }

      if (ch === '[') {
        if (!final && buffer.length < 16 && '[TOOL_CALLS]'.startsWith(buffer)) {
          break;
        }
        if (buffer.startsWith('[TOOL_CALLS]')) {
          if (!hasEmitted || /^\[TOOL_CALLS\]\s*[[{]/.test(buffer)) {
            corruptMatch = { kind: 'leaked-tool-markup', detail: 'bracket-tool-calls' };
            buffer = '';
            pendingRepeatHold = '';
            break;
          }
          if (!final && buffer.length < 16) break;
        }
        buffer = buffer.slice(1);
        emitted += inspectCandidate('[', false);
        continue;
      }

      // Buffer starts with '<'.
      const openSuppressed = STREAM_SUPPRESSED_OPEN_RE.exec(buffer);
      if (openSuppressed !== null) {
        const tagName = openSuppressed[1] ?? '';
        const selfClosing = openSuppressed[2] === '/';
        buffer = buffer.slice(openSuppressed[0].length);
        if (!selfClosing) {
          activeSuppressedTag = tagName;
          suppressedLen = 0;
        }
        continue;
      }

      const closeSuppressed = STREAM_SUPPRESSED_CLOSE_RE.exec(buffer);
      if (closeSuppressed !== null) {
        buffer = buffer.slice(closeSuppressed[0].length);
        continue;
      }

      // Check provider tool sentinels or structured tool XML starting at '<'.
      if (!hasEmitted && START_TOOL_OPENERS.some((opener) => buffer.startsWith(opener))) {
        corruptMatch = { kind: 'leaked-tool-markup', detail: 'start-tool-opener' };
        buffer = '';
        pendingRepeatHold = '';
        break;
      }

      MID_TEXT_TOOL_MARKUP_RE.lastIndex = 0;
      const midMatch = MID_TEXT_TOOL_MARKUP_RE.exec(buffer);
      if (midMatch !== null && midMatch.index === 0) {
        corruptMatch = { kind: 'leaked-tool-markup', detail: 'mid-text-tool-markup' };
        buffer = '';
        pendingRepeatHold = '';
        break;
      }

      // Buffer uncertain `<...` prefixes until '>' arrives or max tag length is exceeded.
      const gt = buffer.indexOf('>');
      if (!final) {
        if (gt === -1 && buffer.length < MAX_UNCERTAIN_TAG_CHARS && isPotentialTagPrefix(buffer)) {
          break;
        }
        // Wait for one more char after `<tool_call>` / `<tool_use>` to tell prose from `{...}` payload.
        if (
          gt !== -1 &&
          gt < 32 &&
          /^<(tool_call|tool_use)(?:\s[^>]*)?>$/i.test(buffer.slice(0, gt + 1)) &&
          buffer.length < gt + 4
        ) {
          break;
        }
      }

      // Ordinary '<' (e.g. `a < b` or HTML prose mention) — emit '<' and continue.
      buffer = buffer.slice(1);
      emitted += inspectCandidate('<', false);
    }

    if (final && corruptMatch === null) {
      const tailOut = inspectCandidate('', true);
      emitted += tailOut;
    }

    if (corruptMatch !== null) {
      return { emit: '', corrupt: corruptMatch };
    }
    return { emit: emitted, corrupt: null };
  };

  return {
    push(delta: string): PublicOutputGuardStep {
      if (corruptMatch !== null) return { emit: '', corrupt: corruptMatch };
      if (delta === '') return { emit: '', corrupt: null };
      buffer += delta;
      return drain(false);
    },
    flush(): PublicOutputGuardStep {
      return drain(true);
    },
    tripped(): CorruptOutputMatch | null {
      return corruptMatch;
    },
  };
}

function findNextSpecial(text: string): number {
  let best = -1;
  for (const needle of ['<', '[', '`', '~']) {
    const idx = text.indexOf(needle);
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }
  return best;
}
