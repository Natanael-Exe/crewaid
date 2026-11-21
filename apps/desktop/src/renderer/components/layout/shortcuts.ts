import { useEffect } from 'react';

export interface ShellShortcutEvent {
  readonly key: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly repeat?: boolean;
  readonly defaultPrevented?: boolean;
  preventDefault(): void;
}

export type ShellShortcutAction =
  { readonly type: 'focus-search' } | { readonly type: 'select-bot'; readonly index: number };

/** Pure resolver so the global key policy is unit-testable without a browser. */
export function getShellShortcutAction(
  event: ShellShortcutEvent,
  botCount: number,
): ShellShortcutAction | null {
  if (
    event.defaultPrevented ||
    event.repeat ||
    (!event.metaKey && !event.ctrlKey) ||
    event.shiftKey ||
    event.altKey
  ) {
    return null;
  }

  if (event.key.toLowerCase() === 'k') return { type: 'focus-search' };

  if (/^[1-9]$/.test(event.key)) {
    const index = Number(event.key) - 1;
    return index < botCount ? { type: 'select-bot', index } : null;
  }

  return null;
}

export function useShellShortcuts({
  botIds,
  onSelectBot,
  onFocusSearch,
}: {
  readonly botIds: readonly string[];
  readonly onSelectBot: (botId: string) => void;
  readonly onFocusSearch: () => void;
}): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const action = getShellShortcutAction(event, botIds.length);
      if (action === null) return;

      event.preventDefault();
      if (action.type === 'focus-search') {
        onFocusSearch();
        return;
      }

      const botId = botIds[action.index];
      if (botId !== undefined) onSelectBot(botId);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [botIds, onFocusSearch, onSelectBot]);
}
