import path from 'node:path';
import type { AcpReportMode } from './types.js';

export const MAX_SUMMARY_CHARS = 16_000;
/** The summary's ceiling when only a summary may leave the machine. */
export const MAX_SUMMARY_ONLY_CHARS = 4_000;
/** Stands in for a fenced code block removed from a summary-only report. */
export const CODE_OMITTED_MARKER = '[code omitted: summary-only reporting]';
export const MAX_STEP_TITLE_CHARS = 120;
export const MAX_TRANSCRIPT_EXCERPT_CHARS = 16_000;
export const MAX_DIFF_EXCERPT_CHARS = 8_000;
export const MAX_SINGLE_DIFF_CHARS = 2_000;

/**
 * Normalizes a file path reported by an ACP harness against the task's `cwd`.
 *
 * - Paths inside `cwd` become clean POSIX relative paths (`src/app.ts`).
 * - Paths outside `cwd` collapse to their basename so unrelated host paths
 *   never leak into progress events or summaries.
 */
export function relativizeReportedPath(cwd: string, rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === '') return '';

  const normalizedCwd = path.resolve(cwd);
  const resolved = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(normalizedCwd, trimmed);

  const rel = path.relative(normalizedCwd, resolved);
  if (rel === '') return '.';
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    return rel.replaceAll('\\', '/');
  }
  return path.basename(resolved) || trimmed;
}

/**
 * Single-line bounded text for progress titles and command labels.
 * Strips control characters and newlines so one verbose tool call cannot flood
 * progress indicators or logs.
 */
export function sanitizeOneLine(raw: string, maxChars = MAX_STEP_TITLE_CHARS): string {
  const compact = raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

/** Truncates text while preserving the tail or head cleanly within `maxChars`. */
export function truncateText(raw: string, maxChars: number): string {
  const trimmed = raw.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

/** A fenced Markdown code block (``` or ~~~), including one left open at the end. */
const FENCED_BLOCK_RE = /(```|~~~)[\s\S]*?(?:\1|$)/g;

/**
 * The harness's final message as it may leave the machine.
 *
 * In `summary` mode the summary is still the agent's own words, and coding
 * agents routinely paste the code they changed into that final message. So
 * fenced code blocks are replaced with a marker and the text is capped, which
 * keeps "summary only" meaning that source code stays local.
 */
export function boundSummary(reportMode: AcpReportMode, text: string): string {
  if (reportMode === 'full') return truncateText(text, MAX_SUMMARY_CHARS);
  return truncateText(text.replace(FENCED_BLOCK_RE, CODE_OMITTED_MARKER), MAX_SUMMARY_ONLY_CHARS);
}

/**
 * Formats a concise diff excerpt for `reportMode === 'full'`.
 * Always returns `undefined` in `summary` mode so raw code diffs are never
 * collected or transmitted when summary-only reporting is active.
 */
export function formatDiffExcerpt(
  reportMode: AcpReportMode,
  cwd: string,
  filePath: string,
  oldText: string | null | undefined,
  newText: string,
): string | undefined {
  if (reportMode !== 'full') return undefined;
  const rel = relativizeReportedPath(cwd, filePath);
  const lines: string[] = [`--- ${rel}`];
  if (oldText !== undefined && oldText !== null && oldText !== '') {
    for (const line of oldText.split('\n').slice(0, 20)) {
      lines.push(`- ${line}`);
    }
  }
  for (const line of newText.split('\n').slice(0, 20)) {
    lines.push(`+ ${line}`);
  }
  return truncateText(lines.join('\n'), MAX_SINGLE_DIFF_CHARS);
}
