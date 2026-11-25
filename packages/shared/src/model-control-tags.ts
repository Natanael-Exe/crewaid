/**
 * Strips leaked internal model harness control directives — such as
 * `<budget:token_budget>200000</budget:token_budget>` or
 * `<system-reminder>...</system-reminder>` — from assistant text while
 * leaving fenced code blocks, inline code spans, and ordinary prose untouched.
 *
 * Some reasoning/provider endpoints occasionally leak these XML-like control
 * tags into assistant text chunks. Because `<budget:token_budget>` matches the
 * CommonMark URI autolink grammar (`<scheme:path>`), an unstripped tag also
 * triggers markdown link hardening and renders as broken `[blocked]` text.
 */

const PAIRED_OR_STRAY_CONTROL_TAG_RE =
  /<budget:[a-z0-9_-]+(?:\s[^>]*)?>[\s\S]*?<\/budget:[a-z0-9_-]+>|<\/?budget:[a-z0-9_-]+(?:\s[^>]*)?\/?>|<system[-_]reminder(?:\s[^>]*)?>[\s\S]*?<\/system[-_]reminder>|<\/?system[-_]reminder(?:\s[^>]*)?\/?>/gi;

/** Splits text into protected code spans/fences and ordinary prose runs. */
const CODE_SEGMENT_RE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g;

const CONTROL_OPENERS = [
  '<budget:',
  '</budget:',
  '<system-reminder',
  '</system-reminder',
  '<system_reminder',
  '</system_reminder',
] as const;

const COMPLETE_OPEN_TAG_RE = /^<(budget:[a-z0-9_-]+|system[-_]reminder)(?:\s[^>]*)?(\/?)>/i;
const COMPLETE_CLOSE_TAG_RE = /^<\/(budget:[a-z0-9_-]+|system[-_]reminder)\s*>/i;

const MAX_TAG_BUFFER_CHARS = 2048;

function hasPotentialControlTag(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('<budget:') ||
    lower.includes('</budget:') ||
    lower.includes('<system-reminder') ||
    lower.includes('<system_reminder') ||
    lower.includes('</system-reminder') ||
    lower.includes('</system_reminder')
  );
}

/**
 * Removes leaked model control tags from settled prose while keeping fenced
 * code blocks and inline code spans byte-for-byte intact.
 */
export function stripModelControlTags(text: string): string {
  if (!hasPotentialControlTag(text)) return text;

  let removedAny = false;
  const cleaned = text
    .split(CODE_SEGMENT_RE)
    .map((segment, index) => {
      // Odd capture groups are fenced or inline code — never rewrite code.
      if (index % 2 === 1) return segment;
      const next = segment.replace(PAIRED_OR_STRAY_CONTROL_TAG_RE, () => {
        removedAny = true;
        return '';
      });
      return next;
    })
    .join('');

  if (!removedAny) return text;
  // Removing a whole control-tag line can leave leading/trailing blank lines or
  // triple newlines where the tag sat; collapse only that excess whitespace.
  return cleaned
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[ \t]*\n+/, '')
    .replace(/\n+[ \t]*$/, '')
    .trim();
}

export interface StreamTextFilter {
  push(delta: string): string;
  flush(): string;
}

function isOpenerPrefix(fragment: string): boolean {
  const lower = fragment.toLowerCase();
  return CONTROL_OPENERS.some(
    (opener) => opener.startsWith(lower) || lower.startsWith(opener),
  );
}

/**
 * Stateful streaming filter that suppresses leaked `<budget:...>` and
 * `<system-reminder>` blocks across arbitrary chunk boundaries with zero
 * buffering delay on ordinary prose and without touching fenced code blocks.
 */
export function createModelControlTagFilter(): StreamTextFilter {
  let buffer = '';
  let activeTagName: string | null = null;
  let inCodeFence = false;
  let fenceRemainder = '';

  const updateFenceState = (emitted: string): void => {
    const combined = fenceRemainder + emitted;
    let index = 0;
    while (index < combined.length) {
      const triple = combined.indexOf('```', index);
      if (triple === -1) break;
      inCodeFence = !inCodeFence;
      index = triple + 3;
    }
    // Keep up to 2 trailing backticks in case ``` spans a chunk boundary.
    const tailMatch = /`{1,2}$/.exec(combined);
    fenceRemainder = tailMatch === null ? '' : tailMatch[0];
  };

  const drain = (final: boolean): string => {
    let out = '';

    while (buffer.length > 0) {
      if (inCodeFence) {
        const closeAt = buffer.indexOf('```');
        if (closeAt === -1) {
          if (final) {
            out += buffer;
            updateFenceState(buffer);
            buffer = '';
          } else {
            const safeEnd = buffer.endsWith('``')
              ? buffer.length - 2
              : buffer.endsWith('`')
                ? buffer.length - 1
                : buffer.length;
            if (safeEnd === 0) break;
            const chunk = buffer.slice(0, safeEnd);
            out += chunk;
            updateFenceState(chunk);
            buffer = buffer.slice(safeEnd);
          }
          break;
        }
        const chunk = buffer.slice(0, closeAt + 3);
        out += chunk;
        updateFenceState(chunk);
        buffer = buffer.slice(closeAt + 3);
        continue;
      }

      if (activeTagName !== null) {
        const closeToken = `</${activeTagName}>`;
        const closeIdx = buffer.toLowerCase().indexOf(closeToken.toLowerCase());
        if (closeIdx !== -1) {
          // Drop the entire directive block plus a single trailing newline if it stood alone.
          let end = closeIdx + closeToken.length;
          if (buffer[end] === '\r' && buffer[end + 1] === '\n') end += 2;
          else if (buffer[end] === '\n') end += 1;
          buffer = buffer.slice(end);
          activeTagName = null;
          continue;
        }
        if (final) {
          // Drop truncated budget payload (e.g. `<budget:token_budget>200000` cut off at EOF).
          if (/^[\s0-9._-]*$/.test(buffer)) {
            buffer = '';
            activeTagName = null;
            break;
          }
          out += buffer;
          updateFenceState(buffer);
          buffer = '';
          activeTagName = null;
          break;
        }
        if (buffer.length > MAX_TAG_BUFFER_CHARS) {
          // Safety bound: avoid unbounded buffering on malformed unclosed tags.
          out += buffer;
          updateFenceState(buffer);
          buffer = '';
          activeTagName = null;
          continue;
        }
        break;
      }

      const lt = buffer.indexOf('<');
      if (lt === -1) {
        const safeEnd = !final && buffer.endsWith('``')
          ? buffer.length - 2
          : !final && buffer.endsWith('`')
            ? buffer.length - 1
            : buffer.length;
        if (safeEnd === 0) break;
        const chunk = buffer.slice(0, safeEnd);
        out += chunk;
        updateFenceState(chunk);
        buffer = buffer.slice(safeEnd);
        break;
      }

      if (lt > 0) {
        const before = buffer.slice(0, lt);
        // Check whether a code fence opens before `<`.
        const fenceAt = before.indexOf('```');
        if (fenceAt !== -1) {
          const chunk = buffer.slice(0, fenceAt + 3);
          out += chunk;
          updateFenceState(chunk);
          buffer = buffer.slice(fenceAt + 3);
          continue;
        }
        out += before;
        updateFenceState(before);
        buffer = buffer.slice(lt);
      }

      // Now buffer starts with '<'.
      const openMatch = COMPLETE_OPEN_TAG_RE.exec(buffer);
      if (openMatch !== null) {
        const tagName = openMatch[1] ?? '';
        const selfClosing = openMatch[2] === '/';
        buffer = buffer.slice(openMatch[0].length);
        if (!selfClosing) {
          activeTagName = tagName;
        }
        continue;
      }

      const closeMatch = COMPLETE_CLOSE_TAG_RE.exec(buffer);
      if (closeMatch !== null) {
        buffer = buffer.slice(closeMatch[0].length);
        continue;
      }

      // Could this still become a control tag opener as more characters arrive?
      const gt = buffer.indexOf('>');
      if (gt === -1 && !final && buffer.length < 64 && isOpenerPrefix(buffer)) {
        break;
      }

      // Not a control tag — emit '<' and continue scanning the remainder.
      out += '<';
      updateFenceState('<');
      buffer = buffer.slice(1);
    }

    return out;
  };

  return {
    push(delta: string): string {
      if (delta === '') return '';
      if (
        buffer === '' &&
        activeTagName === null &&
        !inCodeFence &&
        !delta.includes('<') &&
        !delta.includes('`')
      ) {
        return delta;
      }
      buffer += delta;
      return drain(false);
    },
    flush(): string {
      return drain(true);
    },
  };
}
