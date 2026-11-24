import { Chip, Separator } from '@heroui/react';
import type { ToolInfo } from '@crewaid/shared';
import type { ComposerCommand } from './composerCommands';
import { ComposerPaletteShell } from './ComposerPaletteShell';
import { toolSummary } from './toolMention';
import { useT } from '../../i18n/i18n';

export const TOOL_PALETTE_LIST_ID = 'crewaid-tool-palette-list';
export const toolPaletteOptionId = (index: number): string => `crewaid-tool-palette-opt-${index}`;

/**
 * The `/` palette — every tool the orchestrator offers, filtered by what the
 * operator typed.
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
  return (
    <ComposerPaletteShell
      id={TOOL_PALETTE_LIST_ID}
      label={t('composer.tools')}
      dataAttr="tool"
      widthClass="w-[min(560px,100%)]"
      selected={selected}
      rowSelector="[data-tool-row], [data-command-row]"
      showBottomFade
    >
      {commands.map((command, index) => (
        <div
          key={`command-${command.name}`}
          id={toolPaletteOptionId(index)}
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
            <span className="font-mono text-footnote font-medium">/{command.name}</span>
            <span className="text-caption text-muted">{command.label}</span>
          </span>
          <span className="line-clamp-2 text-caption text-muted">{command.summary}</span>
        </div>
      ))}
      {commands.length > 0 && tools.length > 0 ? <Separator className="mx-3 my-1" /> : null}
      {tools.map((tool, toolIndex) => {
        const index = commands.length + toolIndex;
        return (
          <div
            key={tool.name}
            id={toolPaletteOptionId(index)}
            data-tool-row={tool.name}
            role="option"
            aria-selected={index === selected}
            tabIndex={-1}
            className={`mx-1.5 flex cursor-pointer flex-col gap-0.5 rounded-lg px-2.5 py-1.5 ${
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
              <span className="font-mono text-footnote font-medium">/{tool.alias}</span>
              <span className="text-caption text-muted">{tool.label}</span>
              {tool.reach === 'sensitive' ? (
                <Chip
                  color="warning"
                  variant="soft"
                  size="sm"
                  className="h-5 shrink-0 rounded-full px-2 text-micro"
                >
                  {t('composer.tool.asksApprovalChip')}
                </Chip>
              ) : null}
            </span>
            <span className="line-clamp-2 text-caption text-muted">{toolSummary(tool)}</span>
          </div>
        );
      })}
      {tools.length === 0 && commands.length === 0 ? (
        <div className="px-3 py-3 text-caption text-muted">{t('composer.tool.noMatch')}</div>
      ) : null}
    </ComposerPaletteShell>
  );
}
