import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { z } from 'zod';

import { PrismaService } from '../prisma/prisma.service.js';
import {
  ModelResolutionService,
  type ResolvedTextModel,
} from '../models/model-resolution.service.js';
import { askModelText } from '../models/text-call.js';
import { answerInstructions, parseJsonAnswer } from '../models/structured-answer.js';
import { MODEL_REF_DEFAULT } from '@crewaid/shared';
import { MemoryService, claimHashOf } from './memory.service.js';
import {
  MEMORY_DISTILL_WINDOW,
  readMemoryDistillIntervalMs,
  readMemoryDistillMinMessages,
} from '../agent/agent-loop.config.js';

/**
 * What gets remembered without being told.
 *
 * Explicit `remember` cannot capture "resources consulted": a model rarely
 * volunteers it, which is exactly the under-saving failure the memory exists
 * to avoid. This reads recent conversations and proposes facts.
 *
 * Shipped disabled, and not for cost reasons
 *
 * D-064 puts `remember` and `forget` on the `ask` fallthrough, so the operator
 * was promised that memory writes are approved. A background worker writing
 * memories silently revokes that promise. Turning this on is a product-policy
 * decision and belongs to whoever made the promise, not to a default.
 *
 * Three things that make it survivable when it is on
 *
 * 1. Every write is a CANDIDATE — searchable, never injected. A wrong
 * inference is a search result rather than a standing truth in a trim-proof
 * prompt.
 * 2. Off the turn path entirely. A second model call per turn, on the latency
 * path, for a benefit that turn never sees, is the wrong shape.
 * 3. Tombstone-checked. Without that this re-derives a fact the user erased
 * from the very transcript that established it, and the correction silently
 * undoes itself on the next pass — the defect the tombstones exist for.
 */
@Injectable()
export class MemoryDistillService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MemoryDistillService.name);

  /**
   * Unique among the four this database takes: 5_390_031 (attachment
   * capacity), 5_390_039 (sandbox admission), 5_390_040 (workspace retention).
   */
  private static readonly SWEEP_LOCK_KEY = 5_390_041;

  private readonly intervalMs: number;
  private readonly minMessages: number;
  private timer: NodeJS.Timeout | null = null;
  /** A pass in flight. A slow model call must not stack ticks on top of it. */
  private sweeping = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MemoryService) private readonly memories: MemoryService,
    // Resolved directly rather than through EXECUTION_BACKEND. That
    // interface runs a TURN — streamed events, cancellation, a transcript to
    // persist — and distillation is one structured-output call that emits
    // nothing and is watched by nobody. Putting it behind the turn interface
    // would mean inventing a turn with no conversation to belong to.
    @Inject(ModelResolutionService) private readonly models: ModelResolutionService,
  ) {
    this.intervalMs = readMemoryDistillIntervalMs(process.env['AGENT_MEMORY_DISTILL_INTERVAL_MS']);
    this.minMessages = readMemoryDistillMinMessages(
      process.env['AGENT_MEMORY_DISTILL_MIN_MESSAGES'],
    );
  }

  onApplicationBootstrap(): void {
    if (this.intervalMs <= 0) {
      this.logger.log('memory distillation disabled (AGENT_MEMORY_DISTILL_INTERVAL_MS <= 0)');
      return;
    }
    // `unref` for the same reason every other background policy does it: this
    // must never be the thing keeping a shutdown or a test runner open.
    // Resolved inside the tick, not at construction. A disabled sweep must
    // not resolve a provider, and a provider resolved at boot would be one
    // more thing that can fail a boot for a feature nobody turned on.
    // One extractor PER OWNER. Resolution reads the caller's
    // connections now, so a single extractor built once would send every
    // user's transcript to whichever user's key it happened to resolve — and
    // bill them for it. There is no default model that is nobody's.
    this.timer = setInterval(() => {
      void this.sweep(async (userId) =>
        modelExtractor(await this.models.resolveText(userId, MODEL_REF_DEFAULT)),
      );
    }, this.intervalMs).unref();
    this.logger.log(`memory distillation every ${this.intervalMs}ms`);
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass. Public because the tests drive it directly — asserting an
   * interval policy by waiting for the interval measures the clock.
   *
   * `extractorFor` is a parameter rather than a field so a test can supply a
   * model without one being constructed at boot: a sweep that is disabled must
   * not resolve a provider, and a sweep under test must not call one.
   *
   * It takes an OWNER because resolution is owner-scoped. Called
   * inside the per-bot try, so a user whose default model is unset or whose
   * key was removed costs that user's bots this pass and nobody else's — the
   * same containment the extraction call already had.
   */
  async sweep(extractorFor: ExtractorFor): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const due = await this.botsDue();
      for (const bot of due) {
        try {
          await this.distillOne(bot, await extractorFor(bot.userId));
        } catch (error) {
          // One bot's failure is not the sweep's. A provider hiccup on bot A
          // must not stop bot B from ever being read.
          this.logger.warn(
            `distillation failed for ${bot.botId}: ${
              error instanceof Error ? error.message : 'unknown'
            }`,
          );
        }
      }
    } finally {
      this.sweeping = false;
    }
  }

  /** Bots with at least `minMessages` new messages since their watermark. */
  private async botsDue(): Promise<Array<{ botId: string; userId: string }>> {
    const rows = await this.prisma.bot.findMany({
      select: {
        id: true,
        userId: true,
        distillation: { select: { throughCreatedAt: true } },
        conversation: { select: { id: true } },
      },
    });

    const due: Array<{ botId: string; userId: string }> = [];
    for (const row of rows) {
      if (row.conversation === null) continue;
      const since = row.distillation?.throughCreatedAt ?? null;
      const count = await this.prisma.message.count({
        where: {
          conversationId: row.conversation.id,
          author: { in: ['USER', 'BOT'] },
          content: { not: '' },
          ...(since === null ? {} : { createdAt: { gt: since } }),
        },
      });
      if (count >= this.minMessages) due.push({ botId: row.id, userId: row.userId });
    }
    return due;
  }

  private async distillOne(
    bot: { botId: string; userId: string },
    extract: Extractor,
  ): Promise<void> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { botId: bot.botId },
      select: { id: true },
    });
    if (conversation === null) return;

    const watermark = await this.prisma.memoryDistillation.findUnique({
      where: { botId: bot.botId },
      select: { throughCreatedAt: true },
    });
    const since = watermark?.throughCreatedAt ?? null;

    const window = await this.prisma.message.findMany({
      where: {
        conversationId: conversation.id,
        author: { in: ['USER', 'BOT'] },
        content: { not: '' },
        ...(since === null ? {} : { createdAt: { gt: since } }),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MEMORY_DISTILL_WINDOW,
      select: { id: true, author: true, content: true, createdAt: true },
    });
    if (window.length === 0) return;

    const last = window[window.length - 1];
    if (last === undefined) return;

    const candidates = await extract(
      window.map((m) => ({ author: m.author === 'USER' ? 'user' : 'assistant', text: m.content })),
    );

    let written = 0;
    for (const candidate of candidates) {
      const text = candidate.text.trim();
      if (text === '') continue;

      // The defect this exists to prevent: re-deriving a claim the user erased
      // from the very transcript that established it.
      if (await this.memories.isTombstoned(bot.userId, null, claimHashOf(text))) continue;

      // Deduplicated by NORMALISED claim, not by string equality: a sweep that
      // re-reads a window after a crash must not insert the same fact twice
      // with different punctuation.
      //
      // CANDIDATE is in the list explicitly, and has to be: this writes
      // candidates, so deduplicating against ACTIVE alone would mean it could
      // not see its own prior output and every re-read would duplicate.
      const seen: readonly ['ACTIVE', 'CANDIDATE'] = ['ACTIVE', 'CANDIDATE'];
      if ((await this.memories.findEquivalent(bot.userId, null, text, seen)) !== null) continue;
      if ((await this.memories.findEquivalent(bot.userId, bot.botId, text, seen)) !== null)
        continue;

      await this.prisma.memory.create({
        data: {
          userId: bot.userId,
          botId: candidate.scope === 'bot' ? bot.botId : null,
          // The distilled bot is the establishing author on BOTH scopes: a
          // private row's author is already its scope, and a workspace row
          // distilled from this bot's conversation is exactly the one a
          // teammate would otherwise read as their own work.
          authorBotId: bot.botId,
          kind: candidate.kind,
          source: 'DISTILLED',
          // NEVER ACTIVE. The whole reason this is safe to switch on.
          status: 'CANDIDATE',
          text,
          messageId: candidate.messageId ?? null,
        },
      });
      written += 1;
    }

    // Advances only HERE, after the writes, and inside the lock.
    //
    // THE LOCK IS AROUND THE WRITES, NOT THE PASS. Two orchestrator processes
    // may both read the window and both call the model — wasteful, and
    // harmless, because the dedupe above catches it. What they must not do is
    // interleave the watermark update, which would leave it pointing at a
    // window one of them never wrote. Holding the lock across the model call
    // would fix the waste and hold a database transaction open for the length
    // of a provider round trip, which is the worse trade.
    //
    // A crash before this re-reads the window: one model call, deduplicated. A
    // watermark advanced FIRST would skip the window entirely and lose the
    // only chance to notice what was in it.
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${MemoryDistillService.SWEEP_LOCK_KEY}::bigint)`;
      await tx.memoryDistillation.upsert({
        where: { botId: bot.botId },
        create: {
          botId: bot.botId,
          throughMessageId: last.id,
          throughCreatedAt: last.createdAt,
          candidatesWritten: written,
        },
        update: {
          throughMessageId: last.id,
          throughCreatedAt: last.createdAt,
          lastRunAt: new Date(),
          candidatesWritten: { increment: written },
        },
      });
    });
  }
}

/** One proposed fact. `scope: 'bot'` is private to the bot that produced it. */
export interface DistilledCandidate {
  readonly text: string;
  readonly kind: 'PREFERENCE' | 'CONVENTION' | 'FACT' | 'DECISION' | 'RESOURCE';
  readonly scope: 'workspace' | 'bot';
  readonly messageId?: string | null;
}

export type Extractor = (
  window: ReadonlyArray<{ author: 'user' | 'assistant'; text: string }>,
) => Promise<DistilledCandidate[]>;

/**
 * An extractor for one owner's bots.
 *
 * The indirection is the owner scoping: a sweep spans every user's bots, and
 * which model serves one of them is a property of THAT user's connections, so
 * the model cannot be chosen once for the pass.
 */
export type ExtractorFor = (userId: string) => Promise<Extractor>;

/**
 * The extraction schema. `TASK_STATE` is deliberately absent: working state is
 * what a bot writes about its OWN progress, and a sweep reading a finished
 * conversation cannot tell "the migration is prepared" from "the migration was
 * prepared last month", which is exactly the row that must expire.
 */
const CandidateSchema = z.object({
  facts: z
    .array(
      z.object({
        text: z.string().max(300),
        kind: z.enum(['PREFERENCE', 'CONVENTION', 'FACT', 'DECISION', 'RESOURCE']),
        scope: z.enum(['workspace', 'bot']),
      }),
    )
    .max(5),
});

/**
 * The real extractor. Asks for AT MOST five facts and allows zero: a pass that
 * finds nothing worth remembering is the common case, and a prompt that
 * implies a quota is one that invents.
 *
 * Plain text with the schema in the prompt (`answerInstructions`), for the
 * same reason the skill compiler asks that way: a custom OpenAI-compatible
 * endpoint never receives `generateObject`'s json_schema constraint, so a
 * model serving chat fine would have its extraction die as an unparseable
 * answer. A malformed reply throws — the sweep's per-bot catch logs it and
 * moves on, which is the right size for a background pass.
 */
export function modelExtractor(model: Pick<ResolvedTextModel, 'adapter'>): Extractor {
  return async (window) => {
    const transcript = window.map((m) => `${m.author}: ${m.text}`).join('\n');
    const text = await askModelText(model, {
      system: answerInstructions(CandidateSchema),
      prompt:
        'Below is part of a conversation between a user and an assistant. List any DURABLE ' +
        'facts worth remembering beyond this conversation — a convention, a preference, where ' +
        'something lives, a decision and why, a useful resource.\n\n' +
        'Do NOT list what merely happened; the transcript already has that. Do not list ' +
        'anything about the current state of a task. It is normal and correct to return an ' +
        'empty list.\n\n' +
        'Mark a fact `workspace` when it is true no matter which assistant is asked, and `bot` ' +
        'when it is about this assistant’s own role.\n\n' +
        `---\n${transcript}\n---`,
    });
    const parsed = parseJsonAnswer(text);
    if (!parsed.ok) throw new Error(`memory distillation was unreadable: ${parsed.problem}`);
    const shape = CandidateSchema.safeParse(parsed.value);
    if (!shape.success) throw new Error('memory distillation did not match the requested shape');
    return shape.data.facts.map((f) => ({ text: f.text, kind: f.kind, scope: f.scope }));
  };
}
