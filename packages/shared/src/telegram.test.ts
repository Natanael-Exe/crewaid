import { describe, expect, it } from 'vitest';
import {
  TELEGRAM_PAIRING_ALPHABET,
  formatTelegramPairingCode,
  normalizeTelegramPairingCode,
  telegramBotWebhookId,
  telegramBotWebhookPath,
} from './telegram.js';

describe('Telegram pairing code', () => {
  it('reads a code the way a person types it', () => {
    for (const typed of ['K7M2-Q9XF', 'k7m2q9xf', ' K7M2 Q9XF ', 'k7m2-q9xf'])
      expect(normalizeTelegramPairingCode(typed)).toBe('K7M2Q9XF');
  });
  it('refuses characters a person could misread, and the wrong length', () => {
    for (const typed of ['K7M2-Q9X0', 'K7M2-Q9XI', 'K7M2-Q9XL', 'K7M2-Q9X', 'K7M2-Q9XFF', ''])
      expect(normalizeTelegramPairingCode(typed)).toBeNull();
    expect(TELEGRAM_PAIRING_ALPHABET).not.toMatch(/[01ILO]/);
  });
  it('shows the code in two groups of four', () => {
    expect(formatTelegramPairingCode('K7M2Q9XF')).toBe('K7M2-Q9XF');
  });
});

describe('Telegram webhook paths', () => {
  it('reads back the bot id from exactly its own path', () => {
    expect(telegramBotWebhookId(telegramBotWebhookPath('8123456789'))).toBe('8123456789');
    for (const path of [
      '/channels/telegram/bots/abc/webhook',
      '/channels/telegram/bots/1/webhook/x',
      '/channels/telegram/bots//webhook',
      '/channels/telegram/bots/1',
      '/channels/telegram/webhook',
      '/api/v1/channels/telegram/bots/1/webhook',
    ])
      expect(telegramBotWebhookId(path)).toBeNull();
  });
});
