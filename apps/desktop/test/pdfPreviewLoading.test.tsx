import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  PDF_PREVIEW_FRAME_CLASS,
  PdfPreviewLoading,
} from '../src/renderer/components/attachments/PdfPreviewLoading';

describe('PdfPreviewLoading', () => {
  it('keeps the PDF viewer footprint while the document or a page loads', () => {
    const html = renderToStaticMarkup(<PdfPreviewLoading label="Loading page 2" tone="page" />);

    expect(PDF_PREVIEW_FRAME_CLASS).toContain('min-h-');
    expect(html).toContain('data-pdf-preview-loading');
    expect(html).toContain('min-h-[60vh]');
    expect(html).toContain('Loading page 2');
  });
});
