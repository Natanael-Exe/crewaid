import type { McpDirectoryEntry, McpServerSummary, Template } from '@crewaid/shared';
import type { BotDraft } from '../bots/botProfileForm';
import { t } from '../i18n/i18n';

/** What the account's connections say about one tool a template supports. */
export type ToolState = 'connected' | 'reconnect' | 'available' | 'unavailable' | 'unknown';

export const TOOL_STATE_LABEL: Record<ToolState, string> = {
  get connected() {
    return t('experience.templateView.connected');
  },
  get reconnect() {
    return t('experience.templateView.needsReconnecting');
  },
  get available() {
    return t('experience.templateView.notConnected');
  },
  get unavailable() {
    return t('experience.templateView.notAvailableOnThisServer');
  },
  get unknown() {
    return t('experience.templateView.couldntCheck');
  },
};

export type Connections = {
  readonly servers: readonly McpServerSummary[];
  readonly directory: readonly McpDirectoryEntry[];
  /** False when the directory could not be read, so "not listed" means nothing. */
  readonly directoryRead: boolean;
};

export const NO_CONNECTIONS: Connections = { servers: [], directory: [], directoryRead: false };

const sameSlug = (a: string, b: string) =>
  a.toLowerCase().replace(/[-_]/g, '') === b.toLowerCase().replace(/[-_]/g, '');

export function serverFor(slug: string, connections: Connections): McpServerSummary | undefined {
  return connections.servers.find((server) => sameSlug(server.slug, slug));
}

export function toolState(slug: string, connections: Connections): ToolState {
  const server = serverFor(slug, connections);
  if (server) return server.status === 'CONNECTED' ? 'connected' : 'reconnect';
  if (!connections.directoryRead) return 'unknown';
  return connections.directory.some((entry) => sameSlug(entry.slug, slug))
    ? 'available'
    : 'unavailable';
}

/** The library's own page for a crew member: every specialist is also a bot template. */
export const botTemplateId = (key: string) => `bot-${key}`;

/** A bot template becomes the create form's starting point; the person edits it from there. */
export function draftFromTemplate(template: Template): BotDraft | null {
  const bot = template.bots[0];
  if (template.kind !== 'bot' || bot === undefined) return null;
  return {
    name: bot.name,
    role: bot.role,
    systemPrompt: bot.systemPrompt,
    avatarColor: bot.avatarColor,
    avatarShape: bot.avatarShape,
  };
}

/** A goal and context Crewaid drafted from the conversation, read off its `read_template` call. */
export type SetupPrefill = { readonly goal: string; readonly context: string };

export function prefillFrom(input: unknown): SetupPrefill | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const { goal, context } = input as { goal?: unknown; context?: unknown };
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  if (text(goal) === '' && text(context) === '') return undefined;
  return { goal: text(goal), context: text(context) };
}
