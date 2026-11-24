import { Chip, Tooltip } from '@heroui/react';
import { connectionStatusCopy } from './connectionStatus';
import type { WsConnectionState } from './wsClient';

/** Small, non-invasive live-transport indicator for the transcript header. */
export function ConnectionStatusBadge({ state }: { state: WsConnectionState }) {
  const copy = connectionStatusCopy(state);

  if (state.status === 'connected') {
    return null;
  }

  return (
    <Tooltip>
      <Tooltip.Trigger>
        <Chip
          color={copy.tone}
          variant="soft"
          size="sm"
          aria-label={copy.label}
          className="h-6 rounded-full px-2 text-micro"
        >
          <Chip.Label>{copy.label}</Chip.Label>
        </Chip>
      </Tooltip.Trigger>
      <Tooltip.Content>{copy.detail}</Tooltip.Content>
    </Tooltip>
  );
}
