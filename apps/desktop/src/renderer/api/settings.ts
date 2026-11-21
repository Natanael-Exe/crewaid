import {
  API_ROUTES,
  UserSettingsResponseSchema,
  type UpdateUserSettingsBody,
  type UserSettings,
} from '@crewaid/shared';
import type { ApiClient } from './apiClient';

/** `GET /settings`: the account's settings row, answered even before one is written. */
export async function getSettings(client: ApiClient, signal?: AbortSignal): Promise<UserSettings> {
  const response = await client.request(API_ROUTES.settings.get, {
    schema: UserSettingsResponseSchema,
    ...(signal !== undefined && { signal }),
  });
  return response.settings;
}

/** `PATCH /settings`: absent fields are left alone, null clears one. */
export async function updateSettings(
  client: ApiClient,
  body: UpdateUserSettingsBody,
): Promise<UserSettings> {
  const response = await client.request(API_ROUTES.settings.update, {
    body,
    schema: UserSettingsResponseSchema,
  });
  return response.settings;
}
