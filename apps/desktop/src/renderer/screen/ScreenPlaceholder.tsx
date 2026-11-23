import { Button } from '@heroui/react';
import { IconLoader2 } from '@tabler/icons-react';
import type { ScreenCardAction } from './screenCardState';

/**
 * The screen card with no picture in it.
 *
 * Its own module because `ScreenCard` imports noVNC at the top level, and
 * noVNC touches `window` on import — so a suite that renders with
 * `renderToStaticMarkup` and no DOM cannot load that file at all. The half
 * worth asserting is this one: what a computer that is asleep, waking,
 * refused for capacity or unwell says, and the single thing the operator can
 * press. `screenCardState` decides all of it; this only draws it.
 */
export function ScreenPlaceholder({
  kind,
  message,
  detail,
  action,
  onAct,
}: {
  kind: string;
  message: string;
  /**
   * The diagnostic behind the message, one hover away. A title attribute
   * rather than a line of its own: it is for the person who runs the server,
   * and putting it on the card would put back exactly the wall of ids this
   * message exists to replace.
   */
  detail?: string | null;
  action: ScreenCardAction | null;
  onAct: (() => void) | undefined;
}) {
  return (
    <div
      data-screen-state={kind}
      className="crewaid-screen-ambient grid h-full w-full place-items-center px-4 text-center text-caption text-[#507087]"
    >
      <div className="flex flex-col items-center gap-3">
        {kind === 'starting' ? (
          <span className="grid size-10 place-items-center rounded-2xl border border-white/55 bg-white/45 shadow-[0_8px_28px_rgb(48_112_158_/_14%)] backdrop-blur-md">
            <IconLoader2 className="size-5 animate-spin" stroke={1.8} />
          </span>
        ) : null}
        <span {...(detail ? { title: detail } : {})}>{message}</span>
        {action === null || onAct === undefined ? null : (
          <Button
            variant="tertiary"
            size="sm"
            data-screen-action={action.kind}
            onPress={onAct}
            className="h-8 rounded-[10px] px-4 text-caption font-medium"
          >
            {action.label}
          </Button>
        )}
      </div>
    </div>
  );
}
