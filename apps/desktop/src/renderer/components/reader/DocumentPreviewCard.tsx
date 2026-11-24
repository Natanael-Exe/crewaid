import type { ReactNode } from 'react';
import { useT } from '../../i18n/i18n';
import { StreamingMarkdown } from '../markdown/StreamingMarkdown';
import { withoutLeadingTitle } from './documentText';

/**
 * A document in the conversation, shown as a page you can pick up: its title
 * in display type over the top of its text, faded out where the card ends.
 * The whole card opens the reader.
 */
export function DocumentPreviewCard({
  title,
  format,
  source,
  meta,
  onOpen,
}: {
  readonly title: string;
  readonly format: 'markdown' | 'text';
  /** The text, or `null` while it loads (the sheet then holds its place). */
  readonly source: string | null;
  /** A quiet line under the title: file type and size, say. */
  readonly meta?: ReactNode;
  readonly onOpen: () => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t('reader.open', { title })}
      data-document-preview
      className="crewaid-doc-card flex w-[min(100%,420px)] cursor-[var(--cursor-interactive)] flex-col gap-3 rounded-[20px] bg-message-bot p-5 text-start text-message-bot-foreground outline-none focus-visible:ring-2 focus-visible:ring-focus/50"
    >
      <span className="flex flex-col gap-1">
        <span className="crewaid-doc-card-title">{title}</span>
        {meta === undefined ? null : <span className="text-caption text-muted">{meta}</span>}
      </span>
      <span
        aria-hidden
        className="crewaid-doc-card-sheet pointer-events-none block max-h-[140px] overflow-hidden rounded-[14px] bg-surface-secondary/70 px-4 py-3 text-footnote"
      >
        {source === null ? (
          <span className="block h-[92px]" />
        ) : format === 'markdown' ? (
          <StreamingMarkdown source={withoutLeadingTitle(source).slice(0, 2000)} />
        ) : (
          <span className="block whitespace-pre-wrap font-mono text-caption leading-relaxed">
            {source.slice(0, 1200)}
          </span>
        )}
      </span>
    </button>
  );
}
