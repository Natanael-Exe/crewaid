/**
 * @skip-reason: on-demand real-token comparison; requires MODAI05_REAL_MODEL,
 * EVAL_API_KEY_<KIND> and DATABASE_URL. Fixture proposals/runs, real owned BYOK resolver,
 * real provider, real library engine and real Prisma transcript. No restart/billing claim.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EventType } from '@tanstack/ai';
import { z } from 'zod';
import { ProviderKindSchema } from '@crewaid/shared';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { CredentialService } from '../src/credentials/credential.service.js';
import { ModelResolutionService } from '../src/models/model-resolution.service.js';
import { toDbKind } from '../src/providers/provider-connections.service.js';
import type { ExecutionOutcome } from '../src/agent/execution/execution-backend.port.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';
import { prismaExecutionFixture } from './mod-ai05-prisma-harness.js';

const MODEL = process.env['MODAI05_REAL_MODEL'] ?? '';
const OUT = process.env['MODAI05_REAL_OUT'];
const DATABASE_URL = process.env['DATABASE_URL'];
const records: Array<{
  shape: string;
  status: string;
  finishReason: string | null;
  ms: number;
  effects: number;
  rows: number;
  toolOutputs: string[];
  modelCallIds: string[];
  usage: ExecutionOutcome['usage'];
}> = [];
describe.skipIf(!MODEL || !DATABASE_URL)(
  'MOD-AI-05 real BYOK comparison against MOD-03 behavior baseline',
  () => {
    const prisma = new PrismaService();
    let owner: SignedInUser;
    let models: ModelResolutionService;
    let modelId: string;
    beforeAll(async () => {
      vi.stubEnv('CREWAID_CREDENTIAL_KEYRING', JSON.stringify({ 1: '8'.repeat(64) }));
      vi.stubEnv('CREWAID_CREDENTIAL_KEY_ACTIVE', '1');
      await prisma.$connect();
      owner = await signIn(prisma, { label: 'modai05real' });
      const separator = MODEL.indexOf(':');
      const kind = ProviderKindSchema.parse(MODEL.slice(0, separator));
      if (kind === 'custom' || kind === 'crewaid')
        throw new Error('real acceptance needs a built-in BYOK provider');
      const apiKey = process.env[`EVAL_API_KEY_${kind.toUpperCase()}`];
      if (!apiKey) throw new Error(`EVAL_API_KEY_${kind.toUpperCase()} is required`);
      const connection = await prisma.providerConnection.create({
        data: { userId: owner.userId, kind: toDbKind(kind), name: 'MOD-AI-05 controlled BYOK' },
      });
      const credentials = new CredentialService(prisma);
      await credentials.setCredential(owner.userId, connection.id, apiKey);
      const model = await prisma.providerModel.create({
        data: {
          connectionId: connection.id,
          upstreamModelId: MODEL.slice(separator + 1),
          label: 'Controlled real model',
          contextWindow: 200000,
          supportsTools: true,
        },
      });
      modelId = model.id;
      models = new ModelResolutionService(prisma, credentials);
    });
    afterAll(async () => {
      if (OUT) {
        const path = resolve(process.cwd(), '../..', OUT);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(
          path,
          JSON.stringify(
            {
              model: MODEL,
              recordedAt: new Date().toISOString(),
              node: process.version,
              baseline: 'docs/reviews/evidence/mod-03/real-model/',
              limits:
                'Real owned BYOK/provider/transcript; controlled proposals/run/interrupt/event-log fixtures. Behavior comparison, not MOD-AI-13 performance sign-off.',
              runs: records,
            },
            null,
            2,
          ) + '\n',
        );
      }
      if (owner) await signOutAndDelete(prisma, owner.userId);
      await prisma.$disconnect();
      vi.unstubAllEnvs();
    });
    async function setup(write = false) {
      const h = await prismaExecutionFixture(prisma, owner, {
        write,
        smallResult: true,
        dynamicCalls: true,
        resolveModel: ({ userId, modelRef }) => models.resolveText(userId, modelRef),
      });
      return {
        ...h,
        request: { ...h.request, model: { userId: owner.userId, modelRef: modelId }, maxSteps: 5 },
      };
    }
    async function record(
      shape: string,
      h: Awaited<ReturnType<typeof setup>>,
      outcome: ExecutionOutcome,
      started: number,
    ) {
      const rows = await prisma.message.count({ where: { conversationId: h.thread.id } });
      const toolRows = await prisma.message.findMany({
        where: { conversationId: h.thread.id, author: 'TOOL' },
        orderBy: { sequence: 'asc' },
      });
      records.push({
        shape,
        status: outcome.status,
        finishReason: outcome.finishReason,
        ms: Math.round(performance.now() - started),
        effects: h.effects.mock.calls.length,
        rows,
        toolOutputs: toolRows.map((row) => row.content.slice(0, 2048)),
        modelCallIds: [...h.f.proposals.values()].map((proposal) => proposal.toolCallId),
        usage: outcome.usage,
      });
      expect(
        await prisma.message.count({ where: { conversationId: h.thread.id, author: 'USER' } }),
      ).toBe(1);
      expect(
        h.events.filter(
          (event) => z.object({ type: z.string() }).parse(event).type === EventType.RUN_ERROR,
        ),
      ).toHaveLength(outcome.status === 'aborted' ? 1 : 0);
    }
    it('text answer without any computer or tool acquisition', async () => {
      const h = await setup();
      const started = performance.now();
      const outcome = await h.backend.execute({ ...h.request, tools: {} }, h.ports);
      await record('text', h, outcome, started);
      expect(outcome.status).toBe('completed');
      expect(outcome.finishReason).toBe('stop');
      expect(h.effects).not.toHaveBeenCalled();
    }, 180000);
    it('one read tool and a normal terminal answer', async () => {
      const h = await setup();
      const started = performance.now();
      const outcome = await h.backend.execute(h.request, h.ports);
      await record('read', h, outcome, started);
      expect(outcome.status).toBe('completed');
      expect(h.effects).toHaveBeenCalledTimes(1);
      expect(outcome.usage.reportedCalls).toBeGreaterThanOrEqual(2);
    }, 180000);
    it.each([
      ['reviewed-write', true, false],
      ['declined-write', false, false],
      ['edited-write', true, true],
    ] as const)(
      '%s pauses and continues the model call after an owned answer',
      async (shape, approved, edit) => {
        const h = await setup(true);
        const started = performance.now();
        const paused = await h.backend.execute(h.request, h.ports);
        expect(paused.status).toBe('interrupted');
        expect(h.effects).not.toHaveBeenCalled();
        const pending = await h.f.persistence.stores.interrupts.listPending(h.thread.id);
        expect(pending).toHaveLength(1);
        await prisma.agentTurn.update({ where: { id: h.run.id }, data: { status: 'interrupted' } });
        const continuation = await prisma.agentTurn.create({
          data: {
            botId: h.bot.id,
            conversationId: h.thread.id,
            triggerMessageId: h.request.triggerMessageId,
          },
        });
        const { modelId: _model, ...priorUsage } = paused.usage;
        h.budget.usage = priorUsage;
        h.budget.workingMs = paused.workingMs;
        const outcome = await h.backend.execute(
          {
            ...h.request,
            runId: continuation.id,
            parentRunId: h.run.id,
            resume: pending.map((record) => ({
              interruptId: record.interruptId,
              status: 'resolved',
              payload: { approved, ...(edit ? { editedArgs: { value: 'reviewed edit' } } : {}) },
            })),
          },
          h.ports,
        );
        await record(shape, h, outcome, started);
        expect(outcome.status).toBe('completed');
        expect(h.effects).toHaveBeenCalledTimes(approved ? 1 : 0);
        if (edit) expect(h.effects.mock.calls[0]?.[0]).toEqual({ value: 'reviewed edit' });
        const rows = await prisma.message.findMany({
          where: { conversationId: h.thread.id },
          orderBy: { sequence: 'asc' },
        });
        expect(rows.map((row) => row.author)).toEqual(['USER', 'BOT', 'TOOL', 'BOT']);
        expect(rows.find((row) => row.author === 'TOOL')?.parts).not.toBeNull();
        expect(rows.find((row) => row.author === 'TOOL')?.runId).toBe(h.run.id);
        expect(await h.f.persistence.stores.interrupts.listPending(h.thread.id)).toHaveLength(0);
      },
      180000,
    );
    it('an explicit deny remains a refusal and cannot perform a write', async () => {
      const h = await setup(true);
      const started = performance.now();
      h.f.state.snapshot.rules = [{ toolPattern: 'fixture_action', decision: 'deny' }];
      const outcome = await h.backend.execute(h.request, h.ports);
      await record('policy-deny', h, outcome, started);
      expect(outcome.status).toBe('completed');
      expect(h.effects).not.toHaveBeenCalled();
      expect(h.f.proposals.size).toBe(0);
    }, 180000);
    it('operator cancellation stops a real provider stream', async () => {
      const h = await setup();
      const started = performance.now();
      const controller = new AbortController();
      const outcome = await h.backend.execute(
        { ...h.request, tools: {} },
        {
          ...h.ports,
          signal: controller.signal,
          appendEvent: async (event) => {
            await h.ports.appendEvent(event);
            if (z.object({ type: z.string() }).parse(event).type === EventType.TEXT_MESSAGE_CONTENT)
              controller.abort();
          },
        },
      );
      await record('cancel', h, outcome, started);
      expect(controller.signal.aborted).toBe(true);
      expect(outcome.status).toBe('aborted');
      expect(h.effects).not.toHaveBeenCalled();
    }, 180000);
  },
);
