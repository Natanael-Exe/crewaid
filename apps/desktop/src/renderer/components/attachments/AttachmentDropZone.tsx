import { IconPlus } from '@tabler/icons-react';
import type { DropEvent } from 'react-aria';
// NOTE: DropZone and FileTrigger are imported from react-aria-components
// DIRECTLY — HeroUI v3 does NOT re-export them (verified against the
// installed tree).
import { DropZone, type FileDropItem, FileTrigger } from 'react-aria-components';
import { IconButtonTooltip } from '../ui';
import { useT } from '../../i18n/i18n';

/**
 * Attach affordances for the composer.
 *
 * AttachButton: HeroUI Button + Tooltip wrapped in FileTrigger, so "+" opens
 * the OS file picker. ComposerDropZone wraps the composer pill; dropping files
 * anywhere on it stages them while ignoring directories.
 */

async function filesFromDropEvent(e: DropEvent): Promise<File[]> {
  const dropped = e.items.filter((item): item is FileDropItem => item.kind === 'file');
  return Promise.all(dropped.map((item) => item.getFile()));
}

export function AttachButton({ onFiles }: { onFiles: (files: File[]) => void }) {
  const t = useT();
  return (
    <FileTrigger
      allowsMultiple
      onSelect={(fileList) => {
        if (fileList && fileList.length > 0) onFiles(Array.from(fileList));
      }}
    >
      <IconButtonTooltip
        label={t('attachments.attach')}
        placement="top"
        className="ms-0.5 mb-0.5 size-8 shrink-0 rounded-full bg-background-secondary text-muted"
      >
        <IconPlus className="size-4" stroke={1.8} />
      </IconButtonTooltip>
    </FileTrigger>
  );
}

export function ComposerDropZone({
  children,
  onFiles,
}: {
  children: React.ReactNode;
  onFiles: (files: File[]) => void;
}) {
  const t = useT();
  return (
    <DropZone
      aria-label={t('attachments.drop')}
      getDropOperation={(types) => (types.has('files') ? 'copy' : 'cancel')}
      onDrop={(e) => {
        void filesFromDropEvent(e).then((files) => {
          if (files.length > 0) onFiles(files);
        });
      }}
      className="rounded-full data-[drop-target]:ring-2 data-[drop-target]:ring-focus"
    >
      {children}
    </DropZone>
  );
}
