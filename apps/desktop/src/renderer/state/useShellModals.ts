import { useCallback, useEffect, useState } from 'react';
import type { BotGroup } from '@crewaid/shared';
import type { BotDraft } from '../bots/botProfileForm';
import { menuBridge } from '../bridge';
import type { GroupDialogState } from '../components/AppModals';
import type { DeleteMessagesRequest } from '../components/DeleteMessagesDialog';
import type { SettingsPaneId } from '../settings/settingsPanes';
import type { MessageWorkRequest } from '../work/MessageWorkDialogs';

/**
 * Overlay and modal open/draft state owned by the top-level shell.
 */
export function useShellModals() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPane, setSettingsPane] = useState<SettingsPaneId | undefined>(undefined);
  // Bumped when Settings closes so the composer's model picker refetches edits.
  const [catalogVersion, setCatalogVersion] = useState(0);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState<BotDraft | null>(null);
  const [projectDialog, setProjectDialog] = useState<'new' | 'manage' | null>(null);
  const [messageWork, setMessageWork] = useState<MessageWorkRequest | null>(null);
  const [deleteRequest, setDeleteRequest] = useState<DeleteMessagesRequest | null>(null);
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const [groupDialog, setGroupDialog] = useState<GroupDialogState | null>(null);
  const [deletingGroup, setDeletingGroup] = useState<BotGroup | null>(null);
  const [reviewSkillId, setReviewSkillId] = useState<string | null>(null);

  useEffect(() => menuBridge.onNewBot(() => setCreateOpen(true)), []);

  const openSettings = useCallback(() => {
    setSettingsPane(undefined);
    setSettingsOpen(true);
  }, []);

  const openPlan = useCallback(() => {
    setSettingsPane('plan');
    setSettingsOpen(true);
  }, []);

  const onSettingsOpenChange = useCallback((open: boolean) => {
    setSettingsOpen(open);
    if (!open) setCatalogVersion((version) => version + 1);
  }, []);

  const openCreateBot = useCallback((draft?: BotDraft) => {
    if (draft !== undefined) setCreateDraft(draft);
    setCreateOpen(true);
  }, []);

  const onCreateOpenChange = useCallback((open: boolean) => {
    setCreateOpen(open);
    if (!open) setCreateDraft(null);
  }, []);

  const focusSearch = useCallback(() => setSearchQuery(''), []);

  return {
    settingsOpen,
    settingsPane,
    catalogVersion,
    openSettings,
    openPlan,
    onSettingsOpenChange,
    pluginsOpen,
    setPluginsOpen,
    createOpen,
    createDraft,
    openCreateBot,
    onCreateOpenChange,
    projectDialog,
    setProjectDialog,
    messageWork,
    setMessageWork,
    deleteRequest,
    setDeleteRequest,
    searchQuery,
    setSearchQuery,
    focusSearch,
    groupDialog,
    setGroupDialog,
    deletingGroup,
    setDeletingGroup,
    reviewSkillId,
    setReviewSkillId,
  };
}
