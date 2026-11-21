import { z } from 'zod';

const Id = z.number().int().positive().safe();
const Person = z.object({
  id: Id,
  is_bot: z.boolean(),
  first_name: z.string(),
  last_name: z.string().optional(),
});
const File = z.object({
  file_id: z.string().min(1),
  file_size: z.number().nonnegative().optional(),
  file_name: z.string().optional(),
  mime_type: z.string().optional(),
});
const Message = z.object({
  message_id: Id,
  chat: z.object({ id: z.number().int().safe(), type: z.string() }),
  from: Person.optional(),
  text: z.string().max(16384).optional(),
  caption: z.string().max(4096).optional(),
  document: File.optional(),
  photo: z.array(File).optional(),
  voice: File.extend({ duration: z.number().nonnegative() }).optional(),
});
export const TelegramUpdateSchema = z.object({
  update_id: z.number().int().nonnegative().safe(),
  message: Message.optional(),
  callback_query: z
    .object({
      id: z.string(),
      from: Person,
      message: Message.optional(),
      data: z.string().max(64).optional(),
    })
    .optional(),
  /** Manager bot only: a bot was created for it, or a managed bot's token or owner changed. */
  managed_bot: z
    .object({
      user: Person,
      bot: Person.extend({ username: z.string().regex(/^[A-Za-z0-9_]+$/) }),
    })
    .optional(),
});
export type TelegramUpdate = z.infer<typeof TelegramUpdateSchema>;
export type TelegramMessage = NonNullable<TelegramUpdate['message']>;
export type TelegramManagedBot = NonNullable<TelegramUpdate['managed_bot']>;
export type TelegramButton = { text: string; callback_data: string };

/** The `telegramBotId` of a job that arrived at the manager bot rather than a person's bot. */
export const TELEGRAM_MANAGER = 'manager';

export type TelegramJob = {
  /** Which bot received the update: a person's bot id, or `TELEGRAM_MANAGER`. */
  telegramBotId: string;
  update: TelegramUpdate;
  connectionId: string | null;
  /** Chosen on first consumption and persisted before work, so retries cannot switch bots. */
  targetBotId?: string | null | undefined;
  /** A pairing code is never retained in Redis; only its digest is. */
  codeHash?: string | undefined;
  /** Stored media and transcript, kept so a retry never downloads or bills them again. */
  incoming?: TelegramIncoming | undefined;
};
export type TelegramIncoming = { text: string; attachmentIds: string[] };

/**
 * The one reading of "is this a command". The queue pins a bot from it, so it
 * must agree with the handler about which messages are commands. Crew
 * commands (`/emma`) follow Telegram's rules: a letter, then up to 31 more
 * letters, digits or underscores.
 */
export function telegramCommand(text: string | undefined): string | undefined {
  return /^\/([a-z][a-z0-9_]{0,31})(?:@[A-Za-z0-9_]+)?(?:\s|$)/i
    .exec(text ?? '')?.[1]
    ?.toLowerCase();
}

/** What follows a command: `/emma find leads` → `find leads`. */
export function commandArguments(text: string | undefined): string {
  return (text ?? '').replace(/^\/[a-z][a-z0-9_]{0,31}(?:@[A-Za-z0-9_]+)?/i, '').trim();
}

export function privateSender(update: TelegramUpdate) {
  const message = update.callback_query?.message ?? update.message;
  const from = update.callback_query?.from ?? update.message?.from;
  if (
    !message ||
    message.chat.type !== 'private' ||
    !from ||
    from.is_bot ||
    message.chat.id !== from.id
  )
    return null;
  return { message, from, chatId: String(message.chat.id), telegramUserId: String(from.id) };
}

export function splitTelegramText(text: string, size = 4000): string[] {
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > size) {
    let end = remaining.lastIndexOf('\n', size);
    if (end < size / 2) end = size;
    // Never split a UTF-16 surrogate pair.
    if (/[\uD800-\uDBFF]/.test(remaining.charAt(end - 1))) end--;
    parts.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining) parts.push(remaining);
  return parts;
}
