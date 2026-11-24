import { Spinner } from '@heroui/react';

/** The PDF's stable footprint, shared by loading and loaded states. */
export const PDF_PREVIEW_FRAME_CLASS = 'min-h-[60vh] w-[min(860px,85vw)]';

export function PdfPreviewLoading({
  label,
  tone = 'overlay',
}: {
  label: string;
  tone?: 'overlay' | 'page';
}) {
  return (
    <div
      data-pdf-preview-loading
      role="status"
      className={`flex ${PDF_PREVIEW_FRAME_CLASS} items-center justify-center gap-2 text-sm ${
        tone === 'page' ? 'text-foreground' : 'text-muted'
      }`}
    >
      <Spinner size="sm" color="current" aria-hidden />
      {label}…
    </div>
  );
}
