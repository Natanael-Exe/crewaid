import { Dropdown, ScrollShadow } from '@heroui/react';
import { IconArrowsMinimize, IconCopy, IconDots, IconDownload } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { useT } from '../../i18n/i18n';
import { copyText } from '../copyText';
import { StreamingMarkdown } from '../markdown/StreamingMarkdown';
import { Sheet, SheetButton } from '../ui';
import { withoutLeadingTitle } from './documentText';

export type ReaderDocument = {
  /** Display title: the document's own heading, or its filename. */
  readonly title: string;
  /** A short word for what this is ("Markdown", "Deliverable"), centred above. */
  readonly label: string;
  readonly format: 'markdown' | 'text';
  /** `null` while the text is still arriving. */
  readonly source: string | null;
};

/**
 * A document read full-window: the room frosts out behind a single paper
 * sheet at a comfortable measure, the way a long report deserves rather than
 * a scrolling box inside a dialog.
 */
export function DocumentReaderOverlay({
  isOpen,
  onOpenChange,
  document: doc,
  status,
  footer,
  onDownload,
}: {
  readonly isOpen: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly document: ReaderDocument;
  /** Shown in place of the body: loading, or why there is nothing to read. */
  readonly status?: ReactNode;
  /** A line under the body, e.g. that the preview was cut short. */
  readonly footer?: ReactNode;
  readonly onDownload?: (() => void) | undefined;
}) {
  const t = useT();
  const source = doc.source;
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      aria-label={t('reader.labelFor', { title: doc.title })}
      className="crewaid-reader"
    >
      <div className="crewaid-sheet-bar window-drag grid h-16 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 px-6 pt-4">
        <SheetButton label={t('reader.close')} onPress={() => onOpenChange(false)}>
          <IconArrowsMinimize className="size-4" stroke={1.8} aria-hidden />
        </SheetButton>
        <span className="truncate text-callout font-medium text-room-foreground">{doc.label}</span>
        <div className="flex justify-end">
          <Dropdown>
            <Dropdown.Trigger
              aria-label={t('reader.more')}
              className="button button--secondary button--icon-only crewaid-sheet-button inline-flex size-10 min-w-10 shrink-0 items-center justify-center rounded-full p-0"
            >
              <IconDots className="size-4" stroke={1.8} aria-hidden />
            </Dropdown.Trigger>
            <Dropdown.Popover placement="bottom end" className="min-w-[200px]">
              <Dropdown.Menu
                aria-label={t('reader.more')}
                disabledKeys={[
                  ...(source === null ? ['copy'] : []),
                  ...(onDownload === undefined ? ['download'] : []),
                ]}
                onAction={(key) => {
                  if (key === 'copy' && source !== null) void copyText(source);
                  if (key === 'download') onDownload?.();
                }}
              >
                <Dropdown.Item id="copy" textValue={t('reader.copy')}>
                  <IconCopy className="size-4 shrink-0" stroke={1.8} aria-hidden />
                  <span>
                    {doc.format === 'markdown' ? t('reader.copyMarkdown') : t('reader.copy')}
                  </span>
                </Dropdown.Item>
                <Dropdown.Item id="download" textValue={t('reader.download')}>
                  <IconDownload className="size-4 shrink-0" stroke={1.8} aria-hidden />
                  <span>{t('reader.download')}</span>
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        </div>
      </div>
      <ScrollShadow hideScrollBar={false} className="min-h-0 flex-1 overflow-y-auto px-6 pb-16">
        <article className="crewaid-reader-sheet mx-auto mt-6 w-full max-w-[680px]">
          <h1 className="crewaid-reader-title mb-5">{doc.title}</h1>
          {status !== undefined && status !== null ? (
            status
          ) : source === null ? null : doc.format === 'markdown' ? (
            <StreamingMarkdown source={withoutLeadingTitle(source)} />
          ) : (
            <pre className="whitespace-pre-wrap font-mono text-footnote leading-relaxed">
              {source}
            </pre>
          )}
          {footer === undefined ? null : (
            <div className="mt-6 text-caption text-muted">{footer}</div>
          )}
        </article>
      </ScrollShadow>
    </Sheet>
  );
}
