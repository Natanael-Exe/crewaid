import { START_BRIEF_CLOSING_PREFIX } from '@crewaid/shared';
import { IconChecklist } from '@tabler/icons-react';
import { StreamingMarkdown } from '../components/markdown/StreamingMarkdown';
import { useT } from '../i18n/i18n';

/** A Start brief, read back into its parts (the format PRD-WORK §3.3 writes). */
export type BriefParts = {
  readonly title: string;
  readonly context: string | null;
  readonly body: string;
};

/**
 * `Task: <title>` / `Project: … · Goal: … · Due: …` / blank / `<brief>`.
 * A message not in that shape reads as a title-less body, so a hand-edited
 * or future-format brief still renders rather than disappearing.
 */
export function parseBrief(text: string): BriefParts {
  // The closing line is addressed to the bot; the card is for the user.
  const closing = text.lastIndexOf(`\n\n${START_BRIEF_CLOSING_PREFIX}`);
  if (closing !== -1) text = text.slice(0, closing);
  const lines = text.split('\n');
  const first = lines[0] ?? '';
  if (!first.startsWith('Task: ')) return { title: '', context: null, body: text };
  const title = first.slice('Task: '.length).trim();
  const second = lines[1] ?? '';
  const hasContext = /^(Project|Goal|Due): /.test(second);
  const rest = lines
    .slice(hasContext ? 2 : 1)
    .join('\n')
    .trim();
  return { title, context: hasContext ? second : null, body: rest };
}

/**
 * A Start brief in the transcript (PRD-WORK §7.4): the task's card rather than
 * a plain bubble — it is the user starting a task, not the user chatting —
 * with a way into the task's details.
 */
export function TaskBriefCard({
  text,
  taskId,
  timeLabel,
  onOpenTask,
}: {
  text: string;
  taskId: string;
  timeLabel: string;
  onOpenTask?: ((taskId: string) => void) | undefined;
}) {
  const t = useT();
  const brief = parseBrief(text);
  return (
    <div className="mb-2 flex justify-end px-1">
      <div
        data-task-brief={taskId}
        title={timeLabel}
        className="flex w-full max-w-[72%] flex-col gap-2 rounded-card border border-border bg-surface px-3.5 py-3"
      >
        <div className="flex items-center gap-2 text-[11px] font-medium text-muted">
          <IconChecklist className="size-3.5" stroke={1.8} />
          {t('work.taskBriefCard.taskStarted')}
        </div>
        {brief.title === '' ? null : (
          <div className="text-[14px] font-semibold leading-5 text-foreground">{brief.title}</div>
        )}
        {brief.context === null ? null : (
          <div className="text-[12px] text-muted">{brief.context}</div>
        )}
        {brief.body === '' ? null : (
          <StreamingMarkdown source={brief.body} className="text-[13px] leading-5" />
        )}
        {onOpenTask === undefined ? null : (
          <button
            type="button"
            onClick={() => onOpenTask(taskId)}
            className="self-start text-[12px]! font-medium text-accent hover:underline"
          >
            {t('work.taskBriefCard.openTask')}
          </button>
        )}
      </div>
    </div>
  );
}
