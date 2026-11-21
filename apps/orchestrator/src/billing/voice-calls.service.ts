import {
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CALL_ALLOWANCE_USED_CODE,
  CALL_PLAN_REQUIRED_CODE,
  type CallAllowanceResponse,
  type StartCallResponse,
  type UpdateCallBody,
  type VoiceCall,
} from '@crewaid/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  CALL_AGENT_FACTORY,
  type CallAgent,
  CallAgentError,
  type CallAgentFactory,
  SIGNED_URL_TTL_MS,
  type SignedConversation,
} from '../models/voice/elevenlabs-agent.js';
import { HOUSE_VOICE_ID } from '../models/voice/voice-engine.js';
import {
  languageName,
  USER_PREFERENCES_SELECT,
  userPreferences,
} from '../providers/user-preferences.js';
import { callAgentLanguage, callGreeting } from './call-language.js';
import type { BillingConfig } from './billing.config.js';
import { BillingService } from './billing.service.js';
import { BILLING_CONFIG } from './billing.tokens.js';

/** The agent's own ceiling on one conversation, and so on one call. */
export const CALL_CEILING_SECONDS = 1800;
/** A call whose conversation ElevenLabs does not know after this long never connected. */
const CONNECT_WINDOW_MS = SIGNED_URL_TTL_MS + 60 * 1000;
/** How long past the ceiling ElevenLabs may take to report a call done. */
const SETTLE_GRACE_MS = 10 * 60 * 1000;

/**
 * What the voice is told on a call. It speaks AS the bot: work
 * goes to the bot through `ask_bot`, and the bot's answer comes back as a
 * message to read aloud. The spike found the "Read this answer" framing is
 * what keeps the voice from handing the bot's own answer back to it as a new
 * request; the check-in line is framed the same way for the same reason.
 *
 * Work in progress reaches the voice as contextual updates, which ElevenLabs
 * never answers aloud, so knowing the state costs no turn. Only the answer
 * and a rare check-in are spoken on the desktop's initiative.
 */
export function relayPrompt(botName: string, language?: string): string {
  return [
    // The instructions stay English, and so do the desktop's relay phrases
    // they key on; only what the voice says changes language.
    ...(language !== undefined && language !== 'English'
      ? [`Speak ${language} on this call, unless the user speaks another language to you.`]
      : []),
    `You are the voice of ${botName}, a Crewaid bot, on a live call. Speak in the first person as ${botName}.`,
    'Anything that needs work, research, current facts, or what you know about the user, their files or their computer: call ask_bot with the request in the user’s own words, then say in one short sentence that you are on it. Never answer such a request yourself.',
    'Small talk and light conversation you may answer yourself, briefly. Work you sent stays in progress while you talk: never send it again, cancel it or forget it.',
    'Updates starting "Work status:" tell you what the work is doing, that it is waiting for an approval on screen, or that it ended. Never answer them aloud. If the user asks how it is going, answer from the latest one, and never guess a step, a result or a finish time.',
    'While work is in progress and the user is quiet, stay quiet too. Never ask whether there is anything else, or whether the user is still there.',
    'When a message starts with "Give the user a short update", say one short sentence about how the work is going, from the latest work status. Do not ask the user anything. Never send it to ask_bot.',
    'When a message starts with "Read this answer to the user", read the answer that follows aloud, naturally, without adding facts of your own or offering more help. If you were talking about something else, say briefly that you are coming back to the earlier request. Never send it to ask_bot.',
    `Never mention a bot, a tool or a relay: to the user, you are ${botName}.`,
    'Never ask for passwords, keys or codes aloud. Keep every turn short.',
  ].join('\n');
}

type CallRow = {
  readonly id: string;
  readonly botId: string;
  readonly conversationId: string | null;
  readonly reservedSeconds: number;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly durationSeconds: number | null;
  readonly settledAt: Date | null;
};

const CALL_SELECT = {
  id: true,
  botId: true,
  conversationId: true,
  reservedSeconds: true,
  startedAt: true,
  endedAt: true,
  durationSeconds: true,
  settledAt: true,
} as const;

/**
 * Calls with a bot on the hosted service, and the minutes they use.
 *
 * Minutes are settled from ElevenLabs' own count of each conversation, never
 * from the client: a call reserves what is left of the period when it starts,
 * counts as its elapsed time while it is open, and settles to
 * `call_duration_secs` once it ends. A call nobody ended is settled the next
 * time the account's minutes are read, so there is no sweep to schedule.
 */
@Injectable()
export class VoiceCallsService {
  private readonly agent: CallAgent;
  private readonly logger = new Logger('VoiceCalls');

  constructor(
    @Inject(BILLING_CONFIG) config: BillingConfig,
    @Inject(CALL_AGENT_FACTORY) agents: CallAgentFactory,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BillingService) private readonly billing: BillingService,
  ) {
    if (config.elevenlabsKey === null || config.elevenlabsAgentId === null) {
      throw new Error('VoiceCallsService needs CREWAID_ELEVENLABS_API_KEY and _AGENT_ID');
    }
    this.agent = agents(config.elevenlabsKey, config.elevenlabsAgentId);
  }

  /** `GET /calls/allowance`. */
  async allowance(userId: string, now: Date = new Date()): Promise<CallAllowanceResponse> {
    const entitlement = await this.billing.entitlementFor(userId, now);
    if (entitlement.period === null) return { limitSeconds: 0, usedSeconds: 0 };
    const usedSeconds = await this.usedSeconds(userId, entitlement.period.start, now);
    return { limitSeconds: entitlement.callLimitSeconds, usedSeconds };
  }

  /** `POST /bots/:id/calls`. */
  async start(userId: string, botId: string, now: Date = new Date()): Promise<StartCallResponse> {
    const bot = await this.prisma.bot.findFirst({
      where: { id: botId, userId },
      select: {
        name: true,
        voiceId: true,
        user: { select: { settings: { select: USER_PREFERENCES_SELECT } } },
      },
    });
    if (bot === null) throw new NotFoundException();

    const entitlement = await this.billing.entitlementFor(userId, now);
    const limit = entitlement.callLimitSeconds;
    if (entitlement.period === null || limit === 0) {
      throw new HttpException(
        {
          statusCode: 402,
          code: CALL_PLAN_REQUIRED_CODE,
          message: 'Calls come with Pro. Upgrade to talk to your bots live.',
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    const used = await this.usedSeconds(userId, entitlement.period.start, now);
    const open = (await this.rows(userId, { endedAt: null })).some(
      (row) => now.getTime() - row.startedAt.getTime() < CALL_CEILING_SECONDS * 1000,
    );
    if (open) throw new ConflictException('You are already on a call. Hang up first.');

    const remaining = limit === null ? null : Math.max(0, limit - used);
    if (remaining === 0) {
      throw new HttpException(
        {
          statusCode: 402,
          code: CALL_ALLOWANCE_USED_CODE,
          message: 'This period’s call minutes are used up. They reset when your plan renews.',
          detail: {
            usedSeconds: used,
            limitSeconds: limit,
            resetsAt: entitlement.period.end.toISOString(),
          },
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    let signed: SignedConversation;
    try {
      signed = await this.agent.signedUrl();
    } catch (error) {
      throw this.unreachable(error);
    }
    const maxDurationSeconds = Math.min(remaining ?? CALL_CEILING_SECONDS, CALL_CEILING_SECONDS);
    const { language } = userPreferences(bot.user.settings);
    const spokenLanguage = language === null ? undefined : languageName(language);
    const agentLanguage = callAgentLanguage(language);
    const call = await this.prisma.voiceCall.create({
      data: {
        userId,
        botId,
        periodStart: entitlement.period.start,
        reservedSeconds: maxDurationSeconds,
        startedAt: now,
        // Bound here, from ElevenLabs, never from the client's report: the
        // URL starts this conversation and no other.
        conversationId: signed.conversationId,
      },
      select: { id: true },
    });
    return {
      callId: call.id,
      signedUrl: signed.url,
      remainingSeconds: remaining,
      overrides: {
        prompt: relayPrompt(bot.name, spokenLanguage),
        firstMessage: callGreeting(language, bot.name),
        voiceId: bot.voiceId ?? HOUSE_VOICE_ID,
        maxDurationSeconds,
        ...(agentLanguage !== undefined && { language: agentLanguage }),
      },
    };
  }

  /** `PATCH /calls/:callId`. */
  async update(
    userId: string,
    callId: string,
    body: UpdateCallBody,
    now: Date = new Date(),
  ): Promise<VoiceCall> {
    const [call] = await this.rows(userId, { id: callId });
    if (call === undefined) throw new NotFoundException();
    if (
      body.conversationId !== undefined &&
      call.conversationId !== null &&
      call.conversationId !== body.conversationId
    ) {
      throw new ConflictException('This call is already a different conversation.');
    }

    await this.prisma.voiceCall.updateMany({
      where: { id: callId, userId },
      data: {
        ...(body.conversationId !== undefined &&
          call.conversationId === null && { conversationId: body.conversationId }),
        ...(body.ended === true && call.endedAt === null && { endedAt: now }),
      },
    });
    const [updated] = await this.rows(userId, { id: callId });
    if (updated === undefined) throw new NotFoundException();
    const settled = updated.endedAt !== null ? await this.settle(userId, updated, now) : updated;
    return toWire(settled);
  }

  /** Settled seconds, plus unsettled calls at their elapsed time, for one period. */
  private async usedSeconds(userId: string, periodStart: Date, now: Date): Promise<number> {
    let used = 0;
    for (const row of await this.rows(userId, { periodStart })) {
      const current = row.settledAt === null ? await this.settle(userId, row, now) : row;
      const until = current.endedAt ?? now;
      used +=
        current.settledAt !== null
          ? (current.durationSeconds ?? 0)
          : Math.min(
              current.reservedSeconds,
              Math.max(0, Math.ceil((until.getTime() - current.startedAt.getTime()) / 1000)),
            );
    }
    return used;
  }

  /**
   * Settle a call if its count is known, and return it as it now stands. Asks
   * ElevenLabs only about a call that has ended or can no longer be starting,
   * so a call in progress costs no request per allowance read.
   */
  private async settle(userId: string, call: CallRow, now: Date): Promise<CallRow> {
    if (call.settledAt !== null) return call;
    const age = now.getTime() - call.startedAt.getTime();
    const ended = call.endedAt !== null;
    let seconds: number | null = null;

    if (call.conversationId === null) {
      // Every call is bound to its conversation when it starts, so a row with
      // none cannot be counted: it is held at its reservation once it is over.
      if (ended || age > CALL_CEILING_SECONDS * 1000) seconds = call.reservedSeconds;
    } else if (ended || age > CONNECT_WINDOW_MS) {
      try {
        seconds = await this.agent.conversationSeconds(call.conversationId);
      } catch (error) {
        // ElevenLabs has no conversation until somebody connects. "Never
        // connected" is only final once the single-use URL has expired: before
        // that, a client that reports `ended` first could still connect.
        if (
          error instanceof CallAgentError &&
          error.kind === 'not_found' &&
          age > CONNECT_WINDOW_MS
        ) {
          seconds = 0;
        } else {
          this.logger.warn(`call ${call.id}: settlement deferred (${errorKind(error)})`);
        }
      }
      // ElevenLabs has never answered for it: hold it at its reservation.
      if (seconds === null && age > CALL_CEILING_SECONDS * 1000 + SETTLE_GRACE_MS) {
        seconds = call.reservedSeconds;
      }
    }
    if (seconds === null) return call;

    await this.prisma.voiceCall.updateMany({
      where: { id: call.id, userId, settledAt: null },
      data: { durationSeconds: seconds, settledAt: now, ...(ended ? {} : { endedAt: now }) },
    });
    return { ...call, durationSeconds: seconds, settledAt: now, endedAt: call.endedAt ?? now };
  }

  private rows(
    userId: string,
    where: { id?: string; periodStart?: Date; endedAt?: null },
  ): Promise<CallRow[]> {
    return this.prisma.voiceCall.findMany({
      where: { ...where, userId },
      select: CALL_SELECT,
      orderBy: { startedAt: 'asc' },
    });
  }

  private unreachable(error: unknown): HttpException {
    this.logger.warn(`call start failed (${errorKind(error)})`);
    return new HttpException(
      'The voice service could not be reached. Try again in a moment.',
      HttpStatus.BAD_GATEWAY,
    );
  }
}

function toWire(row: CallRow): VoiceCall {
  return {
    id: row.id,
    botId: row.botId,
    conversationId: row.conversationId,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    durationSeconds: row.settledAt === null ? null : row.durationSeconds,
  };
}

function errorKind(error: unknown): string {
  return error instanceof CallAgentError ? error.kind : 'unknown';
}
