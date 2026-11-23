import { Button, Tooltip } from '@heroui/react';
import { IconDownload, IconRefresh } from '@tabler/icons-react';
import type { UpdateState } from '../../preload';
import { appUpdate } from '../bridge';
import { useAppUpdate } from '../state/useAppUpdate';
import { t } from '../i18n/i18n';

/**
 * What the update button offers in a given state, or `null` for no button.
 *
 * Only when there is something to act on. A check in progress, a download
 * under way or a failed check is not the person's concern: the button appears
 * once the update is ready to install — or, where this build cannot install
 * one itself (unsigned macOS), once a newer version exists to download.
 */
export function updateOffer(
  state: UpdateState,
): { readonly label: string; readonly kind: 'restart' | 'download' } | null {
  switch (state.status) {
    case 'ready':
      return { label: t('update.restart', { version: state.version }), kind: 'restart' };
    case 'available':
      return { label: t('update.download', { version: state.version }), kind: 'download' };
    case 'idle':
    case 'downloading':
      return null;
  }
}

/** The button itself, given a state; `UpdateButton` below connects it to the app. */
export function UpdateButtonView({
  state,
  onPress,
}: {
  readonly state: UpdateState;
  readonly onPress: () => void;
}) {
  const offer = updateOffer(state);
  if (offer === null) return null;
  const Icon = offer.kind === 'restart' ? IconRefresh : IconDownload;
  return (
    <Tooltip>
      <Button
        variant="ghost"
        isIconOnly
        size="sm"
        aria-label={offer.label}
        onPress={onPress}
        className="size-8 shrink-0 rounded-lg text-accent"
      >
        <Icon className="size-[18px]" stroke={1.8} />
      </Button>
      <Tooltip.Content>{offer.label}</Tooltip.Content>
    </Tooltip>
  );
}

/** The sidebar's update button: restarts into a downloaded update. */
export function UpdateButton() {
  const state = useAppUpdate();
  return <UpdateButtonView state={state} onPress={() => void appUpdate.install()} />;
}
