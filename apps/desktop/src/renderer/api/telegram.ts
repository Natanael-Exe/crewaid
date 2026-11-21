import {
  API_ROUTES,
  TelegramStatusSchema,
  TelegramLinkResponseSchema,
  TelegramBotRegisteredSchema,
  TelegramConfirmResponseSchema,
  TelegramDisconnectResponseSchema,
} from '@crewaid/shared';
import type { ApiClient } from './apiClient';

export function telegramStatus(client: ApiClient, signal?: AbortSignal) {
  return client.request(API_ROUTES.telegram.status, {
    schema: TelegramStatusSchema,
    ...(signal ? { signal } : {}),
  });
}

/** A fresh pairing code, and the QR code's link when the server can create bots. */
export function connectTelegram(client: ApiClient) {
  return client.request(API_ROUTES.telegram.link, { schema: TelegramLinkResponseSchema });
}

/** A bot the person made with @BotFather themselves. */
export function registerTelegramBot(client: ApiClient, token: string) {
  return client.request(API_ROUTES.telegram.registerBot, {
    body: { token },
    schema: TelegramBotRegisteredSchema,
  });
}

export function confirmTelegram(client: ApiClient) {
  return client.request(API_ROUTES.telegram.confirm, { schema: TelegramConfirmResponseSchema });
}

/** Cancels a bot that is still connecting, or disconnects the connected one. */
export function disconnectTelegram(client: ApiClient) {
  return client.request(API_ROUTES.telegram.disconnect, {
    schema: TelegramDisconnectResponseSchema,
  });
}
