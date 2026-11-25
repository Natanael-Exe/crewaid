import {
  API_ROUTES,
  ListWorkflowsResponseSchema,
  StopWorkflowResponseSchema,
  WrapUpWorkflowResponseSchema,
  type ListWorkflowsResponse,
  type StopWorkflowResponse,
  type WrapUpWorkflowResponse,
} from '@crewaid/shared';
import type { ApiClient } from './apiClient';

export function listWorkflows(
  client: ApiClient,
  botId: string,
  signal?: AbortSignal,
): Promise<ListWorkflowsResponse> {
  return client.request(API_ROUTES.bots.workflows, {
    params: { id: botId },
    schema: ListWorkflowsResponseSchema,
    ...(signal === undefined ? {} : { signal }),
  });
}

export function stopWorkflow(
  client: ApiClient,
  botId: string,
  chainId?: string,
): Promise<StopWorkflowResponse> {
  return client.request(API_ROUTES.bots.stopWorkflow, {
    params: { id: botId },
    body: chainId === undefined ? {} : { chainId },
    schema: StopWorkflowResponseSchema,
  });
}

export function wrapUpWorkflow(
  client: ApiClient,
  botId: string,
  chainId?: string,
): Promise<WrapUpWorkflowResponse> {
  return client.request(API_ROUTES.bots.wrapUpWorkflow, {
    params: { id: botId },
    body: chainId === undefined ? {} : { chainId },
    schema: WrapUpWorkflowResponseSchema,
  });
}
