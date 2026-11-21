import {
  API_ROUTES,
  BotSchema,
  ListBotsResponseSchema,
  MarkBotReadResponseSchema,
  type Bot,
  type MarkBotReadResponse,
  type ListBotsResponse,
  type CreateBotBody,
  type UpdateBotBody,
} from '@crewaid/shared';
import type { ApiClient } from './apiClient';

/**
 * REST bot routes.
 *
 * `GET /bots` answers a bare array — `BotsService.list` returns its
 * `findMany({ include: { sandbox: true } })` straight through, with no
 * envelope to unwrap. That shape is named in `@crewaid/shared` rather than
 * composed here, so the client parses a contract instead of a local guess.
 */
export function listBots(client: ApiClient): Promise<ListBotsResponse> {
  return client.request(API_ROUTES.bots.list, { schema: ListBotsResponseSchema });
}

export function createBot(client: ApiClient, body: CreateBotBody): Promise<Bot> {
  return client.request(API_ROUTES.bots.create, { body, schema: BotSchema });
}

export function updateBot(client: ApiClient, id: string, body: UpdateBotBody): Promise<Bot> {
  return client.request(API_ROUTES.bots.update, { params: { id }, body, schema: BotSchema });
}

export function duplicateBot(client: ApiClient, id: string): Promise<Bot> {
  return client.request(API_ROUTES.bots.duplicate, { params: { id }, schema: BotSchema });
}

/** 204 — no body to parse. */
export function deleteBot(client: ApiClient, id: string): Promise<void> {
  return client.request(API_ROUTES.bots.remove, { params: { id } });
}

/**
 * Mark this bot's messages read, or its newest one unread. Answers with
 * the count after the change, so the badge shows the server's number.
 */
export function markBotRead(
  client: ApiClient,
  id: string,
  unread = false,
): Promise<MarkBotReadResponse> {
  return client.request(API_ROUTES.bots.markRead, {
    params: { id },
    body: unread ? { unread: true } : {},
    schema: MarkBotReadResponseSchema,
  });
}
