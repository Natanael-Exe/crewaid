import { mentionSegments, type MentionBot } from '../composer/botMention';

/** The parts of an mdast node this plugin reads; the tree is otherwise untouched. */
type MdNode = { type: string; value?: string; children?: MdNode[]; data?: unknown };

/**
 * A remark plugin that turns roster names in prose into `mention` elements.
 * Only `text` nodes are read, so inline code and fences keep a name literal,
 * and text inside a link stays link text: a button inside an anchor would make
 * both targets unreliable. The element carries the bot id and nothing else;
 * `StreamingMarkdown` renders it.
 */
export function remarkBotMentions(bots: readonly MentionBot[]) {
  const walk = (node: MdNode): void => {
    const children = node.children;
    if (children === undefined || node.type === 'link') return;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (child === undefined) continue;
      if (child.type !== 'text' || child.value === undefined) {
        walk(child);
        continue;
      }
      const segments = mentionSegments(child.value, bots);
      if (segments.every((segment) => segment.kind === 'text')) continue;
      const replacement: MdNode[] = segments.map((segment) =>
        segment.kind === 'text'
          ? { type: 'text', value: segment.value }
          : {
              type: 'botMention',
              data: { hName: 'mention', hProperties: { botid: segment.bot.id } },
              children: [{ type: 'text', value: segment.value }],
            },
      );
      children.splice(index, 1, ...replacement);
      index += replacement.length - 1;
    }
  };
  return () => (tree: MdNode) => walk(tree);
}
