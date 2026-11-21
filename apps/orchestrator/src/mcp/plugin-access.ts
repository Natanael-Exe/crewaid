import type { Prisma } from '@prisma/client';
import type { PluginAccess } from '@crewaid/shared';

/** Evaluate against the owned server at assembly and dispatch, including future bots. */
export function enabledPluginWhere(botId: string): Prisma.McpServerWhereInput {
  return {
    OR: [
      { accessMode: 'SELECTED', bots: { some: { botId, enabled: true } } },
      { accessMode: 'ALL', bots: { none: { botId, enabled: false } } },
    ],
    NOT: { composioConnection: { is: { removing: true } } },
  };
}

export function toPluginAccess(row: {
  accessMode: 'SELECTED' | 'ALL';
  bots: readonly { botId: string; enabled: boolean }[];
}): PluginAccess {
  return row.accessMode === 'ALL'
    ? {
        mode: 'ALL',
        excludedBotIds: row.bots
          .filter((bot) => !bot.enabled)
          .map((bot) => bot.botId)
          .sort(),
      }
    : {
        mode: 'SELECTED',
        selectedBotIds: row.bots
          .filter((bot) => bot.enabled)
          .map((bot) => bot.botId)
          .sort(),
      };
}
