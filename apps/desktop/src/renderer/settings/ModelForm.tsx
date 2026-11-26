import { Button, Input, Switch } from '@heroui/react';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useState } from 'react';
import { EMPTY_MODEL_DRAFT, modelDraftIssue, type ModelDraft } from './connectionsState';
import { useT } from '../i18n/i18n';

/**
 * The model form, for adding one and for editing one.
 *
 * Why it is shared
 *
 * A model was write-once: add it, and the only correction available was to
 * delete and re-add — which changes the row id, and `Bot.modelId` stores the
 * row id, so every bot pointing at it silently stopped resolving. The
 * route to fix a model in place has existed for a while
 * (`PATCH /providers/models/:modelId`) and so has the client function; nothing
 * ever called them.
 *
 * One component for both because the fields are the same fields. Two would be
 * two places to add the next one to, and the one that got missed would be the
 * edit form — the half nobody demos.
 *
 * The capability toggles are new here
 *
 * `ModelDraft` carries `tools`, `vision` and `reasoning`, all enabled by
 * default for new models; if a selected model does not support one of them,
 * the chat error banner tells the operator which capability to turn off here.
 *
 * And they were unclickable
 *
 * HeroUI's `Switch` is React Aria's `SwitchField`, which is a FIELD: a div with
 * no control of its own. The interactive element — the hidden checkbox carrying
 * `role="switch"`, the `onChange` and the keyboard handling — is rendered by
 * `Switch.Content` and nowhere else. Composed without it, a switch is a picture
 * of a switch: it reflects `isSelected`, it honours `isDisabled`, and pressing
 * it does nothing at all. Both this form and the connection's enable switch
 * were built that way, which is why nobody could turn vision on.
 */

export type ModelFormProps = {
  /** Populated for an edit; absent when adding. */
  readonly initial?: ModelDraft;
  readonly busy: boolean;
  readonly submitLabel: string;
  readonly onSubmit: (draft: ModelDraft) => void;
  readonly onCancel: () => void;
};

const CAPABILITIES = ['tools', 'vision', 'reasoning'] as const satisfies ReadonlyArray<
  keyof Pick<ModelDraft, 'tools' | 'vision' | 'reasoning'>
>;

export function ModelForm({ initial, busy, submitLabel, onSubmit, onCancel }: ModelFormProps) {
  const t = useT();
  const [draft, setDraft] = useState<ModelDraft>(initial ?? EMPTY_MODEL_DRAFT);
  const problem = modelDraftIssue(draft);

  return (
    <div className="space-y-3">
      <div>
        <label
          htmlFor="model-upstream-id"
          className="mb-1.5 block text-caption font-medium text-foreground"
        >
          {t('settings.model.upstreamId')}
        </label>
        <Input
          id="model-upstream-id"
          variant="secondary"
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder={t('settings.model.upstreamId.placeholder')}
          value={draft.upstreamModelId}
          onChange={(event) => setDraft({ ...draft, upstreamModelId: event.target.value })}
          className="w-full"
        />
        {/* The provider's own id, not the row id: this is the string the
            provider's API answers to, and the one to check against their
            dashboard when a turn comes back MODEL_NOT_FOUND. */}
        <p className="mt-1 text-caption text-muted">{t('settings.model.upstreamId.hint')}</p>
      </div>

      <div>
        <label
          htmlFor="model-label"
          className="mb-1.5 block text-caption font-medium text-foreground"
        >
          {t('settings.model.label')}
        </label>
        <Input
          id="model-label"
          variant="secondary"
          type="text"
          autoComplete="off"
          placeholder={t('settings.model.label.placeholder')}
          value={draft.label}
          onChange={(event) => setDraft({ ...draft, label: event.target.value })}
          className="w-full"
        />
      </div>

      <div>
        <label
          htmlFor="model-context"
          className="mb-1.5 block text-caption font-medium text-foreground"
        >
          {t('settings.model.contextWindow')}
        </label>
        <Input
          id="model-context"
          variant="secondary"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder={t('settings.model.contextWindow.placeholder')}
          value={draft.contextWindow}
          onChange={(event) => setDraft({ ...draft, contextWindow: event.target.value })}
          className="w-full"
        />
      </div>

      <div>
        <span className="mb-1.5 block text-caption font-medium text-foreground">
          {t('settings.model.capabilities')}
        </span>
        <div className="overflow-hidden rounded-[10px] border border-separator">
          {CAPABILITIES.map((capability) => (
            // The row is the switch's own content slot, so the whole row — label
            // and hint included — is the control's hit area. It is a `<label>`
            // in the DOM, which is also why this is not wrapped in another one.
            <Switch
              key={capability}
              size="sm"
              isSelected={draft[capability]}
              isDisabled={busy}
              onChange={(on) => setDraft({ ...draft, [capability]: on })}
              aria-label={t(`settings.model.${capability}`)}
              className="w-full border-b border-separator px-3 py-2.5 last:border-b-0"
            >
              <Switch.Content className="w-full">
                <span className="min-w-0 flex-1">
                  <span className="block text-footnote font-normal text-foreground">
                    {t(`settings.model.${capability}`)}
                  </span>
                  <span className="block text-caption font-normal leading-[17px] text-muted">
                    {t(`settings.model.${capability}.hint`)}
                  </span>
                </span>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
          ))}
        </div>
        {/* Said once, here, because it is the question the toggles raise: they
            describe the MODEL, not what this orchestrator will do with it —
            D-087 keeps those apart, and an execution backend may still refuse
            tools a model supports. */}
        <p className="mt-1.5 text-caption leading-[17px] text-muted">
          {t('settings.model.capabilities.hint')}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          isDisabled={busy || problem !== null}
          onPress={() => onSubmit(draft)}
          className="h-9 rounded-[10px] px-3.5 text-caption font-medium"
        >
          {submitLabel}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onPress={onCancel}
          className="h-9 rounded-[10px] px-3 text-caption font-medium text-muted"
        >
          {t('settings.cancel')}
        </Button>
      </div>

      {problem === null ? null : (
        <p className="flex items-start gap-1.5 text-caption leading-[17px] text-danger">
          <IconAlertTriangle className="mt-px size-4 shrink-0" stroke={1.8} aria-hidden />
          <span>{problem}</span>
        </p>
      )}
    </div>
  );
}
