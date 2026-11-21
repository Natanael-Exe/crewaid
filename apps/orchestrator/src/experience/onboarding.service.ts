import { randomUUID } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  DEFAULT_AUTO_REVIEW_RULES,
  welcomeCopy,
  welcomeLines,
  type Locale,
  type OnboardingBootstrapBody,
  type UpdateOnboardingBody,
  type WelcomeReply,
} from '@crewaid/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { USER_PREFERENCES_SELECT, writingLanguage } from '../providers/user-preferences.js';
import { TurnEventBus } from '../agent/turn-event.bus.js';
import { toTranscriptRow } from '../agent/persistence/transcript.js';

type Tx = Prisma.TransactionClient;
type Line = { readonly role: 'user' | 'assistant'; readonly content: string };

/** How far back the tour looks for its own guide; a welcome is a handful of lines. */
const WELCOME_LOOKBACK = 200;

/** Each reply, as the person says it and as Crewaid answers it, in one language. */
function answers(language: Locale | null): Record<WelcomeReply, readonly Line[]> {
  const copy = welcomeCopy(language);
  return {
    TASK: [
      { role: 'user', content: copy.replies.TASK },
      { role: 'assistant', content: copy.taskQuestion },
    ],
    TOUR: [
      { role: 'user', content: copy.replies.TOUR },
      { role: 'assistant', content: copy.guide },
      { role: 'assistant', content: copy.afterGuide },
    ],
  };
}

@Injectable()
export class OnboardingService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TurnEventBus) private readonly events: TurnEventBus,
  ) {}

  async bootstrap(userId: string, body: OnboardingBootstrapBody = {}) {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "User" WHERE id = ${userId} FOR NO KEY UPDATE`;
      const person = await tx.user.findFirst({
        where: { id: userId },
        select: { name: true, settings: { select: USER_PREFERENCES_SELECT } },
      });
      const language = writingLanguage(person?.settings, body.language);
      const firstName = person?.name.trim().split(/\s+/)[0] || null;
      const existing = await tx.bot.findFirst({ where: { userId, kind: 'MAIN' } });
      const otherBots = await tx.bot.count({ where: { userId, kind: 'STANDARD' } });
      const onboarding = await tx.userOnboarding.upsert({
        where: { userId },
        create: {
          userId,
          welcomeSeen: otherBots > 0,
          discovery: otherBots > 0 ? 'SKIPPED' : 'NEW',
        },
        update: {},
      });
      if (existing) {
        if (!onboarding.welcomeSeen) await this.greet(tx, userId, language, firstName);
        return { bot: existing, onboarding, isNewAccount: otherBots === 0, created: false };
      }
      const computer = await tx.sandbox.findFirst({
        where: { userId },
        orderBy: { id: 'asc' },
        select: { id: true },
      });
      const bot = await tx.bot.create({
        data: {
          userId,
          kind: 'MAIN',
          name: 'Crewaid',
          role: welcomeCopy(language).assistantRole,
          avatarColor: '#4c6ef5',
          avatarShape: 'egg',
          systemPrompt: '',
          modelId: 'default',
          pinned: true,
          sandboxId: computer?.id ?? null,
          autoReviewRules: DEFAULT_AUTO_REVIEW_RULES,
        },
      });
      await tx.conversation.create({ data: { botId: bot.id } });
      if (!onboarding.welcomeSeen) await this.greet(tx, userId, language, firstName);
      return { bot, onboarding, isNewAccount: otherBots === 0, created: true };
    });
    if (result.created) {
      try {
        this.events.emitBotsChanged(userId, result.bot.id, 'created');
      } catch {
        /* A committed account bootstrap must survive a disconnected notification transport. */
      }
    }
    return { bot: result.bot, onboarding: result.onboarding, isNewAccount: result.isNewAccount };
  }

  async read(userId: string) {
    const state = await this.prisma.userOnboarding.findFirst({ where: { userId } });
    if (!state) throw new NotFoundException('Open Crewaid to begin.');
    return state;
  }
  async update(userId: string, input: UpdateOnboardingBody) {
    await this.read(userId);
    if (input.reply !== undefined) await this.answer(userId, input.reply);
    return this.prisma.userOnboarding.update({
      where: { userId },
      data: {
        ...(input.welcomeSeen !== undefined && { welcomeSeen: input.welcomeSeen }),
        ...(input.discovery !== undefined && { discovery: input.discovery }),
      },
    });
  }

  /**
   * D-232: Crewaid says hello in its own thread, as its own messages with no
   * run: the app wrote them and no model did. Only an open welcome on an empty
   * thread is greeted, inside bootstrap's lock on the user, so two windows
   * opening at once greet once.
   */
  private async greet(tx: Tx, userId: string, language: Locale | null, firstName: string | null) {
    const thread = await this.mainThread(tx, userId);
    if ((await tx.message.count({ where: { conversationId: thread.id } })) > 0) return;
    await this.say(
      tx,
      userId,
      thread,
      welcomeCopy(language)
        .greeting(firstName)
        .map((content) => ({ role: 'assistant', content })),
    );
  }

  /**
   * D-232: a reply the person tapped, stored in their words with Crewaid's
   * fixed answer. "I have a task" closes the welcome, so only the update that
   * closes it answers (D-231). The tour keeps it open and is answered once:
   * the lock on the user serialises two clicks, and the second finds the guide.
   */
  private async answer(userId: string, reply: WelcomeReply) {
    await this.prisma.$transaction(async (tx) => {
      if (reply === 'TASK') {
        const closed = await tx.userOnboarding.updateMany({
          where: { userId, welcomeSeen: false },
          data: { welcomeSeen: true },
        });
        if (closed.count === 0) return;
      } else {
        await tx.$executeRaw`SELECT id FROM "User" WHERE id = ${userId} FOR NO KEY UPDATE`;
        const open = await tx.userOnboarding.count({ where: { userId, welcomeSeen: false } });
        if (open === 0) return;
      }
      const thread = await this.mainThread(tx, userId);
      if (reply === 'TOUR') {
        // In any language: a guide written before a language change is still the guide.
        // Compared here rather than in the query: stored text is sealed, and the
        // welcome's own lines are the only bot rows no run wrote.
        const guides = new Set(welcomeLines('guide'));
        const said = await tx.message.findMany({
          where: { conversationId: thread.id, author: 'BOT', runId: null },
          orderBy: { sequence: 'desc' },
          take: WELCOME_LOOKBACK,
          select: { content: true },
        });
        if (said.some((line) => guides.has(line.content))) return;
      }
      const person = await tx.user.findFirst({
        where: { id: userId },
        select: { settings: { select: USER_PREFERENCES_SELECT } },
      });
      await this.say(tx, userId, thread, answers(writingLanguage(person?.settings))[reply]);
    });
  }

  private async mainThread(tx: Tx, userId: string) {
    const thread = await tx.conversation.findFirst({
      where: { bot: { userId, kind: 'MAIN' } },
      select: { id: true, botId: true },
    });
    if (thread === null) throw new NotFoundException('Open Crewaid to begin.');
    return thread;
  }

  /**
   * Writes lines into the main thread in order, through the one validating
   * mapper (D-165). The person is on this thread when they arrive, so the
   * read mark moves past them and no unread badge appears.
   */
  private async say(
    tx: Tx,
    userId: string,
    thread: { id: string; botId: string },
    lines: readonly Line[],
  ) {
    const start = Date.now();
    let at = new Date(start);
    for (const [index, line] of lines.entries()) {
      const row = toTranscriptRow(
        { id: randomUUID(), role: line.role, content: line.content },
        { threadBotId: thread.botId, runId: null },
      );
      if (!row.ok) throw new Error(`A welcome line cannot be stored: ${row.violation.kind}`);
      // A millisecond apart, so the order survives anything that sorts by time.
      at = new Date(start + index);
      await tx.message.create({ data: { conversationId: thread.id, ...row.value, createdAt: at } });
    }
    await tx.conversation.updateMany({
      where: { id: thread.id, bot: { userId } },
      data: { lastReadAt: at },
    });
  }
}
