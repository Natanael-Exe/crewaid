import {
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  DeleteMessagesQuerySchema,
  type DeleteMessagesQuery,
  type Principal,
} from '@crewaid/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { MessagesService } from './messages.service.js';

/**
 * D-147's deletions and `/new` over the canonical transcript. A message is
 * sent and the history read through the chat routes; the
 * REST list and send routes went with the AI SDK engine.
 */
@Controller('bots/:id')
export class MessagesController {
  constructor(@Inject(MessagesService) private readonly messages: MessagesService) {}

  /** "Clear chat". 200 with counts, not 204: the client reports them. */
  @Delete('messages')
  @HttpCode(HttpStatus.OK)
  clear(
    @Param('id') botId: string,
    @Query(new ZodValidationPipe(DeleteMessagesQuerySchema)) query: DeleteMessagesQuery,
    @CurrentUser() principal: Principal,
  ) {
    return this.messages.deleteMessages(principal.userId, botId, { forget: query.forget });
  }

  /** Delete one message. */
  @Delete('messages/:messageId')
  @HttpCode(HttpStatus.OK)
  remove(
    @Param('id') botId: string,
    @Param('messageId') messageId: string,
    @Query(new ZodValidationPipe(DeleteMessagesQuerySchema)) query: DeleteMessagesQuery,
    @CurrentUser() principal: Principal,
  ) {
    return this.messages.deleteMessages(principal.userId, botId, {
      messageId,
      forget: query.forget,
    });
  }

  /**
   * `/new`. Created here and not by POST /messages, because a
   * boundary is not something said to the bot: it starts no turn.
   */
  @Post('topics')
  @HttpCode(HttpStatus.CREATED)
  startTopic(@Param('id') botId: string, @CurrentUser() principal: Principal) {
    return this.messages.startTopic(principal.userId, botId);
  }
}
