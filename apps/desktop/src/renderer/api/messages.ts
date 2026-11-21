import {
  API_ROUTES,
  DeleteMessagesResponseSchema,
  MessageWithAttachmentsSchema,
  type DeleteMessagesResponse,
  type MessageWithAttachments,
} from '@crewaid/shared';
import type { ApiClient } from './apiClient';

/**
 * REST message routes that outlived the AI SDK engine: deleting and
 * `/new`. A person's message and the bot's reply travel over the chat route.
 */

/**
 * Delete one message. `forget` also forgets what the bot learned from
 * it; without it every memory stays. Refused (409) while the bot is working.
 */
export function deleteMessage(
  client: ApiClient,
  botId: string,
  messageId: string,
  forget: boolean,
): Promise<DeleteMessagesResponse> {
  return client.request(API_ROUTES.bots.deleteMessage, {
    params: { id: botId, messageId },
    query: { forget: forget ? 'true' : 'false' },
    schema: DeleteMessagesResponseSchema,
  });
}

/** "Clear chat" — every message in the bot's conversation. */
export function clearMessages(
  client: ApiClient,
  botId: string,
  forget: boolean,
): Promise<DeleteMessagesResponse> {
  return client.request(API_ROUTES.bots.clearMessages, {
    params: { id: botId },
    query: { forget: forget ? 'true' : 'false' },
    schema: DeleteMessagesResponseSchema,
  });
}

/**
 * `/new`. Answers with the boundary row; it starts no turn, so there
 * is no reply to wait for.
 */
export function startTopic(client: ApiClient, botId: string): Promise<MessageWithAttachments> {
  return client.request(API_ROUTES.bots.startTopic, {
    params: { id: botId },
    schema: MessageWithAttachmentsSchema,
  });
}
