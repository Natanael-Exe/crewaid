import { NativeToolInputs } from '@crewaid/shared';

import { tool } from './tool-contract.js';
import { CONTAINED_BUILTIN, OBSERVING_BUILTIN } from './tool-registry.js';
import type { RegisteredTool, ToolContext } from './tool-registry.js';
import {
  MACHINE_HOME,
  resolveWorkspacePath,
  resolveWorkspaceSearchPlan,
  type WorkspaceSearchPlan,
} from './workspace-paths.js';

/**
 * Coding-grade file tools: `fs_edit`, `fs_grep`, and `fs_glob`.
 *
 * Every path and search root goes through `workspace-paths.ts` before hitting
 * the sandbox, and every search result is post-filtered through
 * `resolveWorkspacePath` as a backstop. User/model strings (patterns, paths,
 * globs) always travel in environment variables — never interpolated into a
 * shell command line.
 */

const MAX_OUTPUT_CHARS = 16_000;
const MAX_WRITE_BYTES = 1024 * 1024;
const DEFAULT_MAX_MATCHES = 100;
const DEFAULT_MAX_RESULTS = 200;
const SEARCH_TIMEOUT_S = 30;
const SEARCH_WAIT_MS = (SEARCH_TIMEOUT_S + 5) * 1000;
const RG_MAX_COLUMNS = 300;
const RG_MAX_FILESIZE = '2M';
/** Line cap for the `grep` fallback, which has no `--max-columns` (images without rg). */
const GREP_FALLBACK_MAX_LINE_BYTES = 1000;
/** Last line of `fs_glob`'s output: how many paths matched before the cap. */
const TOTAL_LINE_RE = /^#TOTAL (\d+)$/;

function failure(action: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${action} failed: ${detail}`;
}

function lineNumberAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function findMatchOffsets(content: string, needle: string): number[] {
  const offsets: number[] = [];
  let cursor = 0;
  while (cursor <= content.length) {
    const idx = content.indexOf(needle, cursor);
    if (idx === -1) break;
    offsets.push(idx);
    cursor = idx + needle.length;
  }
  return offsets;
}

const LINE_PREFIX_RE = /^\s*\d+(?:\t|: ?)/;

function looksLikeCopiedLineNumbers(content: string, needle: string): boolean {
  const lines = needle.split('\n');
  const nonEmpty = lines.filter((line) => line.length > 0);
  if (nonEmpty.length === 0 || !nonEmpty.some((line) => LINE_PREFIX_RE.test(line))) {
    return false;
  }
  const stripped = lines.map((line) => line.replace(LINE_PREFIX_RE, '')).join('\n');
  return stripped !== needle && stripped.length > 0 && content.includes(stripped);
}

function editContextPreview(updated: string, startLine: number, endLine: number): string {
  const lines = updated.split('\n');
  const from = Math.max(1, startLine - 1);
  const to = Math.min(lines.length, endLine + 1);
  const snippet: string[] = [];
  for (let n = from; n <= to; n += 1) {
    snippet.push(`${n}\t${lines[n - 1] ?? ''}`);
  }
  return snippet.join('\n');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Emit shell commands that populate `"$@"` with the allowed search roots.
 *
 * When searching `/home/bot` directly, machine-owned dirs and sibling bot/group
 * directories are excluded before `rg`/`fd` traverse them so hidden sibling
 * matches never exhaust result limits before post-filtering runs.
 */
function buildRootsPrelude(
  plan: Extract<WorkspaceSearchPlan, { readonly ok: true; readonly mode: 'root' | 'machine-home' }>,
): { readonly prelude: string; readonly env: Record<string, string> } {
  if (plan.mode === 'root') {
    return {
      prelude: 'set -- "$CREWAID_ROOT"',
      env: { CREWAID_ROOT: plan.path },
    };
  }
  const skipCases = plan.skipTopLevel.map((name) => shellQuote(name)).join('|');
  const prelude = [
    'set --',
    'for entry in /home/bot/* /home/bot/.[!.]* /home/bot/..?*; do',
    '  [ -e "$entry" ] || continue',
    '  base=${entry#/home/bot/}',
    `  case "$base" in ${skipCases}) continue ;; esac`,
    '  set -- "$@" "$entry"',
    'done',
    '[ -e "$CREWAID_OWN_DIR" ] && set -- "$@" "$CREWAID_OWN_DIR"',
    'if [ -n "${CREWAID_GROUP_DIR:-}" ] && [ -e "$CREWAID_GROUP_DIR" ]; then',
    '  set -- "$@" "$CREWAID_GROUP_DIR"',
    'fi',
    'if [ "$#" -eq 0 ]; then exit 0; fi',
  ].join('\n');
  return {
    prelude,
    env: {
      CREWAID_OWN_DIR: plan.ownDir,
      ...(plan.groupDir !== null ? { CREWAID_GROUP_DIR: plan.groupDir } : {}),
    },
  };
}

function normalizeGlobForFullPath(pattern: string): string {
  if (pattern.startsWith('/') || pattern.startsWith('**/')) return pattern;
  return `**/${pattern}`;
}

function buildGrepCommand(
  plan: Extract<WorkspaceSearchPlan, { readonly ok: true; readonly mode: 'root' | 'machine-home' }>,
  options: {
    readonly pattern: string;
    readonly glob: string | undefined;
    readonly fixedStrings: boolean;
    readonly caseSensitive: boolean;
    readonly maxMatches: number;
  },
): { readonly command: string; readonly env: Record<string, string> } {
  const { prelude, env } = buildRootsPrelude(plan);
  const rgExcludes = plan.excludes
    .flatMap((dir) => [`--glob ${shellQuote(`!${dir}`)}`, `--glob ${shellQuote(`!${dir}/**`)}`])
    .join(' ');
  const grepExcludes = plan.excludes.map((dir) => `--exclude-dir=${shellQuote(dir)}`).join(' ');

  const rgFlags = [
    '--hidden',
    '--line-number',
    '--with-filename',
    '--no-heading',
    '--color=never',
    `--max-columns=${RG_MAX_COLUMNS}`,
    '--max-columns-preview',
    `--max-filesize=${RG_MAX_FILESIZE}`,
    '--max-count',
    '"$CREWAID_MAX_PER_FILE"',
    options.fixedStrings ? '--fixed-strings' : '',
    options.caseSensitive ? '--case-sensitive' : '--smart-case',
    rgExcludes,
  ]
    .filter(Boolean)
    .join(' ');

  const smartCaseInsensitive =
    !options.caseSensitive && options.pattern === options.pattern.toLowerCase();
  const grepFlags = [
    '-rnI',
    options.fixedStrings ? '-F' : '-E',
    smartCaseInsensitive ? '-i' : '',
    grepExcludes,
  ]
    .filter(Boolean)
    .join(' ');

  // `head` bounds what crosses the bridge, not just what reaches the model:
  // `run` buffers all of stdout, and `--max-count` is per file, so a common
  // pattern over a large tree could otherwise ship megabytes to the
  // orchestrator only to be cut to 16k characters there. A pipeline's status is
  // `head`'s, so the tool reads "no output" plus stderr instead of rg's exit code.
  const script = [
    prelude,
    'if command -v rg >/dev/null 2>&1; then',
    '  if [ -n "${CREWAID_GLOB:-}" ]; then',
    `    rg ${rgFlags} --glob "$CREWAID_GLOB" -- "$CREWAID_PATTERN" "$@" | head -n "$CREWAID_MAX_LINES"`,
    '  else',
    `    rg ${rgFlags} -- "$CREWAID_PATTERN" "$@" | head -n "$CREWAID_MAX_LINES"`,
    '  fi',
    '  exit 0',
    'fi',
    'if [ -n "${CREWAID_GLOB:-}" ]; then',
    `  grep ${grepFlags} --include="$CREWAID_GLOB" -- "$CREWAID_PATTERN" "$@" | cut -c1-${GREP_FALLBACK_MAX_LINE_BYTES} | head -n "$CREWAID_MAX_LINES"`,
    'else',
    `  grep ${grepFlags} -- "$CREWAID_PATTERN" "$@" | cut -c1-${GREP_FALLBACK_MAX_LINE_BYTES} | head -n "$CREWAID_MAX_LINES"`,
    'fi',
    'exit 0',
  ].join('\n');

  return {
    command: `timeout --kill-after=5s ${SEARCH_TIMEOUT_S}s sh -c ${shellQuote(script)}`,
    env: {
      ...env,
      CREWAID_PATTERN: options.pattern,
      // One past the limit: with exactly `maxMatches` per file, a single file
      // with thousands of hits would come back complete-looking at the limit,
      // and the model would never be told there was more.
      CREWAID_MAX_PER_FILE: String(options.maxMatches + 1),
      // Twice the limit leaves room for lines the post-filter drops, so a
      // truncated answer is still recognisable as truncated.
      CREWAID_MAX_LINES: String(options.maxMatches * 2 + 1),
      ...(options.glob !== undefined && options.glob.trim() !== ''
        ? { CREWAID_GLOB: options.glob }
        : {}),
    },
  };
}

function buildGlobCommand(
  plan: Extract<WorkspaceSearchPlan, { readonly ok: true; readonly mode: 'root' | 'machine-home' }>,
  options: { readonly pattern: string; readonly maxResults: number },
): { readonly command: string; readonly env: Record<string, string> } {
  const { prelude, env } = buildRootsPrelude(plan);
  const fullPath = options.pattern.includes('/');
  const effectivePattern = fullPath ? normalizeGlobForFullPath(options.pattern) : options.pattern;
  const fdExcludes = plan.excludes.map((dir) => `--exclude ${shellQuote(dir)}`).join(' ');
  const findPrune = plan.excludes.map((dir) => `-name ${shellQuote(dir)}`).join(' -o ');
  const findMatchFlag = fullPath ? '-path' : '-name';

  // Sorted and capped inside the container, for the same reason fs_grep pipes
  // through `head`: only `max` paths cross the bridge. awk still counts every
  // match, so the answer can say how many it left out.
  const script = [
    prelude,
    'FD_BIN=""',
    'if command -v fd >/dev/null 2>&1; then FD_BIN=fd',
    'elif command -v fdfind >/dev/null 2>&1; then FD_BIN=fdfind',
    'fi',
    'if [ -n "$FD_BIN" ]; then',
    `  "$FD_BIN" --hidden --type f --color never --glob ${fullPath ? '--full-path ' : ''}${fdExcludes} -- "$CREWAID_PATTERN" "$@"`,
    'else',
    `  find "$@" \\( ${findPrune} \\) -prune -o -type f ${findMatchFlag} "$CREWAID_FIND_PATTERN" -print`,
    'fi | LC_ALL=C sort | awk -v max="$CREWAID_MAX_LINES" \'NR <= max { print } END { print "#TOTAL " NR }\'',
  ].join('\n');

  // POSIX `find -path` uses `*` rather than `**` for recursive segments.
  const findPattern = effectivePattern.replaceAll('**/', '*/');

  return {
    command: `timeout --kill-after=5s ${SEARCH_TIMEOUT_S}s sh -c ${shellQuote(script)}`,
    env: {
      ...env,
      CREWAID_PATTERN: effectivePattern,
      CREWAID_FIND_PATTERN: findPattern,
      CREWAID_MAX_LINES: String(options.maxResults * 2 + 1),
    },
  };
}

function extractGrepPath(line: string): string | null {
  const match = line.match(/^([^:\0]+):(\d+):/);
  return match?.[1] ?? null;
}

export function codingTools(): RegisteredTool[] {
  return [
    {
      name: 'fs_edit',
      behavior: CONTAINED_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description:
            'Make a surgical search-and-replace edit in an existing text file on this bot’s computer. ' +
            'Prefer this over fs_write when modifying part of a file. Copy oldText verbatim from ' +
            'fs_read without line-number prefixes; include enough surrounding lines so it matches once ' +
            '(or set replaceAll: true to replace every occurrence).',
          inputSchema: NativeToolInputs.fs_edit,
          execute: async ({
            path,
            oldText,
            newText,
            replaceAll,
          }: {
            path: string;
            oldText: string;
            newText: string;
            replaceAll?: boolean | undefined;
          }) => {
            const verdict = resolveWorkspacePath(
              context.botId,
              path,
              context.groupId ?? null,
              context.workingDirectory,
            );
            if (!verdict.ok) return `fs_edit refused: ${verdict.reason}`;
            try {
              const session = await context.session();
              const raw = await session.readTextFile({ path: verdict.path });
              if (raw === null) {
                return `fs_edit failed: ${verdict.path} does not exist. Use fs_write to create a new file.`;
              }
              if (raw.includes('\u0000')) {
                return `fs_edit refused: ${JSON.stringify(verdict.path)} contains binary data.`;
              }

              // Only a file whose every newline is CRLF is normalized and written
              // back as CRLF. A mostly-LF file with one stray CRLF would otherwise
              // be rewritten wholesale, turning a one-line edit into a whole-file diff.
              const crlfCount = raw.split('\r\n').length - 1;
              const hasCrlf = crlfCount > 0 && crlfCount === raw.split('\n').length - 1;
              const content = hasCrlf ? raw.replaceAll('\r\n', '\n') : raw;
              const needle = oldText.replaceAll('\r\n', '\n');
              const replacement = newText.replaceAll('\r\n', '\n');

              if (needle === replacement) {
                return `fs_edit refused: oldText and newText are identical for ${verdict.path}.`;
              }

              const offsets = findMatchOffsets(content, needle);
              if (offsets.length === 0) {
                if (looksLikeCopiedLineNumbers(content, needle)) {
                  return (
                    `fs_edit failed: oldText was not found in ${verdict.path}. ` +
                    'It looks like oldText includes line-number prefixes (e.g. "12\\t...") copied ' +
                    'from fs_read — omit the line numbers and pass only the file text.'
                  );
                }
                return (
                  `fs_edit failed: oldText was not found in ${verdict.path}. ` +
                  'Read the target lines with fs_read and copy the exact text including indentation.'
                );
              }

              if (offsets.length > 1 && replaceAll !== true) {
                const lines = offsets.map((offset) => lineNumberAt(content, offset));
                const listed =
                  lines.length > 10 ? `${lines.slice(0, 10).join(', ')}, …` : lines.join(', ');
                return (
                  `fs_edit failed: oldText matched ${offsets.length} locations in ${verdict.path} ` +
                  `(lines ${listed}). Include more surrounding lines to make the match unique, ` +
                  'or pass replaceAll: true.'
                );
              }

              const firstOffset = offsets[0] ?? 0;
              const firstStartLine = lineNumberAt(content, firstOffset);
              const removedPerMatch = needle.split('\n').length;
              const addedPerMatch = replacement.split('\n').length;
              const appliedCount = replaceAll === true ? offsets.length : 1;

              // split/join rather than String#replaceAll: a string replacement
              // there expands `$&`, `$'` and `$$`, so code such as `echo $$` would
              // be silently rewritten.
              const updatedNormalized =
                replaceAll === true
                  ? content.split(needle).join(replacement)
                  : content.slice(0, firstOffset) +
                    replacement +
                    content.slice(firstOffset + needle.length);

              const updated = hasCrlf
                ? updatedNormalized.replaceAll('\n', '\r\n')
                : updatedNormalized;
              const bytes = Buffer.byteLength(updated, 'utf8');
              if (bytes > MAX_WRITE_BYTES) {
                return (
                  `fs_edit refused: resulting file (${bytes.toLocaleString('en-US')} bytes) ` +
                  `exceeds the ${MAX_WRITE_BYTES.toLocaleString('en-US')}-byte limit.`
                );
              }

              await session.writeTextFile({ path: verdict.path, content: updated });

              const firstEndLine = firstStartLine + Math.max(0, addedPerMatch - 1);
              const countText =
                appliedCount === 1 ? '1 replacement' : `${appliedCount} replacements`;
              const totalAdded = addedPerMatch * appliedCount;
              const totalRemoved = removedPerMatch * appliedCount;
              const preview = editContextPreview(updatedNormalized, firstStartLine, firstEndLine);

              return (
                `edited ${verdict.path} (${countText}, lines ${firstStartLine}–${firstEndLine}, ` +
                `+${totalAdded}/-${totalRemoved})\n${preview}`
              );
            } catch (error) {
              return failure(`fs_edit ${JSON.stringify(verdict.path)}`, error);
            }
          },
        }),
    },
    {
      name: 'fs_grep',
      behavior: OBSERVING_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description:
            `Search file contents on this bot’s computer (backed by ripgrep). Searches your own area ` +
            `${MACHINE_HOME}/agents/${context.botId} by default, or pass a path inside ${MACHINE_HOME}/shared ` +
            'or your area. Searches hidden config files (like .github/workflows and .env.example) while ' +
            'skipping .git and node_modules.',
          inputSchema: NativeToolInputs.fs_grep,
          execute: async (
            {
              pattern,
              path,
              glob,
              fixedStrings,
              caseSensitive,
              maxMatches,
            }: {
              pattern: string;
              path?: string | undefined;
              glob?: string | undefined;
              fixedStrings?: boolean | undefined;
              caseSensitive?: boolean | undefined;
              maxMatches?: number | undefined;
            },
            { abortSignal }: { abortSignal?: AbortSignal },
          ) => {
            const plan = resolveWorkspaceSearchPlan(
              context.botId,
              path,
              context.groupId ?? null,
              context.workingDirectory,
            );
            if (!plan.ok) return `fs_grep refused: ${plan.reason}`;
            if (plan.mode === 'empty') return 'fs_grep: no matches found.';

            const limit = maxMatches ?? DEFAULT_MAX_MATCHES;
            const built = buildGrepCommand(plan, {
              pattern,
              glob,
              fixedStrings: fixedStrings === true,
              caseSensitive: caseSensitive === true,
              maxMatches: limit,
            });
            try {
              const session = await context.session();
              const result = await session.run({
                command: built.command,
                workingDirectory: MACHINE_HOME,
                env: built.env,
                abortSignal:
                  abortSignal === undefined
                    ? AbortSignal.timeout(SEARCH_WAIT_MS)
                    : AbortSignal.any([abortSignal, AbortSignal.timeout(SEARCH_WAIT_MS)]),
              });
              if (result.exitCode === 124 || result.exitCode === 137) {
                return `fs_grep failed: search timed out after ${SEARCH_TIMEOUT_S}s. Narrow path or glob and retry.`;
              }

              const rawLines = result.stdout
                .split('\n')
                .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
                .filter((line) => line.length > 0);
              if (rawLines.length === 0) {
                // No output: a bad regex or unreadable root says why on stderr;
                // a clean search that found nothing says nothing.
                const reason = result.stderr.trim();
                return reason === ''
                  ? 'fs_grep: no matches found.'
                  : `fs_grep failed: ${reason.slice(0, 500)}`;
              }

              const kept: string[] = [];
              let usedChars = 0;
              let truncatedByMatches = false;
              let truncatedByChars = false;

              for (const line of rawLines) {
                const matchPath = extractGrepPath(line);
                if (
                  matchPath !== null &&
                  !resolveWorkspacePath(context.botId, matchPath, context.groupId ?? null).ok
                ) {
                  continue;
                }
                if (kept.length >= limit) {
                  truncatedByMatches = true;
                  break;
                }
                const sep = kept.length === 0 ? 0 : 1;
                if (usedChars + sep + line.length > MAX_OUTPUT_CHARS) {
                  truncatedByChars = true;
                  break;
                }
                kept.push(line);
                usedChars += sep + line.length;
              }

              if (kept.length === 0) return 'fs_grep: no matches found.';
              const body = kept.join('\n');
              if (truncatedByMatches || truncatedByChars) {
                return (
                  `${body}\n[truncated at ${kept.length} matches — narrow path, add glob, ` +
                  'or raise maxMatches to see more]'
                );
              }
              return body;
            } catch (error) {
              return failure('fs_grep', error);
            }
          },
        }),
    },
    {
      name: 'fs_glob',
      behavior: OBSERVING_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description:
            `Find files by glob pattern on this bot’s computer (backed by fd). Searches your own area ` +
            `${MACHINE_HOME}/agents/${context.botId} by default, or pass a directory inside ` +
            `${MACHINE_HOME}/shared or your area. Includes hidden files (like .github/workflows) while ` +
            'skipping .git and node_modules.',
          inputSchema: NativeToolInputs.fs_glob,
          execute: async (
            {
              pattern,
              path,
              maxResults,
            }: {
              pattern: string;
              path?: string | undefined;
              maxResults?: number | undefined;
            },
            { abortSignal }: { abortSignal?: AbortSignal },
          ) => {
            const plan = resolveWorkspaceSearchPlan(
              context.botId,
              path,
              context.groupId ?? null,
              context.workingDirectory,
            );
            if (!plan.ok) return `fs_glob refused: ${plan.reason}`;
            if (plan.mode === 'empty') return 'fs_glob: no matching files found.';

            const limit = maxResults ?? DEFAULT_MAX_RESULTS;
            const built = buildGlobCommand(plan, { pattern, maxResults: limit });
            try {
              const session = await context.session();
              const result = await session.run({
                command: built.command,
                workingDirectory: MACHINE_HOME,
                env: built.env,
                abortSignal:
                  abortSignal === undefined
                    ? AbortSignal.timeout(SEARCH_WAIT_MS)
                    : AbortSignal.any([abortSignal, AbortSignal.timeout(SEARCH_WAIT_MS)]),
              });
              if (result.exitCode === 124 || result.exitCode === 137) {
                return `fs_glob failed: search timed out after ${SEARCH_TIMEOUT_S}s. Narrow path or pattern and retry.`;
              }

              const lines = result.stdout
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line.length > 0);
              const totalMatch = TOTAL_LINE_RE.exec(lines.at(-1) ?? '');
              if (totalMatch !== null) lines.pop();
              const total = totalMatch === null ? lines.length : Number(totalMatch[1]);

              // Already sorted inside the container; this only drops what the
              // pre-search exclusions should have kept out anyway.
              const allowed = lines.filter(
                (filePath) =>
                  resolveWorkspacePath(context.botId, filePath, context.groupId ?? null).ok,
              );

              if (allowed.length === 0) {
                const reason = result.stderr.trim();
                return total === 0 && reason !== ''
                  ? `fs_glob failed: ${reason.slice(0, 500)}`
                  : 'fs_glob: no matching files found.';
              }
              const matched = Math.max(allowed.length, total - (lines.length - allowed.length));

              const kept: string[] = [];
              let usedChars = 0;
              let truncated = false;
              for (const filePath of allowed) {
                if (kept.length >= limit) {
                  truncated = true;
                  break;
                }
                const sep = kept.length === 0 ? 0 : 1;
                if (usedChars + sep + filePath.length > MAX_OUTPUT_CHARS) {
                  truncated = true;
                  break;
                }
                kept.push(filePath);
                usedChars += sep + filePath.length;
              }

              const body = kept.join('\n');
              if (truncated || kept.length < matched) {
                return (
                  `${body}\n[showing ${kept.length} of ${matched.toLocaleString('en-US')} files — narrow path ` +
                  'or pattern to see more]'
                );
              }
              return body;
            } catch (error) {
              return failure('fs_glob', error);
            }
          },
        }),
    },
  ];
}
