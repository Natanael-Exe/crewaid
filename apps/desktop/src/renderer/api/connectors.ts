import {
  API_ROUTES,
  CreateConnectorResponseSchema,
  ListConnectorsResponseSchema,
  RotateConnectorResponseSchema,
  type CreateConnectorBody,
} from '@crewaid/shared';
import type { ApiClient } from './apiClient';

export function listConnectors(client: ApiClient, signal?: AbortSignal) {
  return client.request(API_ROUTES.connectors.list, {
    schema: ListConnectorsResponseSchema,
    ...(signal === undefined ? {} : { signal }),
  });
}

export function createConnector(client: ApiClient, body: CreateConnectorBody) {
  return client.request(API_ROUTES.connectors.create, {
    body,
    schema: CreateConnectorResponseSchema,
  });
}

export function rotateConnectorSecret(client: ApiClient, id: string) {
  return client.request(API_ROUTES.connectors.rotate, {
    params: { id },
    schema: RotateConnectorResponseSchema,
  });
}

export function removeConnector(client: ApiClient, id: string) {
  return client.request(API_ROUTES.connectors.remove, {
    params: { id },
  });
}
