import { randomInt } from 'node:crypto';
import {
  TELEGRAM_PAIRING_ALPHABET,
  TELEGRAM_PAIRING_CODE_LENGTH,
  normalizeTelegramPairingCode,
} from '@crewaid/shared';
import { commandSlug } from './telegram-commands.js';

/** A code is valid for ten minutes, and its bot has as long to be confirmed once claimed. */
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
export const PAIRING_CONFIRM_TTL_MS = 10 * 60 * 1000;
/** How long a created or pasted bot waits for its code before it is retired. */
export const PENDING_BOT_TTL_MS = 30 * 60 * 1000;
/** Wrong codes a pending bot accepts before it is retired. */
export const PAIRING_MAX_ATTEMPTS = 5;
/** Unclaimed bots one Telegram account may have Crewaid create at a time. */
export const PENDING_BOTS_PER_CREATOR = 3;

export function newPairingCode(): string {
  let code = '';
  for (let index = 0; index < TELEGRAM_PAIRING_CODE_LENGTH; index++)
    code += TELEGRAM_PAIRING_ALPHABET.charAt(randomInt(TELEGRAM_PAIRING_ALPHABET.length));
  return code;
}

/** The code in a message: sent on its own, or carried by Start from a `?start=` link. */
export function pairingCodeIn(text: string | undefined): string | null {
  const trimmed = (text ?? '').trim();
  const start = /^\/start(?:@[A-Za-z0-9_]+)?(?:\s+(.*))?$/i.exec(trimmed);
  const candidate = start ? (start[1] ?? '') : trimmed;
  return candidate ? normalizeTelegramPairingCode(candidate) : null;
}

/**
 * The suggested username and name in the create link. Telegram shows both
 * pre-filled and editable; the four random characters only make the
 * suggestion likely to be free.
 */
export function suggestedBot(personName: string | null): { username: string; name: string } {
  const first = (personName ?? '').trim().split(/\s+/)[0] ?? '';
  let slug = commandSlug(first).slice(0, 12).replace(/_+$/, '');
  if (!/^[a-z]/.test(slug)) slug = 'my';
  let suffix = '';
  for (let index = 0; index < 4; index++)
    suffix += 'abcdefghijkmnpqrstuvwxyz23456789'.charAt(randomInt(32));
  return {
    username: `${slug}_crew_${suffix}_bot`,
    name: (first ? `${first}’s Crew` : 'My Crew').slice(0, 64),
  };
}

export function createBotLink(managerUsername: string, personName: string | null): string {
  const suggestion = suggestedBot(personName);
  const url = new URL(`https://t.me/newbot/${managerUsername}/${suggestion.username}`);
  url.searchParams.set('name', suggestion.name);
  return url.href;
}

export function openBotLink(botUsername: string, code: string): string {
  const url = new URL(`https://t.me/${botUsername}`);
  url.searchParams.set('start', code);
  return url.href;
}
