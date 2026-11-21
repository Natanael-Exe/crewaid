import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Full-text search over what was said, now that what was said is stored
 * sealed.
 *
 * Postgres cannot index or match ciphertext, so the index this replaced
 * (`Message_content_fts_idx`) is gone. The matching itself did not have to
 * change: the scope's most recent messages are read through the client, which
 * opens them, and handed back to Postgres as parameters to rank. The stemming,
 * the `websearch` query syntax, the ranking and the `<<…>>` excerpts are the
 * ones every other search in the app uses, and nothing readable is written
 * anywhere: the text is a parameter of one statement.
 *
 * What it costs is the window. A search reads and opens up to
 * `TRANSCRIPT_SEARCH_WINDOW` messages, so one older than that is not found,
 * where the index found any. Memory is what a bot is meant to keep for longer
 * than its recent conversation.
 */

/** How many of a scope's most recent spoken messages a search reads. */
export const TRANSCRIPT_SEARCH_WINDOW = 2000;

/** The excerpt: at most two fragments, matches wrapped in `<<` and `>>`. */
export const TRANSCRIPT_HEADLINE = 'MaxFragments=2,MaxWords=30,MinWords=8,StartSel=<<,StopSel=>>';

export interface TranscriptSearchHit {
  readonly id: string;
  readonly botId: string;
  readonly author: 'USER' | 'BOT';
  readonly createdAt: Date;
  /** `ts_headline` output: the matching fragments, not the whole message. */
  readonly excerpt: string;
  readonly rank: number;
}

/**
 * The best `limit` matches in the user's transcripts, or in one bot's.
 *
 * USER and BOT rows only, and never empty ones: a SYSTEM row is an
 * operator-facing note and a TOOL row said nothing. Ownership is the first
 * query's `where`, so a foreign message is never read, let alone ranked.
 */
export async function searchTranscripts(
  prisma: PrismaService,
  scope: { readonly userId: string; readonly botId?: string | undefined },
  query: string,
  limit: number,
): Promise<TranscriptSearchHit[]> {
  const recent = await prisma.message.findMany({
    where: {
      conversation: {
        bot: { userId: scope.userId, ...(scope.botId === undefined ? {} : { id: scope.botId }) },
      },
      author: { in: ['USER', 'BOT'] },
      content: { not: '' },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: TRANSCRIPT_SEARCH_WINDOW,
    select: {
      id: true,
      author: true,
      createdAt: true,
      content: true,
      conversation: { select: { botId: true } },
    },
  });
  if (recent.length === 0) return [];

  // Newest first, so a position is also the tie-break the index's query used.
  // Postgres refuses U+0000 in text, and sealed text can hold one.
  const ranked = await prisma.$queryRaw<{ position: bigint; excerpt: string; rank: number }[]>`
    SELECT t.position,
           ts_headline('english', t.content, q.query, ${TRANSCRIPT_HEADLINE}) AS excerpt,
           ts_rank_cd(to_tsvector('english', t.content), q.query) AS rank
    FROM unnest(${recent.map((message) => message.content.replaceAll('\u0000', ''))}::text[])
           WITH ORDINALITY AS t(content, position),
         websearch_to_tsquery('english', ${query}) AS q(query)
    WHERE to_tsvector('english', t.content) @@ q.query
    ORDER BY rank DESC, t.position ASC
    LIMIT ${limit}
  `;

  return ranked.flatMap((hit) => {
    const message = recent[Number(hit.position) - 1];
    if (message === undefined || (message.author !== 'USER' && message.author !== 'BOT')) return [];
    return [
      {
        id: message.id,
        botId: message.conversation.botId,
        author: message.author,
        createdAt: message.createdAt,
        excerpt: hit.excerpt,
        rank: hit.rank,
      },
    ];
  });
}
