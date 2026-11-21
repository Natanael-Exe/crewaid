import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { splitTelegramText, type TelegramButton } from './telegram.protocol.js';
import type { TelegramMenuEntry } from './telegram-commands.js';

export const TELEGRAM_CLIENTS = 'TELEGRAM_CLIENTS';
export const TELEGRAM_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
/** What a person's bot is subscribed to; the manager also hears `managed_bot`. */
export const TELEGRAM_BOT_UPDATES = ['message', 'callback_query'] as const;
export const TELEGRAM_MANAGER_UPDATES = ['managed_bot', 'message'] as const;

export type TelegramIdentity = { id: number; username: string; canManageBots: boolean };

/** One bot, spoken to with its own token. */
export interface TelegramApi {
  me(): Promise<TelegramIdentity>;
  text(chatId: string, text: string, buttons?: TelegramButton[][]): Promise<void>;
  answer(callbackId: string, text: string): Promise<void>;
  download(fileId: string, maxBytes: number): Promise<Buffer>;
  document(chatId: string, bytes: Uint8Array, filename: string, mimeType: string): Promise<void>;
  setWebhook(url: string, secret: string, updates: readonly string[]): Promise<void>;
  deleteWebhook(): Promise<void>;
  setCommands(commands: readonly TelegramMenuEntry[]): Promise<void>;
}

/** The manager bot's extra powers over the bots it created (Bot API 9.6/10.0). */
export interface TelegramManagerApi extends TelegramApi {
  managedBotToken(telegramBotId: string): Promise<string>;
  /** Revokes the token Crewaid holds. The new one is discarded, never stored. */
  revokeManagedBotToken(telegramBotId: string): Promise<void>;
  /** Only the bot's owner can use it: strangers can't even send it a code. */
  restrictManagedBot(telegramBotId: string): Promise<void>;
}

/** Hands out a client per token, so no service keeps another person's token around. */
export interface TelegramClients {
  forToken(token: string): TelegramApi;
  manager(): TelegramManagerApi | null;
}

/** Only safe numeric status survives a provider failure; its URLs contain the bot token. */
export class TelegramApiError extends Error {
  constructor(readonly status: number) {
    super('Telegram request failed');
    this.name = 'TelegramApiError';
  }
}

const BotTokenSchema = z.string().regex(/^\d{1,20}:[A-Za-z0-9_-]{20,128}$/);

function botUserId(telegramBotId: string): number {
  const id = Number(telegramBotId);
  if (!/^\d{1,20}$/.test(telegramBotId) || !Number.isSafeInteger(id))
    throw new TelegramApiError(400);
  return id;
}

export class TelegramApiClient implements TelegramManagerApi {
  private identity: Promise<TelegramIdentity> | undefined;
  constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async call(
    method: string,
    body: Record<string, unknown> | FormData,
    attempt = 0,
  ): Promise<unknown> {
    try {
      const response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        ...(body instanceof FormData
          ? { body }
          : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20_000),
        redirect: 'error',
      });
      // A short wait is cheaper here than a job retry. A long one is the job's:
      // waiting in place holds the shard's only worker for every chat on it.
      if (response.status === 429 && attempt < 3) {
        const retry = z
          .object({ parameters: z.object({ retry_after: z.number().int().min(0).max(5) }) })
          .safeParse(await response.json());
        if (retry.success) {
          await delay(Math.max(1, retry.data.parameters.retry_after) * 1000);
          return this.call(method, body, attempt + 1);
        }
      }
      if (!response.ok) throw new TelegramApiError(response.status);
      const parsed = z
        .object({ ok: z.boolean(), result: z.unknown() })
        .parse(await response.json());
      if (!parsed.ok) throw new TelegramApiError(502);
      return parsed.result;
    } catch (error) {
      throw error instanceof TelegramApiError ? error : new TelegramApiError(502);
    }
  }

  me() {
    this.identity ??= this.call('getMe', {})
      .then((result) => {
        const me = z
          .object({
            id: z.number().int().positive().safe(),
            username: z.string().regex(/^[A-Za-z0-9_]+$/),
            can_manage_bots: z.boolean().optional(),
          })
          .parse(result);
        return { id: me.id, username: me.username, canManageBots: me.can_manage_bots === true };
      })
      .catch((error: unknown) => {
        this.identity = undefined;
        throw error instanceof TelegramApiError ? error : new TelegramApiError(502);
      });
    return this.identity;
  }

  async text(chatId: string, text: string, buttons?: TelegramButton[][]): Promise<void> {
    const parts = splitTelegramText(text);
    for (const [index, part] of parts.entries()) {
      await this.call('sendMessage', {
        chat_id: chatId,
        text: part,
        ...(buttons && index === parts.length - 1
          ? { reply_markup: { inline_keyboard: buttons } }
          : {}),
      });
    }
  }

  async answer(callbackId: string, text: string): Promise<void> {
    await this.call('answerCallbackQuery', {
      callback_query_id: callbackId,
      text: text.slice(0, 180),
    });
  }

  async download(fileId: string, maxBytes: number): Promise<Buffer> {
    const result = z
      .object({ file_path: z.string(), file_size: z.number().optional() })
      .parse(await this.call('getFile', { file_id: fileId }));
    const limit = Math.min(maxBytes, TELEGRAM_MEDIA_MAX_BYTES);
    if ((result.file_size ?? 0) > limit) throw new TelegramApiError(413);
    // A provider-returned path can never become an authority or escape its prefix.
    if (
      !/^[A-Za-z0-9_./-]+$/.test(result.file_path) ||
      result.file_path.split('/').some((part) => part === '..' || part === '.') ||
      result.file_path.startsWith('/')
    )
      throw new TelegramApiError(502);
    let response: Response;
    try {
      response = await this.fetcher(
        `https://api.telegram.org/file/bot${this.token}/${result.file_path}`,
        { redirect: 'error', signal: AbortSignal.timeout(20_000) },
      );
    } catch {
      throw new TelegramApiError(502);
    }
    if (!response.ok || !response.body) throw new TelegramApiError(response.status);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        const bytes = z.instanceof(Uint8Array).parse(part.value);
        total += bytes.length;
        if (total > limit) throw new TelegramApiError(413);
        chunks.push(bytes);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return Buffer.concat(chunks);
  }

  async document(
    chatId: string,
    bytes: Uint8Array,
    filename: string,
    mimeType: string,
  ): Promise<void> {
    const form = new FormData();
    form.set('chat_id', chatId);
    form.set('document', new Blob([new Uint8Array(bytes)], { type: mimeType }), filename);
    await this.call('sendDocument', form);
  }

  async setWebhook(url: string, secret: string, updates: readonly string[]): Promise<void> {
    await this.call('setWebhook', {
      url,
      secret_token: secret,
      allowed_updates: [...updates],
    });
  }

  async deleteWebhook(): Promise<void> {
    await this.call('deleteWebhook', { drop_pending_updates: true });
  }

  async setCommands(commands: readonly TelegramMenuEntry[]): Promise<void> {
    await this.call('setMyCommands', { commands });
  }

  async managedBotToken(telegramBotId: string): Promise<string> {
    const token = BotTokenSchema.safeParse(
      await this.call('getManagedBotToken', { user_id: botUserId(telegramBotId) }),
    );
    if (!token.success) throw new TelegramApiError(502);
    return token.data;
  }

  async revokeManagedBotToken(telegramBotId: string): Promise<void> {
    await this.call('replaceManagedBotToken', { user_id: botUserId(telegramBotId) });
  }

  async restrictManagedBot(telegramBotId: string): Promise<void> {
    await this.call('setManagedBotAccessSettings', {
      user_id: botUserId(telegramBotId),
      is_access_restricted: true,
    });
  }
}

export class TelegramClientFactory implements TelegramClients {
  private readonly managerClient: TelegramApiClient | null;
  constructor(
    managerToken: string | null,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.managerClient = managerToken ? new TelegramApiClient(managerToken, fetcher) : null;
  }

  forToken(token: string): TelegramApi {
    return new TelegramApiClient(token, this.fetcher);
  }

  manager(): TelegramManagerApi | null {
    return this.managerClient;
  }
}
