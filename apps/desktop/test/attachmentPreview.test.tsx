import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@heroui/react';
import {
  AttachmentCard,
  type MessageAttachment,
} from '../src/renderer/components/attachments/AttachmentCard';
import { previewKindOf } from '../src/renderer/components/attachments/AttachmentPreviewOverlay';

/**
 * What the preview overlay promises, per mime type.
 *
 * The edge that has bitten: kinds the window cannot render must degrade to
 * the download card rather than to a preview that lies. A PDF used to be one
 * of those — Electron ships no PDF viewer plugin, and the iframe embed painted
 * blank. It previews again now that the renderer draws the pages itself
 * (pdfPreview.tsx, PDF.js), so these cases pin which kinds own a Preview chip
 * and which do not.
 */

function attachment(mimeType: string): MessageAttachment {
  return {
    id: 'clx1a2b3c4d5e6f7g8h9i0j1',
    filename: `file.${mimeType.split('/').pop()}`,
    mimeType,
    sizeBytes: 2048,
  };
}

function render(attachment: MessageAttachment) {
  return renderToStaticMarkup(
    <I18nProvider>
      <AttachmentCard attachment={attachment} />
    </I18nProvider>,
  );
}

describe('previewKindOf', () => {
  it('previews the kinds the renderer can actually display', () => {
    expect(previewKindOf(attachment('image/png'))).toBe('image');
    expect(previewKindOf(attachment('video/mp4'))).toBe('video');
    expect(previewKindOf(attachment('video/webm'))).toBe('video');
    expect(previewKindOf(attachment('text/markdown'))).toBe('markdown');
    expect(previewKindOf(attachment('text/plain'))).toBe('text');
    expect(previewKindOf(attachment('application/json'))).toBe('text');
  });

  it('previews a PDF — the renderer draws it, Electron has no plugin for it', () => {
    expect(previewKindOf(attachment('application/pdf'))).toBe('pdf');
  });

  it('offers no preview for kinds with no renderer', () => {
    expect(previewKindOf(attachment('application/zip'))).toBeNull();
  });
});

describe('the card’s preview affordance', () => {
  it('offers Preview exactly for the kinds that can render', () => {
    expect(render(attachment('video/mp4'))).toContain('Preview');
    // Markdown is prose: the whole card is the way into the reader.
    expect(render(attachment('text/markdown'))).toContain('data-document-preview');
    expect(render(attachment('application/pdf'))).toContain('Preview');
  });

  it('keeps an image inline on the card rather than behind a Preview click', () => {
    // The inline thumbnail IS the preview; a second chip for it would be a
    // click between the operator and the screenshot’s whole point.
    const html = render(attachment('image/png'));

    expect(html).not.toContain('>Preview<');
    expect(html).toContain('Image');
  });
});
