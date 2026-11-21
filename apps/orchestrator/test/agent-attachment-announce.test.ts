import { describe, expect, it } from 'vitest';
import { AgentAttachmentService } from '../src/agent/agent-attachment.service.js';
import type { TurnEventBus } from '../src/agent/turn-event.bus.js';
import type { AttachmentsService } from '../src/attachments/attachments.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { StructuredLogger } from '../src/logging/structured-logger.js';

/**
 * The live announcement of a bot-side attachment claim (§4.2
 * `message.attachments`).
 *
 * A claim is bound to a reply that is already on every connected client —
 * `message.created` left before the turn ran, with an empty list by
 * construction. Without an announcement the claim reaches a client only on
 * its next history fetch, which for an open window is "never until the app
 * restarts". The store therefore ends with a frame, addressed to the bot that
 * OWNS the conversation the claimed reply lives in.
 */

const USER = 'user-under-test';
const BOT = 'clx1a2b3c4d5e6f7g8h9i0j1';
const MESSAGE = 'clxmsg00000000000000001';

function build(
  overrides: {
    prisma?: Record<string, unknown>;
  } = {},
): { service: AgentAttachmentService; announced: Array<{ botId: string; messageId: string }> } {
  const announced: Array<{ botId: string; messageId: string }> = [];
  const storedRow = {
    id: 'clxattach00000000000001',
    messageId: MESSAGE,
    filename: 'shot.png',
    mimeType: 'image/png',
    sizeBytes: 12,
    storageKey: '2026-09-18/shot.png',
  };
  const attachments = {
    store: async () => storedRow,
    claimForMessage: async () => undefined,
  } as unknown as AttachmentsService;
  const prisma = {
    attachment: {
      findUnique: async () => storedRow,
    },
    message: {
      findUnique: async () => ({
        conversation: { botId: BOT },
      }),
    },
    ...(overrides.prisma ?? {}),
  } as unknown as PrismaService;
  const events = {
    emitMessageAttachments: (botId: string, messageId: string) => {
      announced.push({ botId, messageId });
    },
  } as unknown as TurnEventBus;
  const logger = {
    error: () => undefined,
  } as unknown as StructuredLogger;
  return {
    service: new AgentAttachmentService(attachments, prisma, events, logger),
    announced,
  };
}

describe('AgentAttachmentService.storeFromBot', () => {
  it('announces the claim to the bot that owns the reply', async () => {
    const { service, announced } = build();

    const stored = await service.storeFromBot({
      userId: USER,
      messageId: MESSAGE,
      filename: 'shot.png',
      bytes: Buffer.from('a png, honestly'),
    });

    expect(stored.id).toBe('clxattach00000000000001');
    expect(announced).toEqual([{ botId: BOT, messageId: MESSAGE }]);
  });

  it('stays silent when the row it stored cannot be read back as claimed', async () => {
    const { service, announced } = build({
      prisma: {
        attachment: {
          findUnique: async () => ({
            id: 'clxattach00000000000001',
            messageId: null,
            filename: 'shot.png',
            mimeType: 'image/png',
            sizeBytes: 12,
            storageKey: '2026-09-18/shot.png',
          }),
        },
      },
    });

    await service.storeFromBot({
      userId: USER,
      messageId: MESSAGE,
      filename: 'shot.png',
      bytes: Buffer.from('a png, honestly'),
    });

    // An unannounced claim is repaired by the next history read; a WRONG
    // announcement would point a card at a message that does not own it.
    expect(announced).toEqual([]);
  });

  it('never fails the tool call because the announcement could not be built', async () => {
    const failing = build({
      prisma: {
        message: {
          findUnique: async () => {
            throw new Error('connection refused');
          },
        },
      },
    });

    const stored = await failing.service.storeFromBot({
      userId: USER,
      messageId: MESSAGE,
      filename: 'shot.png',
      bytes: Buffer.from('a png, honestly'),
    });

    // The file is stored and claimed either way — the announcement is
    // observational, and a transport hiccup must not eat the attachment.
    expect(stored.id).toBe('clxattach00000000000001');
    expect(failing.announced).toEqual([]);
  });
});
