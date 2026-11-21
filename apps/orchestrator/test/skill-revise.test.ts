import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from './model-resolution-fake.js';
import type { MockLanguageModelV4 as LanguageModel } from './model-resolution-fake.js';

import { SkillReviseService } from '../src/skills/skill-revise.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
// A value import, not `import type`: the `vi.mock` above replaces this class,
// and a type-only import would leave the real one (or nothing) in scope here.
import { ModelResolutionService } from '../src/models/model-resolution.service.js';
import { resolvedTextModelOf } from './model-resolution-fake.js';
import type { ResolvedModel, ResolvedTextModel } from '../src/models/model-resolution.service.js';

/**
 * D-098 — `POST /skills/:id/revise`, the plain-language edit.
 *
 * The unit suite exists for the same reason `skill-compile.test.ts` does: what
 * the model is asked and what its answer is allowed to become are decisions,
 * and they can be asserted without a queue, a recording, or a live provider in
 * the way. The stub is the AI SDK's `MockLanguageModelV4` through the same
 * `ModelResolutionService` seam the compile suite uses (D-086 made resolution
 * owner-scoped, so it is a service read rather than a module function).
 */
const { resolveModel } = vi.hoisted(() => ({ resolveModel: vi.fn() }));
vi.mock('../src/models/model-resolution.service.js', async () => ({
  ...(await vi.importActual<object>('../src/models/model-resolution.service.js')),
  ModelResolutionService: class {
    // The arguments are FORWARDED into the hoisted mock rather than dropped:
    // "which model id was resolved for which owner" is part of what this
    // service decides, so the cases below assert on it.
    resolve = (userId: string, modelId: string): Promise<ResolvedModel> =>
      Promise.resolve({
        model: resolveModel(userId, modelId) as LanguageModel,
        capabilities: { vision: false },
        modelId,
      });
    resolveText = (userId: string, modelId: string): Promise<ResolvedTextModel> =>
      Promise.resolve({
        ...resolvedTextModelOf(resolveModel(userId, modelId) as LanguageModel),
        modelId,
      });
    setAddressResolverForTests = (): void => {};
  },
}));

/** The mocked `ModelResolutionService` (see the `vi.mock` above). */
function models(): ModelResolutionService {
  return new ModelResolutionService(undefined as never, undefined as never);
}

/** The answer a model returns for the happy path. */
const ANSWER = {
  name: 'search_the_web',
  description: 'Searches for a term with Firefox and opens the first result.',
  params: [{ name: 'query', type: 'string', description: 'what to search for', required: true }],
  steps: ['Open Firefox.', 'Type the search term.', 'Press Enter.'],
  script: 'export default async function run(ctx, params) { await ctx.type(params.query); }',
};

interface StoredSkill {
  id: string;
  botId: string | null;
  name: string;
  description: string;
  paramsSchema: unknown;
  steps: unknown;
  script: string;
  version: number;
  status: string;
  sourceRecordingId: string | null;
}

function storedSkill(over: Partial<StoredSkill> = {}): StoredSkill {
  return {
    id: 'skill-1',
    botId: 'bot-1',
    name: 'search_the_web',
    description: 'Searches for a term.',
    paramsSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'what to search for' } },
      required: ['query'],
      additionalProperties: false,
    },
    steps: ['Open Chrome.', 'Type the search term.', 'Press Enter.'],
    script: 'export default async function run(ctx, params) { await ctx.click(10, 20); }',
    version: 1,
    status: 'DRAFT',
    sourceRecordingId: null,
    ...over,
  };
}

function setup(
  options: {
    skill?: StoredSkill | null;
    botModelId?: string | null;
    transactionFailures?: readonly ('P2002' | 'P2034')[];
  } = {},
) {
  const skill = options.skill === undefined ? storedSkill() : options.skill;
  const created: Record<string, unknown>[] = [];

  const skillFindFirst = vi.fn(() => Promise.resolve(skill));
  const botFindFirst = vi.fn(() =>
    Promise.resolve(
      options.botModelId === null
        ? null
        : { modelId: options.botModelId ?? 'openrouter:test-model' },
    ),
  );
  const client = {
    skill: {
      findFirst: skillFindFirst,
      create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `skill-${created.length + 2}`, createdAt: new Date(), ...data };
        created.push(row);
        return Promise.resolve(row);
      }),
    },
    bot: { findFirst: botFindFirst },
  };
  const transactionFailures = [...(options.transactionFailures ?? [])];
  const transaction = vi.fn((fn: (tx: unknown) => Promise<unknown>) => {
    const code = transactionFailures.shift();
    if (code !== undefined) return Promise.reject({ code });
    return fn(client);
  });
  const prisma = {
    ...client,
    $transaction: transaction,
  } as unknown as PrismaService;

  const service = new SkillReviseService(prisma, models());
  return { service, created, skillFindFirst, botFindFirst, transaction };
}

/** A model that answers from `next()`, recording what each call was asked. */
function modelAnswering(next: () => unknown) {
  const calls: { prompt: unknown }[] = [];
  resolveModel.mockReturnValue(
    new MockLanguageModelV4({
      doGenerate: async (options) => {
        calls.push({ prompt: options.prompt });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(next()) }],
          finishReason: 'stop' as const,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        };
      },
    }),
  );
  return calls;
}

/** One role's text from the nth call, joined across its parts. */
function textOf(calls: { prompt: unknown }[], role: string, index = 0): string {
  const messages = calls[index]?.prompt as { role: string; content: unknown }[];
  const content = messages.find((message) => message.role === role)?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part as { text?: string }).text ?? '').join('\n');
  }
  return '';
}

beforeEach(() => {
  resolveModel.mockReset();
});

describe('SkillReviseService — what the model is asked', () => {
  it('sends the skill as it stands, the instruction, and the fixed-name rule', async () => {
    const { service } = setup();
    const calls = modelAnswering(() => ANSWER);

    await service.revise('user-1', 'skill-1', 'Use Firefox instead of Chrome.');

    const task = textOf(calls, 'user');
    expect(task).toContain('Use Firefox instead of Chrome.');
    // The current state travels whole: the model is editing bytes it cannot
    // otherwise see, and the summary is the half it must keep true.
    expect(task).toContain('name: search_the_web');
    expect(task).toContain('await ctx.click(10, 20)');
    expect(task).toContain('1. Open Chrome.');
    expect(task).toContain('what to search for');
    // The name lock is a rule, not a request, and the §6 timing rule rides
    // every prompt that can write a script.
    expect(textOf(calls, 'system')).toMatch(/name is fixed/i);
    expect(textOf(calls, 'system')).toContain('Waits are predicates, never durations');
  });

  it('resolves the bot’s model', async () => {
    const withBot = setup({ botModelId: 'openai:gpt-5' });
    modelAnswering(() => ANSWER);
    await withBot.service.revise('user-1', 'skill-1', 'Wait longer.');
    expect(withBot.botFindFirst).toHaveBeenCalledWith({
      where: { id: 'bot-1', userId: 'user-1' },
      select: { modelId: true },
    });
    expect(resolveModel).toHaveBeenCalledWith('user-1', 'openai:gpt-5');
  });

  it('does not expose a global skill through a bot-owned route', async () => {
    const { service, botFindFirst } = setup({ skill: storedSkill({ botId: null }) });
    const calls = modelAnswering(() => ANSWER);

    await expect(service.revise('user-1', 'skill-1', 'Wait longer.')).rejects.toMatchObject({
      status: 404,
    });
    expect(botFindFirst).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('never asks a model for a skill the caller does not own', async () => {
    const { service } = setup({ skill: null });
    const calls = modelAnswering(() => ANSWER);

    await expect(service.revise('user-1', 'skill-1', 'Use Firefox.')).rejects.toMatchObject({
      status: 404,
    });
    expect(calls).toHaveLength(0);
  });
});

describe('SkillReviseService — what a revision may become', () => {
  it('writes the next version, DRAFT, with the model’s script, summary and schema', async () => {
    const { service, created } = setup({
      skill: storedSkill({ version: 4, sourceRecordingId: 'rec-9' }),
    });
    modelAnswering(() => ANSWER);

    const row = await service.revise('user-1', 'skill-1', 'Use Firefox.');

    expect(created).toHaveLength(1);
    expect(row).toMatchObject({
      botId: 'bot-1',
      name: 'search_the_web',
      version: 5,
      status: 'DRAFT',
      script: ANSWER.script,
      steps: ANSWER.steps,
      description: ANSWER.description,
      sourceRecordingId: 'rec-9',
    });
    // §6 asks for the parameter list; §3 stores the assembled schema.
    expect((row as { paramsSchema: unknown }).paramsSchema).toEqual({
      type: 'object',
      properties: { query: { type: 'string', description: 'what to search for' } },
      required: ['query'],
      additionalProperties: false,
    });
  });

  it.each(['P2034', 'P2002'] as const)(
    'retries a concurrent version allocation after %s',
    async (code) => {
      const { service, created, transaction } = setup({ transactionFailures: [code] });
      modelAnswering(() => ANSWER);

      const row = await service.revise('user-1', 'skill-1', 'Use Firefox.');

      expect(row).toMatchObject({ version: 2, status: 'DRAFT' });
      expect(created).toHaveLength(1);
      expect(transaction).toHaveBeenCalledTimes(2);
      expect(transaction.mock.calls[1]?.[1]).toEqual({ isolationLevel: 'Serializable' });
    },
  );

  it('retries once when the answer is unusable, and stores the repair', async () => {
    const { service, created } = setup();
    const answers = [
      // The first waits by sleeping — M3-BE-07's rule — so the validator
      // refuses it and the retry has to carry the defect back.
      { ...ANSWER, script: 'await sleep(500);' },
      { ...ANSWER, script: 'export default async () => 1;' },
    ];
    let index = 0;
    const calls = modelAnswering(() => answers[index++]);

    const row = await service.revise('user-1', 'skill-1', 'Use Firefox.');

    expect(calls).toHaveLength(2);
    expect(textOf(calls, 'user', 1)).toContain('sleep(');
    expect((row as { script: string }).script).toBe(answers[1]!.script);
    expect(created).toHaveLength(1);
  });

  it('refuses a revision that renames the skill, after naming the rule once', async () => {
    const { service, created } = setup();
    const calls = modelAnswering(() => ({ ...ANSWER, name: 'search_the_web_v2' }));

    await expect(service.revise('user-1', 'skill-1', 'Use Firefox.')).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('search_the_web'),
    });

    // Two attempts — the retry names the offending rename — and no row.
    expect(calls).toHaveLength(2);
    expect(textOf(calls, 'user', 1)).toContain('must stay "search_the_web"');
    expect(created).toHaveLength(0);
  });

  it('turns a provider failure into 503, and writes nothing', async () => {
    const { service, created } = setup();
    resolveModel.mockReturnValue(
      new MockLanguageModelV4({
        doGenerate: () => Promise.reject(new Error('invalid x-api-key: sk-proj-LEAKED-SECRET')),
      }),
    );

    await expect(service.revise('user-1', 'skill-1', 'Use Firefox.')).rejects.toMatchObject({
      status: 503,
    });
    expect(created).toHaveLength(0);
  });
});
