import { Chip, Surface } from '@heroui/react';
import { useEffect, useRef } from 'react';
import type { ToolInfo } from '@crewaid/shared';
import type { ComposerCommand } from './composerCommands';
import { toolSummary } from './toolMention';
import { useT } from '../../i18n/i18n';

/**
 * The `/` palette — every tool the orchestrator offers, filtered by what the
 * operator typed.
 *
 * It is a listbox anchored above the composer pill, driven entirely by
 * keyboard: ArrowUp/Down move the highlight, Enter or Tab picks, Escape
 * closes and leaves the draft untouched. Clicking a row picks it too — the
 * pointer is never the ONLY way to choose, because the palette exists in the
 * middle of a typing flow.
 *
 * `reach` is surfaced because it is the one fact a tool's description does
 * not reliably state and the operator most wants before naming one: a
 * `sensitive` tool will put a prompt in front of them, a `contained` one
 * runs as part of the turn. Only the sensitive case carries a badge — the
 * badge marks the exception, and a green chip repeating "runs directly" on
 * every row said nothing by the second glance.
 */
export function ToolPalette({
  commands = [],
  tools,
  selected,
  onPickCommand,
  onPick,
  onSelectedChanged,
}: {
  /** The app's own commands, listed first. `selected` counts them. */
  commands?: readonly ComposerCommand[];
  tools: readonly ToolInfo[];
  selected: number;
  onPickCommand?: ((command: ComposerCommand) => void) | undefined;
  onPick: (tool: ToolInfo) => void;
  onSelectedChanged: (index: number) => void;
}) {
  const t = useT();
  const listRef = useRef<HTMLDivElement>(null);

  // Keyboard focus stays in the textarea; the palette is a view of keys the
  // textarea's onKeyDown already intercepts. Scrolling the highlighted row
  // into view is the one behaviour that needs an effect here — the list can
  // outgrow its max height.
  useEffect(() => {
    const rows = listRef.current?.querySelectorAll('[data-tool-row], [data-command-row]');
    rows?.[selected]?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  return (
    <Surface
      variant="default"
      data-tool-palette
      className="absolute bottom-full start-0 z-40 mb-2 w-[min(560px,100%)] overflow-hidden rounded-card shadow-lg"
    >
      <div
        ref={listRef}
        role="listbox"
        aria-label={t('composer.tools')}
        className="max-h-72 overflow-y-auto py-1"
      >
        {commands.map((command, index) => (
          <div
            key={`command-${command.name}`}
            data-command-row={command.name}
            role="option"
            aria-selected={index === selected}
            tabIndex={-1}
            className={`mx-1.5 flex cursor-pointer flex-col gap-0.5 rounded-lg px-2.5 py-1.5 ${
              index === selected ? 'bg-surface-secondary' : ''
            }`}
            onMouseDown={(event) => {
              event.preventDefault();
              onPickCommand?.(command);
            }}
            onMouseEnter={() => onSelectedChanged(index)}
          >
            <span className="flex items-center gap-2">
              <span className="font-mono text-[13px] font-medium">/{command.name}</span>
              <span className="text-[12px] text-muted">{command.label}</span>
            </span>
            <span className="line-clamp-2 text-[12px] text-muted">{command.summary}</span>
          </div>
        ))}
        {commands.length > 0 && tools.length > 0 ? (
          <div aria-hidden className="mx-3 my-1 h-px bg-separator" />
        ) : null}
        {tools.map((tool, toolIndex) => {
          const index = commands.length + toolIndex;
          return (
            <div
              key={tool.name}
              data-tool-row={tool.name}
              role="option"
              aria-selected={index === selected}
              tabIndex={-1}
              className={`mx-1.5 flex cursor-pointer flex-col gap-0.5 rounded-lg px-2.5 py-1.5 ${
                // White palette, gray highlight — the highlight is the same
                // gray the palette itself used to be, so the hover reads as a
                // pill lifted off the page (per the reference palette) rather
                // than a hole punched in it.
                index === selected ? 'bg-surface-secondary' : ''
              }`}
              onMouseDown={(event) => {
                // mousedown, not click: the textarea's blur must not close the
                // palette before the pick lands.
                event.preventDefault();
                onPick(tool);
              }}
              onMouseEnter={() => onSelectedChanged(index)}
            >
              <span className="flex items-center gap-2">
                {/* The ALIAS is what a person types and reads back in their own
                  message; the internal name stays in `data-tool-row` for the
                  tests and the inspector, where it belongs. */}
                <span className="font-mono text-[13px] font-medium">/{tool.alias}</span>
                <span className="text-[12px] text-muted">{tool.label}</span>
                {tool.reach === 'sensitive' ? (
                  // The badge marks the EXCEPTION. A green "Runs directly" on
                  // every row carried no information past the first glance —
                  // and it drowned the one case an operator must not miss: the
                  // tool that will stop and ask before it touches anything.
                  <Chip
                    color="warning"
                    variant="soft"
                    size="sm"
                    className="h-5 shrink-0 rounded-full px-2 text-[10px]"
                  >
                    {t('composer.tool.asksApprovalChip')}
                  </Chip>
                ) : null}
              </span>
              <span className="line-clamp-2 text-[12px] text-muted">{toolSummary(tool)}</span>
            </div>
          );
        })}
        {tools.length === 0 && commands.length === 0 ? (
          <div className="px-3 py-3 text-[12px] text-muted">{t('composer.tool.noMatch')}</div>
        ) : null}
        {/* Sticky inside the scroller, so it pins to the bottom edge of the
            visible list and fades whatever row the scroll cut in half — the
            partial row reads as "more below", not as a rendering glitch. */}
        <div
          aria-hidden
          className="pointer-events-none sticky bottom-0 h-3 bg-gradient-to-t from-surface"
        />
      </div>
      <div className="border-t border-divider px-3 py-1.5 text-[10px] text-foreground-faint">
        {t('composer.palette.hint')}
      </div>
    </Surface>
  );
}
