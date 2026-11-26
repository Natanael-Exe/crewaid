import { Suspense, lazy } from 'react';
import type {
  BotGroup,
  BotWithSandbox,
  DeliverableView,
  OnboardingBootstrap,
  ProjectWithCounts,
  Skill,
} from '@crewaid/shared';
import type { ApiClient } from '../api';
import { CreateBotDialog } from '../bots/CreateBotDialog';
import { DeleteGroupDialog, GroupDialog, type GroupDraft } from '../bots/GroupDialog';
import type { BotDraft } from '../bots/botProfileForm';
import type { Experience } from '../experience/ExperienceGate';
import { useT } from '../i18n/i18n';
import { PluginsModal } from '../settings/PluginsModal';
import { SettingsModal, type SettingsAccount } from '../settings/SettingsModal';
import type { SettingsPaneId } from '../settings/settingsPanes';
import { SkillReviewModal } from '../skills/SkillReviewModal';
import type { BotMutation, ChatController } from '../state/useChat';
import { MessageWorkDialogs, type MessageWorkRequest } from '../work/MessageWorkDialogs';
import { ManageProjectsDialog, NewProjectDialog } from '../work/ProjectDialogs';
import { SearchPalette, type SearchTarget } from '../work/SearchPalette';
import { DeleteMessagesDialog, type DeleteMessagesRequest } from './DeleteMessagesDialog';

const TemplatesModal = lazy(() =>
  import('../experience/TemplatesModal').then((module) => ({ default: module.TemplatesModal })),
);

export interface GroupDialogState {
  readonly group: BotGroup | null;
  readonly forBotId?: string;
}

export interface AppModalsProps {
  readonly client: ApiClient;
  readonly bots: readonly BotWithSandbox[];
  readonly projects: readonly ProjectWithCounts[];
  readonly selectedBot: BotWithSandbox | null;
  readonly groups: {
    readonly dialog: GroupDialogState | null;
    readonly onCloseDialog: () => void;
    readonly onSaveGroup: (draft: GroupDraft) => Promise<BotMutation<unknown>>;
    readonly deleting: BotGroup | null;
    readonly onCloseDeleting: () => void;
    readonly onConfirmDelete: (group: BotGroup) => void;
  };
  readonly deleteMessages: {
    readonly request: DeleteMessagesRequest | null;
    readonly onClose: () => void;
    readonly onClearChat: ChatController['clearChat'];
    readonly onDeleteMessage: ChatController['deleteMessage'];
  };
  readonly work: {
    readonly messageWork: MessageWorkRequest | null;
    readonly onCloseMessageWork: () => void;
    readonly onTaskCreated: (taskId: string) => void;
    readonly onOpenDeliverable: (deliverable: DeliverableView) => void;
    readonly projectDialog: 'new' | 'manage' | null;
    readonly onProjectDialogChange: (dialog: 'new' | 'manage' | null) => void;
    readonly onProjectCreated: (projectId: string) => void;
    readonly onProjectsChanged: () => void;
  };
  readonly search: {
    readonly query: string | null;
    readonly onClose: () => void;
    readonly onChoose: (target: SearchTarget) => void;
  };
  readonly templates: {
    readonly experience: Experience | null;
    readonly assistant: OnboardingBootstrap | null;
    readonly onAddBot: (draft: BotDraft) => void;
    readonly onInstalled: () => Promise<void>;
    readonly onOpenCrew: (botId: string) => void;
    readonly onStartTask: (botId: string, text: string) => void;
  };
  readonly createBot: {
    readonly isOpen: boolean;
    readonly draft: BotDraft | null;
    readonly onOpenChange: (open: boolean) => void;
    readonly onCreate: ChatController['createNewBot'];
    readonly onCreated: (botId: string) => void;
  };
  readonly settings: {
    readonly isOpen: boolean;
    readonly initialPane: SettingsPaneId | undefined;
    readonly onOpenChange: (open: boolean) => void;
    readonly onCredentialsSaved: () => void;
    readonly account: SettingsAccount;
    readonly onSignOut: () => void;
    readonly connectorsVersion?: number | undefined;
  };
  readonly plugins: {
    readonly isOpen: boolean;
    readonly onOpenChange: (open: boolean) => void;
  };
  readonly skillReview: {
    readonly skillId: string | null;
    readonly onClose: () => void;
    readonly onSkillSaved: (skill: Skill) => void;
  };
}

export function AppModals({
  client,
  bots,
  projects,
  selectedBot,
  groups,
  deleteMessages,
  work,
  search,
  templates,
  createBot,
  settings,
  plugins,
  skillReview,
}: AppModalsProps) {
  const t = useT();
  const exp = templates.experience;

  return (
    <>
      <GroupDialog
        isOpen={groups.dialog !== null}
        onOpenChange={(open) => {
          if (!open) groups.onCloseDialog();
        }}
        group={groups.dialog?.group ?? null}
        forBotName={bots.find((bot) => bot.id === groups.dialog?.forBotId)?.name}
        onSave={groups.onSaveGroup}
      />
      <DeleteGroupDialog
        group={groups.deleting}
        onOpenChange={(open) => {
          if (!open) groups.onCloseDeleting();
        }}
        onConfirm={groups.onConfirmDelete}
      />
      <DeleteMessagesDialog
        request={deleteMessages.request}
        botName={
          bots.find((bot) => bot.id === deleteMessages.request?.botId)?.name ??
          t('app.shell.theBot')
        }
        onClose={deleteMessages.onClose}
        onConfirm={async (request, forget) => {
          const result =
            request.kind === 'clear'
              ? await deleteMessages.onClearChat(request.botId, forget)
              : await deleteMessages.onDeleteMessage(request.botId, request.messageId, forget);
          return result.ok ? { ok: true } : { ok: false, failure: result.failure };
        }}
      />
      <MessageWorkDialogs
        request={work.messageWork}
        onClose={work.onCloseMessageWork}
        client={client}
        bots={bots}
        projects={projects}
        onTaskCreated={(taskId) => {
          if (taskId !== null) work.onTaskCreated(taskId);
        }}
        onOpenDeliverable={work.onOpenDeliverable}
      />
      <SearchPalette
        isOpen={search.query !== null}
        onOpenChange={(open) => {
          if (!open) search.onClose();
        }}
        client={client}
        initialQuery={search.query ?? ''}
        bots={bots}
        projects={projects}
        onChoose={search.onChoose}
      />
      <NewProjectDialog
        isOpen={work.projectDialog === 'new'}
        onOpenChange={(open) => work.onProjectDialogChange(open ? 'new' : null)}
        client={client}
        projects={projects}
        onCreated={(project) => work.onProjectCreated(project.id)}
      />
      <ManageProjectsDialog
        isOpen={work.projectDialog === 'manage'}
        onOpenChange={(open) => work.onProjectDialogChange(open ? 'manage' : null)}
        client={client}
        projects={projects}
        onChanged={work.onProjectsChanged}
      />
      <Suspense fallback={null}>
        {exp?.templates ? (
          <TemplatesModal
            target={exp.templates}
            canStart={templates.assistant !== null}
            onClose={exp.closeTemplates}
            onAddBot={(draft) => {
              exp.closeTemplates();
              templates.onAddBot(draft);
            }}
            onInstalled={templates.onInstalled}
            onOpenCrew={(installation) => {
              exp.closeTemplates();
              if (installation.botIds[0]) templates.onOpenCrew(installation.botIds[0]);
            }}
            onStartTask={(text) => {
              exp.closeTemplates();
              if (templates.assistant === null) return;
              void exp
                .progress({ welcomeSeen: true, discovery: 'COMPLETE' })
                .catch(() => undefined);
              templates.onStartTask(templates.assistant.bot.id, text);
            }}
          />
        ) : null}
      </Suspense>
      <CreateBotDialog
        isOpen={createBot.isOpen}
        onOpenChange={createBot.onOpenChange}
        initialDraft={createBot.draft}
        onCreate={createBot.onCreate}
        onCreated={(bot) => createBot.onCreated(bot.id)}
      />
      <SettingsModal
        isOpen={settings.isOpen}
        {...(settings.initialPane === undefined ? {} : { initialPane: settings.initialPane })}
        onOpenChange={settings.onOpenChange}
        onCredentialsSaved={settings.onCredentialsSaved}
        account={settings.account}
        onSignOut={settings.onSignOut}
        connectorsVersion={settings.connectorsVersion}
      />
      <PluginsModal
        isOpen={plugins.isOpen}
        onOpenChange={plugins.onOpenChange}
        botId={selectedBot?.id ?? null}
        botName={selectedBot?.name ?? null}
      />
      <SkillReviewModal
        skillId={skillReview.skillId}
        isOpen={skillReview.skillId !== null}
        onOpenChange={(open) => {
          if (!open) skillReview.onClose();
        }}
        onSkillSaved={skillReview.onSkillSaved}
      />
    </>
  );
}
