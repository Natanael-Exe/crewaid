import { Alert, Button, Modal, ScrollShadow, Spinner, useOverlayState } from '@heroui/react';
import { IconArrowLeft, IconSparkles, IconX } from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import type { Template, TemplateInstallation } from '@crewaid/shared';
import { listDirectory, listServers, useApiClient } from '../api';
import { installTemplate, listTemplates } from '../api/experience';
import type { BotDraft } from '../bots/botProfileForm';
import { EmptyState, IconButtonTooltip, Stepper } from '../components/ui';
import { PluginsPane } from '../settings/PluginsPane';
import type { TemplatesTarget } from './ExperienceGate';
import { INITIAL_BROWSE, TemplateBrowse, type BrowseState } from './TemplateBrowse';
import { BotDetail, CrewDetail } from './TemplateDetail';
import { CrewAdded, CrewSetup, type SetupDraft } from './TemplateSetup';
import { NO_CONNECTIONS, botTemplateId, draftFromTemplate, type Connections } from './templateView';
import { useT } from '../i18n/i18n';

type View =
  | { readonly kind: 'browse' }
  /** `from` is the crew a member's page was opened from, so Back returns there. */
  | { readonly kind: 'detail'; readonly id: string; readonly from: string | null }
  | { readonly kind: 'setup'; readonly id: string }
  | { readonly kind: 'connections'; readonly id: string }
  | { readonly kind: 'added'; readonly id: string; readonly installation: TemplateInstallation };

function viewFor(target: TemplatesTarget): View {
  if (target.id === null) return { kind: 'browse' };
  return target.setup
    ? { kind: 'setup', id: target.id }
    : { kind: 'detail', id: target.id, from: null };
}

const EMPTY_DRAFT: SetupDraft = { goal: '', context: '', serverIds: [] };

/**
 * The Templates library. Browse, read a crew or a specialist, review a
 * crew's brief and tools, add it, and optionally hand Crewaid a first task.
 * The same catalog and installer serve Crewaid's chat tools.
 */
export function TemplatesModal({
  target,
  canStart,
  onClose,
  onAddBot,
  onInstalled,
  onOpenCrew,
  onStartTask,
}: {
  target: TemplatesTarget;
  /** Whether there is a Crewaid to send a first task to. */
  canStart: boolean;
  onClose: () => void;
  /** A bot template continues in the ordinary create form, prefilled. */
  onAddBot: (draft: BotDraft) => void;
  onInstalled: (installation: TemplateInstallation) => Promise<void>;
  onOpenCrew: (installation: TemplateInstallation) => void;
  onStartTask: (text: string) => void;
}) {
  const t = useT();
  const client = useApiClient();
  const overlay = useOverlayState({
    isOpen: true,
    onOpenChange: (open) => {
      if (!open) onClose();
    },
  });
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [connections, setConnections] = useState<Connections>(NO_CONNECTIONS);
  const [view, setView] = useState<View>(() => viewFor(target));
  // Kept across detail pages, so Back lands on the same search and filters.
  const [browse, setBrowse] = useState<BrowseState>(INITIAL_BROWSE);
  const [draft, setDraft] = useState<SetupDraft>(() => ({ ...EMPTY_DRAFT, ...target.prefill }));
  // The draft follows one template; a prefill from Crewaid belongs to the one it opened.
  const [draftFor, setDraftFor] = useState<string | null>(target.id);
  // One key per reviewed draft: a retry of the same draft can never add a second crew.
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [firstTask, setFirstTask] = useState('');

  const loadConnections = useCallback(async () => {
    const [servers, directory] = await Promise.allSettled([
      listServers(client),
      listDirectory(client),
    ]);
    setConnections({
      servers: servers.status === 'fulfilled' ? servers.value : [],
      directory: directory.status === 'fulfilled' ? directory.value : [],
      directoryRead: directory.status === 'fulfilled',
    });
  }, [client]);
  const load = useCallback(() => {
    setLoadFailed(false);
    listTemplates(client).then(setTemplates, () => setLoadFailed(true));
  }, [client]);
  useEffect(() => {
    load();
    void loadConnections();
  }, [load, loadConnections]);

  const find = (id: string) => templates?.find((entry) => entry.id === id);
  const openSetup = (id: string) => {
    if (draftFor !== id) {
      setDraft(EMPTY_DRAFT);
      setDraftFor(id);
      setRequestKey(crypto.randomUUID());
    }
    setFailed(false);
    setView({ kind: 'setup', id });
  };
  const changeDraft = (next: SetupDraft) => {
    setDraft(next);
    setRequestKey(crypto.randomUUID());
    setFailed(false);
  };
  async function add(template: Template) {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const installation = await installTemplate(client, {
        templateId: template.id,
        revision: template.revision,
        idempotencyKey: requestKey,
        goal: draft.goal,
        context: draft.context,
        serverIds: [...draft.serverIds],
      });
      await onInstalled(installation);
      setFirstTask(template.starterTask);
      setView({ kind: 'added', id: template.id, installation });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const activeTemplate = view.kind === 'browse' ? undefined : find(view.id);
  const crewFlowStep =
    activeTemplate?.kind === 'crew'
      ? view.kind === 'detail'
        ? 0
        : view.kind === 'added'
          ? 2
          : 1
      : null;

  function body() {
    if (templates === null)
      return (
        <div className="flex flex-col items-start gap-3 px-8 py-12">
          {loadFailed ? (
            <Alert status="danger" className="max-w-md">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>
                  {t('experience.templatesModal.templatesCouldNotBeLoaded')}
                </Alert.Description>
              </Alert.Content>
              <Button size="sm" variant="secondary" onPress={load}>
                {t('experience.templatesModal.tryAgain')}
              </Button>
            </Alert>
          ) : (
            <div className="flex items-center gap-2.5 text-sm text-muted">
              <Spinner size="sm" />
              <span>{t('experience.templatesModal.loadingTemplates')}</span>
            </div>
          )}
        </div>
      );
    if (view.kind === 'browse')
      return (
        <TemplateBrowse
          templates={templates}
          state={browse}
          onChange={setBrowse}
          onOpen={(id) => setView({ kind: 'detail', id, from: null })}
        />
      );
    const template = activeTemplate;
    if (template === undefined)
      return (
        <EmptyState size="sm" className="px-8 py-12">
          <EmptyState.Header>
            <EmptyState.Media variant="icon">
              <IconSparkles className="size-5 text-muted" aria-hidden />
            </EmptyState.Media>
            <EmptyState.Title>
              {t('experience.templatesModal.thisTemplateIsNoLonger')}
            </EmptyState.Title>
          </EmptyState.Header>
          <EmptyState.Content>
            <Button variant="ghost" onPress={() => setView({ kind: 'browse' })}>
              {t('experience.templateDetail.allTemplates')}
            </Button>
          </EmptyState.Content>
        </EmptyState>
      );
    if (view.kind === 'detail')
      return template.kind === 'crew' ? (
        <CrewDetail
          template={template}
          connections={connections}
          onBack={() => setView({ kind: 'browse' })}
          onAdd={() => openSetup(template.id)}
          onOpenMember={(key) =>
            setView({ kind: 'detail', id: botTemplateId(key), from: template.id })
          }
        />
      ) : (
        <BotDetail
          template={template}
          connections={connections}
          backLabel={
            view.from === null
              ? t('experience.templateDetail.allTemplates')
              : (find(view.from)?.title ?? t('experience.templateSetup.back'))
          }
          onBack={() =>
            setView(
              view.from === null
                ? { kind: 'browse' }
                : { kind: 'detail', id: view.from, from: null },
            )
          }
          onAdd={() => {
            const prefilled = draftFromTemplate(template);
            if (prefilled) onAddBot(prefilled);
          }}
        />
      );
    if (view.kind === 'setup')
      return (
        <CrewSetup
          template={template}
          connections={connections}
          draft={draft}
          onChange={changeDraft}
          busy={busy}
          failed={failed}
          onBack={() => setView({ kind: 'detail', id: template.id, from: null })}
          onAdd={() => void add(template)}
          onConnect={() => setView({ kind: 'connections', id: template.id })}
        />
      );
    if (view.kind === 'connections')
      return (
        <div className="flex flex-col gap-4 px-8 pb-6">
          <Button
            size="sm"
            variant="ghost"
            onPress={() => {
              void loadConnections();
              setView({ kind: 'setup', id: template.id });
            }}
            className="self-start -ms-2 text-footnote text-muted hover:text-foreground"
          >
            <IconArrowLeft className="size-4 rtl:-scale-x-100" aria-hidden />
            {t('experience.templatesModal.backToSetup')}
          </Button>
          <PluginsPane />
        </div>
      );
    return (
      <CrewAdded
        template={template}
        installation={view.installation}
        firstTask={firstTask}
        onFirstTask={setFirstTask}
        canStart={canStart}
        onOpenCrew={() => onOpenCrew(view.installation)}
        onStart={() => onStartTask(firstTask.trim())}
      />
    );
  }

  return (
    <Modal state={overlay}>
      <Modal.Backdrop>
        <Modal.Container
          size="cover"
          placement="center"
          scroll="inside"
          className="h-fit sm:w-auto"
        >
          <Modal.Dialog
            aria-label={t('experience.templatesModal.templates')}
            className="crewaid-templates-dialog relative flex h-fit max-h-[90vh] w-[min(1056px,94vw)] max-w-[94vw] flex-col overflow-hidden p-0"
          >
            <IconButtonTooltip
              label={t('experience.templatesModal.closeTemplates')}
              variant="ghost"
              onPress={onClose}
              className="absolute end-5 top-5 z-10"
            >
              <IconX className="size-4" aria-hidden />
            </IconButtonTooltip>
            <ScrollShadow hideScrollBar={false} className="min-h-0 flex-1 overflow-y-auto pt-7">
              {view.kind === 'browse' ? (
                <div className="flex flex-col gap-1.5 px-8 pb-5 pe-20">
                  <Modal.Heading className="crewaid-template-title">
                    {t('experience.templatesModal.templates')}
                  </Modal.Heading>
                  <p className="text-callout text-muted">
                    {t('experience.templatesModal.aStartingCrewOrA')}
                  </p>
                </div>
              ) : crewFlowStep !== null && activeTemplate !== undefined ? (
                <div className="px-8 pb-5 pe-20">
                  <Stepper
                    currentStep={crewFlowStep}
                    {...(view.kind !== 'added'
                      ? {
                          onStepChange: (step: number) => {
                            if (step === 0) {
                              setView({ kind: 'detail', id: activeTemplate.id, from: null });
                            } else if (step === 1) {
                              if (view.kind === 'connections') void loadConnections();
                              openSetup(activeTemplate.id);
                            }
                          },
                        }
                      : {})}
                    className="max-w-md"
                  >
                    <Stepper.Step>
                      <Stepper.Indicator />
                      <Stepper.Title>
                        {t('experience.templateResultCard.viewDetails')}
                      </Stepper.Title>
                      <Stepper.Separator />
                    </Stepper.Step>
                    <Stepper.Step>
                      <Stepper.Indicator />
                      <Stepper.Title>{t('experience.templateResultCard.setUpCrew')}</Stepper.Title>
                      <Stepper.Separator />
                    </Stepper.Step>
                    <Stepper.Step>
                      <Stepper.Indicator />
                      <Stepper.Title>{t('experience.templateSetup.crewAdded')}</Stepper.Title>
                    </Stepper.Step>
                  </Stepper>
                </div>
              ) : null}
              {body()}
            </ScrollShadow>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
