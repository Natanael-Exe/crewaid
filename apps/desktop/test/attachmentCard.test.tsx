import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@heroui/react';
import {
  AttachmentCard,
  type MessageAttachment,
} from '../src/renderer/components/attachments/AttachmentCard';

/**
 * M1-FE-14 regression. The download action was an `<a download href=…>`, which
 * reads well and cannot work: Electron's download manager performs that
 * request outside `fetch`, so it carries no Authorization header and AuthGuard
 * answers 401 for every attachment in the transcript. The action has to be a
 * control that runs a fetch, so the markup is the assertion.
 */
function render(attachment: MessageAttachment) {
  return renderToStaticMarkup(
    <I18nProvider>
      <AttachmentCard attachment={attachment} />
    </I18nProvider>,
  );
}

const file: MessageAttachment = {
  id: 'clx1a2b3c4d5e6f7g8h9i0j1',
  filename: 'leads.csv',
  mimeType: 'text/csv',
  sizeBytes: 2048,
};

describe('AttachmentCard', () => {
  it('offers the download as a button, never as a link the guard would 401', () => {
    const html = render(file);

    expect(html).toContain('Download');
    expect(html).toContain('<button');
    // Neither an href nor a `download` attribute: both would mean the transfer
    // is being handed to a request that cannot carry the bearer.
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('download="leads.csv"');
  });

  it('shows the file identity and size', () => {
    const html = render(file);
    expect(html).toContain('leads.csv');
    expect(html).toContain('2 KB');
    expect(html).toContain('Spreadsheet');
    expect(html).toContain('Preview leads.csv');
  });

  it('does not invent a pre-existing server error for a claimed attachment', () => {
    const html = render(file);

    // MessageWithAttachments has no attachment error field. An unavailable
    // state can only be learned from an attempted download, not from history.
    expect(html).not.toContain('Unavailable');
    expect(html).not.toContain('Something went wrong');
  });
});
