import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { botTools } from '../src/agent/bot-tools.js';
import type { ToolDefinition } from '../src/agent/tool-contract.js';
import type { ToolContext, ToolRegistry } from '../src/agent/tool-registry.js';
import { assembleTurn, type TurnAssemblyServices, type TurnBot } from '../src/agent/turn-assembly.js';
import { BotsService } from '../src/bots/bots.service.js';
import type { CredentialService } from '../src/credentials/credential.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { ProviderConnectionsService } from '../src/providers/provider-connections.service.js';
import type { SandboxProvider } from '../src/sandbox/sandbox.provider.js';
import type { SeatService } from '../src/sandbox/seat.service.js';
import type { TurnEventBus } from '../src/agent/turn-event.bus.js';

const USER = 'clx1a2b3c4d5e6f7g8h9i0j1';
const MODEL_CODER = 'clx4m5n6o7p8q9r0s1t2u3v4';
const MODEL_ACCOUNT = 'clx7h8i9j0k1l2m3n4o5p6q7';
const BOT_ID = 'clx9z8y7x6w5v4u3t2s1r0q9';

describe('ProviderConnectionsService codingModelId & reference integrity', () => {
  function makeService(prismaOverrides: Record<string, unknown>) {
    return new ProviderConnectionsService(
      prismaOverrides as unknown as PrismaService,
      {} as CredentialService,
    );
  }

  it('returns codingModelId: null when UserSettings row does not exist yet', async () => {
    const service = makeService({
      userSettings: { findFirst: vi.fn().mockResolvedValue(null) },
    });

    const settings = await service.settings(USER);
    expect(settings.codingModelId).toBeNull();
    expect(settings.defaultModelId).toBeNull();
  });

  it('validates ownership and supportsTools when saving UserSettings.codingModelId, and allows clearing to null', async () => {
    const findModel = vi.fn().mockResolvedValue({
      id: MODEL_CODER,
      supportsTools: true,
      connection: { kind: 'OPENAI' },
    });
    const upsert = vi.fn().mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({
      userId: USER,
      defaultModelId: null,
      codingModelId: (create['codingModelId'] as string | null | undefined) ?? null,
      language: null,
      timezone: null,
      systemLanguage: null,
      systemTimezone: null,
      updatedAt: new Date('2026-11-26T00:00:00Z'),
    }));

    const service = makeService({
      providerModel: { findFirst: findModel },
      userSettings: { upsert },
    });

    const saved = await service.updateSettings(USER, { codingModelId: MODEL_CODER });
    expect(saved.codingModelId).toBe(MODEL_CODER);

    const cleared = await service.updateSettings(USER, { codingModelId: null });
    expect(cleared.codingModelId).toBeNull();

    // Non-tool-capable model refused with 400
    findModel.mockResolvedValueOnce({
      id: MODEL_CODER,
      supportsTools: false,
      connection: { kind: 'OPENAI' },
    });
    await expect(service.updateSettings(USER, { codingModelId: MODEL_CODER })).rejects.toThrow(
      BadRequestException,
    );

    // Foreign/missing model refused with 404
    findModel.mockResolvedValueOnce(null);
    await expect(service.updateSettings(USER, { codingModelId: MODEL_CODER })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('refuses removing a model referenced by Bot.codingModelId or UserSettings.codingModelId', async () => {
    const providerModel = {
      findFirst: vi.fn().mockResolvedValue({
        id: MODEL_CODER,
        connection: { kind: 'OPENAI' },
      }),
      deleteMany: vi.fn(),
    };

    // Case 1: referenced by a bot's codingModelId
    const serviceBotRef = makeService({
      providerModel,
      bot: { findMany: vi.fn().mockResolvedValue([{ name: 'Builder' }]) },
      userSettings: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    await expect(serviceBotRef.removeModel(USER, MODEL_CODER)).rejects.toThrow(ConflictException);
    expect(providerModel.deleteMany).not.toHaveBeenCalled();

    // Case 2: referenced by UserSettings.codingModelId
    const serviceCodingRef = makeService({
      providerModel,
      bot: { findMany: vi.fn().mockResolvedValue([]) },
      userSettings: {
        findFirst: vi.fn().mockResolvedValue({
          defaultModelId: null,
          codingModelId: MODEL_CODER,
        }),
      },
    });
    await expect(serviceCodingRef.removeModel(USER, MODEL_CODER)).rejects.toThrow(
      /still your coding model/,
    );

    // Case 3: referenced by both defaultModelId and codingModelId
    const serviceBothRef = makeService({
      providerModel,
      bot: { findMany: vi.fn().mockResolvedValue([]) },
      userSettings: {
        findFirst: vi.fn().mockResolvedValue({
          defaultModelId: MODEL_CODER,
          codingModelId: MODEL_CODER,
        }),
      },
    });
    await expect(serviceBothRef.removeModel(USER, MODEL_CODER)).rejects.toThrow(
      /still your default and coding model/,
    );
  });
});

describe('BotsService & edit_bot codingModelId', () => {
  it('validates Bot.codingModelId on update (rejecting default alias and non-tool models) and allows clearing', async () => {
    const findBot = vi.fn().mockResolvedValue({ id: BOT_ID, userId: USER, kind: 'STANDARD' });
    const findModel = vi.fn();
    const updateBot = vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: BOT_ID,
      name: 'Builder',
      ...data,
    }));

    const service = new BotsService(
      {
        bot: { findFirst: findBot, update: updateBot },
        providerModel: { findFirst: findModel },
      } as unknown as PrismaService,
      {} as SandboxProvider,
      {} as SeatService,
      { emitBotsChanged: vi.fn() } as unknown as TurnEventBus,
    );

    // Tool-capable owned model succeeds
    findModel.mockResolvedValueOnce({ id: MODEL_CODER, supportsTools: true });
    const updated = await service.update(USER, BOT_ID, { codingModelId: MODEL_CODER });
    expect(updated.codingModelId).toBe(MODEL_CODER);

    // Clearing to null succeeds without querying providerModel
    const cleared = await service.update(USER, BOT_ID, { codingModelId: null });
    expect(cleared.codingModelId).toBeNull();

    // Non-tool-capable model rejected
    findModel.mockResolvedValueOnce({ id: MODEL_CODER, supportsTools: false });
    await expect(service.update(USER, BOT_ID, { codingModelId: MODEL_CODER })).rejects.toThrow(
      BadRequestException,
    );

    // Literal "default" alias rejected as codingModelId (must be a ProviderModel id or null)
    findModel.mockResolvedValueOnce(null);
    await expect(service.update(USER, BOT_ID, { codingModelId: 'default' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('passes codingModelId through edit_bot tool', async () => {
    const updateSpy = vi.fn().mockResolvedValue({ id: BOT_ID, name: 'Builder' });
    const editEntry = botTools({
      bots: {
        create: vi.fn(),
        update: updateSpy,
        remove: vi.fn(),
      },
    }).find((entry) => entry.name === 'edit_bot');
    expect(editEntry).toBeDefined();

    const built = editEntry!.build({
      userId: USER,
      botId: 'caller-bot',
    } as unknown as ToolContext) as ToolDefinition & {
      execute: (input: unknown, options: unknown) => Promise<string>;
    };

    const res = await built.execute({ botId: BOT_ID, codingModelId: MODEL_CODER }, {});
    expect(updateSpy).toHaveBeenCalledWith(USER, BOT_ID, { codingModelId: MODEL_CODER });
    expect(res).toContain('codingModelId');

    await built.execute({ botId: BOT_ID, codingModelId: null }, {});
    expect(updateSpy).toHaveBeenCalledWith(USER, BOT_ID, { codingModelId: null });
  });
});

describe('assembleTurn codingModelId cascade', () => {
  async function resolvedCodingModelFor(bot: Partial<TurnBot>): Promise<string | null | undefined> {
    let seenContext: ToolContext | undefined;
    const services = {
      prisma: {
        bot: { findMany: vi.fn().mockResolvedValue([]) },
      },
      tools: {
        resolveFor: (ctx: ToolContext) => {
          seenContext = ctx;
          return {
            tools: {},
            descriptors: [],
            byName: new Map(),
            refusals: [],
            behaviorOf: () => undefined,
          };
        },
      } as unknown as ToolRegistry,
      plugins: {
        toolsForBot: vi.fn().mockResolvedValue({
          tools: [],
          byName: new Map(),
          refusals: [],
          catalog: [],
        }),
      },
      computers: {},
      browsers: {},
      sessions: {},
      identities: {},
      seats: {},
      policyState: {},
      approvalHub: {},
    } as unknown as TurnAssemblyServices;

    await assembleTurn(services, {
      userId: USER,
      bot: {
        id: BOT_ID,
        name: 'Builder',
        role: 'Engineer',
        modelId: 'default',
        systemPrompt: 'Build things.',
        autoReviewRules: [],
        approvalMode: 'AUTO',
        sandboxId: null,
        group: null,
        ...bot,
      } as TurnBot,
      threadId: 'conv-1',
      runId: 'run-1',
      trigger: { id: 'msg-1', chainId: null, hopCount: 0 },
      attachmentHost: () => Promise.resolve('msg-1'),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      signal: new AbortController().signal,
    });

    return seenContext?.codingModelId;
  }

  it('prefers bot.codingModelId over UserSettings.codingModelId, falling back to null', async () => {
    // 1. Per-bot override beats account default
    expect(
      await resolvedCodingModelFor({
        codingModelId: MODEL_CODER,
        user: {
          settings: {
            language: null,
            timezone: null,
            systemLanguage: null,
            systemTimezone: null,
            codingModelId: MODEL_ACCOUNT,
          },
        },
      }),
    ).toBe(MODEL_CODER);

    // 2. Account coding model used when bot has no per-bot override
    expect(
      await resolvedCodingModelFor({
        codingModelId: null,
        user: {
          settings: {
            language: null,
            timezone: null,
            systemLanguage: null,
            systemTimezone: null,
            codingModelId: MODEL_ACCOUNT,
          },
        },
      }),
    ).toBe(MODEL_ACCOUNT);

    // 3. Neither set -> null (BuiltInCodingRunner falls back to bot.modelId)
    expect(
      await resolvedCodingModelFor({
        codingModelId: null,
        user: {
          settings: {
            language: null,
            timezone: null,
            systemLanguage: null,
            systemTimezone: null,
            codingModelId: null,
          },
        },
      }),
    ).toBeNull();
  });
});
