import { describe, expect, it, vi } from 'vitest';

import type { ArtifactStore } from '../src/attachments/artifact-store.js';
import { AttachmentsService } from '../src/attachments/attachments.service.js';

describe('claimed attachments used as model input', () => {
  it('reads image bytes only for the owner, message, and vision model', async () => {
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const findMany = vi.fn(
      ({
        where,
      }: {
        where: {
          messageId: string;
          message: { conversation: { botId: string; bot: { userId: string } } };
        };
      }) =>
        Promise.resolve(
          where.messageId === 'message-1' &&
            where.message.conversation.botId === 'bot-1' &&
            where.message.conversation.bot.userId === 'owner-1'
            ? [{ id: 'image-1', filename: 'image.png', mimeType: 'image/png' }]
            : [],
        ),
    );
    // The download path's ownership read, which `forModel` reuses before
    // asking the store for bytes.
    const findFirst = vi.fn(() =>
      Promise.resolve({
        id: 'image-1',
        storageKey: '2026-10-13/image-1-image.png',
        messageId: 'message-1',
        deliverable: null,
        createdAt: new Date(),
      }),
    );
    const get = vi.fn((key: string) =>
      Promise.resolve(key === '2026-10-13/image-1-image.png' ? bytes : null),
    );
    const store: ArtifactStore = {
      kind: 'r2',
      put: vi.fn(),
      get,
      open: vi.fn(),
      delete: vi.fn(),
    };
    const service = new AttachmentsService(
      { attachment: { findMany, findFirst } } as never,
      {} as never,
      store,
    );

    expect(await service.forModel('owner-1', 'bot-1', 'message-1', true)).toEqual([
      { filename: 'image.png', mimeType: 'image/png', data: bytes },
    ]);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'image-1' }) }),
    );
    expect(get).toHaveBeenCalledWith('2026-10-13/image-1-image.png');

    get.mockClear();
    expect(await service.forModel('owner-1', 'bot-1', 'message-1', false)).toEqual([
      { filename: 'image.png', mimeType: 'image/png' },
    ]);
    expect(get).not.toHaveBeenCalled();

    expect(await service.forModel('another-owner', 'bot-1', 'message-1', true)).toEqual([]);
    expect(await service.forModel('owner-1', 'another-bot', 'message-1', true)).toEqual([]);
    expect(await service.forModel('owner-1', 'bot-1', 'another-message', true)).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });
});
