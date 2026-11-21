import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { PolicyProposalSchema } from '../src/agent/policy/proposal-store.js';

/**
 * A user turn through `POST /bots/:id/chat`, the one route a person's message
 * takes since the §4.1 message routes went with the AI SDK engine (D-199).
 *
 * The body is what `@tanstack/ai-client` sends; the response is the run's
 * AG-UI stream, which supertest reads to its end — so an awaited send is a
 * run that has finished streaming, the way the old route's awaited turn was.
 */
export function chatBody(threadId: string, content: string, id = `u-${randomUUID()}`) {
  return {
    threadId,
    runId: `run-${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    messages: [{ id, role: 'user', content }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  };
}

/** The bot's thread id: its one conversation. */
export async function threadOf(
  prisma: Pick<PrismaClient, 'conversation'>,
  botId: string,
): Promise<string> {
  const conversation = await prisma.conversation.findUniqueOrThrow({
    where: { botId },
    select: { id: true },
  });
  return conversation.id;
}

export async function sendChat(
  server: Parameters<typeof request>[0],
  options: {
    readonly prisma: Pick<PrismaClient, 'conversation'>;
    readonly headers: Record<string, string>;
    readonly botId: string;
    readonly content: string;
    /** The route's prefix, `/api/v1` unless the app sets none. */
    readonly prefix?: string;
  },
) {
  const threadId = await threadOf(options.prisma, options.botId);
  const body = chatBody(threadId, options.content);
  const response = await request(server)
    .post(`${options.prefix ?? '/api/v1'}/bots/${options.botId}/chat`)
    .set(options.headers)
    .send(body);
  return { response, body, threadId };
}

/**
 * The question a parked run is waiting on, as the operator is asked it: the
 * pending approval of the bot's newest interrupted run, or null.
 */
export async function pendingApproval(
  prisma: Pick<PrismaClient, 'conversation' | 'agentTurn'>,
  botId: string,
) {
  const threadId = await threadOf(prisma, botId);
  const parked = await prisma.agentTurn.findFirst({
    where: { conversationId: threadId, status: 'interrupted' },
    orderBy: { startedAt: 'desc' },
    select: {
      id: true,
      interrupts: {
        where: { status: 'pending' },
        orderBy: { sequence: 'asc' },
        select: { nativeInterruptId: true, payload: true },
      },
    },
  });
  const interrupt = parked?.interrupts[0];
  if (parked == null || interrupt === undefined) return null;
  return {
    runId: parked.id,
    interruptId: interrupt.nativeInterruptId,
    /** The proposal the operator is shown: the call, its arguments, its binding. */
    request: PolicyProposalSchema.parse(interrupt.payload),
  };
}

/**
 * An operator's answer to the newest parked run: a continuation through the
 * same route, resuming every pending interrupt with `answer` (D-160). Awaited
 * to the end of its stream, so the continuation has run.
 */
export async function answerChat(
  server: Parameters<typeof request>[0],
  options: {
    readonly prisma: Pick<PrismaClient, 'conversation' | 'agentTurn'>;
    readonly headers: Record<string, string>;
    readonly botId: string;
    readonly answer: { readonly approved: boolean; readonly reason?: string };
    readonly prefix?: string;
  },
) {
  const threadId = await threadOf(options.prisma, options.botId);
  const parked = await options.prisma.agentTurn.findFirstOrThrow({
    where: { conversationId: threadId, status: 'interrupted' },
    orderBy: { startedAt: 'desc' },
    select: {
      id: true,
      interrupts: { where: { status: 'pending' }, select: { nativeInterruptId: true } },
    },
  });
  const body = {
    ...chatBody(threadId, ''),
    messages: [],
    parentRunId: parked.id,
    resume: parked.interrupts.map((interrupt) => ({
      interruptId: interrupt.nativeInterruptId,
      status: 'resolved',
      payload: options.answer,
    })),
  };
  const response = await request(server)
    .post(`${options.prefix ?? '/api/v1'}/bots/${options.botId}/chat`)
    .set(options.headers)
    .send(body);
  return { response, runId: body.runId };
}
