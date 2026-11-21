import {
  API_ROUTES,
  MemoryResponseSchema,
  OnboardingBootstrapSchema,
  OnboardingStateSchema,
  type OnboardingBootstrapBody,
  TemplateListSchema,
  TemplateSchema,
  TemplateInstallResponseSchema,
  type TemplateInstallBody,
  type UpdateOnboardingBody,
} from '@crewaid/shared';
import type { ApiClient } from './apiClient';
export const bootstrapExperience = (client: ApiClient, body: OnboardingBootstrapBody) =>
  client.request(API_ROUTES.onboarding.bootstrap, { body, schema: OnboardingBootstrapSchema });
export const updateOnboarding = (client: ApiClient, body: UpdateOnboardingBody) =>
  client.request(API_ROUTES.onboarding.update, { body, schema: OnboardingStateSchema });
export const listTemplates = (client: ApiClient) =>
  client.request(API_ROUTES.templates.list, { schema: TemplateListSchema });
export const readTemplate = (client: ApiClient, id: string) =>
  client.request(API_ROUTES.templates.get, { params: { id }, schema: TemplateSchema });
export const installTemplate = (client: ApiClient, body: TemplateInstallBody) =>
  client.request(API_ROUTES.templates.install, { body, schema: TemplateInstallResponseSchema });
export const listMemories = (client: ApiClient, botId: string) =>
  client.request(API_ROUTES.memory, { query: { botId }, schema: MemoryResponseSchema });
export const editMemory = (client: ApiClient, id: string, text: string): Promise<void> =>
  client.request(API_ROUTES.memoryUpdate, { params: { id }, body: { text } });
export const forgetMemory = (client: ApiClient, id: string): Promise<void> =>
  client.request(API_ROUTES.memoryRemove, { params: { id } });
