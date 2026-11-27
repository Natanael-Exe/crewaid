import { Surface } from '@heroui/react';
import { useEffect, useRef, type ReactNode } from 'react';
import { useT } from '../../i18n/i18n';

/**
 * Shared floating listbox shell for the composer's `@` bot and `/` tool
 * palettes. Focus stays in the textarea while Arrow/Enter/Tab/Escape drive the
 * active option via `aria-controls` and `aria-activedescendant`.
 */
export function ComposerPaletteShell({
  id,
  label,
  dataAttr,
  widthClass,
  selected,
  rowSelector,
  showBottomFade = false,
  children,
}: {
  readonly id?: string | undefined;
  readonly label: string;
  readonly dataAttr: 'bot' | 'tool';
  readonly widthClass: string;
  readonly selected: number;
  readonly rowSelector: string;
  readonly showBottomFade?: boolean;
  readonly children: ReactNode;
}) {
  const t = useT();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const rows = listRef.current?.querySelectorAll(rowSelector);
    rows?.[selected]?.scrollIntoView({ block: 'nearest' });
  }, [rowSelector, selected]);

  return (
    <Surface
      variant="default"
      {...(dataAttr === 'bot' ? { 'data-bot-palette': '' } : { 'data-tool-palette': '' })}
      // The overlay material, as on every popover: the transcript scrolls
      // under this list, and the plain card surface let its text read
      // through the rows.
      className={`crewaid-composer-palette absolute bottom-full start-0 z-40 mb-2 overflow-hidden rounded-card bg-overlay shadow-overlay ${widthClass}`}
    >
      <div
        id={id}
        ref={listRef}
        role="listbox"
        aria-label={label}
        className="max-h-72 overflow-y-auto py-1"
      >
        {children}
        {showBottomFade ? (
          <div
            aria-hidden
            className="pointer-events-none sticky bottom-0 h-3 bg-gradient-to-t from-overlay"
          />
        ) : null}
      </div>
      <div className="border-t border-separator px-3 py-1.5 text-micro text-foreground-faint">
        {t('composer.palette.hint')}
      </div>
    </Surface>
  );
}
