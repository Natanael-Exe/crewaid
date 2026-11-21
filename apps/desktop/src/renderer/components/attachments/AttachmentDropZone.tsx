import { Button, Surface } from '@heroui/react';
import { IconPlus } from '@tabler/icons-react';
import type { DropEvent } from 'react-aria';
// NOTE: DropZone and FileTrigger are imported from react-aria-components
// DIRECTLY — HeroUI v3 does NOT re-export them (verified against the
// installed tree in M1-FE-02 and again in M1-FE-08). Do not "fix" this
// import to '@heroui/react'; that path does not exist. D-001 composes the
// free React Aria layer here.
import { DropZone, type FileDropItem, FileTrigger } from 'react-aria-components';
import { useT } from '../../i18n/i18n';

/**
 * Attach affordances for the composer.
 *
 * AttachButton: HeroUI Button (PO requirement 1) wrapped in FileTrigger, so
 * the "+" opens the OS file picker. allowsMultiple: a message can carry
 * several attachments (SendMessageBodySchema.attachmentIds is an array).
 *
 * ComposerDropZone: wraps the composer pill; dropping files anywhere on it
 * stages them. getDropOperation accepts file drags only; directories are
 * ignored (their entries are neither validated nor uploaded).
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
      <Button
        variant="ghost"
        isIconOnly
        size="sm"
        aria-label={t('attachments.attach')}
        className="ms-0.5 mb-0.5 size-8 shrink-0 rounded-full bg-background-secondary text-muted"
      >
        <IconPlus className="size-4" stroke={1.8} />
      </Button>
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

/** Kept for the upcoming right-rail drop surface; same rules, bigger chrome. */
export function PanelDropSurface({
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
      className="rounded-card outline-dashed outline-1 outline-transparent data-[drop-target]:outline-focus data-[drop-target]:outline-solid"
    >
      <Surface variant="transparent" className="h-full w-full">
        {children}
      </Surface>
    </DropZone>
  );
}
