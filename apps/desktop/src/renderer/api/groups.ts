import {
  API_ROUTES,
  BotGroupSchema,
  ListBotGroupsResponseSchema,
  type BotGroup,
  type CreateBotGroupBody,
  type ListBotGroupsResponse,
  type UpdateBotGroupBody,
} from '@crewaid/shared';
import type { ApiClient } from './apiClient';

/** The sidebar's bot groups. */
export function listGroups(client: ApiClient): Promise<ListBotGroupsResponse> {
  return client.request(API_ROUTES.groups.list, { schema: ListBotGroupsResponseSchema });
}

export function createGroup(client: ApiClient, body: CreateBotGroupBody): Promise<BotGroup> {
  return client.request(API_ROUTES.groups.create, { body, schema: BotGroupSchema });
}

export function updateGroup(
  client: ApiClient,
  id: string,
  body: UpdateBotGroupBody,
): Promise<BotGroup> {
  return client.request(API_ROUTES.groups.update, { params: { id }, body, schema: BotGroupSchema });
}

export function deleteGroup(client: ApiClient, id: string): Promise<void> {
  return client.request(API_ROUTES.groups.remove, { params: { id } });
}
