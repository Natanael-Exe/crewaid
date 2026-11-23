import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HttpException } from '@nestjs/common';
import { CALL_ALLOWANCE_USED_CODE, CALL_PLAN_REQUIRED_CODE } from '@crewaid/shared';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import type { BillingConfig } from '../../src/ee/billing/billing.config.js';
import type { BillingService } from '../../src/ee/billing/billing.service.js';
import type { Entitlement } from '../../src/ee/billing/entitlement.js';
import {
  CALL_CEILING_SECONDS,
  VoiceCallsService,
  relayPrompt,
} from '../../src/ee/billing/voice-calls.service.js';
import { CallAgentError, type CallAgent } from '../../src/ee/voice/elevenlabs-agent.js';
import { HOUSE_VOICE_ID } from '../../src/models/voice/voice-engine.js';

const DATABASE_URL = process.env['DATABASE_URL'];

const PERIOD = { start: new Date('2026-10-01T00:00:00Z'), end: new Date('2026-11-01T00:00:00Z') };
const NOW = new Date('2026-10-14T12:00:00Z');
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

const CONFIG: BillingConfig = {
  secretKey: 'sk_test',
  webhookSecret: 'whsec',
  prices: { starter: 'price_a', pro: 'price_b' },
  automaticTax: false,
  returnUrl: 'https://crewaid.io/billing/done',
  openrouterKey: null,
  elevenlabsKey: 'sk_el_hosted',
  elevenlabsAgentId: 'agent_relay',
};

/**
 * D-222 — a call's minutes, over a real database with a second user.
 *
 * The plan and ElevenLabs are the two things faked: the plan says what a
 * period allows, and the agent says what each conversation lasted, which is
 * the only count a call settles to.
 */
describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')('D-222 — call minutes', () => {
  let prisma: PrismaService;
  const owner = `call-owner-${randomUUID()}`;
  const other = `call-other-${randomUUID()}`;
  let botId: string;
  let otherBotId: string;

  let limitSeconds: number | null = 1800;
  /** A count, null while it runs, or 'missing' for one nobody ever connected to. */
  const durations = new Map<string, number | null | 'missing'>();
  const agentCalls: string[] = [];
  let agentDown = false;
  let issued = 0;
  /** The conversation the last signed URL starts. */
  let conversation = '';
  const agent: CallAgent = {
    signedUrl: async () => {
      agentCalls.push('signedUrl');
      if (agentDown) throw new CallAgentError('unreachable');
      issued += 1;
      conversation = `conv_t${issued}`;
      return {
        url: `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_relay&conversation_signature=s&conversation_id=${conversation}`,
        conversationId: conversation,
      };
    },
    conversationSeconds: async (id) => {
      agentCalls.push(`conversation:${id}`);
      if (agentDown) throw new CallAgentError('unreachable');
      const known = durations.get(id);
      if (known === 'missing') throw new CallAgentError('not_found');
      return known ?? null;
    },
  };
  /** Past the window in which a signed URL could still start its conversation. */
  const AFTER_CONNECT_WINDOW = 17 * 60;
  const billing = {
    entitlementFor: async (): Promise<Partial<Entitlement>> => ({
      period: limitSeconds === 0 ? null : PERIOD,
      callLimitSeconds: limitSeconds,
    }),
  } as unknown as BillingService;
  let calls: VoiceCallsService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    for (const id of [owner, other]) {
      await prisma.user.create({ data: { id, name: id, email: `${id}@test.invalid` } });
    }
    const bot = (userId: string, name: string, voiceId: string | null) =>
      prisma.bot.create({
        data: {
          userId,
          name,
          role: 'Assistant',
          avatarColor: '#4c6ef5',
          systemPrompt: '',
          voiceId,
        },
      });
    botId = (await bot(owner, 'Quill', 'voice-quill')).id;
    otherBotId = (await bot(other, 'Moss', null)).id;
    calls = new VoiceCallsService(CONFIG, () => agent, prisma, billing);
  });

  beforeEach(async () => {
    limitSeconds = 1800;
    agentDown = false;
    durations.clear();
    agentCalls.length = 0;
    await prisma.voiceCall.deleteMany({ where: { userId: { in: [owner, other] } } });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [owner, other] } } });
    await prisma.$disconnect();
  });

  async function refusal(promise: Promise<unknown>): Promise<{ status: number; code?: unknown }> {
    try {
      await promise;
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      const body = error.getResponse();
      return {
        status: error.getStatus(),
        code:
          typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined,
      };
    }
    throw new Error('expected a refusal');
  }

  it('starts a call as the bot, in its voice, capped at what the period has left', async () => {
    const started = await calls.start(owner, botId, NOW);
    expect(started.remainingSeconds).toBe(1800);
    expect(started.signedUrl).toMatch(/^wss:\/\//);
    expect(started.overrides).toEqual({
      prompt: relayPrompt('Quill'),
      firstMessage: "Hi, it's Quill.",
      voiceId: 'voice-quill',
      maxDurationSeconds: 1800,
    });
    expect(started.overrides.prompt).toContain('ask_bot');
    const row = await prisma.voiceCall.findFirst({ where: { id: started.callId, userId: owner } });
    expect(row).toMatchObject({
      botId,
      reservedSeconds: 1800,
      periodStart: PERIOD.start,
      conversationId: conversation,
    });
  });

  it("opens and speaks in the person's language, and keeps the instructions English (D-234)", async () => {
    await prisma.userSettings.upsert({
      where: { userId: owner },
      create: { userId: owner, language: 'pt' },
      update: { language: 'pt' },
    });
    try {
      const started = await calls.start(owner, botId, NOW);
      expect(started.overrides.firstMessage).toBe('Oi, aqui é Quill.');
      expect(started.overrides.language).toBe('pt-br');
      expect(started.overrides.prompt).toContain('Speak Portuguese on this call');
      // The relay phrases the desktop sends are matched in English.
      expect(started.overrides.prompt).toContain('Read this answer to the user');
    } finally {
      await prisma.userSettings.deleteMany({ where: { userId: owner } });
    }
  });

  it('binds a call to the conversation its URL starts, and refuses any other', async () => {
    const started = await calls.start(owner, botId, NOW);
    const bound = conversation;
    // The client's report of the same conversation is accepted...
    await calls.update(owner, started.callId, { conversationId: bound }, at(1));
    // ...and a shorter one of its choosing is not.
    durations.set('conv_short', 4);
    expect(
      (await refusal(calls.update(owner, started.callId, { conversationId: 'conv_short' }, at(2))))
        .status,
    ).toBe(409);
    durations.set(bound, 1500);
    const ended = await calls.update(owner, started.callId, { ended: true }, at(1500));
    expect(ended).toMatchObject({ conversationId: bound, durationSeconds: 1500 });
  });

  it('settles a call the client never reported to its own conversation, not to zero', async () => {
    const started = await calls.start(owner, botId, NOW);
    durations.set(conversation, 1500);
    const ended = await calls.update(owner, started.callId, { ended: true }, at(1500));
    expect(ended.durationSeconds).toBe(1500);
  });

  it('charges a client that ends the call first and connects afterwards', async () => {
    const started = await calls.start(owner, botId, NOW);
    durations.set(conversation, 'missing');
    const ended = await calls.update(owner, started.callId, { ended: true }, at(5));
    // Nobody has connected yet, but the URL still could: not settled.
    expect(ended.durationSeconds).toBeNull();
    durations.set(conversation, 900);
    expect((await calls.allowance(owner, at(1000))).usedSeconds).toBe(900);
  });

  it('speaks in the house voice for a bot with none of its own', async () => {
    const started = await calls.start(other, otherBotId, NOW);
    expect(started.overrides.voiceId).toBe(HOUSE_VOICE_ID);
  });

  it('refuses a plan with no call minutes before asking ElevenLabs for anything', async () => {
    limitSeconds = 0;
    expect(await refusal(calls.start(owner, botId, NOW))).toEqual({
      status: 402,
      code: CALL_PLAN_REQUIRED_CODE,
    });
    expect(agentCalls).toEqual([]);
  });

  it('allows one open call at a time', async () => {
    await calls.start(owner, botId, NOW);
    expect((await refusal(calls.start(owner, botId, at(30)))).status).toBe(409);
  });

  it('settles an ended call to ElevenLabs’ own count, not the time the client saw', async () => {
    const started = await calls.start(owner, botId, NOW);
    durations.set(conversation, 21);
    const ended = await calls.update(owner, started.callId, { ended: true }, at(300));
    expect(ended).toMatchObject({ conversationId: conversation, durationSeconds: 21 });
    expect(await calls.allowance(owner, at(301))).toEqual({ limitSeconds: 1800, usedSeconds: 21 });
  });

  it('counts an open call as its elapsed time, and asks ElevenLabs nothing about it', async () => {
    await calls.start(owner, botId, NOW);
    agentCalls.length = 0;
    expect((await calls.allowance(owner, at(90))).usedSeconds).toBe(90);
    expect(agentCalls).toEqual([]);
  });

  it('owes nothing for a call that never connected, once its URL has expired', async () => {
    const started = await calls.start(owner, botId, NOW);
    durations.set(conversation, 'missing');
    const ended = await calls.update(owner, started.callId, { ended: true }, at(5));
    expect(ended.durationSeconds).toBeNull();
    // Counted to its end meanwhile, not to the clock.
    expect((await calls.allowance(owner, at(60))).usedSeconds).toBe(5);
    expect((await calls.allowance(owner, at(AFTER_CONNECT_WINDOW))).usedSeconds).toBe(0);
    // And a forgotten one settles the same way once it is clearly dead.
    const later = AFTER_CONNECT_WINDOW + 10;
    await calls.start(owner, botId, at(later));
    durations.set(conversation, 'missing');
    expect((await calls.allowance(owner, at(later + AFTER_CONNECT_WINDOW))).usedSeconds).toBe(0);
  });

  it('holds a row with no conversation at its reservation', async () => {
    const row = await prisma.voiceCall.create({
      data: {
        userId: owner,
        botId,
        periodStart: PERIOD.start,
        reservedSeconds: 1200,
        startedAt: NOW,
        endedAt: at(5),
      },
    });
    expect((await calls.allowance(owner, at(10))).usedSeconds).toBe(1200);
    expect(await prisma.voiceCall.findFirst({ where: { id: row.id } })).toMatchObject({
      durationSeconds: 1200,
    });
  });

  it('keeps an ended call open while ElevenLabs cannot answer, then settles it', async () => {
    const started = await calls.start(owner, botId, NOW);
    const bound = conversation;
    agentDown = true;
    const ended = await calls.update(owner, started.callId, { ended: true }, at(60));
    expect(ended.durationSeconds).toBeNull();
    expect((await calls.allowance(owner, at(61))).usedSeconds).toBe(60);
    agentDown = false;
    durations.set(bound, 58);
    expect((await calls.allowance(owner, at(120))).usedSeconds).toBe(58);
  });

  it('holds a call ElevenLabs never reports at its reservation, past the ceiling', async () => {
    await calls.start(owner, botId, NOW);
    const later = CALL_CEILING_SECONDS + 11 * 60;
    expect((await calls.allowance(owner, at(later))).usedSeconds).toBe(1800);
  });

  it('refuses once the minutes are spent, and caps the next call at what is left', async () => {
    limitSeconds = 600;
    const first = await calls.start(owner, botId, NOW);
    expect(first.overrides.maxDurationSeconds).toBe(600);
    durations.set(conversation, 450);
    await calls.update(owner, first.callId, { ended: true }, at(450));

    const second = await calls.start(owner, botId, at(500));
    expect(second).toMatchObject({ remainingSeconds: 150 });
    expect(second.overrides.maxDurationSeconds).toBe(150);
    durations.set(conversation, 150);
    await calls.update(owner, second.callId, { ended: true }, at(651));

    expect(await refusal(calls.start(owner, botId, at(700)))).toEqual({
      status: 402,
      code: CALL_ALLOWANCE_USED_CODE,
    });
  });

  it('gives a plan with no limit its full ceiling per call', async () => {
    limitSeconds = null;
    const started = await calls.start(owner, botId, NOW);
    expect(started.remainingSeconds).toBeNull();
    expect(started.overrides.maxDurationSeconds).toBe(CALL_CEILING_SECONDS);
  });

  it('answers 502 when ElevenLabs cannot mint a call, and records nothing', async () => {
    agentDown = true;
    expect((await refusal(calls.start(owner, botId, NOW))).status).toBe(502);
    expect(await prisma.voiceCall.count({ where: { userId: owner } })).toBe(0);
  });

  it('never reads, ends or counts another person’s call', async () => {
    const theirs = await calls.start(other, otherBotId, NOW);
    expect((await refusal(calls.update(owner, theirs.callId, { ended: true }, at(5)))).status).toBe(
      404,
    );
    expect((await refusal(calls.start(owner, otherBotId, NOW))).status).toBe(404);
    // Theirs is still open, and the owner's minutes do not include it.
    expect(await prisma.voiceCall.findFirst({ where: { id: theirs.callId } })).toMatchObject({
      endedAt: null,
    });
    expect((await calls.allowance(owner, at(60))).usedSeconds).toBe(0);
    expect((await calls.allowance(other, at(60))).usedSeconds).toBe(60);
  });
});
