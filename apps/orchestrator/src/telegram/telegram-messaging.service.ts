import { Inject, Injectable, HttpException } from '@nestjs/common';
import type { TelegramConnection } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { ChatSendService } from '../chat/chat-send.service.js';
import { MessagesService } from '../messages/messages.service.js';
import { TurnControlService } from '../agent/turn-control.service.js';
import { AttachmentsService } from '../attachments/attachments.service.js';
import { VoiceService, VOICE_MAX_BYTES } from '../voice/voice.service.js';
import { StructuredLogger } from '../logging/structured-logger.js';
import { PolicyProposalSchema } from '../agent/policy/proposal-store.js';
import { TelegramAccountsService } from './telegram-accounts.service.js';
import { TelegramBotsService } from './telegram-bots.service.js';
import { TelegramApiError, type TelegramApi } from './telegram-api.js';
import {
  CONTROL_COMMANDS,
  crewCommands,
  isControlCommand,
  telegramMenu,
  type CrewCommand,
} from './telegram-commands.js';
import {
  TELEGRAM_MANAGER,
  commandArguments,
  privateSender,
  telegramCommand,
  type TelegramIncoming,
  type TelegramJob,
  type TelegramMessage,
} from './telegram.protocol.js';
import { telegramDigest } from './telegram.config.js';

const AWAITING_DECISION =
  'This conversation is waiting for a decision. Use /approvals, then send your message again.';
const CONTROLS = CONTROL_COMMANDS.map((entry) => `/${entry.command} — ${entry.description}`).join(
  '\n',
);
const SEND_CODE =
  'Send the 8-character code shown in Crewaid → Settings → Channels to connect this bot.';
const CONFIRM_IN_APP =
  'Almost done. Confirm the connection in Crewaid → Settings → Channels to finish.';
const WRONG_CODE =
  'That code isn’t right or has expired. Check Crewaid → Settings → Channels and send it again.';
const LOCKED_OUT = 'Too many wrong codes. Start again from Crewaid → Settings → Channels.';
const FROM_MANAGER =
  'I create Crewaid bots. To make yours, open Crewaid → Settings → Channels → Connect Telegram.';

@Injectable()
export class TelegramMessagingService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TelegramAccountsService) private readonly accounts: TelegramAccountsService,
    @Inject(TelegramBotsService) private readonly bots: TelegramBotsService,
    @Inject(ChatSendService) private readonly chat: ChatSendService,
    @Inject(MessagesService) private readonly messages: MessagesService,
    @Inject(TurnControlService) private readonly controls: TurnControlService,
    @Inject(AttachmentsService) private readonly attachments: AttachmentsService,
    @Inject(VoiceService) private readonly voice: VoiceService,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
  ) {}

  /** Each person's bot speaks with its own token, opened only for the send. */
  private client(connection: TelegramConnection): TelegramApi {
    return this.bots.clientForConnection(connection);
  }

  /** `remember` persists prepared media on the job before admission can fail. */
  async handle(
    job: TelegramJob,
    remember?: (incoming: TelegramIncoming) => Promise<void>,
  ): Promise<void> {
    if (job.telegramBotId === TELEGRAM_MANAGER) {
      await this.managerUpdate(job);
      return;
    }
    const sender = privateSender(job.update);
    if (!sender) return;
    // Binding at receipt prevents old jobs from acquiring a new connection's authority.
    const connection =
      job.connectionId === null
        ? null
        : await this.accounts.resolve(
            job.telegramBotId,
            sender.telegramUserId,
            sender.chatId,
            job.connectionId,
          );
    if (!connection) {
      if (job.connectionId === null) await this.pairing(job, sender);
      return;
    }
    const callback = job.update.callback_query;
    if (callback) {
      const api = this.client(connection);
      try {
        if (callback.data?.startsWith('b:')) {
          const selected = await this.select(connection, callback.data.slice(2));
          await api.answer(
            callback.id,
            selected ? 'Crew member selected' : 'That crew member is unavailable',
          );
        } else if (/^[ar]:/.test(callback.data ?? '')) {
          const accepted = await this.answerApproval(connection, callback.data ?? '');
          await api.answer(
            callback.id,
            accepted
              ? 'Decision recorded'
              : 'This approval changed or was already answered. Use /approvals.',
          );
        } else await api.answer(callback.id, 'Use /bots or /approvals for current controls.');
      } catch (error) {
        if (!(error instanceof HttpException)) throw error;
        await api.answer(
          callback.id,
          'This decision could not be applied. Use /approvals for the current state.',
        );
      }
      return;
    }
    const message = job.update.message;
    if (!message) return;
    const command = telegramCommand(message.text);
    if (command === 'start' || command === 'help') {
      await this.help(connection);
      return;
    }
    if (command === 'bots') {
      await this.chooseCrew(connection);
      return;
    }
    if (command === 'unlink') {
      await this.text(
        connection,
        'Telegram is disconnected. You can connect a bot again from Crewaid Settings → Channels.',
      );
      await this.accounts.disconnect(connection.userId, connection.id);
      return;
    }
    // `/emma` selects Emma; `/emma find leads` also sends her the rest.
    let targetBotId = job.targetBotId;
    let body: string | undefined;
    if (command !== undefined && !isControlCommand(command)) {
      const member = (await this.crew(connection)).find((entry) => entry.command === command);
      if (!member) {
        await this.help(connection);
        return;
      }
      body = commandArguments(message.text);
      if (!body) {
        await this.select(connection, member.botId);
        return;
      }
      targetBotId ??= member.botId;
      if (connection.selectedBotId !== targetBotId)
        await this.select(connection, targetBotId, false);
    }
    const bot = await this.selected(
      targetBotId === undefined ? connection : { ...connection, selectedBotId: targetBotId },
    );
    if (!bot?.conversation) {
      await this.text(connection, 'Choose a crew member first with /bots.');
      return;
    }
    if (command === 'status') {
      await this.text(connection, `${bot.name}: ${bot.status.toLowerCase().replaceAll('_', ' ')}.`);
      return;
    }
    if (command === 'stop') {
      this.controls.cancelTurn(connection.userId, bot.id);
      await this.text(connection, `Stop requested for ${bot.name}.`);
      return;
    }
    if (command === 'approvals') {
      if (await this.approvals(connection, true)) return;
      await this.text(
        connection,
        (await this.chat.awaitingApproval(connection.userId, bot.id, bot.conversation.id))
          ? `${bot.name} is waiting for a decision Telegram can’t show. Open Crewaid to answer it.`
          : `${bot.name} has no pending chat approvals.`,
      );
      return;
    }
    // `/new` starts a topic, as the app's does; `/new plan the launch` also
    // opens it with that message.
    const id = `tg_${telegramDigest(`${connection.id}:${job.update.update_id}`).slice(0, 40)}`;
    if (command === 'new') {
      body = commandArguments(message.text);
      if (!body) {
        await this.messages.startTopic(connection.userId, bot.id, `${id}_new`);
        await this.text(
          connection,
          `New topic with ${bot.name}. Earlier messages stay in Crewaid but are no longer sent to ${bot.name}.`,
        );
        return;
      }
    }

    const existing = await this.prisma.message.findFirst({
      where: {
        id,
        conversation: { bot: { userId: connection.userId } },
      },
      select: { id: true },
    });
    if (existing) return;
    try {
      // Asked before any download or transcription: a refused message would
      // otherwise be paid for again when it is sent a second time.
      if (
        job.incoming === undefined &&
        (await this.chat.awaitingApproval(connection.userId, bot.id, bot.conversation.id))
      ) {
        await this.text(connection, AWAITING_DECISION);
        return;
      }
      const incoming = job.incoming ?? (await this.incoming(connection, message, body));
      if (!incoming) {
        await this.text(connection, 'Send text, a photo, a supported document or a voice note.');
        return;
      }
      if (job.incoming === undefined && incoming.attachmentIds.length > 0)
        await remember?.(incoming);
      if (!(await this.accounts.owned(connection.userId, connection.id))) return;
      // After the duplicate check, so a retried job opens no second topic.
      if (command === 'new') await this.messages.startTopic(connection.userId, bot.id, `${id}_new`);
      const parsed = await this.chat.parse({
        threadId: bot.conversation.id,
        runId: `run_${id}`,
        messages: [{ id, role: 'user', content: incoming.text }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: { attachmentIds: incoming.attachmentIds },
      });
      const admitted = await this.chat.admit(connection.userId, bot.id, parsed);
      if (admitted.kind === 'deferred')
        await this.text(
          connection,
          `${bot.name} is working. Your message is queued for the next reply.`,
        );
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() < 500) {
        await this.text(
          connection,
          error.getStatus() === 409
            ? AWAITING_DECISION
            : 'The message could not be accepted. Check the file type, voice setup and account allowance in Crewaid.',
        );
        return;
      }
      if (error instanceof TelegramApiError && error.status === 413) {
        await this.text(
          connection,
          'That file is too large. Send files up to 20 MiB and voice notes up to 10 MiB.',
        );
        return;
      }
      throw error;
    }
  }

  /**
   * The bot a chat message goes to, decided once so a retry can't switch it:
   * the selected crew member (also for either form of `/new`), or the one a
   * `/name` command with text names. Undefined when the update is a control
   * command, not a chat message.
   */
  async targetFor(
    connection: TelegramConnection,
    text: string | undefined,
  ): Promise<string | null | undefined> {
    const command = telegramCommand(text);
    if (command === undefined) return connection.selectedBotId;
    if (command === 'new') return connection.selectedBotId;
    if (isControlCommand(command) || !commandArguments(text)) return undefined;
    return (await this.crew(connection)).find((entry) => entry.command === command)?.botId;
  }

  /** After the account's Confirm: the menu, a hello, and who to talk to. */
  async welcome(connection: TelegramConnection): Promise<void> {
    await this.text(connection, 'Connected to Crewaid. Type / to see your crew, or choose below.');
    await this.chooseCrew(connection);
  }

  /**
   * A message to a bot that isn't linked yet. Only the pairing code does
   * anything, and even the right one only asks for the Confirm in Crewaid.
   */
  private async pairing(
    job: TelegramJob,
    sender: NonNullable<ReturnType<typeof privateSender>>,
  ): Promise<void> {
    const pending = await this.bots.pending(job.telegramBotId);
    if (!pending) return;
    if (pending.managed && pending.ownerTelegramUserId !== sender.telegramUserId) return;
    const api = this.bots.clientForPending(pending);
    const reply = (text: string) => this.send(() => api.text(sender.chatId, text));
    const callback = job.update.callback_query;
    if (callback) {
      await this.send(() => api.answer(callback.id, 'Finish connecting in Crewaid first.'));
      return;
    }
    if (!job.codeHash) {
      await reply(pending.claimedAt ? CONFIRM_IN_APP : SEND_CODE);
      return;
    }
    const claim = await this.accounts.claim(
      job.telegramBotId,
      {
        telegramUserId: sender.telegramUserId,
        chatId: sender.chatId,
        displayName: [sender.from.first_name, sender.from.last_name].filter(Boolean).join(' '),
      },
      job.codeHash,
    );
    if (claim.outcome === 'claimed') {
      if (claim.displaced) await this.bots.retire(this.bots.pendingTarget(claim.displaced));
      await reply(CONFIRM_IN_APP);
    } else if (claim.outcome === 'awaiting') await reply(CONFIRM_IN_APP);
    else if (claim.outcome === 'wrong') await reply(WRONG_CODE);
    else if (claim.outcome === 'locked') {
      await reply(LOCKED_OUT);
      await this.bots.removePending(pending);
    }
  }

  private async managerUpdate(job: TelegramJob): Promise<void> {
    if (job.update.managed_bot) {
      await this.bots.onManagedBot(job.update.managed_bot);
      return;
    }
    const sender = privateSender(job.update);
    const manager = this.bots.manager();
    if (sender && manager && job.update.message)
      await this.send(() => manager.text(sender.chatId, FROM_MANAGER));
  }

  private async text(connection: TelegramConnection, text: string): Promise<void> {
    if (await this.accounts.owned(connection.userId, connection.id))
      await this.send(() => this.client(connection).text(connection.chatId, text));
  }

  /**
   * False when Telegram refused this exact request. Resending it fails the same
   * way, so a caller records it as handled; rethrowing would retry it on every
   * scan and hold back everything queued after it.
   */
  private async send(request: () => Promise<void>): Promise<boolean> {
    try {
      await request();
      return true;
    } catch (error) {
      if (!refused(error)) throw error;
      this.logger.warn('telegram.send.refused', { status: error.status });
      return false;
    }
  }

  private selected(connection: TelegramConnection) {
    return this.prisma.bot.findFirst({
      where: { id: connection.selectedBotId ?? '', userId: connection.userId },
      select: { id: true, name: true, status: true, conversation: { select: { id: true } } },
    });
  }

  private async crew(connection: TelegramConnection): Promise<CrewCommand[]> {
    return crewCommands(
      await this.prisma.bot.findMany({
        where: { userId: connection.userId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, role: true },
      }),
    );
  }

  /** Telegram's `/` menu lists the crew; it is rewritten only when the crew changed. */
  private async syncCommands(
    connection: TelegramConnection,
    crew: readonly CrewCommand[],
  ): Promise<void> {
    const menu = telegramMenu(crew);
    const digest = telegramDigest(JSON.stringify(menu));
    if (digest === connection.commandsDigest) return;
    if (!(await this.accounts.owned(connection.userId, connection.id))) return;
    if (!(await this.send(() => this.client(connection).setCommands(menu)))) return;
    await this.prisma.telegramConnection.updateMany({
      where: { id: connection.id, userId: connection.userId },
      data: { commandsDigest: digest },
    });
  }

  private async help(connection: TelegramConnection): Promise<void> {
    const crew = await this.crew(connection);
    await this.syncCommands(connection, crew);
    const members =
      crew.length === 0
        ? 'Create a crew member in Crewaid first.'
        : crew.map((entry) => `/${entry.command} — ${entry.name}`).join('\n');
    await this.text(
      connection,
      `Type / to pick who to talk to, then send text, a photo, a file or a voice note.\n\n${members}\n\n${CONTROLS}`,
    );
  }

  private async chooseCrew(connection: TelegramConnection): Promise<void> {
    const crew = await this.crew(connection);
    if (!(await this.accounts.owned(connection.userId, connection.id))) return;
    await this.syncCommands(connection, crew);
    if (crew.length === 0) {
      await this.text(connection, 'Create a crew member in Crewaid first, then use /bots.');
      return;
    }
    const api = this.client(connection);
    for (let offset = 0; offset < crew.length; offset += 30)
      await api.text(
        connection.chatId,
        'Who would you like to talk to?',
        crew
          .slice(offset, offset + 30)
          .map((entry) => [{ text: entry.name.slice(0, 60), callback_data: `b:${entry.botId}` }]),
      );
  }

  private async select(
    connection: TelegramConnection,
    botId: string,
    announce = true,
  ): Promise<boolean> {
    const bot = await this.prisma.bot.findFirst({
      where: { id: botId, userId: connection.userId },
      select: { id: true, name: true, conversation: { select: { id: true } } },
    });
    if (!bot?.conversation) return false;
    if (connection.selectedBotId === botId) {
      if (announce) await this.text(connection, `You’re already talking to ${bot.name}.`);
      return true;
    }
    const [lastMessage, lastRun] = await Promise.all([
      this.prisma.message.findFirst({
        where: {
          conversationId: bot.conversation.id,
          conversation: { bot: { userId: connection.userId } },
        },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      }),
      this.prisma.agentTurn.findFirst({
        where: { botId, bot: { userId: connection.userId } },
        orderBy: { sequence: 'desc' },
        select: { sequence: true, status: true },
      }),
    ]);
    const updated = await this.prisma.telegramConnection.updateMany({
      where: { id: connection.id, userId: connection.userId },
      data: {
        selectedBotId: botId,
        selectedAt: new Date(),
        lastMessageSequence: lastMessage?.sequence ?? 0,
        lastRunSequence: lastRun ? lastRun.sequence - (lastRun.status === 'running' ? 1 : 0) : 0,
        notifiedInterruptIds: [],
      },
    });
    if (updated.count !== 1) return false;
    if (announce)
      await this.text(
        connection,
        `You’re talking to ${bot.name}. Send a message, photo, file or voice note. Type / to switch.`,
      );
    return true;
  }

  private async incoming(connection: TelegramConnection, message: TelegramMessage, body?: string) {
    let text = body ?? message.text ?? message.caption ?? '';
    const attachmentIds: string[] = [];
    const file = message.voice ?? message.document ?? message.photo?.at(-1);
    if (file) {
      const maxBytes = message.voice ? VOICE_MAX_BYTES : 20 * 1024 * 1024;
      if ((file.file_size ?? 0) > maxBytes) throw new TelegramApiError(413);
      const buffer = await this.client(connection).download(file.file_id, maxBytes);
      if (message.voice) {
        const note = await this.voice.storeNote(connection.userId, {
          buffer,
          originalname: 'telegram-voice.ogg',
          mimetype: file.mime_type ?? 'audio/ogg',
        });
        attachmentIds.push(note.attachment.id);
        text = [text, note.transcript].filter(Boolean).join('\n\n');
      } else {
        const stored = await this.attachments.store(
          { userId: connection.userId },
          {
            buffer,
            size: buffer.length,
            originalname:
              file.file_name ?? (message.photo ? 'telegram-photo.jpg' : 'telegram-file'),
            mimetype: file.mime_type ?? (message.photo ? 'image/jpeg' : 'application/octet-stream'),
          },
        );
        attachmentIds.push(stored.id);
      }
    }
    return text.trim() || attachmentIds.length > 0 ? { text, attachmentIds } : null;
  }

  private pending(userId: string, botId: string) {
    return this.prisma.runInterrupt.findMany({
      where: {
        userId,
        status: 'pending',
        nativeStatus: 'pending',
        nativeInterruptId: { not: null },
        run: { botId, bot: { userId }, status: 'interrupted' },
      },
      orderBy: { sequence: 'asc' },
      select: {
        id: true,
        runId: true,
        conversationId: true,
        nativeInterruptId: true,
        payload: true,
      },
    });
  }

  private async answerApproval(connection: TelegramConnection, data: string): Promise<boolean> {
    const [action, id, digest] = data.split(':');
    if (!id || !digest) return false;
    const row = await this.prisma.runInterrupt.findFirst({
      where: {
        id,
        userId: connection.userId,
        status: 'pending',
        run: { bot: { userId: connection.userId } },
      },
      select: { run: { select: { botId: true } } },
    });
    if (!row) return false;
    const prompt = approvalPrompt(await this.pending(connection.userId, row.run.botId));
    if (!prompt || digest !== prompt.digest || (action === 'a' && !prompt.complete)) return false;
    if (!(await this.accounts.owned(connection.userId, connection.id))) return false;
    await this.chat.admit(
      connection.userId,
      row.run.botId,
      await this.chat.parse({
        threadId: prompt.first.conversationId,
        runId: `tga_${telegramDigest(data).slice(0, 40)}`,
        parentRunId: prompt.first.runId,
        messages: [],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
        resume: prompt.rows.map((interrupt) => ({
          interruptId: interrupt.nativeInterruptId,
          status: 'resolved',
          payload: { approved: action === 'a' },
        })),
      }),
    );
    return true;
  }

  async approvals(connection: TelegramConnection, force = false): Promise<boolean> {
    if (!connection.selectedBotId) return false;
    const bot = await this.selected(connection);
    if (!bot) return false;
    const prompt = approvalPrompt(await this.pending(connection.userId, connection.selectedBotId));
    const ids = prompt?.rows.map((row) => row.id) ?? [];
    if (prompt && (force || ids.some((id) => !connection.notifiedInterruptIds.includes(id)))) {
      if (!(await this.accounts.owned(connection.userId, connection.id))) return false;
      const buttons = [
        ...(prompt.complete
          ? [
              {
                text: ids.length === 1 ? 'Approve' : 'Approve all',
                callback_data: `a:${prompt.first.id}:${prompt.digest}`,
              },
            ]
          : []),
        {
          text: ids.length === 1 ? 'Reject' : 'Reject all',
          callback_data: `r:${prompt.first.id}:${prompt.digest}`,
        },
      ];
      await this.send(() =>
        this.client(connection).text(connection.chatId, `${bot.name}\n\n${prompt.text}`, [buttons]),
      );
    }
    // Every delivery scan lands here; an unchanged batch is not a write.
    const notified = connection.notifiedInterruptIds;
    if (ids.length !== notified.length || ids.some((id) => !notified.includes(id)))
      await this.prisma.telegramConnection.updateMany({
        where: {
          id: connection.id,
          userId: connection.userId,
          selectedBotId: connection.selectedBotId,
        },
        data: { notifiedInterruptIds: ids },
      });
    return prompt !== null;
  }

  /** Persistent sequence cursors make closed-desktop and restart delivery equivalent. */
  async deliver(userId: string, connectionId: string): Promise<void> {
    const connection = await this.accounts.owned(userId, connectionId);
    if (!connection || !connection.selectedBotId) return;
    const bot = await this.selected(connection);
    if (!bot?.conversation) return;
    const api = this.client(connection);
    const messages = await this.prisma.message.findMany({
      where: {
        conversationId: bot.conversation.id,
        sequence: { gt: connection.lastMessageSequence },
        author: 'BOT',
        fromBotId: bot.id,
        conversation: { bot: { userId } },
      },
      orderBy: { sequence: 'asc' },
      take: 20,
      select: {
        content: true,
        sequence: true,
        run: { select: { status: true } },
      },
    });
    for (const message of messages) {
      if (message.run?.status === 'running') break;
      if (!(await this.accounts.owned(userId, connection.id))) return;
      if (
        message.content.trim() &&
        !(await this.send(() => api.text(connection.chatId, `${bot.name}\n\n${message.content}`)))
      )
        await this.text(
          connection,
          `A reply from ${bot.name} couldn’t be sent to Telegram. Open Crewaid to read it.`,
        );
      await this.prisma.telegramConnection.updateMany({
        where: { id: connection.id, userId, selectedBotId: bot.id },
        data: { lastMessageSequence: message.sequence },
      });
    }
    // Spoken replies and generated files can attach after text has been delivered.
    // Their receipts must not share the message sequence cursor.
    const files = await this.prisma.attachment.findMany({
      where: {
        ownerId: userId,
        createdAt: { gte: connection.selectedAt },
        message: {
          conversationId: bot.conversation.id,
          conversation: { bot: { userId } },
          author: 'BOT',
          fromBotId: bot.id,
          OR: [{ runId: null }, { run: { status: { not: 'running' } } }],
        },
        telegramDeliveries: { none: { connectionId: connection.id } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 20,
      select: { id: true },
    });
    for (const file of files) {
      if (!(await this.accounts.owned(userId, connection.id))) return;
      let opened: Awaited<ReturnType<AttachmentsService['openForDownload']>> | undefined;
      try {
        opened = await this.attachments.openForDownload(userId, file.id);
      } catch (error) {
        if (!(error instanceof HttpException) || ![404, 410].includes(error.getStatus()))
          throw error;
        await this.text(connection, 'An attached file is no longer available in Crewaid.');
      }
      if (opened) {
        const chunks: Buffer[] = [];
        let size = 0;
        try {
          for await (const chunk of opened.stream) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
            size += bytes.length;
            if (size > AttachmentsService.MAX_BYTES) break;
            chunks.push(bytes);
          }
        } finally {
          opened.stream.destroy();
        }
        const { filename, mimeType } = opened.attachment;
        const sent =
          size <= AttachmentsService.MAX_BYTES &&
          (await this.send(() =>
            api.document(connection.chatId, Buffer.concat(chunks), filename, mimeType),
          ));
        if (!sent)
          await this.text(
            connection,
            `${filename} couldn’t be sent to Telegram. Open Crewaid to download it.`,
          );
      }
      // A disconnect deletes the connection and its receipts. Never recreate a
      // receipt for work that was revoked while the provider request was in flight.
      if (!(await this.accounts.owned(userId, connection.id))) return;
      await this.prisma.telegramAttachmentDelivery.upsert({
        where: {
          connectionId_attachmentId: { connectionId: connection.id, attachmentId: file.id },
        },
        create: {
          connection: { connect: { id: connection.id, userId } },
          attachment: { connect: { id: file.id, ownerId: userId } },
        },
        update: {},
      });
    }
    await this.approvals(connection);
    const runs = await this.prisma.agentTurn.findMany({
      where: { botId: bot.id, bot: { userId }, sequence: { gt: connection.lastRunSequence } },
      orderBy: { sequence: 'asc' },
      take: 20,
      select: {
        sequence: true,
        status: true,
        messages: { where: { author: 'BOT', content: { not: '' } }, take: 1, select: { id: true } },
      },
    });
    for (const run of runs) {
      if (run.status === 'running') break;
      if (run.status === 'completed' && run.messages.length === 0)
        await this.text(connection, `${bot.name} finished.`);
      if (run.status === 'failed' || run.status === 'aborted')
        await this.text(
          connection,
          `${bot.name}: ${run.status === 'failed' ? 'work could not finish. Open Crewaid for details.' : 'work stopped.'}`,
        );
      await this.prisma.telegramConnection.updateMany({
        where: { id: connection.id, userId, selectedBotId: bot.id },
        data: { lastRunSequence: run.sequence },
      });
    }
  }
}

/** A 4xx other than 403 (blocked, which disconnects) and 429 (later) is refused for good. */
function refused(error: unknown): error is TelegramApiError {
  return (
    error instanceof TelegramApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 403 &&
    error.status !== 429
  );
}

/**
 * The oldest run's pending batch. One answer resumes one run, so later runs
 * are shown once this one is settled. A payload Telegram cannot read is still
 * shown, rejectable but not approvable: hiding it would leave the thread
 * refusing messages with nothing to answer.
 */
function approvalPrompt<
  Row extends { id: string; runId: string; conversationId: string; payload: unknown },
>(pending: Row[]) {
  const first = pending[0];
  if (!first) return null;
  const rows = pending.filter((row) => row.runId === first.runId);
  const parsed = rows.map((row) => PolicyProposalSchema.safeParse(row.payload));
  const readable = parsed.every((row) => row.success);
  const details = parsed
    .map((row) =>
      row.success
        ? `${row.data.toolName}\n${JSON.stringify(row.data.args, null, 2)}`
        : 'An action Telegram can’t display',
    )
    .join('\n\n');
  const complete = readable && details.length <= 3400;
  return {
    first,
    rows,
    complete,
    digest: telegramDigest(JSON.stringify(rows)).slice(0, 12),
    text:
      `Approval requested (${rows.length} action${rows.length === 1 ? '' : 's'})\n\n${details.slice(0, 3400)}` +
      (complete
        ? ''
        : '\n\nDetails can’t be shown in full here. Review and approve in Crewaid, or reject below.'),
  };
}
