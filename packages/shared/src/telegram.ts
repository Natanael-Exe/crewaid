import { z } from 'zod';
import { CuidSchema } from './primitives.js';

/**
 * Every person's crew talks through a Telegram bot of their own. A
 * deployment may also run one *manager* bot, which only creates those bots
 * (Telegram's Managed Bots); it never carries anyone's conversation.
 */
export const TELEGRAM_MANAGER_WEBHOOK_PATH = '/channels/telegram/manager/webhook' as const;

/** One person's bot posts here. The id is Telegram's own numeric bot id. */
export const telegramBotWebhookPath = (telegramBotId: string): string =>
  `/channels/telegram/bots/${telegramBotId}/webhook`;

const BOT_WEBHOOK_PATH = /^\/channels\/telegram\/bots\/(\d{1,20})\/webhook$/;

/** The bot id in a per-bot webhook path (without the API prefix), or null. */
export function telegramBotWebhookId(path: string): string | null {
  return BOT_WEBHOOK_PATH.exec(path)?.[1] ?? null;
}

/**
 * The pairing code a person sends from Telegram to prove the bot is theirs.
 * Letters and digits a person can't misread (no 0/O, 1/I/L); eight of them
 * is about 39 bits, single use and valid for ten minutes.
 */
export const TELEGRAM_PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' as const;
export const TELEGRAM_PAIRING_CODE_LENGTH = 8;
const PAIRING_CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{8}$/;

/** A typed or pasted code in canonical form: case, spaces and dashes don't matter. */
export function normalizeTelegramPairingCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  return PAIRING_CODE.test(code) ? code : null;
}

/** `K7M2Q9XF` → `K7M2-Q9XF`, the way it is shown to be typed. */
export function formatTelegramPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export const TelegramPairingCodeSchema = z.string().regex(PAIRING_CODE);

/** Telegram usernames: 5–32 characters, starting with a letter. */
export const TelegramUsernameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{4,31}$/);

/** A token as BotFather prints it: the bot's numeric id, a colon, the secret. */
export const TelegramBotTokenSchema = z
  .string()
  .trim()
  .regex(/^\d{1,20}:[A-Za-z0-9_-]{20,128}$/);

/** Zod still runs a refine after `.url()` fails, and `safeParse` must never throw. */
function telegramUrl(value: string): URL | null {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  return url.protocol === 'https:' &&
    url.hostname === 't.me' &&
    !url.username &&
    !url.password &&
    !url.port &&
    !url.hash
    ? url
    : null;
}

/** `https://t.me/newbot/{manager}/{suggested_username}?name={suggested_name}` */
function isCreateBotLink(value: string): boolean {
  const url = telegramUrl(value);
  if (!url) return false;
  const parts = url.pathname.split('/');
  const keys = [...url.searchParams.keys()];
  return (
    parts.length === 4 &&
    parts[1] === 'newbot' &&
    TelegramUsernameSchema.safeParse(parts[2]).success &&
    TelegramUsernameSchema.safeParse(parts[3]).success &&
    keys.every((key) => key === 'name')
  );
}

/** `https://t.me/{bot}?start={code}`: opening it sends the code with Start. */
function isOpenBotLink(value: string): boolean {
  const url = telegramUrl(value);
  if (!url) return false;
  const keys = [...url.searchParams.keys()];
  return (
    TelegramUsernameSchema.safeParse(url.pathname.slice(1)).success &&
    keys.length === 1 &&
    PAIRING_CODE.test(url.searchParams.get('start') ?? '')
  );
}

export const TelegramStatusSchema = z.object({
  configured: z.boolean(),
  /** A manager bot is set up, so Crewaid can create a person's bot from a QR code. */
  canCreateBots: z.boolean(),
  connection: z
    .object({
      botUsername: TelegramUsernameSchema,
      displayName: z.string(),
      selectedBotId: CuidSchema.nullable(),
      connectedAt: z.coerce.date(),
    })
    .nullable(),
  /**
   * A bot waiting on this account. `telegramName` is null until the right code
   * arrives from Telegram; once set, nothing is live until the person confirms
   * here, so a code read off their screen is not enough.
   */
  pending: z
    .object({
      botUsername: TelegramUsernameSchema,
      telegramName: z.string().nullable(),
      expiresAt: z.coerce.date(),
    })
    .nullable(),
});
export type TelegramStatus = z.infer<typeof TelegramStatusSchema>;

export const TelegramLinkResponseSchema = z.object({
  code: TelegramPairingCodeSchema,
  expiresAt: z.coerce.date(),
  /** The QR code's link, or null when this server has no manager bot. */
  createUrl: z.string().url().refine(isCreateBotLink).nullable(),
});
export type TelegramLinkResponse = z.infer<typeof TelegramLinkResponseSchema>;

export const TelegramBotTokenRequestSchema = z.object({ token: TelegramBotTokenSchema });
export type TelegramBotTokenRequest = z.infer<typeof TelegramBotTokenRequestSchema>;

export const TelegramBotRegisteredSchema = z.object({
  botUsername: TelegramUsernameSchema,
  code: TelegramPairingCodeSchema,
  expiresAt: z.coerce.date(),
  openUrl: z.string().url().refine(isOpenBotLink),
});
export type TelegramBotRegistered = z.infer<typeof TelegramBotRegisteredSchema>;

export const TelegramConfirmResponseSchema = z.object({ connected: z.literal(true) });

export const TelegramDisconnectResponseSchema = z.object({ disconnected: z.literal(true) });
