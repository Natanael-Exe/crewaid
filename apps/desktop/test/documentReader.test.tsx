import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@heroui/react';
import { DocumentPreviewCard } from '../src/renderer/components/reader/DocumentPreviewCard';
import { documentTitle, withoutLeadingTitle } from '../src/renderer/components/reader/documentText';

describe('documentTitle', () => {
  it('reads the opening H1 or H2 as the title', () => {
    expect(documentTitle('# US AI Agent Market\n\nBody', 'report.md')).toBe('US AI Agent Market');
    expect(documentTitle('\n\n## Positions still open ##\nBody', 'report.md')).toBe(
      'Positions still open',
    );
  });

  it('strips inline markdown from the title', () => {
    expect(documentTitle('# The **real** [bottleneck](https://x.y)', 'f.md')).toBe(
      'The real bottleneck',
    );
  });

  it('falls back to the filename when the document does not open with a heading', () => {
    // A heading further down names a section, not the document.
    expect(documentTitle('Intro paragraph.\n\n# Section', 'notes.md')).toBe('notes.md');
    expect(documentTitle('### Too deep', 'notes.md')).toBe('notes.md');
    expect(documentTitle('', 'notes.md')).toBe('notes.md');
  });
});

describe('withoutLeadingTitle', () => {
  it('drops the heading the title was read from, so the reader does not print it twice', () => {
    expect(withoutLeadingTitle('# Title\n\nFirst paragraph.')).toBe('First paragraph.');
  });

  it('leaves a document without an opening heading untouched', () => {
    const source = 'First paragraph.\n\n# Later section';
    expect(withoutLeadingTitle(source)).toBe(source);
  });
});

describe('DocumentPreviewCard', () => {
  function render(source: string | null) {
    return renderToStaticMarkup(
      <I18nProvider>
        <DocumentPreviewCard
          title="US AI Agent Market"
          format="markdown"
          source={source}
          meta="Markdown · 4 KB"
          onOpen={() => undefined}
        />
      </I18nProvider>,
    );
  }

  it('is one button named for the document it opens', () => {
    const html = render('# US AI Agent Market\n\nThe market right now.');
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Open US AI Agent Market"');
    expect(html).toContain('crewaid-doc-card-title');
    expect(html).toContain('Markdown · 4 KB');
  });

  it('previews the body under the title, without repeating the title', () => {
    const html = render('# US AI Agent Market\n\nThe market right now.');
    expect(html).toContain('The market right now.');
    expect(html.split('US AI Agent Market').length - 1).toBe(2); // label + title
  });

  it('holds the preview sheet in place while the text loads', () => {
    const html = render(null);
    expect(html).toContain('crewaid-doc-card-sheet');
    expect(html).toContain('US AI Agent Market');
  });
});
