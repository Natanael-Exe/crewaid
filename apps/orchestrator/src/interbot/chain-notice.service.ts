import { Inject, Injectable } from '@nestjs/common';

import { MessagesService } from '../messages/messages.service.js';
import { StructuredLogger } from '../logging/structured-logger.js';
import { TurnEventBus } from '../agent/turn-event.bus.js';

/**
 * How a chain tells its participants that it stopped.
 *
 * §6/M7 posts "a system message to both bots" when a chain is cut, and D-047
 * keeps that sentence when it removes the shipped ceiling: "a chain that ends
 * must still say why." One place knows how such a notice reaches a
 * transcript, because two paths produce them — the tool refusing a send, and
 * the worker dropping a delivery — and a notice that reached the database but
 * not the socket would be invisible until the next history fetch.
 *
 * A notice that fails must not fail what it was explaining
 *
 * Same posture as `ChatSendService`'s limit announcement: the refusal has
 * already happened and is already correct. Turning a failed write into a
 * failed turn would take the bot down over the sentence describing why it
 * stopped, which is the one outcome worse than the operator not reading it.
 */
@Injectable()
export class ChainNoticeService {
  constructor(
    @Inject(MessagesService) private readonly messages: MessagesService,
    @Inject(TurnEventBus) private readonly events: TurnEventBus,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
  ) {}

  post = async (botId: string, chainId: string, content: string): Promise<void> => {
    try {
      const row = await this.messages.createSystemMessage({ botId, content });
      this.events.emitCreated(botId, { ...row, attachments: [] });
    } catch (error) {
      this.logger.child({ botId, chainId }).warn('interbot.notice.failed', {
        detail: error instanceof Error ? error.message : 'unknown',
      });
    }
  };
}
