import {
  API_ROUTES,
  ListProviderConnectionsResponseSchema,
  ProviderConnectionSchema,
  ProviderModelSchema,
  type CreateProviderConnectionBody,
  type CreateProviderModelBody,
  type ListProviderConnectionsResponse,
  type ProviderConnection,
  type ProviderModel,
  type SetProviderCredentialBody,
  type UpdateProviderConnectionBody,
  type UpdateProviderModelBody,
} from '@crewaid/shared';
import type { ApiClient } from './apiClient';

/**
 * REST provider-connection routes.
 *
 * ⚠️ NOTHING HERE RETURNS A KEY, AND NOTHING HERE CAN. `setCredential` takes
 * one and answers 204; `ProviderConnectionSchema` has no field that could
 * carry one back, and no masked stand-in either. That is the whole point of
 * The write-only property is a fact about the TYPE, so a handler
 * cannot forget it and a pane cannot accidentally render it.
 *
 * Every mutation here answers with the row or with nothing, never with the
 * list. The pane refetches instead: a connection's `state` moves when a key is
 * set or cleared, and its models are a separate resource, so a caller
 * splicing one returned row into a cached list would be constructing a view
 * the server never agreed to.
 */

export function listConnections(client: ApiClient): Promise<ListProviderConnectionsResponse> {
  return client.request(API_ROUTES.providers.list, {
    schema: ListProviderConnectionsResponseSchema,
  });
}

export function createConnection(
  client: ApiClient,
  body: CreateProviderConnectionBody,
): Promise<ProviderConnection> {
  return client.request(API_ROUTES.providers.create, { body, schema: ProviderConnectionSchema });
}

export function updateConnection(
  client: ApiClient,
  id: string,
  body: UpdateProviderConnectionBody,
): Promise<ProviderConnection> {
  return client.request(API_ROUTES.providers.update, {
    params: { id },
    body,
    schema: ProviderConnectionSchema,
  });
}

/** 204 — and a 409 when a bot or the default still points at one of its models. */
export function deleteConnection(client: ApiClient, id: string): Promise<void> {
  return client.request(API_ROUTES.providers.remove, { params: { id } });
}

/**
 * PUT, not POST: setting a key replaces whatever was there, and doing it twice
 * with the same key leaves the same state. 204 — there is nothing to return.
 */
export function setCredential(
  client: ApiClient,
  id: string,
  body: SetProviderCredentialBody,
): Promise<void> {
  return client.request(API_ROUTES.providers.setCredential, { params: { id }, body });
}

/**
 * 204. Takes effect immediately and is NOT refused by the reference guard —
 * that asymmetry is deliberate and the server's own 409 copy points at it:
 * deleting a model a bot uses is refused, but revoking the key it runs on is
 * the emergency stop and must never be blocked by a bot's configuration.
 */
export function clearCredential(client: ApiClient, id: string): Promise<void> {
  return client.request(API_ROUTES.providers.clearCredential, { params: { id } });
}

export function createModel(
  client: ApiClient,
  connectionId: string,
  body: CreateProviderModelBody,
): Promise<ProviderModel> {
  return client.request(API_ROUTES.providers.createModel, {
    params: { id: connectionId },
    body,
    schema: ProviderModelSchema,
  });
}

/**
 * Keyed by the MODEL id, not by connection-then-model: a model id is already
 * unique and already the thing `Bot.modelId` stores, so a nested URL
 * would add a segment that can disagree with the one that matters.
 */
export function updateModel(
  client: ApiClient,
  modelId: string,
  body: UpdateProviderModelBody,
): Promise<ProviderModel> {
  return client.request(API_ROUTES.providers.updateModel, {
    params: { modelId },
    body,
    schema: ProviderModelSchema,
  });
}

/** 204 — and a 409 naming the bots that still point at it. */
export function deleteModel(client: ApiClient, modelId: string): Promise<void> {
  return client.request(API_ROUTES.providers.removeModel, { params: { modelId } });
}
