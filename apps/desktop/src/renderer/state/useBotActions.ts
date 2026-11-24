import { useCallback, useMemo, useState } from 'react';
import type { BotGroup } from '@crewaid/shared';
import { writeFailureMessage } from '../bots/botProfileForm';
import type { GroupDraft } from '../bots/GroupDialog';
import type { GroupDialogState } from '../components/AppModals';
import type { BotRowActions, GroupActions } from '../components/BotSidebar';
import type { BotMutation, useChat } from './useChat';
import type { BotRowView } from './viewTypes';

type ChatController = ReturnType<typeof useChat>;

/**
 * Sidebar row and group mutation handlers with shared error reporting.
 */
export function useBotActions({
  rows,
  groups,
  chatController,
  groupDialog,
  onSelectBot,
  onEditProfile,
  onOpenGroupDialog,
  onDeleteGroup,
  onClearChat,
}: {
  readonly rows: readonly BotRowView[];
  readonly groups: readonly BotGroup[];
  readonly chatController: ChatController;
  readonly groupDialog: GroupDialogState | null;
  readonly onSelectBot: (botId: string) => void;
  readonly onEditProfile: (botId: string) => void;
  readonly onOpenGroupDialog: (dialog: GroupDialogState) => void;
  readonly onDeleteGroup: (group: BotGroup) => void;
  readonly onClearChat: (botId: string) => void;
}) {
  const [botActionFailure, setBotActionFailure] = useState<string | null>(null);

  const reportBotMutation = useCallback(
    async (operation: () => Promise<BotMutation<unknown>>): Promise<void> => {
      setBotActionFailure(null);
      const result = await operation();
      if (!result.ok) setBotActionFailure(writeFailureMessage(result.failure));
    },
    [],
  );

  const rowActions = useMemo<BotRowActions>(
    () => ({
      editProfile: (botId) => {
        setBotActionFailure(null);
        onSelectBot(botId);
        onEditProfile(botId);
      },
      togglePin: (botId) => {
        const current = rows.find((row) => row.bot.id === botId);
        if (current === undefined) return;
        void reportBotMutation(() =>
          chatController.saveBot(botId, { pinned: !current.bot.pinned }),
        );
      },
      hide: (botId) =>
        void reportBotMutation(() => chatController.saveBot(botId, { hiddenFromSidebar: true })),
      duplicate: (botId) =>
        void reportBotMutation(() => chatController.duplicateExistingBot(botId)),
      remove: (botId) => void reportBotMutation(() => chatController.removeBot(botId)),
      moveToGroup: (botId, groupId) =>
        void reportBotMutation(() => chatController.saveBot(botId, { groupId })),
      newGroupFor: (botId) => onOpenGroupDialog({ group: null, forBotId: botId }),
      markUnread: (botId) => void reportBotMutation(() => chatController.markUnread(botId)),
      clearChat: (botId) => onClearChat(botId),
    }),
    [
      chatController.duplicateExistingBot,
      chatController.markUnread,
      chatController.removeBot,
      chatController.saveBot,
      onClearChat,
      onEditProfile,
      onOpenGroupDialog,
      onSelectBot,
      reportBotMutation,
      rows,
    ],
  );

  const groupActions = useMemo<GroupActions>(
    () => ({
      toggleCollapsed: (group) =>
        void reportBotMutation(() =>
          chatController.saveGroup(group.id, { collapsed: !group.collapsed }),
        ),
      edit: (group) => onOpenGroupDialog({ group }),
      // Rewrite contiguous 0..n-1 positions so previously equal orders still move.
      move: (group, direction) => {
        const order = groups.map((g) => g.id);
        const from = order.indexOf(group.id);
        const to = from + direction;
        if (from < 0 || to < 0 || to >= order.length) return;
        [order[from], order[to]] = [order[to] ?? group.id, group.id];
        void reportBotMutation(async () => {
          for (const [index, id] of order.entries()) {
            if (groups.find((g) => g.id === id)?.sortOrder === index) continue;
            const saved = await chatController.saveGroup(id, { sortOrder: index });
            if (!saved.ok) return saved;
          }
          return { ok: true, value: undefined };
        });
      },
      remove: (group) => onDeleteGroup(group),
    }),
    [groups, chatController.saveGroup, onDeleteGroup, onOpenGroupDialog, reportBotMutation],
  );

  const saveGroupDraft = useCallback(
    async (draft: GroupDraft): Promise<BotMutation<unknown>> => {
      if (groupDialog?.group != null) return chatController.saveGroup(groupDialog.group.id, draft);
      const created = await chatController.createNewGroup(draft);
      if (!created.ok || groupDialog?.forBotId === undefined) return created;
      return chatController.saveBot(groupDialog.forBotId, { groupId: created.value.id });
    },
    [chatController.createNewGroup, chatController.saveBot, chatController.saveGroup, groupDialog],
  );

  return {
    botActionFailure,
    setBotActionFailure,
    reportBotMutation,
    rowActions,
    groupActions,
    saveGroupDraft,
  };
}
