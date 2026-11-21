import { Button, Chip } from '@heroui/react';
import { IconX } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import {
  REVISE_SKILL_INSTRUCTION_MAX_LENGTH,
  type Skill,
  type UpdateSkillBody,
} from '@crewaid/shared';
import { SETTINGS_INPUT_CLASS } from '../settings/SettingsLayout';
import {
  draftIssue,
  instructionIssue,
  skillFailureMessage,
  skillParams,
  skillReviewPresentation,
  toUpdateBody,
  type SkillDraft,
  type SkillReviewLoad,
  type SkillReviewPresentation,
} from './skillReviewState';
import { useT } from '../i18n/i18n';

/** Render-only review body, kept outside the portaled modal for unit testing. */
export function SkillReviewBody({
  load,
  mode,
  draft,
  instruction,
  busy,
  notice,
  failure,
  onEdit,
  onCancelEdit,
  onDraftChange,
  onInstructionChange,
  onSave,
  onRevise,
  onApprove,
  onRetry,
  onClose,
}: {
  load: SkillReviewLoad;
  mode: 'view' | 'edit';
  draft: SkillDraft | null;
  /** The plain-language change, as typed; owned by the modal like `draft`. */
  instruction: string;
  busy: null | 'saving' | 'approving' | 'revising';
  notice: string | null;
  failure: string | null;
  onEdit: () => void;
  onCancelEdit: () => void;
  onDraftChange: (next: SkillDraft) => void;
  onInstructionChange: (next: string) => void;
  onSave: () => void;
  onRevise: () => void;
  onApprove: () => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const t = useT();
  if (load.status === 'loading') {
    return (
      <Shell status="loading" onClose={onClose}>
        <p className="flex-1 py-12 text-center text-[13px] text-muted">
          {t('skills.skillReviewBody.loadingSkill')}
        </p>
      </Shell>
    );
  }

  if (load.status === 'error') {
    return (
      <Shell status="error" onClose={onClose}>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 py-12 text-center">
          <p role="alert" className="max-w-[420px] text-[13px] text-danger">
            {skillFailureMessage(load.failure)}
          </p>
          <Button
            variant="tertiary"
            size="sm"
            data-skill-action="retry"
            onPress={onRetry}
            className="h-8 rounded-[10px] px-4 text-[12px] font-medium"
          >
            {t('skills.skillReviewBody.tryAgain')}
          </Button>
        </div>
      </Shell>
    );
  }

  const skill = load.skill;
  const presentation = skillReviewPresentation(skill);
  const body = draft !== null ? toUpdateBody(draft, skill) : null;
  const issue = mode === 'edit' && draft !== null ? draftIssue(draft) : null;
  const params = skillParams(skill.paramsSchema);
  const revising = busy === 'revising';
  // The revise button reads both facts off this one value: an empty sentence is
  // not a change, and `ReviseSkillBodySchema` would refuse it a round trip
  // later anyway.
  const instructionRefusal = instructionIssue(instruction);

  return (
    <Shell
      status="ready"
      onClose={onClose}
      closeDisabled={busy !== null}
      skill={skill}
      presentation={presentation}
    >
      <div className="mt-4 flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pe-1">
          <section>
            <div className="mb-1.5 text-[12px] text-muted">
              {t('skills.skillReviewBody.description')}
            </div>
            {/* Read-only in BOTH modes now: the description is the
                compiler's summary of the task, and the two ways it changes are
                the sentence below — "say why it does this" — and the raw field
                in the developer view. An editable box here would be a second,
                quieter write path beside the primary one. */}
            {skill.description === '' ? (
              <p className="text-[13px] text-muted">{t('skills.skillReviewBody.noDescription')}</p>
            ) : (
              <p className="text-[13px] leading-[19px] whitespace-pre-wrap">{skill.description}</p>
            )}
          </section>

          <section>
            <div className="mb-1.5 text-[12px] text-muted">{t('skills.skillReviewBody.steps')}</div>
            {skill.steps.length === 0 ? (
              // Not an error: a skill written by the bot's `save_skill` tool had
              // no recording to summarize, and one compiled before D-098 has no
              // summary either — the honest sentence is that there is none.
              <p className="text-[13px] text-muted">
                {t('skills.skillReviewBody.noStepSummaryForThis')}
              </p>
            ) : (
              <ol data-skill-steps className="space-y-1">
                {skill.steps.map((step, index) => (
                  <li
                    // Steps are an ordered list with no stable ids; an index key
                    // is exactly as stable as the list the server returned.
                    key={`${index}-${step}`}
                    className="flex gap-2 text-[13px] leading-[19px]"
                  >
                    <span className="shrink-0 text-muted tabular-nums">{index + 1}.</span>
                    <span className="min-w-0">{step}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section>
            {/* Read-only by design: the schema the compiler wrote describes
                the script's arguments, and editing it is its own surface. */}
            <div className="mb-1.5 text-[12px] text-muted">
              {t('skills.skillReviewBody.parameters')}
            </div>
            {params.length === 0 ? (
              <p className="text-[13px] text-muted">{t('skills.skillReviewBody.noParameters')}</p>
            ) : (
              <ul data-skill-parameters className="space-y-1.5">
                {params.map((param) => (
                  <li key={param.name} className="flex flex-col gap-0.5 text-[13px] leading-[19px]">
                    <span className="flex items-baseline gap-2">
                      <span className="font-mono text-[12px]">{param.name}</span>
                      {param.type === null ? null : (
                        <span className="text-[11px] text-muted">{param.type}</span>
                      )}
                      {param.required ? null : (
                        <span className="text-[11px] text-muted">
                          {t('skills.skillReviewBody.optional')}
                        </span>
                      )}
                    </span>
                    {param.description === null ? null : (
                      <span className="text-[12px] text-muted">{param.description}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {mode === 'edit' && draft !== null ? (
            <section>
              <div className="mb-1.5 text-[12px] text-muted">
                {t('skills.skillReviewBody.whatShouldChange')}
              </div>
              <textarea
                data-skill-instruction
                aria-label={t('skills.skillReviewBody.whatShouldChange')}
                rows={3}
                maxLength={REVISE_SKILL_INSTRUCTION_MAX_LENGTH}
                value={instruction}
                onChange={(event) => onInstructionChange(event.target.value)}
                placeholder={t('skills.skillReviewBody.eGUseFirefoxInstead')}
                className={`${SETTINGS_INPUT_CLASS} h-auto resize-none py-2 leading-[18px]`}
              />
              <p className="mt-1.5 text-[12px] text-muted">
                {t('skills.skillReviewBody.sayItInYourOwn')}
              </p>
              {instructionRefusal === null || instruction.trim() === '' ? null : (
                <p role="alert" className="mt-1.5 text-[12px] text-danger">
                  {instructionRefusal}
                </p>
              )}
            </section>
          ) : null}

          <DeveloperDisclosure
            skill={skill}
            // `mode`, not "a draft exists": the modal loads a draft in view
            // mode too, so keying the editors off it would put the raw fields
            // in front of every reader this surface exists to keep them from.
            editing={mode === 'edit' && draft !== null}
            draft={draft}
            body={body}
            issue={issue}
            busy={busy}
            onDraftChange={onDraftChange}
            onSave={onSave}
          />
        </div>

        {notice === null ? null : (
          <p role="status" className="mt-3 shrink-0 text-[12px] text-success">
            {notice}
          </p>
        )}
        {failure === null ? null : (
          <p role="alert" className="mt-3 shrink-0 text-[12px] text-danger">
            {failure}
          </p>
        )}

        <footer className="mt-3 flex shrink-0 justify-end gap-2">
          {mode === 'edit' ? (
            <>
              <Button
                variant="tertiary"
                size="sm"
                data-skill-action="cancel"
                isDisabled={busy !== null}
                onPress={onCancelEdit}
                className="h-8 rounded-[10px] px-4 text-[12px] font-medium"
              >
                {t('skills.skillReviewBody.cancel')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                data-skill-action="revise"
                isDisabled={busy !== null || instructionRefusal !== null}
                onPress={onRevise}
                className="h-8 rounded-[10px] px-4 text-[12px] font-medium"
              >
                {revising
                  ? t('skills.skillReviewBody.updating')
                  : t('skills.skillReviewBody.updateWithAi')}
              </Button>
            </>
          ) : (
            <>
              {presentation.canEdit ? (
                <Button
                  variant="tertiary"
                  size="sm"
                  data-skill-action="edit"
                  isDisabled={busy !== null}
                  onPress={onEdit}
                  className="h-8 rounded-[10px] px-4 text-[12px] font-medium"
                >
                  {t('skills.skillReviewBody.edit')}
                </Button>
              ) : null}
              {presentation.canApprove ? (
                <Button
                  variant="primary"
                  size="sm"
                  data-skill-action="approve"
                  isDisabled={busy !== null}
                  onPress={onApprove}
                  className="h-8 rounded-[10px] px-4 text-[12px] font-medium"
                >
                  {busy === 'approving'
                    ? t('skills.skillReviewBody.approving')
                    : t('skills.skillReviewBody.approveSkill')}
                </Button>
              ) : null}
            </>
          )}
        </footer>
      </div>
    </Shell>
  );
}

/** Raw fields stay available to developers without dominating the review. */
function DeveloperDisclosure({
  skill,
  editing,
  draft,
  body,
  issue,
  busy,
  onDraftChange,
  onSave,
}: {
  skill: Skill;
  /** The raw fields are the EDIT form; view mode shows the same rows as text. */
  editing: boolean;
  draft: SkillDraft | null;
  /** What a save would send; null when nothing changed. */
  body: UpdateSkillBody | null;
  issue: string | null;
  busy: null | 'saving' | 'approving' | 'revising';
  onDraftChange: (next: SkillDraft) => void;
  onSave: () => void;
}) {
  const t = useT();
  const editable = editing && draft !== null;
  return (
    <details data-skill-developer className="rounded-[10px] border border-border">
      <summary className="cursor-pointer px-3 py-2 text-[12px] text-muted select-none">
        {t('skills.skillReviewBody.developerView')}
      </summary>
      <div className="space-y-4 border-t border-border p-3">
        {editable ? (
          <section>
            <div className="mb-1.5 text-[12px] text-muted">
              {t('skills.skillReviewBody.description')}
            </div>
            <textarea
              data-skill-description-editor
              aria-label={t('skills.skillReviewBody.description')}
              rows={2}
              value={draft.description}
              onChange={(event) => onDraftChange({ ...draft, description: event.target.value })}
              className={`${SETTINGS_INPUT_CLASS} h-auto resize-none py-2 leading-[18px]`}
            />
          </section>
        ) : null}
        <section>
          <div className="mb-1.5 text-[12px] text-muted">{t('skills.skillReviewBody.source')}</div>
          {editable ? (
            <>
              <textarea
                data-skill-script-editor
                aria-label={t('skills.skillReviewBody.skillSource')}
                value={draft.script}
                onChange={(event) => onDraftChange({ ...draft, script: event.target.value })}
                spellCheck={false}
                className={`${SETTINGS_INPUT_CLASS} h-[300px] resize-none py-2 font-mono text-[12px] leading-[18px]`}
              />
              {issue === null ? null : (
                <p role="alert" className="mt-1.5 text-[12px] text-danger">
                  {issue}
                </p>
              )}
              <div className="mt-1.5 flex justify-end">
                <Button
                  variant="tertiary"
                  size="sm"
                  data-skill-action="save"
                  // Nothing changed is not a save the contract accepts — an
                  // empty PATCH body is refused — and an empty script is a
                  // refusal this surface can make one layer before the server
                  // would, so the button reads both facts off the same state.
                  isDisabled={busy !== null || body === null || issue !== null}
                  onPress={onSave}
                  className="h-8 rounded-[10px] px-4 text-[12px] font-medium"
                >
                  {busy === 'saving'
                    ? t('skills.skillReviewBody.saving')
                    : t('skills.skillReviewBody.saveChanges')}
                </Button>
              </div>
            </>
          ) : (
            <pre
              data-skill-source
              className="max-h-[300px] overflow-auto rounded-[10px] border border-border bg-surface-secondary p-3 font-mono text-[12px] leading-[18px] whitespace-pre-wrap"
            >
              {skill.script}
            </pre>
          )}
        </section>
        <section>
          <div className="mb-1.5 text-[12px] text-muted">
            {t('skills.skillReviewBody.parametersJsonSchema')}
          </div>
          <pre
            data-skill-params
            className="max-h-[160px] overflow-auto rounded-[10px] border border-border bg-surface-secondary p-3 font-mono text-[12px] leading-[18px] whitespace-pre-wrap"
          >
            {JSON.stringify(skill.paramsSchema, null, 2)}
          </pre>
        </section>
      </div>
    </details>
  );
}

/**
 * The dialog's frame: the title row, the close affordance, and — once the
 * skill is loaded — the identity line every mode shares. Split out so the
 * loading and error states are the same surface with a different body rather
 * than three near-copies of a header.
 */
function Shell({
  status,
  onClose,
  closeDisabled = false,
  skill,
  presentation,
  children,
}: {
  status: 'loading' | 'error' | 'ready';
  onClose: () => void;
  closeDisabled?: boolean;
  skill?: Skill;
  presentation?: SkillReviewPresentation;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div data-skill-review={status} className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold">{t('skills.skillReviewBody.reviewSkill')}</h2>
          {skill === undefined || presentation === undefined ? null : (
            <>
              <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2">
                {/* The contract name is snake_case and read-only; it is the
                    skill's identity, not a label the review may rewrite — and
                    it stays visible even now that the script does not, because
                    it is the name every other surface (the recording card, the
                    bot's tool calls) already says out loud. */}
                <span data-skill-name className="truncate font-mono text-[12px] text-muted">
                  {skill.name}
                </span>
                <Chip
                  color={presentation.statusTone}
                  variant="soft"
                  size="sm"
                  data-skill-status={skill.status}
                  className="h-5 rounded-full px-2 text-[10px]"
                >
                  <Chip.Label>{presentation.statusLabel}</Chip.Label>
                </Chip>
                <span
                  data-skill-version={skill.version}
                  className="rounded-md bg-background-tertiary px-1.5 py-px font-mono text-[10px] text-muted"
                >
                  {presentation.versionLabel}
                </span>
              </div>
              <p className="mt-1.5 text-[12px] text-muted">{presentation.statusNote}</p>
            </>
          )}
        </div>
        <Button
          variant="ghost"
          isIconOnly
          size="sm"
          aria-label={t('skills.skillReviewBody.close')}
          data-skill-action="close"
          isDisabled={closeDisabled}
          onPress={onClose}
          className="size-7 shrink-0 rounded-lg text-muted"
        >
          <IconX className="size-4" stroke={1.8} />
        </Button>
      </header>
      {children}
    </div>
  );
}
