import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from './model-resolution-fake.js';
import type { WebSocket } from 'ws';
import { ServerFrameSchema } from '@crewaid/shared';

import { TurnEventBus } from '../src/agent/turn-event.bus.js';
import { SINGLETON_USER_ID } from '../src/auth/singleton-user.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SkillCompileService } from '../src/skills/skill-compile.service.js';
import type { MockLanguageModelV4 as LanguageModel } from './model-resolution-fake.js';
import type { ResolvedTextModel } from '../src/models/model-resolution.service.js';
import { resolvedTextModelOf } from './model-resolution-fake.js';
import { ModelResolutionService } from '../src/models/model-resolution.service.js';

/**
 * M3-QA-05 — §6/M3's required integration test, as a test:
 *
 *   "Integration with a stubbed model: fixture trace in, fixture skill out,
 *    persisted, `skill.compiled` emitted on WS."
 *
 * Real PostgreSQL (persistence and the recording fence are rows), the real
 * `TurnEventBus` (the frame under test is the one the wire gets), and a
 * STUBBED model — `resolveModel` is replaced by the AI SDK's
 * `MockLanguageModelV4` through the same seam the unit suite uses, because
 * §6's question here is the flow, not a provider. The committed
 * `skill-compile.test.ts` covers the same flow against a fake Prisma and a
 * mocked bus; what this suite adds is that the flow holds when the writes are
 * real and the frame actually leaves through the §4.2 path.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const RUN_ID = randomUUID().slice(0, 8);
const BOT_NAME = `m3qa05-${RUN_ID}`;

const ANSWER = {
  name: 'search_the_web',
  description: 'Searches for a term and opens the first result.',
  params: [{ name: 'query', type: 'string', description: 'what to search for', required: true }],
  // D-098: the summary the review surface opens on; the validator refuses an
  // answer without one, so the fixture carries it like a real compile's.
  steps: ['Open Chrome.', 'Type the search term.', 'Press Enter.'],
  script: 'export default async function run(ctx, params) { await ctx.type(params.query); }',
};

/** The fixture skill §3 will store once the validator has assembled the list. */
const PARAMS_SCHEMA = {
  type: 'object',
  properties: { query: { type: 'string', description: 'what to search for' } },
  required: ['query'],
  additionalProperties: false,
};

/** The fixture trace: two X11 events, exactly what the unit suite compiles. */
const TRACE = [
  {
    tsOffsetMs: 0,
    type: 'pointer',
    payload: { x: 640, y: 400, buttonMask: 1 },
    screenshotKey: null,
  },
  { tsOffsetMs: 120, type: 'type', payload: { text: 'otters' }, screenshotKey: null },
];

/**
 * V1-06: the model stub moved from `model-registry.js`'s `resolveModel` export
 * to `ModelResolutionService.resolve` — D-086 made resolution owner-scoped, so
 * it is a service that reads rows rather than a module-level function.
 *
 * The seam keeps its shape on purpose: cases still say
 * `resolveModel.mockReturnValue(model)`, and `resolvedTextModelOf` wraps whatever
 * that returns in the envelope the real service produces. `importActual`
 * preserves the module's error classes, which callers branch on.
 */
const { resolveModel } = vi.hoisted(() => ({ resolveModel: vi.fn() }));
vi.mock('../src/models/model-resolution.service.js', async () => ({
  ...(await vi.importActual<object>('../src/models/model-resolution.service.js')),
  ModelResolutionService: class {
    resolveText = (): Promise<ResolvedTextModel> =>
      Promise.resolve(resolvedTextModelOf(resolveModel() as LanguageModel));
    setAddressResolverForTests = (): void => {};
  },
}));

/**
 * The mocked `ModelResolutionService` (see the `vi.mock` above). Constructed
 * per use rather than shared: it is stateless, and a shared instance is one
 * more thing a case could accidentally come to depend on.
 */
function models(): ModelResolutionService {
  // The mock class ignores both arguments; the real one needs them. Passing
  // them explicitly keeps the call site honest about that.
  return new ModelResolutionService(undefined as never, undefined as never);
}

/** The wire side of the bus: the same fake the bus's own suite listens with. */
class FakeClient extends EventEmitter {
  readonly readyState = 1;
  readonly frames: string[] = [];

  send(frame: string): void {
    this.frames.push(frame);
  }
}

/** The user turn's text, and the bytes of every image attached to it. */
function askedFor(prompt: unknown): { text: string; images: string[] } {
  const messages = prompt as { role: string; content: unknown }[];
  const user = messages.find((m) => m.role === 'user');
  const parts = (user?.content ?? []) as { type: string; text?: string; data?: unknown }[];
  const text = parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('\n');
  const images = parts
    .filter((p) => p.type === 'file' || p.type === 'image')
    .map((p) => {
      const wrapper = p.data as { data?: unknown };
      const bytes = (wrapper.data ?? p.data) as Uint8Array;
      return Buffer.from(bytes).toString('utf8');
    });
  return { text, images };
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'M3-QA-05 — fixture trace to skill.compiled over the real stack (real db, stub model)',
  () => {
    let prisma: PrismaService;
    let bus: TurnEventBus;
    let client: FakeClient;
    let service: SkillCompileService;
    let botId: string;
    let recordingId: string;
    const modelCalls: { prompt: unknown }[] = [];

    beforeAll(async () => {
      prisma = new PrismaService();
      await prisma.$connect();
      await prisma.user.upsert({
        where: { id: SINGLETON_USER_ID },
        create: {
          id: SINGLETON_USER_ID,
          name: 'Test User',
          email: `${SINGLETON_USER_ID}@test.invalid`,
        },
        update: {},
      });

      const bot = await prisma.bot.create({
        data: {
          userId: SINGLETON_USER_ID,
          name: BOT_NAME,
          role: 'QA fixture',
          avatarColor: '#123456',
          systemPrompt: 'fixture',
        },
      });
      botId = bot.id;

      // The resolution the trace's coordinates were captured at (§6: "the
      // sandbox resolution") — without it the compile refuses instead of
      // guessing (§5.1's 1280x800 is not this bot's truth).
      await prisma.sandbox.create({
        data: {
          id: botId,
          userId: (await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).userId,
          bots: { connect: { id: botId } },
          widthPx: 1280,
          heightPx: 800,
        },
      });

      const recording = await prisma.recording.create({
        data: {
          botId,
          state: 'COMPILING',
          intent: 'search for otters',
          endedAt: new Date(),
        },
      });
      recordingId = recording.id;
      await prisma.recordingEvent.createMany({
        data: TRACE.map((event) => ({ recordingId, layer: 'X11' as const, ...event })),
      });
    });

    afterAll(async () => {
      // A Skill survives its bot (botId is SetNull), so it goes first; the bot
      // delete cascades the recording, its events and the sandbox row.
      await prisma?.skill.deleteMany({ where: { botId } }).catch(() => undefined);
      await prisma?.bot.deleteMany({ where: { id: botId } }).catch(() => undefined);
      await prisma?.$disconnect();
    }, 30_000);

    beforeEach(() => {
      modelCalls.length = 0;
      resolveModel.mockReset();
      resolveModel.mockReturnValue(
        new MockLanguageModelV4({
          doGenerate: async (options) => {
            modelCalls.push({ prompt: options.prompt });
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(ANSWER) }],
              finishReason: 'stop' as const,
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              warnings: [],
            };
          },
        }),
      );
      bus = new TurnEventBus(prisma);
      client = new FakeClient();
      bus.add(client as unknown as WebSocket, {
        userId: () => SINGLETON_USER_ID,
        expired: () => undefined,
      });
      service = new SkillCompileService(prisma, bus, models());
    });

    it('fixture trace in, fixture skill out, persisted, skill.compiled emitted on WS', async () => {
      await service.run(recordingId);

      // 1) Persisted: the recording settled READY, no operator error.
      const recording = await prisma.recording.findUniqueOrThrow({ where: { id: recordingId } });
      expect(recording.state).toBe('READY');
      expect(recording.error).toBeNull();

      // 2) Persisted: exactly one DRAFT skill row, assembled from the answer.
      const skills = await prisma.skill.findMany({ where: { botId, name: ANSWER.name } });
      expect(skills).toHaveLength(1);
      const skill = skills[0];
      expect(skill).toMatchObject({
        botId,
        name: ANSWER.name,
        description: ANSWER.description,
        script: ANSWER.script,
        version: 1,
        status: 'DRAFT',
        sourceRecordingId: recordingId,
      });
      expect(skill?.paramsSchema).toEqual(PARAMS_SCHEMA);

      // 3) Emitted on WS: two frames through the real bus, the second `skill.compiled`.
      // TurnEventBus resolves the bot's owner asynchronously on the first frame, so
      // wait for both frames to flush before asserting.
      await vi.waitFor(() => {
        expect(client.frames).toHaveLength(2);
      });
      const frames = client.frames.map((raw) => ServerFrameSchema.parse(JSON.parse(raw)));
      expect(frames.map((frame) => frame.type)).toEqual(['recording.state', 'skill.compiled']);
      const compiled = frames[1];
      expect(compiled?.botId).toBe(botId);
      expect(compiled?.payload).toEqual({ recordingId, skillId: skill?.id, name: ANSWER.name });

      // 4) Fixture trace IN: the stub saw the intent, the resolution and the
      //    rendered trace rows — one call, no judgement (the capture was not
      //    truncated, so there is nothing to judge).
      expect(modelCalls).toHaveLength(1);
      const { text } = askedFor(modelCalls[0]?.prompt);
      expect(text).toContain('search for otters');
      expect(text).toContain('1280x800');
      expect(text).toContain('{"ms":120,"type":"type","text":"otters"}');
    });
  },
);
