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
      className={`flex ${PDF_PREVIEW_FRAME_CLASS} items-center justify-center gap-2 text-sm ${
        tone === 'page' ? 'text-black' : 'text-white/70'
      }`}
    >
      <span
        aria-hidden
        className={`size-4 animate-spin rounded-full border-2 ${
          tone === 'page' ? 'border-black/20 border-t-black' : 'border-white/30 border-t-white/80'
        }`}
      />
      {label}…
    </div>
  );
}
