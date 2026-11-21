/**
 * A bot's reply, rewritten to be heard rather than read. Shared, because the server
 * speaks a reply to a voice message and the desktop hands one to a call.
 *
 * A reply is written for a screen: fenced code, file paths, tables, link
 * markup. Read verbatim, a diff is minutes of punctuation and
 * `apps/orchestrator/src/main.ts` is "apps slash orchestrator slash…". The
 * rule is to say the prose, name the artifacts and drop the syntax; the
 * person has the written reply on screen for anything they want exactly.
 *
 * Narrow ordered replacements rather than a markdown parser, and pure, so it
 * can be tuned against real replies without touching anything that speaks.
 */

const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  typescript: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  javascript: 'JavaScript',
  py: 'Python',
  python: 'Python',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  shell: 'shell',
  json: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  sql: 'SQL',
  html: 'HTML',
  css: 'CSS',
  go: 'Go',
  rust: 'Rust',
  rs: 'Rust',
  diff: 'diff',
};

/** A clip much longer than this is a lecture; the rest stays on screen. */
export const SPOKEN_REPLY_MAX_CHARS = 2500;
export const SPOKEN_REMAINDER = 'The rest is in the chat.';

function codeBlock(info: string): string {
  const language = LANGUAGE_NAMES[info.trim().split(/\s+/)[0]?.toLowerCase() ?? ''];
  return language === undefined ? ' (a code block) ' : ` (a ${language} code block) `;
}

/** `a/b/c/file.ts` → `file.ts`: a path's directories are for the eye. */
function shortenPaths(text: string): string {
  return text.replace(/(?:[\w.@~-]+\/)+([\w.-]+\.[A-Za-z0-9]{1,8})\b/g, '$1');
}

/** One line of markdown, without its block syntax, ending as a sentence. */
function speakLine(line: string): string {
  const stripped = line
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*>\s?/, '')
    .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?/, '')
    .trim();
  if (stripped === '') return '';
  return /[.!?:;,]$/.test(stripped) ? stripped : `${stripped}.`;
}

export function speakable(markdown: string): string {
  let text = markdown.replace(/\r\n?/g, '\n');

  // Fenced code first, so nothing inside it is read as prose.
  text = text.replace(/```([^\n]*)\n[\s\S]*?(?:```|$)/g, (_match, info: string) => codeBlock(info));

  // A table is announced once, however many rows it has.
  text = text.replace(/(?:^[ \t]*\|.*\|[ \t]*(?:\n|$))+/gm, ' (a table) \n');

  text = text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) => (alt.trim() === '' ? 'an image' : alt))
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<?https?:\/\/[^\s>)]+>?/g, 'a link')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?:;]|$)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '');

  text = shortenPaths(text);

  const spoken = text
    .split('\n')
    .map(speakLine)
    .filter((line) => line !== '')
    .join(' ')
    .replace(/\s+([.,!?:;])/g, '$1')
    .replace(/\.{2,}/g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return capped(spoken);
}

/** Cut at the last sentence that fits, and say where the rest is. */
function capped(text: string): string {
  if (text.length <= SPOKEN_REPLY_MAX_CHARS) return text;
  const room = SPOKEN_REPLY_MAX_CHARS - SPOKEN_REMAINDER.length - 1;
  const head = text.slice(0, room);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  const kept = end > room / 2 ? head.slice(0, end + 1) : `${head.slice(0, head.lastIndexOf(' '))}…`;
  return `${kept} ${SPOKEN_REMAINDER}`;
}
