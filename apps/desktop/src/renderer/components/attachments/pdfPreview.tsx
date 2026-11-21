import { useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import PdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&inline';
import { PDF_PREVIEW_FRAME_CLASS, PdfPreviewLoading } from './PdfPreviewLoading';
import { useT } from '../../i18n/i18n';

/**
 * PDF preview — the renderer draws it itself, because Electron will not.
 *
 * Chromium's PDF viewer plugin is not part of Electron's renderer, so the
 * obvious embed (an `<iframe>` over the fetched bytes) paints a blank frame:
 * a preview that lies about a file the operator can in fact read. PDF.js
 * (through `react-pdf`) renders each page to a canvas in-process instead,
 * which needs no plugin and no second fetch — the bytes the overlay already
 * holds with the bearer are the bytes it draws.
 *
 * The worker, and why it is inline
 *
 * PDF.js parses on a worker. The production renderer loads over `file://`,
 * where neither a separately emitted worker chunk nor a `workerSrc` fetch can
 * resolve, so the worker ships INSIDE this bundle: Vite's `?worker&inline`
 * base64s it and spawns it from a blob URL, which the CSP's `worker-src
 * 'self' blob:` (index.html) exists to permit. One worker port is created
 * per app session and shared by every document — pdf.js caches workers by
 * port, and a second parse running beside the first is not a thing a
 * transcript preview needs.
 *
 * `ensureWorkerPort` is a no-op where there is no `Worker` global: the
 * desktop suites render with `renderToStaticMarkup`, effects never run, and
 * the document never loads, so the port is never wanted there.
 */
function ensureWorkerPort(): void {
  if (typeof Worker === 'undefined') return;
  if (pdfjs.GlobalWorkerOptions.workerPort === null) {
    pdfjs.GlobalWorkerOptions.workerPort = new PdfjsWorker();
  }
}

/**
 * One PDF, paged. Canvas only: the text and annotation layers are switched
 * off because they are the two layers that need PDF.js's own stylesheets and
 * a selectable transcript of a report is not what a preview is for — reading
 * it is, and the download carries the real file.
 */
export default function PdfPreview({ file }: { file: Blob }) {
  const t = useT();
  // Here, not in an effect: the child Document starts its load in its OWN
  // effect, and children's effects run before the parent's, so a port
  // assigned in one of ours would arrive after the document asked for it.
  // Idempotent — the second preview reuses the first one's port.
  ensureWorkerPort();
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(1);
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className="flex min-h-24 flex-col items-center justify-center gap-1 py-6 text-sm text-foreground-faint">
        <span>{t('attachments.pdf.failed')}</span>
        <span className="text-xs">{t('attachments.pdf.downloadHint')}</span>
      </div>
    );
  }

  // The BLOB, not a copy of its bytes: react-pdf's `file` admits a Blob, and
  // pdf.js reads it rather than taking ownership of a buffer, so the
  // overlay's blob stays whole for the Save action and the next open.
  return (
    <div className={`flex max-h-[75vh] ${PDF_PREVIEW_FRAME_CLASS} flex-col gap-2`}>
      <div className="min-h-0 flex-1 overflow-auto rounded-lg bg-white">
        <Document
          file={file}
          onLoadSuccess={({ numPages }) => setPages(numPages)}
          onLoadError={() => setFailed(true)}
          loading={<PdfPreviewLoading label={t('attachments.openingPdf')} tone="page" />}
        >
          <Page
            pageNumber={page}
            renderTextLayer={false}
            renderAnnotationLayer={false}
            loading={
              <PdfPreviewLoading label={t('attachments.pdf.loadingPage', { page })} tone="page" />
            }
          />
        </Document>
      </div>
      {pages > 1 ? (
        <div className="flex items-center justify-center gap-3 text-[12px] text-black">
          <button
            type="button"
            className="cursor-pointer rounded px-2 py-0.5 hover:bg-black/10 disabled:cursor-default disabled:opacity-40"
            disabled={page <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            {t('attachments.pdf.previous')}
          </button>
          <span>{t('attachments.pdf.page', { page, pages })}</span>
          <button
            type="button"
            className="cursor-pointer rounded px-2 py-0.5 hover:bg-black/10 disabled:cursor-default disabled:opacity-40"
            disabled={page >= pages}
            onClick={() => setPage((current) => Math.min(pages, current + 1))}
          >
            {t('attachments.pdf.next')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
