import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { API_PREFIX, TELEGRAM_MANAGER_WEBHOOK_PATH, telegramBotWebhookPath } from '@crewaid/shared';
import { redisConnection, queueRedisUrl, readWorkerEnabled } from '../common/queue-config.js';
import { assertTelegramTokenKey } from './telegram-tokens.js';

export const TELEGRAM_CONFIG = 'TELEGRAM_CONFIG';

export type TelegramConfig = {
  /** The HTTPS origin Telegram posts to; every bot's webhook is registered under it. */
  publicUrl: string;
  /** The deployment's manager bot, which only creates people's bots. Optional. */
  manager: { token: string; secret: string } | null;
  connection: ReturnType<typeof redisConnection>;
  worker: boolean;
};

const BOT_TOKEN = /^\d{1,20}:[A-Za-z0-9_-]{20,128}$/;
const SECRET = /^[A-Za-z0-9_-]{32,256}$/;

/**
 * D-233. `TELEGRAM_PUBLIC_URL` turns the channel on; people then bring their
 * own bots. The manager pair is optional and only adds creating a bot from a
 * QR code. Every failure names the variable, never its value.
 */
export function telegramConfig(env: NodeJS.ProcessEnv = process.env): TelegramConfig | null {
  const publicUrl = env['TELEGRAM_PUBLIC_URL']?.trim();
  const managerToken = env['TELEGRAM_MANAGER_BOT_TOKEN']?.trim();
  const managerSecret = env['TELEGRAM_MANAGER_WEBHOOK_SECRET']?.trim();
  if (!publicUrl) {
    if (managerToken || managerSecret)
      throw new Error('TELEGRAM_MANAGER_BOT_TOKEN needs TELEGRAM_PUBLIC_URL');
    return null;
  }
  const origin = publicOrigin(publicUrl);
  let manager: TelegramConfig['manager'] = null;
  if (managerToken || managerSecret) {
    if (!managerToken || !BOT_TOKEN.test(managerToken))
      throw new Error('TELEGRAM_MANAGER_BOT_TOKEN must be a BotFather token');
    if (!managerSecret || !SECRET.test(managerSecret))
      throw new Error('TELEGRAM_MANAGER_WEBHOOK_SECRET must be 32–256 URL-safe characters');
    manager = { token: managerToken, secret: managerSecret };
  }
  const redis = queueRedisUrl(env['REDIS_URL']);
  if (redis === null) throw new Error('Telegram needs REDIS_URL');
  // People's bot tokens are sealed at rest, so a server that cannot seal them
  // must not accept one.
  assertTelegramTokenKey(env);
  return {
    publicUrl: origin,
    manager,
    connection: redisConnection(redis),
    worker: readWorkerEnabled('TELEGRAM_WORKER', env['TELEGRAM_WORKER']),
  };
}

function publicOrigin(raw: string): string {
  const url = URL.canParse(raw) ? new URL(raw) : null;
  if (
    !url ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('TELEGRAM_PUBLIC_URL must be an https:// origin Telegram can reach, no path');
  return url.origin;
}

export const telegramBotWebhookUrl = (config: TelegramConfig, telegramBotId: string): string =>
  `${config.publicUrl}${API_PREFIX}${telegramBotWebhookPath(telegramBotId)}`;

export const telegramManagerWebhookUrl = (config: TelegramConfig): string =>
  `${config.publicUrl}${API_PREFIX}${TELEGRAM_MANAGER_WEBHOOK_PATH}`;

/** Telegram echoes it in `X-Telegram-Bot-Api-Secret-Token`; only its digest is stored. */
export const newTelegramWebhookSecret = (): string => randomBytes(32).toString('base64url');

export function validTelegramSecret(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string') return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

export const telegramDigest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
