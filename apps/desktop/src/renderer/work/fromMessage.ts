/** The longest title a draft proposes; the user can edit it before saving. */
const DRAFT_TITLE_MAX = 80;
/** A task brief's own ceiling (the shared schema's long-text bound). */
const BRIEF_MAX = 20_000;

/**
 * A title for work made from a transcript message: its first line with
 * markdown markers taken off, cut at a word near 80 characters. A message
 * that is all markup or blank proposes nothing and the dialog asks for one.
 */
export function titleFromMessage(content: string): string {
  const line =
    content
      .split('\n')
      .map((row) =>
        row
          .replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, '')
          .replace(/[*_`~]/g, '')
          .trim(),
      )
      .find((row) => row !== '') ?? '';
  if (line.length <= DRAFT_TITLE_MAX) return line;
  const cut = line.slice(0, DRAFT_TITLE_MAX);
  const space = cut.lastIndexOf(' ');
  return `${(space > DRAFT_TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * A new task drafted from a message (PRD-WORK §7.4, D-141): the message
 * quoted as the brief, so the words travel with the task and a Start sends
 * them to whoever does it. Nothing links the task back to the message.
 */
export function taskDraftFromMessage(content: string): { title: string; brief: string } {
  const brief = content
    .trim()
    .split('\n')
    .map((row) => (row === '' ? '>' : `> ${row}`))
    .join('\n')
    .slice(0, BRIEF_MAX);
  return { title: titleFromMessage(content), brief };
}
