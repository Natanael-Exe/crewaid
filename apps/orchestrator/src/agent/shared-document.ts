import type { ToolContext } from './tool-registry.js';

/**
 * M5-BE-20/21 — one plain-text file on the machine that several bots edit.
 *
 * The board and the memory are the same problem twice, and the problem is not
 * storage: `fs_read`/`fs_write` already store. It is that `fs_write` replaces
 * the WHOLE file, so a bot changing one line has to re-emit every other line
 * — from a context window that may have been trimmed since it read them
 * (M5-BE-02), beside a sibling writing the same file in the same moment.
 * D-046 made that ordinary rather than exotic.
 *
 * So the three operations here are the ones that cannot lose a write nobody
 * saw: read the whole thing, APPEND (which never re-emits), and replace ONE
 * EXACT piece (which refuses when the text has moved). What each of them says
 * to the model stays with the tool, because the board and the memory are
 * different things to a reader and "Added to the board" and "Remembered" are
 * not interchangeable sentences. What is shared is the part where getting it
 * wrong loses somebody's work.
 *
 * Nothing here parses the document. No entry format, no ordering, no status
 * column: the operator decides what a line means, and both files stay
 * readable and editable by hand.
 */

/** A bounded plain-text document several bots share on one machine. */
export interface SharedDocument {
  /** Absolute path inside the sandbox. */
  readonly path: string;
  /**
   * The most this document may be, in characters.
   *
   * Not `fs_read`'s ceiling, which bounds one tool RESULT. This bounds the
   * FILE, because several bots append to it and nothing prunes it — and it is
   * read at the start of work, when a turn can least afford a context window
   * spent on it.
   */
  readonly maxChars: number;
}

/** What happened, in terms the calling tool can phrase for its own document. */
export type DocumentOutcome =
  | { readonly kind: 'read'; readonly text: string }
  /** The file does not exist yet. Not an error: it is a new machine. */
  | { readonly kind: 'absent' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'written' }
  | { readonly kind: 'too-large'; readonly would: number; readonly limit: number }
  /** The text to replace is not there — usually because a sibling moved it. */
  | { readonly kind: 'not-found' }
  /** The text to replace appears more than once; replacing one would guess. */
  | { readonly kind: 'ambiguous' }
  | { readonly kind: 'failed'; readonly detail: string };

function failed(error: unknown): DocumentOutcome {
  return { kind: 'failed', detail: error instanceof Error ? error.message : String(error) };
}

export async function readDocument(
  context: ToolContext,
  document: SharedDocument,
): Promise<DocumentOutcome> {
  try {
    const session = await context.session();
    const text = await session.readTextFile({ path: document.path });
    if (text === null) return { kind: 'absent' };
    return text === '' ? { kind: 'empty' } : { kind: 'read', text };
  } catch (error) {
    return failed(error);
  }
}

/**
 * Add a line at the end, starting the file if this is the first one.
 *
 * Appending is the whole point: this never re-emits a line it did not write,
 * so it cannot revert an edit it never saw. The newline handling is not
 * cosmetic either — a file somebody left without a trailing newline and one
 * left with three both join to exactly one, so appending repeatedly cannot
 * drift into a document made mostly of blank lines.
 *
 * The parent directory is created by `writeTextFile`. `/home/bot/shared` is
 * NOT in the image's skel — a fresh container's home holds dotfiles and
 * nothing else — so this is load-bearing, and it was measured against a real
 * container rather than assumed: the unit fakes cannot tell the difference,
 * which is the shape `browser-tools-chrome` exists for.
 */
export async function appendToDocument(
  context: ToolContext,
  document: SharedDocument,
  entry: string,
): Promise<DocumentOutcome> {
  try {
    const session = await context.session();
    const before = (await session.readTextFile({ path: document.path })) ?? '';
    const next = before === '' ? `${entry}\n` : `${before.replace(/\n*$/, '\n')}${entry}\n`;
    if (next.length > document.maxChars) {
      return { kind: 'too-large', would: next.length, limit: document.maxChars };
    }
    await session.writeTextFile({ path: document.path, content: next });
    return { kind: 'written' };
  } catch (error) {
    return failed(error);
  }
}

/**
 * Replace one exact, unique piece of text. An empty `replace` removes it.
 *
 * The two refusals are the reason this exists rather than an `fs_write`.
 *
 * NOT FOUND is what a lost update looks like from inside: this bot read the
 * file, a sibling changed that line, and the text is no longer there. Writing
 * anyway is what would revert them.
 *
 * AMBIGUOUS is the sharper one. Replacing "the first match" on a document
 * whose lines repeat is how a bot ticks off somebody else's task or forgets
 * the wrong fact — and the model's own next move, given the refusal, is to
 * pass more of the surrounding line.
 */
export async function replaceInDocument(
  context: ToolContext,
  document: SharedDocument,
  find: string,
  replace: string,
): Promise<DocumentOutcome> {
  try {
    const session = await context.session();
    const before = await session.readTextFile({ path: document.path });
    if (before === null) return { kind: 'absent' };

    const first = before.indexOf(find);
    if (first === -1) return { kind: 'not-found' };
    if (before.indexOf(find, first + find.length) !== -1) return { kind: 'ambiguous' };

    const next = `${before.slice(0, first)}${replace}${before.slice(first + find.length)}`;
    if (next.length > document.maxChars) {
      return { kind: 'too-large', would: next.length, limit: document.maxChars };
    }
    await session.writeTextFile({ path: document.path, content: next });
    return { kind: 'written' };
  } catch (error) {
    return failed(error);
  }
}

/** `32,000` — the shape every bound in these tools is reported in. */
export function counted(value: number): string {
  return value.toLocaleString('en-US');
}
