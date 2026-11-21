/** The parts of an mdast node this plugin reads; the tree is otherwise untouched. */
type MdNode = { type: string; value?: string; children?: MdNode[] };

/**
 * A remark plugin that makes every newline in prose a line break.
 *
 * In Markdown a single newline joins two lines into one paragraph line, which
 * is right for a document and wrong for a chat: a message typed on nine lines
 * reads on nine lines. Only `text` nodes are split, so code keeps its own
 * newlines.
 */
export function remarkSoftBreaks() {
  const walk = (node: MdNode): void => {
    const children = node.children;
    if (children === undefined) return;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (child === undefined) continue;
      if (child.type !== 'text' || child.value?.includes('\n') !== true) {
        walk(child);
        continue;
      }
      const replacement: MdNode[] = [];
      child.value.split('\n').forEach((line, position) => {
        if (position > 0) replacement.push({ type: 'break' });
        if (line !== '') replacement.push({ type: 'text', value: line });
      });
      children.splice(index, 1, ...replacement);
      index += replacement.length - 1;
    }
  };
  return () => (tree: MdNode) => walk(tree);
}
