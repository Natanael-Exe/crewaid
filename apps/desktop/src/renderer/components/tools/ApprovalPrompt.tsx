import { useState } from 'react';
import { JsonSchema, type Json } from '@crewaid/shared';
import { Button, Checkbox, Disclosure, TextArea } from '@heroui/react';
import type { PendingApproval } from '../../state/chatReducer';
import { safeJson, summarizeInput, truncateForDisplay } from './toolParts';
import { describeToolAsk } from './toolPhrase';
import { toolMark } from '../attachments/artifactMarks';
import { ResourcePreview } from './ResourcePreview';
import { resourcePreview } from './resourcePresentation';
import { InternalPathHint, ToolCard, ToolFields } from './ToolCard';
import {
  isInternalWorkspacePath,
  previewFields,
  toolFilePath,
  toolPresentation,
} from './toolPresentation';
import { useT } from '../../i18n/i18n';

/** Native pending interrupts supply the captured binding; answers use the existing handler. */

/** The arguments an operator is being asked to approve, in full. */
const ARGS_CHARS = 2000;
/** The one value on the face of the card — a command, a filename, a URL. */
const DETAIL_CHARS = 400;

/**
 * The script a `save_skill` call is asking to store — or null for every other
 * tool.
 *
 * `save_skill` lands its row APPROVED and `run_skill` executes an approved
 * skill without asking again, so THIS CARD is the §7.3 review of those bytes:
 * the script the operator scrolls here is the script that gets stored. It is
 * therefore rendered in FULL, in its own block on the face of the card — the
 * generic args disclosure truncates at ARGS_CHARS, which would leave the tail
 * of a long script unreviewed and still approved, exactly the gap a review
 * that can be skipped is not a review. A script is capped at save time
 * (the tool refuses over 256k characters), so the block is large but bounded.
 */
function scriptUnderReview(toolName: string, args: unknown): string | null {
  if (toolName !== 'save_skill') return null;
  if (typeof args !== 'object' || args === null) return null;
  const script = (args as Record<string, unknown>).script;
  return typeof script === 'string' && script !== '' ? script : null;
}

interface LocalTaskReview {
  readonly connector: string;
  readonly folder: string;
  readonly harness: string | null;
  readonly verifyCommand: string | null;
  readonly hashPrefix: string | null;
  readonly fullPrompt: string;
}

/**
 * Extracts the bound target and full untruncated prompt for `local_code_task`
 * so the operator reviews the exact text being dispatched to their machine
 * without truncation.
 */
function localTaskUnderReview(
  toolName: string,
  args: unknown,
  binding: PendingApproval['binding'],
): LocalTaskReview | null {
  if (toolName !== 'local_code_task') return null;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null;
  const record = args as Record<string, unknown>;
  const goal = typeof record['goal'] === 'string' ? record['goal'].trim() : '';
  if (goal === '') return null;
  const extraContext = typeof record['context'] === 'string' ? record['context'].trim() : '';
  const fullPrompt = extraContext === '' ? goal : `${goal}\n\n${extraContext}`;
  const connectorId = typeof record['connectorId'] === 'string' ? record['connectorId'] : '';
  const destination = binding.commit?.destinations[0];
  const destFolder =
    destination !== undefined && destination.includes(':')
      ? destination.slice(destination.indexOf(':') + 1)
      : undefined;
  const rawRelative =
    typeof record['relativeCwd'] === 'string' && record['relativeCwd'].trim() !== ''
      ? record['relativeCwd'].trim()
      : undefined;
  const folder = destFolder ?? rawRelative ?? '.';
  const harness =
    typeof record['harness'] === 'string' && record['harness'].trim() !== ''
      ? record['harness'].trim()
      : null;
  const verifyCommand =
    typeof record['verifyCommand'] === 'string' && record['verifyCommand'].trim() !== ''
      ? record['verifyCommand'].trim()
      : null;
  const hashPrefix =
    binding.commit?.contentRevision !== undefined
      ? binding.commit.contentRevision.slice(0, 12)
      : null;
  return {
    connector: binding.commit?.account ?? (connectorId !== '' ? connectorId : 'local'),
    folder,
    harness,
    verifyCommand,
    hashPrefix,
    fullPrompt,
  };
}

export function ApprovalPrompt({
  approval,
  botName,
  onRespond,
}: {
  approval: PendingApproval;
  botName: string;
  onRespond: (toolCallId: string, approved: boolean, editedArgs?: Json) => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState(() => safeJson(approval.args, 2));
  let editedArgs: Json | undefined;
  let validEdit = true;
  if (editing) {
    try {
      const parsed = JsonSchema.safeParse(JSON.parse(edited));
      validEdit = parsed.success;
      if (parsed.success) editedArgs = parsed.data;
    } catch {
      validEdit = false;
    }
  }
  const presentation = toolPresentation(approval.toolName);
  const reviewArgs = editing && validEdit ? editedArgs : approval.args;
  const resource = resourcePreview(approval.toolName, reviewArgs, undefined, 'awaiting-approval');
  const fields = previewFields(reviewArgs);
  const review = approval.binding.commit?.review;
  const ask = describeToolAsk(approval.toolName, approval.args);
  const filePath = toolFilePath(reviewArgs);
  const internalPath =
    filePath !== undefined && isInternalWorkspacePath(filePath) ? filePath : undefined;
  const script = scriptUnderReview(approval.toolName, approval.args);
  const localTask = localTaskUnderReview(approval.toolName, reviewArgs, approval.binding);
  const full = approval.args === undefined ? '' : safeJson(approval.args, 2);
  const answered = approval.answered;
  const summary = summarizeInput(approval.args, 160);
  // Worth opening whenever it says more than the face of the card already
  // does — which for `shell` it usually does not, because the command is on
  // the face.
  const showFull = full !== '' && full !== `"${summary}"` && full !== '{}';

  return (
    <div
      role="group"
      aria-label={t('tools.approval.label', { tool: approval.toolName })}
      data-approval-prompt={approval.toolCallId}
      data-approval-answered={answered ?? 'no'}
      className="crewaid-approval-card mx-1 my-2 max-w-full"
    >
      <ToolCard
        kind="approval"
        mark={toolMark(approval.toolName, resource?.kind ?? presentation.kind)}
        source={t('tools.approvalSource', { source: presentation.source })}
        title={ask.question}
        status={
          answered === undefined
            ? 'awaiting-approval'
            : answered === 'declined'
              ? 'denied'
              : 'answered'
        }
      >
        <span hidden data-approval-question>
          {ask.question}
        </span>
        {resource !== undefined ? (
          <ResourcePreview preview={resource} showTitle />
        ) : presentation.kind === 'connection' && fields.length > 0 ? (
          <ToolFields fields={fields} />
        ) : null}
        {approval.binding.scope === 'identity-turn' ? (
          <p className="mt-1 text-caption text-muted">
            {t('tools.approval.identity', { identity: approval.binding.seat?.identity ?? '' })}
          </p>
        ) : approval.binding.effect === 'unknown' ? (
          <p className="mt-1 text-caption text-muted">{t('tools.approval.unknownEffect')}</p>
        ) : null}
        {resource !== undefined ||
        ask.detail === null ||
        (presentation.kind === 'connection' && fields.length > 0) ? null : (
          <div
            className={`mt-1 flex flex-wrap items-center gap-1.5 break-words text-footnote opacity-70 ${ask.detailIsCode ? 'crewaid-code font-mono' : ''}`}
          >
            <span>{truncateForDisplay(ask.detail, DETAIL_CHARS)}</span>
            {internalPath === undefined ? null : <InternalPathHint path={internalPath} />}
          </div>
        )}

        {review ? (
          <div className="mt-2 text-footnote" data-git-publish-review>
            <p>
              {t('tools.approval.publish', {
                repository: review.repository,
                branch: review.branch,
              })}
            </p>
            <Disclosure defaultExpanded={false} className="mt-1">
              <Disclosure.Heading>
                <Disclosure.Trigger className="inline-flex items-center gap-1 rounded-md py-0.5 text-caption text-muted hover:text-foreground">
                  {t('tools.approval.reviewFiles')}
                  <Disclosure.Indicator className="size-3.5 text-muted" />
                </Disclosure.Trigger>
              </Disclosure.Heading>
              <Disclosure.Content>
                <Disclosure.Body>
                  <pre className="crewaid-code mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-caption">
                    {review.summary}
                  </pre>
                  <ul>
                    {review.files.map((file) => (
                      <li key={file} className="break-all font-mono text-caption">
                        {file}
                      </li>
                    ))}
                  </ul>
                </Disclosure.Body>
              </Disclosure.Content>
            </Disclosure>
          </div>
        ) : null}

        {script === null ? null : (
          // Open, scrollable, untruncated: see scriptUnderReview for why this
          // block is the review itself and not a pointer at one.
          <div className="mt-1.5">
            <div className="text-micro font-semibold text-muted">{t('tools.approval.script')}</div>
            <pre
              data-approval-script
              dir="ltr"
              className="mt-0.5 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-separator bg-field px-2.5 py-2 font-mono text-micro leading-[15px] text-foreground"
            >
              {script}
            </pre>
          </div>
        )}

        {localTask === null ? null : (
          <div className="mt-2 space-y-2" data-local-code-task-review>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-caption">
              <dt className="text-muted">{t('tools.approval.localTask.connector')}</dt>
              <dd className="break-words font-medium text-foreground">{localTask.connector}</dd>
              <dt className="text-muted">{t('tools.approval.localTask.folder')}</dt>
              <dd
                className={
                  localTask.folder === '.'
                    ? 'text-foreground'
                    : 'break-all font-mono text-foreground'
                }
              >
                {localTask.folder === '.'
                  ? t('tools.approval.localTask.rootFolder')
                  : localTask.folder}
              </dd>
              <dt className="text-muted">{t('tools.approval.localTask.harness')}</dt>
              <dd className="text-foreground">
                {localTask.harness ?? t('tools.approval.localTask.defaultHarness')}
              </dd>
              {localTask.verifyCommand === null ? null : (
                <>
                  <dt className="text-muted">{t('tools.approval.localTask.verify')}</dt>
                  <dd className="break-all font-mono text-foreground">{localTask.verifyCommand}</dd>
                </>
              )}
              {localTask.hashPrefix === null ? null : (
                <>
                  <dt className="text-muted">{t('tools.approval.localTask.boundHash')}</dt>
                  <dd className="font-mono text-muted">{localTask.hashPrefix}</dd>
                </>
              )}
            </dl>
            <div>
              <div className="text-micro font-semibold text-muted">
                {t('tools.approval.localTask.promptLabel')}
              </div>
              <pre
                data-approval-local-prompt
                dir="ltr"
                className="mt-0.5 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-separator bg-field px-2.5 py-2 font-mono text-micro leading-[15px] text-foreground"
              >
                {localTask.fullPrompt}
              </pre>
            </div>
            <p className="text-caption leading-[17px] text-muted">
              {t('tools.approval.localTask.privacyNote')}
            </p>
          </div>
        )}

        {/* Everything technical lives here: which tool, and the arguments in
          full. It is one click away for the times the act is not the whole
          question, and out of the way the rest of the time. */}
        <Disclosure defaultExpanded={false} className="mt-1.5">
          <Disclosure.Heading>
            <Disclosure.Trigger className="inline-flex items-center gap-1 rounded-md py-0.5 text-caption text-muted hover:text-foreground">
              {t('tools.details')}
              <Disclosure.Indicator className="size-3.5 text-muted" />
            </Disclosure.Trigger>
          </Disclosure.Heading>
          <Disclosure.Content>
            <Disclosure.Body>
              <div className="mt-1 text-caption text-muted">
                <span className="font-mono">{approval.toolName}</span>
              </div>
              {showFull ? (
                <pre className="crewaid-code mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-separator bg-field px-2 py-1.5 font-mono text-micro leading-[15px] text-foreground">
                  {truncateForDisplay(full, ARGS_CHARS)}
                </pre>
              ) : null}
              {answered === undefined && approval.binding.scope === 'call' ? (
                <div className="mt-2 flex flex-col gap-1.5">
                  <Checkbox isSelected={editing} onChange={setEditing}>
                    <Checkbox.Content className="flex items-center gap-2">
                      <Checkbox.Control>
                        <Checkbox.Indicator />
                      </Checkbox.Control>
                      <span className="text-caption text-foreground">
                        {t('tools.approval.editArgs')}
                      </span>
                    </Checkbox.Content>
                  </Checkbox>
                  {editing ? (
                    <>
                      <TextArea
                        dir="ltr"
                        variant="secondary"
                        aria-label={t('tools.approval.argsLabel')}
                        className="mt-1 w-full font-mono text-caption"
                        rows={6}
                        value={edited}
                        onChange={(event) => setEdited(event.target.value)}
                      />
                      {!validEdit ? (
                        <p role="alert" className="text-caption text-danger">
                          {t('tools.approval.invalidJson')}
                        </p>
                      ) : null}
                    </>
                  ) : null}
                </div>
              ) : null}
            </Disclosure.Body>
          </Disclosure.Content>
        </Disclosure>

        {answered === undefined ? (
          <div className="mt-2.5 flex gap-2">
            {/* Decline first in the DOM so the keyboard's first stop is the
              safe answer: this dialog appears mid-reply, under a moving
              transcript, and the destructive choice should not be the one a
              stray Enter lands on. Approve is the visually primary one. */}
            <Button
              size="sm"
              variant="outline"
              onPress={() => onRespond(approval.toolCallId, false)}
              aria-label={t('tools.approval.declineLabel', { tool: approval.toolName })}
            >
              {t('tools.approval.decline')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              isDisabled={!validEdit}
              onPress={() => onRespond(approval.toolCallId, true, editedArgs)}
              aria-label={t('tools.approval.approveLabel', { tool: approval.toolName })}
            >
              {t('tools.approval.approve')}
            </Button>
          </div>
        ) : (
          // The prompt stays, disabled, rather than disappearing on click. The
          // turn resumes asynchronously — the tool still has to run and the
          // model still has to answer — and a row that vanished would leave the
          // operator unsure whether their answer landed. The server resolution
          // clears it in every connected window.
          <div role="status" className="mt-1.5 text-caption text-muted">
            {answered === 'approved'
              ? t('tools.approval.sent', { bot: botName })
              : t('tools.approval.leftAlone')}
          </div>
        )}
      </ToolCard>
    </div>
  );
}

export function ApprovalPromptList({
  approvals,
  botName,
  onRespond,
}: {
  approvals: readonly PendingApproval[];
  botName: string;
  onRespond: (toolCallId: string, approved: boolean, editedArgs?: Json) => void;
}) {
  // One step can ask about several calls at once, and M5-BE-09 asks about all
  // of them concurrently — resuming needs every answer, so showing only the
  // first would leave the turn waiting on a question nobody can see.
  return (
    <>
      {approvals.map((approval) => (
        <ApprovalPrompt
          key={approval.toolCallId}
          approval={approval}
          botName={botName}
          onRespond={onRespond}
        />
      ))}
    </>
  );
}
