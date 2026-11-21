import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TELEGRAM_PAIRING_ALPHABET,
  TelegramBotRegisteredSchema,
  TelegramLinkResponseSchema,
  TelegramUsernameSchema,
} from '@crewaid/shared';
import { telegramConfig, validTelegramSecret } from '../src/telegram/telegram.config.js';
import {
  TELEGRAM_MANAGER,
  TelegramUpdateSchema,
  commandArguments,
  privateSender,
  splitTelegramText,
  telegramCommand,
} from '../src/telegram/telegram.protocol.js';
import { TelegramApiClient } from '../src/telegram/telegram-api.js';
import {
  TELEGRAM_LANES,
  telegramLane,
  telegramLaneKey,
} from '../src/telegram/telegram-queue.service.js';
import {
  createBotLink,
  newPairingCode,
  openBotLink,
  pairingCodeIn,
  suggestedBot,
} from '../src/telegram/telegram-pairing.js';
import {
  CONTROL_COMMANDS,
  commandSlug,
  crewCommands,
  telegramMenu,
} from '../src/telegram/telegram-commands.js';
import {
  openConnectionToken,
  openPendingToken,
  sealConnectionToken,
  sealPendingToken,
} from '../src/telegram/telegram-tokens.js';
import { createStructuredLogger } from '../src/logging/structured-logger.js';

const token = '123456:abcdefghijklmnopqrstuvwxyz0123456789';
const KEY = 'a1'.repeat(32);
const envelope = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));
const update = {
  update_id: 1,
  message: {
    message_id: 1,
    chat: { id: 42, type: 'private' },
    from: { id: 42, is_bot: false, first_name: 'Me' },
    text: 'hello',
  },
};
const enabled = {
  TELEGRAM_PUBLIC_URL: 'https://crew.example',
  REDIS_URL: 'redis://localhost:6379',
  CREDENTIAL_KEY: KEY,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Telegram configuration', () => {
  it('is off without a public URL, and refuses a manager with nowhere to post', () => {
    expect(telegramConfig({})).toBeNull();
    expect(() => telegramConfig({ TELEGRAM_MANAGER_BOT_TOKEN: token })).toThrow(
      'TELEGRAM_PUBLIC_URL',
    );
  });
  it('takes only an https origin Telegram can reach', () => {
    for (const url of [
      'http://crew.example',
      'https://crew.example/api',
      'https://u:p@crew.example',
      'https://crew.example?x=1',
      'not a url',
    ])
      expect(() => telegramConfig({ ...enabled, TELEGRAM_PUBLIC_URL: url })).toThrow(
        'TELEGRAM_PUBLIC_URL',
      );
    expect(telegramConfig({ ...enabled, TELEGRAM_PUBLIC_URL: 'https://crew.example/' })).toEqual(
      expect.objectContaining({ publicUrl: 'https://crew.example', manager: null }),
    );
  });
  it('needs the manager token and secret together, and Redis and the sealing key', () => {
    expect(() => telegramConfig({ ...enabled, TELEGRAM_MANAGER_BOT_TOKEN: token })).toThrow(
      'TELEGRAM_MANAGER_WEBHOOK_SECRET',
    );
    expect(() =>
      telegramConfig({ ...enabled, TELEGRAM_MANAGER_WEBHOOK_SECRET: 's'.repeat(32) }),
    ).toThrow('TELEGRAM_MANAGER_BOT_TOKEN');
    expect(() => telegramConfig({ ...enabled, REDIS_URL: '' })).toThrow('REDIS_URL');
    expect(() => telegramConfig({ ...enabled, CREDENTIAL_KEY: '' })).toThrow('CREDENTIAL_KEY');
    expect(
      telegramConfig({
        ...enabled,
        TELEGRAM_MANAGER_BOT_TOKEN: token,
        TELEGRAM_MANAGER_WEBHOOK_SECRET: 's'.repeat(32),
      })?.manager,
    ).toEqual({ token, secret: 's'.repeat(32) });
  });
  it('compares webhook secrets in full and refuses ambiguous headers', () => {
    expect(validTelegramSecret('secret', 'secret')).toBe(true);
    for (const value of [undefined, ['secret'], 'Secret', 'secret ', '', 'secre'])
      expect(validTelegramSecret('secret', value)).toBe(false);
  });
});

describe('Telegram protocol', () => {
  it('accepts only a human in their own private chat', () => {
    expect(privateSender(TelegramUpdateSchema.parse(update))?.telegramUserId).toBe('42');
    for (const message of [
      { ...update.message, chat: { id: -1, type: 'group' } },
      { ...update.message, chat: { id: 1, type: 'private' } },
      { ...update.message, from: { ...update.message.from, is_bot: true } },
      { ...update.message, from: undefined },
    ])
      expect(privateSender(TelegramUpdateSchema.parse({ update_id: 1, message }))).toBeNull();
  });
  it('reads control and crew commands one way for the queue and the handler', () => {
    expect(telegramCommand('/bots')).toBe('bots');
    expect(telegramCommand('/Bots')).toBe('bots');
    expect(telegramCommand('/status@crew_bot now')).toBe('status');
    expect(telegramCommand('/emma_2 find leads')).toBe('emma_2');
    for (const chat of ['/etc/hosts is broken', 'hello /bots', '/', '/42', '/_x', undefined])
      expect(telegramCommand(chat)).toBeUndefined();
    expect(commandArguments('/emma  find 10 leads ')).toBe('find 10 leads');
    expect(commandArguments('/emma@ana_crew_bot hi')).toBe('hi');
    expect(commandArguments('/emma')).toBe('');
  });
  it('orders one chat with one bot, and orders manager updates by their creator', () => {
    const job = { telegramBotId: '777', update: TelegramUpdateSchema.parse(update) };
    expect(telegramLaneKey(job)).toBe('777:42');
    expect(
      telegramLaneKey({
        telegramBotId: TELEGRAM_MANAGER,
        update: TelegramUpdateSchema.parse({
          update_id: 2,
          managed_bot: {
            user: { id: 42, is_bot: false, first_name: 'Ana' },
            bot: { id: 777, is_bot: true, first_name: 'Ana’s Crew', username: 'ana_crew_bot' },
          },
        }),
      }),
    ).toBe('manager:42');
    expect(telegramLane('777:42')).toBe(telegramLane('777:42'));
    const lanes = new Set(Array.from({ length: 200 }, (_, chat) => telegramLane(`1:${chat}`)));
    expect(lanes.size).toBe(TELEGRAM_LANES);
  });
  it('splits long replies without corrupting emoji or dropping text', () => {
    const value = 'a'.repeat(3999) + '😀' + '\n'.repeat(200) + 'b'.repeat(5000);
    const parts = splitTelegramText(value);
    expect(parts.join('')).toBe(value);
    expect(parts.every((part) => part.length <= 4000)).toBe(true);
    expect(parts.every((part) => !/[\uD800-\uDBFF]$/.test(part))).toBe(true);
  });
});

describe('Telegram pairing', () => {
  it('makes eight-character codes from the unambiguous alphabet', () => {
    const codes = Array.from({ length: 200 }, () => newPairingCode());
    for (const code of codes) {
      expect(code).toHaveLength(8);
      expect([...code].every((char) => TELEGRAM_PAIRING_ALPHABET.includes(char))).toBe(true);
    }
    expect(new Set(codes).size).toBe(codes.length);
  });
  it('finds the code sent alone or carried by Start, however it was typed', () => {
    for (const text of ['K7M2Q9XF', 'k7m2-q9xf', '/start K7M2Q9XF', '/start@ana_crew_bot K7M2Q9XF'])
      expect(pairingCodeIn(text)).toBe('K7M2Q9XF');
    for (const text of ['/start', 'hello there', 'K7M2Q9X0', undefined, '/startK7M2Q9XF'])
      expect(pairingCodeIn(text)).toBeNull();
  });
  it('suggests a valid, likely-free username and a name the person can keep', () => {
    for (const name of ['Ana Ruiz', 'Émilie', '42 Labs', '', null, 'x'.repeat(60)]) {
      const suggestion = suggestedBot(name);
      expect(TelegramUsernameSchema.safeParse(suggestion.username).success).toBe(true);
      expect(suggestion.username).toMatch(/_bot$/);
    }
    expect(suggestedBot('Ana Ruiz').name).toBe('Ana’s Crew');
    expect(suggestedBot(null).name).toBe('My Crew');
  });
  it('builds links the shared contract accepts', () => {
    expect(
      TelegramLinkResponseSchema.safeParse({
        code: 'K7M2Q9XF',
        expiresAt: new Date(),
        createUrl: createBotLink('CrewaidBot', 'Ana'),
      }).success,
    ).toBe(true);
    expect(
      TelegramBotRegisteredSchema.safeParse({
        botUsername: 'ana_crew_bot',
        code: 'K7M2Q9XF',
        expiresAt: new Date(),
        openUrl: openBotLink('ana_crew_bot', 'K7M2Q9XF'),
      }).success,
    ).toBe(true);
  });
});

describe('Telegram crew commands', () => {
  const bot = (name: string, role = 'Outbound writer') => ({ id: `id-${name}`, name, role });
  it('slugs names the way Telegram accepts commands', () => {
    expect(commandSlug('Émma Rose')).toBe('emma_rose');
    expect(commandSlug('  --  ')).toBe('');
    expect(commandSlug('x'.repeat(40))).toHaveLength(32);
  });
  it('never shadows a control command or another crew member', () => {
    const commands = crewCommands([
      bot('Stop'),
      bot('Emma'),
      bot('emma'),
      bot('42'),
      bot('—'),
      bot('Start'),
      bot('New'),
    ]).map((entry) => entry.command);
    expect(commands).toEqual(['stop_2', 'emma', 'emma_2', 'crew_42', 'crew', 'start_2', 'new_2']);
  });
  it('describes each member by role, and stays within Telegram’s 100 commands', () => {
    expect(crewCommands([bot('Emma', ''), bot('Noah', 'QA')])[0]?.description).toBe('Talk to Emma');
    const many = crewCommands(Array.from({ length: 150 }, (_, n) => bot(`Bot ${n}`)));
    const menu = telegramMenu(many);
    expect(menu).toHaveLength(100);
    expect(menu.slice(-CONTROL_COMMANDS.length)).toEqual([...CONTROL_COMMANDS]);
  });
});

describe('Telegram token sealing', () => {
  it('opens a token only under the binding it was sealed with', () => {
    vi.stubEnv('CREDENTIAL_KEY', KEY);
    const pending = sealPendingToken('777', token);
    expect(pending).not.toContain(token);
    expect(openPendingToken({ telegramBotId: '777', tokenCiphertext: pending })).toBe(token);
    expect(() => openPendingToken({ telegramBotId: '778', tokenCiphertext: pending })).toThrow();
    expect(() =>
      openConnectionToken({ userId: 'telegram', telegramBotId: '777', tokenCiphertext: pending }),
    ).toThrow();
    const linked = sealConnectionToken('user-a', '777', token);
    expect(
      openConnectionToken({ userId: 'user-a', telegramBotId: '777', tokenCiphertext: linked }),
    ).toBe(token);
    expect(() =>
      openConnectionToken({ userId: 'user-b', telegramBotId: '777', tokenCiphertext: linked }),
    ).toThrow();
  });
  it('is the only Telegram file that touches the cipher, and stays out of the sandbox and agent', () => {
    const src = join(import.meta.dirname, '..', 'src');
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? files(join(dir, entry.name))
          : entry.name.endsWith('.ts')
            ? [join(dir, entry.name)]
            : [],
      );
    const all = files(src);
    const telegram = all.filter((path) => path.includes(`${join('src', 'telegram')}`));
    expect(
      telegram
        .filter((path) => readFileSync(path, 'utf8').includes('credential-cipher'))
        .map((path) => relative(src, path)),
    ).toEqual([join('telegram', 'telegram-tokens.ts')]);
    expect(
      all
        .filter((path) => readFileSync(path, 'utf8').includes("from './telegram-tokens.js'"))
        .map((path) => relative(src, path))
        .sort(),
    ).toEqual(
      ['telegram-accounts.service.ts', 'telegram-bots.service.ts', 'telegram.config.ts']
        .map((file) => join('telegram', file))
        .sort(),
    );
    for (const dir of ['sandbox', 'agent', 'skills'])
      for (const path of files(join(src, dir)))
        expect(readFileSync(path, 'utf8')).not.toMatch(/telegram-tokens|telegram-api/);
  });
  it('keeps a BotFather token out of logs, even inside a Telegram API URL', () => {
    const lines: string[] = [];
    const logger = createStructuredLogger(
      new Writable({
        write(chunk: Buffer, _encoding, done) {
          lines.push(chunk.toString());
          done();
        },
      }),
    );
    logger.warn('telegram.debug', {
      detail: `failed https://api.telegram.org/bot${token}/getMe and ${token}`,
    });
    expect(lines.join('')).toContain('telegram.debug');
    expect(lines.join('')).not.toContain(token.split(':')[1]);
  });
});

describe('Telegram API boundary', () => {
  it('caches the bot identity, including whether it may create bots', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(envelope({ id: 123456, username: 'crew_bot', can_manage_bots: true }));
    const api = new TelegramApiClient(token, fetcher);
    expect(await api.me()).toEqual({ id: 123456, username: 'crew_bot', canManageBots: true });
    await api.me();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`https://api.telegram.org/bot${token}/getMe`);
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('error');
  });
  it('never exposes token-bearing network errors', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error(`failed https://api.telegram.org/bot${token}/getMe`));
    const api = new TelegramApiClient(token, fetcher);
    await expect(api.me()).rejects.toThrow('Telegram request failed');
    try {
      await api.me();
    } catch (error) {
      expect(String(error)).not.toContain(token);
    }
  });
  it.each(['../secret', '/etc/passwd', 'https://evil.test/file', 'photos/../../secret'])(
    'refuses unsafe file path %s',
    async (file_path) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(envelope({ file_path }));
      await expect(new TelegramApiClient(token, fetcher).download('file', 10)).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('enforces file size while streaming even if provider metadata omits it', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(envelope({ file_path: 'photos/file.jpg' }))
      .mockResolvedValueOnce(new Response(new Uint8Array(11)));
    await expect(new TelegramApiClient(token, fetcher).download('file', 10)).rejects.toMatchObject({
      status: 413,
    });
  });
  it('hands a long rate-limit wait back to the queue instead of holding its lane', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, parameters: { retry_after: 30 } }), {
        status: 429,
      }),
    );
    const started = Date.now();
    await expect(new TelegramApiClient(token, fetcher).text('42', 'hi')).rejects.toMatchObject({
      status: 429,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(Date.now() - started).toBeLessThan(1000);
  });
  it('puts approval buttons only on the final message chunk and uses plain text', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => envelope(true));
    await new TelegramApiClient(token, fetcher).text('42', 'a'.repeat(8001), [
      [{ text: 'Reject', callback_data: 'r:1' }],
    ]);
    const bodies = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toHaveLength(3);
    expect(bodies[0].reply_markup).toBeUndefined();
    expect(bodies[2].reply_markup.inline_keyboard[0][0].text).toBe('Reject');
    expect(bodies.every((body) => body.parse_mode === undefined)).toBe(true);
  });
  it('registers webhooks, menus and managed bots with the documented methods', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        String(url).endsWith('/getManagedBotToken')
          ? envelope(`777:${'t'.repeat(35)}`)
          : envelope(true),
      );
    const api = new TelegramApiClient(token, fetcher);
    await api.setWebhook('https://crew.example/hook', 's'.repeat(43), ['message']);
    await api.deleteWebhook();
    await api.setCommands([{ command: 'emma', description: 'Outbound writer' }]);
    expect(await api.managedBotToken('777')).toBe(`777:${'t'.repeat(35)}`);
    await api.revokeManagedBotToken('777');
    await api.restrictManagedBot('777');
    const calls = fetcher.mock.calls.map(([url, init]) => [
      String(url).split('/').at(-1),
      JSON.parse(String(init?.body)),
    ]);
    expect(calls).toEqual([
      [
        'setWebhook',
        {
          url: 'https://crew.example/hook',
          secret_token: 's'.repeat(43),
          allowed_updates: ['message'],
        },
      ],
      ['deleteWebhook', { drop_pending_updates: true }],
      ['setMyCommands', { commands: [{ command: 'emma', description: 'Outbound writer' }] }],
      ['getManagedBotToken', { user_id: 777 }],
      ['replaceManagedBotToken', { user_id: 777 }],
      ['setManagedBotAccessSettings', { user_id: 777, is_access_restricted: true }],
    ]);
  });
  it('refuses a managed token that isn’t a token, and a bot id that isn’t a number', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(envelope('<html>'));
    const api = new TelegramApiClient(token, fetcher);
    await expect(api.managedBotToken('777')).rejects.toMatchObject({ status: 502 });
    await expect(api.managedBotToken('77a')).rejects.toMatchObject({ status: 400 });
  });
});
