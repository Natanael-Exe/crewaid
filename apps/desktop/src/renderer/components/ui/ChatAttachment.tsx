import { CloseButton, type CloseButtonProps } from '@heroui/react';
import {
  IconFile,
  IconFileCode,
  IconFileMusic,
  IconFileSpreadsheet,
  IconFileText,
  IconFileTypePdf,
  IconFileZip,
  IconPhoto,
  IconVideo,
  type Icon,
} from '@tabler/icons-react';
import { createContext, useContext, type ClipboardEvent, type ComponentPropsWithRef } from 'react';
import { cx } from './compose';

/**
 * A file waiting to go out with the next message: a type icon, the name, a
 * size or status line, and a remove button. The screen tints the whole chip
 * for warning and danger states.
 */

const iconByExtension: Record<string, Icon> = {};
function mapExtensions(icon: Icon, extensions: string): void {
  for (const extension of extensions.split(' ')) iconByExtension[extension] = icon;
}
mapExtensions(IconPhoto, 'png jpg jpeg gif webp svg avif heic');
mapExtensions(IconVideo, 'mp4 mov webm mkv');
mapExtensions(IconFileMusic, 'mp3 wav ogg flac m4a opus');
mapExtensions(IconFileTypePdf, 'pdf');
mapExtensions(IconFileZip, 'zip tar gz tgz 7z rar');
mapExtensions(IconFileSpreadsheet, 'csv tsv xls xlsx numbers');
mapExtensions(IconFileCode, 'js ts tsx jsx json py go rs html css sh yaml yml toml');
mapExtensions(IconFileText, 'md txt doc docx rtf pages');

/** The icon for a file, by MIME family first and extension second. */
export function attachmentIcon(mimeType: string | undefined, name: string | undefined): Icon {
  const family = mimeType?.split('/')[0];
  if (family === 'image') return IconPhoto;
  if (family === 'video') return IconVideo;
  if (family === 'audio') return IconFileMusic;
  if (mimeType === 'application/pdf') return IconFileTypePdf;
  const extension = name?.split('.').pop()?.toLowerCase();
  if (extension !== undefined && extension !== name?.toLowerCase()) {
    const byExtension = iconByExtension[extension];
    if (byExtension !== undefined) return byExtension;
  }
  return family === 'text' ? IconFileText : IconFile;
}

const AttachmentContext = createContext<{ readonly icon: Icon; readonly name?: string }>({
  icon: IconFile,
});

export interface ChatAttachmentRootProps extends ComponentPropsWithRef<'div'> {
  readonly mimeType?: string;
  readonly name?: string;
  readonly status?: 'default' | 'warning' | 'danger';
}

export function ChatAttachmentRoot({
  className,
  mimeType,
  name,
  status = 'default',
  ...props
}: ChatAttachmentRootProps) {
  return (
    <AttachmentContext
      value={{ icon: attachmentIcon(mimeType, name), ...(name !== undefined ? { name } : {}) }}
    >
      <div
        data-slot="chat-attachment"
        data-status={status}
        title={name}
        className={cx(
          'flex min-w-0 max-w-64 items-center gap-2.5 rounded-xl border border-border bg-surface py-1.5 ps-1.5 pe-1',
          className,
        )}
        {...props}
      />
    </AttachmentContext>
  );
}

export function ChatAttachmentIcon({
  children,
  className,
  ...props
}: ComponentPropsWithRef<'span'>) {
  const { icon: FileIcon } = useContext(AttachmentContext);
  return (
    <span
      data-slot="chat-attachment-icon"
      className={cx(
        'grid size-8 shrink-0 place-items-center rounded-lg bg-default text-muted',
        className,
      )}
      {...props}
    >
      {children ?? <FileIcon className="size-4" stroke={1.75} aria-hidden />}
    </span>
  );
}

export function ChatAttachmentInfo({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      data-slot="chat-attachment-info"
      className={cx('flex min-w-0 flex-1 flex-col leading-tight', className)}
      {...props}
    />
  );
}

export function ChatAttachmentName({
  children,
  className,
  ...props
}: ComponentPropsWithRef<'span'>) {
  const { name } = useContext(AttachmentContext);
  return (
    <span
      data-slot="chat-attachment-name"
      className={cx('truncate text-caption font-medium text-foreground', className)}
      {...props}
    >
      {children ?? name}
    </span>
  );
}

export function ChatAttachmentSize({ className, ...props }: ComponentPropsWithRef<'span'>) {
  return (
    <span
      data-slot="chat-attachment-size"
      className={cx('mt-0.5 text-micro text-muted', className)}
      {...props}
    />
  );
}

export function ChatAttachmentRemove({ className, ...props }: CloseButtonProps) {
  return (
    <CloseButton
      data-slot="chat-attachment-remove"
      className={cx('size-6 min-w-6 shrink-0', className)}
      {...props}
    />
  );
}

export function ChatAttachmentGroup({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      data-slot="chat-attachment-group"
      className={cx('flex flex-wrap gap-2', className)}
      {...props}
    />
  );
}

export const ChatAttachment = Object.assign(ChatAttachmentRoot, {
  Root: ChatAttachmentRoot,
  Icon: ChatAttachmentIcon,
  Info: ChatAttachmentInfo,
  Name: ChatAttachmentName,
  Size: ChatAttachmentSize,
  Remove: ChatAttachmentRemove,
});

/**
 * The images in a paste, each with a filename: a screenshot pasted from the
 * clipboard arrives as an unnamed file, and an upload needs a name.
 */
export function clipboardImageFiles(event: ClipboardEvent): File[] {
  const images = Array.from(event.clipboardData.files).filter((file) =>
    file.type.startsWith('image/'),
  );
  return images.map((file, index) => {
    if (file.name !== '') return file;
    const extension = file.type.split('/')[1]?.replace(/\+.*$/, '') || 'png';
    return new File([file], `pasted-image-${index + 1}.${extension}`, { type: file.type });
  });
}
