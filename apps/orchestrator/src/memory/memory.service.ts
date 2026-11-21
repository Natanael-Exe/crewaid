import { createHash } from 'node:crypto';

import { Injectable, NotFoundException } from '@nestjs/common';
import type { MemoryKind, MemoryStatus, Prisma } from '@prisma/client';
import type { MemoryQuery, MemoryRow } from '@crewaid/shared';

import { PrismaService } from '../prisma/prisma.service.js';
import { searchTranscripts } from '../messages/transcript-search.js';
import type { SelectableMemory } from './memory-select.js';

/**
 * the thin Prisma layer under the memory.
 *
 * Every decision about WHICH memories matter lives in `memory-select.ts`,
 * which is pure and has no database behind it. This file only fetches, and
 * the split is what lets the eval corpus grade the ranking without a
 * Postgres anywhere near it.
 *
 * every query here is scoped by `userId` in the WHERE clause. Never a
 * post-filter — a post-filter hides a missing scope instead of failing on it,
 * and for `$queryRaw`, where there is no `where` for the allowlist test to
 * inspect, the scope is an interpolated PARAMETER and never string
 * concatenation.
 */

/**
 * The most a single remembered fact may be.
 *
 * A claim that does not fit in 300 characters is a paragraph, and a paragraph
 * is the shape memory rots into: unsearchable, un-correctable, and too long to
 * inject. The refusal tells the model to split it rather than truncating,
 * because half a fact asserts something nobody said.
 */
export const MEMORY_FACT_MAX_CHARS = 300;

/**
 * The most the whole memory may be, carried over unchanged — the
 * storage moved, the reason did not: "a memory that fills a context window has
 * stopped paying for itself."
 */
export const MEMORY_TOTAL_MAX_CHARS = 16_000;

/**
 * how long working state stays true.
 *
 * TASK_STATE is the one kind with a hard rule rather than a tunable. Working
 * state that ages into a permanent preference is how a memory system starts
 * telling a bot that a migration it finished last month still needs
 * validating — and unlike a stale FACT, nobody ever thinks to `forget` it,
 * because it was true when it was written.
 *
 * Seven days: long enough to survive a weekend and a week of other work,
 * short enough that a stale one is embarrassing rather than damaging. It is a
 * CEILING, not a lifetime — the usual way a TASK_STATE ends is being replaced
 * by the next one.
 */
export const TASK_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * What two statements of "the same fact" have in common.
 *
 * Case and surrounding whitespace never distinguish two claims, and neither
 * does a trailing full stop — a model that writes "Deploys run from the repo
 * root" today and "deploys run from the repo root." tomorrow has not learned
 * anything new. Deliberately NOT stemming or reordering words: a normaliser
 * clever enough to call two different sentences equal will eventually swallow
 * a correction, which is the expensive direction to be wrong in.
 */
export function normalizeClaim(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '');
}

/** The tombstone key. Hashed so an erased claim's text is not itself stored forever. */
export function claimHashOf(text: string): string {
  return createHash('sha256').update(normalizeClaim(text)).digest('hex');
}

/**
 * Postgres's unique-violation code, as Prisma reports it.
 *
 * Narrowed structurally rather than by importing Prisma's error class: the
 * class is a runtime value from the generated client, and the one property
 * that matters here is the code.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/** One excerpt from a past conversation, with the matched words marked. */
export interface TranscriptHit {
  readonly id: string;
  readonly author: 'USER' | 'BOT';
  readonly createdAt: Date;
  /** ts_headline output: the matching fragments, not the whole message. */
  readonly excerpt: string;
  readonly rank: number;
}

/** What a search returned, with the rank Postgres assigned it. */
export interface MemorySearchHit extends SelectableMemory {
  readonly rank: number;
  /**
   * Where an OBSERVED claim came from. Carried out of the query because the
   * tool has to ATTRIBUTE such a claim rather than present it as established
   * — an unattributed line read off a web page is indistinguishable
   * from something the user said.
   */
  readonly sourceRef: string | null;
}

/**
 * How many rows the turn-start read will look at before the selector bounds
 * them by characters. Generous, because the selector's budget is the real
 * bound and this only stops a pathological corpus from being loaded whole.
 */
export const INJECTION_CANDIDATE_LIMIT = 200;

@Injectable()
export class MemoryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The turn-start read: this user's global memory plus this bot's own.
   *
   * One filter rather than two queries, which is the reason scope is two
   * nullable columns instead of an enum. Ordering is left to
   * `selectForInjection` — SQL cannot express "authority beats confirmations"
   * without encoding table in a CASE expression that would then drift
   * from the version the corpus tests.
   */
  async candidatesForInjection(userId: string, botId: string): Promise<SelectableMemory[]> {
    return this.prisma.memory.findMany({
      where: {
        userId,
        OR: [{ botId: null }, { botId }],
        status: 'ACTIVE',
      },
      orderBy: [{ confirmations: 'desc' }, { updatedAt: 'desc' }],
      take: INJECTION_CANDIDATE_LIMIT,
      select: {
        id: true,
        botId: true,
        authorBotId: true,
        kind: true,
        source: true,
        status: true,
        text: true,
        confirmations: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
      },
    });
  }

  /**
   * Full-text search over this user's memory, scoped to what the bot may see.
   *
   * THE EXPRESSION MUST MATCH THE INDEX. `Memory_text_fts_idx` is built on
   * `to_tsvector('english', "text")`, and Postgres uses an expression index
   * only when the query repeats the exact expression. Measured at 4,001 rows:
   * the matching spelling takes a bitmap index scan, whereas `'simple'` falls
   * back to a sequential scan even with enable_seqscan off.
   * mis-spelled query here is correct, silent, and linear in the number of
   * memories.
   *
   * `websearch_to_tsquery` rather than `to_tsquery`: it never throws on
   * operator-shaped input, and this text comes from a model or a user. A
   * search for "a && b" should return nothing useful, not raise.
   *
   * Unlike the injection read this includes CANDIDATE rows: an unpromoted
   * inference is searchable precisely so it can be found and confirmed, it is
   * only barred from being stated as fact.
   */
  async search(
    userId: string,
    botId: string,
    query: string,
    limit = 8,
  ): Promise<MemorySearchHit[]> {
    const trimmed = query.trim();
    if (trimmed === '') return [];
    // Bound as a PARAMETER, not spliced in. Postgres takes a parameter for
    // LIMIT, so there is no reason to reach for Prisma.raw here — and every
    // reason not to, in a file where the R7 audit turns on nothing reaching
    // this SQL except through a placeholder.
    const bounded = Math.max(1, Math.min(50, Math.trunc(limit)));

    const strict = await this.prisma.$queryRaw<MemorySearchHit[]>`
      SELECT id, "botId", "authorBotId", kind, source, status, text, confirmations, "sourceRef",
             "createdAt", "lastUsedAt", "expiresAt",
             ts_rank_cd(to_tsvector('english', "text"),
                        websearch_to_tsquery('english', ${trimmed})) AS rank
      FROM "Memory"
      WHERE "userId" = ${userId}
        AND ("botId" IS NULL OR "botId" = ${botId})
        AND status IN ('ACTIVE', 'CANDIDATE')
        AND to_tsvector('english', "text") @@ websearch_to_tsquery('english', ${trimmed})
      ORDER BY rank DESC, confirmations DESC, "updatedAt" DESC
      LIMIT ${bounded}
    `;
    if (strict.length > 0) return strict;

    // The ANY fallback, and why it is a fallback
    //
    // `websearch_to_tsquery` ANDs its terms. CC-37 measured what that costs:
    // "staging host" against a row reading "Staging lives at
    // crewaid-staging.example.com" returned NOTHING, because one absent word is
    // not a weaker match — it is no match. Two of five answerable queries
    // missed entirely, and both misses were at the QUERY, not the ranking.
    // Tuning the order would not have moved either of them.
    //
    // So: keep AND as the first pass, because when every word is present the
    // result is precise and should not be diluted. Only when it returns
    // nothing, try again requiring ANY term, ranked by ts_rank_cd — which
    // scores a row matching two terms above one matching one, so the ordering
    // does the discriminating that the filter just stopped doing.
    //
    // A fallback rather than a replacement: running ANY first would return
    // something for almost every query, and a memory search that always
    // answers is one a model cannot trust to mean anything.
    // RANKED BY THE SAME OR QUERY IT FILTERS BY. The first version filtered
    // with ANY and ranked with `plainto_tsquery`, which ANDs — so the ranking
    // never saw which row matched MORE terms, and a row sharing one incidental
    // word could outrank the row sharing two. Caught by
    // `precision-under-fallback`, which returned the irrelevant row first;
    // found by checking the claim in that case's own rationale rather than its
    // aggregate score, which had already improved.
    return this.prisma.$queryRaw<MemorySearchHit[]>`
      WITH any_terms AS (
        SELECT string_agg(lexeme, ' | ')::tsquery AS q
        FROM unnest(to_tsvector('english', ${trimmed})) AS t(lexeme)
      )
      SELECT m.id, m."botId", m."authorBotId", m.kind, m.source, m.status, m.text, m.confirmations,
             m."sourceRef", m."createdAt", m."lastUsedAt", m."expiresAt",
             ts_rank_cd(to_tsvector('english', m."text"), any_terms.q) AS rank
      FROM "Memory" m, any_terms
      WHERE m."userId" = ${userId}
        AND (m."botId" IS NULL OR m."botId" = ${botId})
        AND m.status IN ('ACTIVE', 'CANDIDATE')
        AND to_tsvector('english', m."text") @@ any_terms.q
      ORDER BY rank DESC, m.confirmations DESC, m."updatedAt" DESC
      LIMIT ${bounded}
    `;
  }

  /**
   * Search THIS BOT's own past conversation.
   *
   * Deliberately not cross-bot. R7 makes it legal (same user), but a bot
   * reading a sibling's private conversation is a materially larger step than
   * reading a shared memory, and it should be decided on its own evidence
   * rather than arrive as a side effect of a search tool.
   *
   * Excerpts rather than whole messages, via `ts_headline` — a transcript
   * search that returns five full messages has spent the context budget the
   * answer needed. USER and BOT only, and never empty, for the reasons:
   * a SYSTEM row is an operator-facing note and rendering one as speech would
   * have the bot quoting a wall it did not hit.
   *
   * Message text is sealed at rest, so there is no index to match:
   * `searchTranscripts` reads this bot's recent messages opened and has
   * Postgres rank them, with the same query syntax and excerpts as before.
   */
  async searchTranscript(
    userId: string,
    botId: string,
    query: string,
    limit = 5,
  ): Promise<TranscriptHit[]> {
    const trimmed = query.trim();
    if (trimmed === '') return [];
    const bounded = Math.max(1, Math.min(20, Math.trunc(limit)));

    const hits = await searchTranscripts(this.prisma, { userId, botId }, trimmed, bounded);
    return hits.map(({ id, author, createdAt, excerpt, rank }) => ({
      id,
      author,
      createdAt,
      excerpt,
      rank,
    }));
  }

  /**
   * Whether this exact claim has been erased in this scope.
   *
   * Checked before any write the model did not explicitly ask for, so the
   * extraction sweep cannot re-derive a fact the user removed from the very
   * transcript that established it. The user-global row is checked too: a
   * claim erased globally stays erased for a bot that re-encounters it.
   */
  async isTombstoned(userId: string, botId: string | null, claimHash: string): Promise<boolean> {
    const found = await this.prisma.memoryTombstone.findFirst({
      where: { userId, claimHash, OR: [{ botId: null }, { botId }] },
      select: { id: true },
    });
    return found !== null;
  }

  /**
   * What this user's bots know, for an operator to read.
   *
   * Not `liveFor`: this one carries provenance and can include the rows the
   * bot is no longer shown. "What does it believe now" and "since when, and
   * what did it replace" are both questions an operator asks, and only the
   * first is what a turn needs.
   *
   * Ordered newest-first because an operator opening this is usually asking
   * what just changed, not what has been true longest.
   */
  async listFor(userId: string, query: MemoryQuery): Promise<MemoryRow[]> {
    if (query.botId !== undefined) {
      // 404 for both absent and foreign, like every other owned lookup here
      // (bots.service.ts). Without it a typo'd or foreign botId answers 200
      // with the caller's GLOBAL memory — not a leak, but an answer that says
      // "this bot knows these things" about a bot that does not exist, which
      // is the wrong kind of wrong to hand an operator who came here to find
      // out what a bot believes.
      const owned = await this.prisma.bot.findFirst({
        where: { id: query.botId, userId },
        select: { id: true },
      });
      if (owned === null) throw new NotFoundException('bot not found');
    }

    const rows = await this.prisma.memory.findMany({
      where: {
        userId,
        ...(query.botId === undefined ? {} : { OR: [{ botId: null }, { botId: query.botId }] }),
        ...(query.includeInactive ? {} : { status: { in: ['ACTIVE', 'CANDIDATE'] } }),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 500,
    });

    return rows.map((row) => ({
      id: row.id,
      botId: row.botId,
      kind: row.kind,
      source: row.source,
      status: row.status,
      text: row.text,
      detail: row.detail,
      sourceRef: row.sourceRef,
      messageId: row.messageId,
      supersededById: row.supersededById,
      confirmations: row.confirmations,
      useCount: row.useCount,
      lastUsedAt: row.lastUsedAt === null ? null : row.lastUsedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  /**
   * Everything live in scope, newest-authority first. Backs `memory_read`.
   *
   * ACTIVE by default, because `memory_read` shows a bot what it KNOWS and an
   * unconfirmed guess is not that. `forget` passes CANDIDATE as well: its
   * emptiness check runs before the match, so an ACTIVE-only read there made
   * it answer "nothing has been remembered yet" about a candidate the bot
   * could plainly find with memory_search.
   */
  async liveFor(
    userId: string,
    botId: string,
    statuses: readonly MemoryStatus[] = ['ACTIVE'],
  ): Promise<SelectableMemory[]> {
    return this.prisma.memory.findMany({
      where: { userId, OR: [{ botId: null }, { botId }], status: { in: [...statuses] } },
      orderBy: [{ confirmations: 'desc' }, { updatedAt: 'desc' }],
      select: {
        id: true,
        botId: true,
        authorBotId: true,
        kind: true,
        source: true,
        status: true,
        text: true,
        confirmations: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
      },
    });
  }

  /**
   * Teammate names, for the `[from NAME]` prefix rendered beside shared facts.
   *
   * R7: scoped by `userId` in the WHERE, so a foreign bot id resolves to
   * nothing rather than to its name — and the renderer's "a teammate" fallback
   * is what an id outside this user's team renders as, never the real name of
   * a bot that does not belong to them.
   */
  async namesFor(userId: string, botIds: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(botIds)].filter((id) => id !== '');
    if (unique.length === 0) return new Map();
    const rows = await this.prisma.bot.findMany({
      where: { userId, id: { in: unique } },
      select: { id: true, name: true },
    });
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  /** Rendered size of the live memory, for the capacity check. */
  async totalCharsFor(userId: string, botId: string): Promise<number> {
    const rows = await this.prisma.memory.findMany({
      where: { userId, OR: [{ botId: null }, { botId }], status: 'ACTIVE' },
      select: { text: true },
    });
    return rows.reduce((sum, r) => sum + r.text.length + 3, 0);
  }

  /**
   * An exact restatement of something already held.
   *
   * Matched on the normalised claim rather than the raw text, so "Deploys run
   * from the repo root" and "deploys run from the repo root." are one fact and
   * not two.
   *
   * ACTIVE only by DEFAULT, and the default is for `remember`: a user saying
   * "remember X" when X exists only as an unconfirmed CANDIDATE should be able
   * to establish it, not be told it is already known.
   *
   * The sweep passes CANDIDATE explicitly, and must — writing candidates
   * while deduplicating against actives only means it cannot see its own prior
   * output, so every re-read of a window duplicates everything in it. Found by
   * the idempotency case, which is the one that simulates a crash.
   */
  async findEquivalent(
    userId: string,
    botId: string | null,
    text: string,
    statuses: readonly MemoryStatus[] = ['ACTIVE'],
  ): Promise<{ id: string; text: string; confirmations: number } | null> {
    const target = normalizeClaim(text);
    const rows = await this.prisma.memory.findMany({
      where: { userId, botId, status: { in: [...statuses] } },
      select: { id: true, text: true, confirmations: true },
    });
    return rows.find((r) => normalizeClaim(r.text) === target) ?? null;
  }

  /**
   * Live memories in scope whose claim is the one given.
   *
   * Normalised equality, not substring. The file-based version matched raw
   * text and had to append a newline so that erasing "Deploys run from the
   * repo root" did not also match "...root and nowhere else" — a substring
   * match makes one fact capable of erasing a longer one that merely starts
   * the same way. Equality has no such edge, and the one genuine ambiguity it
   * leaves is real: the same claim held both globally and privately, which the
   * model should be asked to disambiguate rather than have guessed for it.
   */
  async matching(
    userId: string,
    botId: string,
    text: string,
  ): Promise<{ id: string; botId: string | null; text: string }[]> {
    const target = normalizeClaim(text);
    const rows = await this.prisma.memory.findMany({
      // CANDIDATE too. A wrong guess the sweep proposed is exactly the
      // thing an operator most wants gone, and `forget` was the only tool for
      // it — with ACTIVE-only matching it answered "that is not in the
      // memory" about a row the bot could plainly find with memory_search.
      where: { userId, OR: [{ botId: null }, { botId }], status: { in: ['ACTIVE', 'CANDIDATE'] } },
      select: { id: true, botId: true, text: true },
    });
    return rows.filter((r) => normalizeClaim(r.text) === target);
  }

  /**
   * A user confirming a guess makes it a fact.
   *
   * The only promotion path, deliberately. The tempting second one — promote
   * a candidate the sweep re-derived N times — does not work: the sweep
   * deduplicates against its own candidates, so a re-derivation never even
   * inserts, and a count that only ever reaches 1 is not a signal. Worse, if
   * it did climb it would measure how often a model repeated itself.
   *
   * A person saying the thing out loud is evidence of a different kind, and
   * it is the kind D-074 already ranks highest.
   */
  async promote(id: string): Promise<void> {
    await this.prisma.memory.update({
      where: { id },
      data: {
        status: 'ACTIVE',
        source: 'TOLD',
        confirmations: { increment: 1 },
        lastUsedAt: new Date(),
      },
    });
  }

  /** Re-establishing a held fact raises its confirmations rather than duplicating it. */
  async confirm(id: string): Promise<void> {
    await this.prisma.memory.update({
      where: { id },
      data: { confirmations: { increment: 1 }, lastUsedAt: new Date() },
    });
  }

  async write(input: {
    userId: string;
    botId: string | null;
    /** The bot establishing the claim. Recorded so shared facts render with a name. */
    authorBotId?: string | null;
    kind: MemoryKind;
    text: string;
    detail?: string | undefined;
    messageId?: string | undefined;
  }): Promise<void> {
    // TASK_STATE REPLACES; every other kind accumulates.
    //
    // Two live "where the work stands" rows for one bot is not a richer
    // memory, it is a contradiction the bot has no way to resolve: both were
    // true when written and neither says which is now. So the previous one is
    // superseded here rather than left to expire on its own clock.
    if (input.kind === 'TASK_STATE') {
      await this.prisma.memory.updateMany({
        where: { userId: input.userId, botId: input.botId, kind: 'TASK_STATE', status: 'ACTIVE' },
        data: { status: 'SUPERSEDED', supersededAt: new Date() },
      });
    }

    await this.prisma.memory.create({
      data: {
        userId: input.userId,
        botId: input.botId,
        authorBotId: input.authorBotId ?? null,
        kind: input.kind,
        source: 'TOLD',
        text: input.text,
        ...(input.detail === undefined ? {} : { detail: input.detail }),
        ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
        // A ceiling, not a lifetime. The usual end of a TASK_STATE is the next
        // one replacing it; this is what happens when there is no next one.
        ...(input.kind === 'TASK_STATE'
          ? { expiresAt: new Date(Date.now() + TASK_STATE_TTL_MS) }
          : {}),
      },
    });
  }

  /**
   * Erase a claim: mark it FORGOTTEN and tombstone it, in ONE transaction.
   *
   * The two halves cannot come apart. A status change without a tombstone
   * leaves the extraction sweep free to re-derive the claim from the very
   * transcript that established it, so the user's correction would silently
   * undo itself on the next pass; a tombstone without the status change
   * suppresses a future write while the current row keeps being injected.
   *
   * The tombstone is written with the memory's OWN scope, so erasing a bot's
   * private note does not also suppress the user-global fact it resembled.
   */
  async forget(
    userId: string,
    memory: { id: string; botId: string | null; text: string },
  ): Promise<void> {
    const claimHash = claimHashOf(memory.text);
    await this.prisma.$transaction(async (tx) => {
      await tx.memory.update({
        where: { id: memory.id },
        data: { status: 'FORGOTTEN', supersededAt: new Date() },
      });
      try {
        await tx.memoryTombstone.create({ data: { userId, botId: memory.botId, claimHash } });
      } catch (error) {
        // Already tombstoned. Not `upsert`, because the uniqueness that
        // actually holds here is a COALESCE EXPRESSION index — Prisma cannot
        // name an expression as a conflict target, so there is no compound
        // unique for it to key on. Catching the violation is what keeps a
        // second erasure of the same claim idempotent instead of fatal, and
        // it stays race-safe because the database, not a prior read, is what
        // decides.
        if (!isUniqueViolation(error)) throw error;
      }
    });
  }

  /** Direct user corrections preserve scope and suppress re-extraction of the old claim. */
  async editOwned(userId: string, id: string, text: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const old = await tx.memory.findFirst({
        where: { userId, id, status: { in: ['ACTIVE', 'CANDIDATE'] } },
      });
      if (!old) throw new NotFoundException('Memory not found.');
      if (old.text === text) return;
      const replacement = await tx.memory.create({
        data: {
          userId,
          botId: old.botId,
          authorBotId: old.authorBotId,
          kind: old.kind,
          source: 'TOLD',
          text,
          detail: 'Corrected directly by the user.',
          messageId: old.messageId,
          sourceRef: old.sourceRef,
          expiresAt: old.expiresAt,
        },
      });
      await tx.memory.update({
        where: { id, userId },
        data: { status: 'SUPERSEDED', supersededAt: new Date(), supersededById: replacement.id },
      });
      await tx.memoryTombstone.createMany({
        data: [{ userId, botId: old.botId, claimHash: claimHashOf(old.text) }],
        skipDuplicates: true,
      });
    });
  }

  async forgetOwned(userId: string, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const memory = await tx.memory.findFirst({ where: { id, userId } });
      if (!memory) throw new NotFoundException('Memory not found.');
      await tx.memory.update({
        where: { id, userId },
        data: { status: 'FORGOTTEN', supersededAt: new Date() },
      });
      await tx.memoryTombstone.createMany({
        data: [{ userId, botId: memory.botId, claimHash: claimHashOf(memory.text) }],
        skipDuplicates: true,
      });
    });
  }

  /**
   * Erase what a set of messages established, when a deletion asks
   * to forget it. The messages are named by a filter rather than by id, so
   * clearing a long conversation does not build a bind list its size.
   *
   * Runs on the caller's transaction, so the memories and the messages go
   * together or not at all: forgetting without the delete would leave the
   * transcript saying what the bot no longer knows, and the reverse is the
   * "keep memory" answer the operator did not choose.
   *
   * Batch statements rather than a loop over `forget`. That one catches a
   * duplicate tombstone after the INSERT fails, which is fine as the last
   * statement of its own transaction but would abort this shared one, and
   * with it the deletion. `skipDuplicates` is `ON CONFLICT DO NOTHING` with no
   * target, which is what honours the COALESCE expression index.
   */
  async forgetLearnedFrom(
    tx: Prisma.TransactionClient,
    userId: string,
    messages: Prisma.MessageWhereInput,
  ): Promise<number> {
    const rows = await tx.memory.findMany({
      where: { userId, message: messages, status: { in: ['ACTIVE', 'CANDIDATE'] } },
      select: { id: true, botId: true, text: true },
    });
    if (rows.length === 0) return 0;
    await tx.memory.updateMany({
      where: { userId, id: { in: rows.map((row) => row.id) } },
      data: { status: 'FORGOTTEN', supersededAt: new Date() },
    });
    await tx.memoryTombstone.createMany({
      data: rows.map((row) => ({ userId, botId: row.botId, claimHash: claimHashOf(row.text) })),
      skipDuplicates: true,
    });
    return rows.length;
  }
}
