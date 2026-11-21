import { SlugSchema } from '@crewaid/shared';

/**
 * where a private server's slug comes from.
 *
 * REST private install carries `{name, url, transport}`; `McpServer.slug` is
 * NOT NULL because MCP plugins namespaces every MCP tool `<slug>__<toolName>`. So
 * the slug is derived here, from the one thing the operator actually typed.
 *
 * Why a refusal and not a fallback
 *
 * The slug is user-visible: it is the first half of every tool name the model
 * is offered, and it is what the operator reads in a transcript. Deriving it
 * from the URL when the name yields nothing (`"!!!"` → `example-com`) would
 * make the namespace depend on a part of the form the operator did not intend
 * to name anything with, and two servers at one host would then be told apart
 * by a suffix nobody chose. Suffixing a collision (`gmail-2`) has the same
 * defect in the other direction: the second install silently gets a different
 * namespace than the first, for the same words, and which one it is depends on
 * install order. Both are the kind of thing that is discovered months later in
 * a transcript. A `null` here becomes a 400 naming the name that has no slug
 * in it, and the operator picks a name that does.
 *
 * Diacritics are folded rather than dropped, so `Café` is `cafe` and not
 * `caf`; anything else that is not `[a-z0-9]` becomes a separator, which is
 * also what makes `My Server!` and `My Server` the same slug — and therefore
 * a collision the caller reports instead of two rows one keystroke apart.
 */
export function deriveMcpSlug(name: string): string | null {
  const derived = name
    .normalize('NFKD')
    // Combining marks, e.g. the accent NFKD just split off `é`.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const parsed = SlugSchema.safeParse(derived);
  return parsed.success ? parsed.data : null;
}
