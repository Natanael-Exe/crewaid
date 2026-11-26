import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CodeView } from '../src/renderer/components/code/CodeView';
import {
  parseNumberedCode,
  parseUnifiedDiff,
  replacementDiff,
} from '../src/renderer/components/code/codeRows';
import {
  classifyDiffLines,
  codeHighlighter,
  highlightCode,
  languageForPath,
} from '../src/renderer/components/markdown/highlight';
import { StreamingMarkdown } from '../src/renderer/components/markdown/StreamingMarkdown';

/** `class:text` for every highlighted token, in order. */
function classed(code: string, language: string): string[] {
  return highlightCode(code, language)
    .filter((token) => token.className !== null)
    .map((token) => `${token.className}:${token.text}`);
}

/**
 * The text a selection would copy. Each code line is its own block, which a
 * copy ends with a newline (an empty line holds one of its own), so a line's
 * close becomes one; then the tags go and entities are decoded.
 */
function textOf(html: string): string {
  return html
    .replace(/\n<\/span>/g, '</span>')
    .replace(
      /<span class="crewaid-code-line"[^>]*>([\s\S]*?)<\/span>(?=<span class="crewaid-code-line"|<\/code>)/g,
      '$1\n',
    )
    .replace(/\n<\/code>/g, '</code>')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
}

const classNames = (html: string): string[] =>
  [...html.matchAll(/class="(hljs-[^"]*)"/g)].map((match) => match[1] ?? '');

describe('code highlighting', () => {
  it('highlights a diff fence by line: additions, deletions and hunks, as text only', () => {
    const diff = [
      'diff --git a/total.ts b/total.ts',
      '--- a/total.ts',
      '+++ b/total.ts',
      '@@ -1,2 +1,2 @@',
      ' export function total(items) {',
      '-  return items.length;',
      '+  return items.reduce((sum, item) => sum + item, 0);',
    ].join('\n');
    // Streamdown applies the highlighter after mount; its port is what a fence is drawn from.
    const lines =
      codeHighlighter.highlight(
        { code: diff, language: 'diff', themes: ['github-light', 'github-dark'] },
        () => undefined,
      )?.tokens ?? [];
    expect(
      lines.map((line) => line.map((token) => [token.htmlAttrs?.['className'], token.content])),
    ).toEqual([
      [['hljs-comment', 'diff --git a/total.ts b/total.ts']],
      [['hljs-comment', '--- a/total.ts']],
      [['hljs-comment', '+++ b/total.ts']],
      [['hljs-meta', '@@ -1,2 +1,2 @@']],
      [[undefined, ' export function total(items) {']],
      [['hljs-deletion', '-  return items.length;']],
      [['hljs-addition', '+  return items.reduce((sum, item) => sum + item, 0);']],
    ]);

    // The fence itself is a labelled diff block whose text is escaped, never markup.
    const output = renderToStaticMarkup(
      <StreamingMarkdown source={['```patch', '-<b>old</b>', '+<i>new</i>', '```'].join('\n')} />,
    );
    expect(output).toContain('data-language="patch"');
    expect(output).toContain('-&lt;b&gt;old&lt;/b&gt;');
    expect(output).not.toContain('<b>old</b>');
  });

  it('follows a counted hunk to its end, so a removed "--" line is not a file header', () => {
    expect(
      classifyDiffLines([
        '--- a/schema.sql',
        '+++ b/schema.sql',
        '@@ -1,2 +1,1 @@',
        '--- a comment that was removed',
        ' select 1;',
        '--- a/next.sql',
        '\\ No newline at end of file',
      ]),
    ).toEqual(['header', 'header', 'hunk', 'deletion', 'context', 'header', 'header']);
    // A bare run of +/- lines, with no hunk header, reads line by line.
    expect(classifyDiffLines(['-old', '+new', ' same'])).toEqual([
      'deletion',
      'addition',
      'context',
    ]);
  });

  it('knows go, rust, java, toml and dockerfile, and their aliases', () => {
    for (const alias of [
      'go',
      'golang',
      'rust',
      'rs',
      'java',
      'toml',
      'dockerfile',
      'docker',
      'containerfile',
      'diff',
      'patch',
    ]) {
      expect(codeHighlighter.supportsLanguage(alias)).toBe(true);
    }

    expect(classed('func main() { fmt.Println("hi", 42, nil) } // go', 'golang')).toEqual([
      'hljs-keyword:func',
      'hljs-title:main',
      'hljs-title:Println',
      'hljs-string:"hi"',
      'hljs-number:42',
      'hljs-literal:nil',
      'hljs-comment:// go',
    ]);
    expect(classed('public final class A { void run() { return; } }', 'java')).toEqual([
      'hljs-keyword:public',
      'hljs-keyword:final',
      'hljs-keyword:class',
      'hljs-keyword:void',
      'hljs-title:run',
      'hljs-keyword:return',
    ]);
    // A lifetime is not a char literal: it must not swallow the code up to the next quote.
    expect(classed("fn first<'a>(x: &'a str) -> char { let c = 'x'; c }", 'rs')).toEqual([
      'hljs-keyword:fn',
      'hljs-keyword:let',
      "hljs-string:'x'",
    ]);
    expect(
      classed(
        '[package]\nname = "crewaid" # app\nedition.year = 2024\n[[bin]]\ntest = false',
        'toml',
      ),
    ).toEqual([
      'hljs-section:[package]',
      'hljs-attr:name',
      'hljs-string:"crewaid"',
      'hljs-comment:# app',
      'hljs-attr:edition.year',
      'hljs-number:2024',
      'hljs-section:[[bin]]',
      'hljs-attr:test',
      'hljs-literal:false',
    ]);
    // Instructions and comments count only at the start of a line.
    expect(
      classed(
        'FROM node:22 AS build\n# deps\nRUN curl https://example.com/a#b && \\\n    run-tests\nCOPY . /app',
        'dockerfile',
      ),
    ).toEqual([
      'hljs-keyword:FROM',
      'hljs-number:22',
      'hljs-comment:# deps',
      'hljs-keyword:RUN',
      'hljs-keyword:COPY',
    ]);
  });

  it('keeps `//` out of comments in languages that comment with `#`', () => {
    expect(classed('curl https://example.com # fetch', 'bash')).toEqual(['hljs-comment:# fetch']);
    expect(classed('half = total // 2  # floor', 'python')).toEqual([
      'hljs-number:2',
      'hljs-comment:# floor',
    ]);
    expect(classed('value = None', 'python')).toEqual(['hljs-literal:None']);
  });

  it('picks a language from a file path, and none for a file it does not know', () => {
    expect(
      [
        'src/App.tsx',
        '/home/bot/agents/b1/server.mjs',
        'main.go',
        'lib.rs',
        'Main.java',
        'Cargo.toml',
        'Dockerfile',
        'infra/Dockerfile.dev',
        'web.dockerfile',
        'fix.patch',
        'notes.md',
        'include/vec.hpp',
        'notes.txt',
        'Makefile',
        '.env',
      ].map(languageForPath),
    ).toEqual([
      'typescript',
      'javascript',
      'go',
      'rust',
      'java',
      'toml',
      'dockerfile',
      'dockerfile',
      'dockerfile',
      'diff',
      'markdown',
      'cpp',
      null,
      null,
      null,
    ]);
  });
});

describe('CodeView', () => {
  it('draws `cat -n` line numbers in a gutter that a copy leaves out', () => {
    const code = parseNumberedCode(
      '12\tconst total = 1; // sum\n13\t\n14\treturn "x";\n[lines 12–14 of 40]',
    );
    expect(code?.before).toEqual([]);
    expect(code?.after).toEqual(['[lines 12–14 of 40]']);
    const html = renderToStaticMarkup(<CodeView rows={code?.rows ?? []} language="typescript" />);

    expect(html).toContain('data-code-view="numbered"');
    expect(html).toContain('data-language="typescript"');
    expect(html).toContain('data-gutter=""');
    expect(html).toContain('--crewaid-code-gutter:2ch');
    expect(html).toContain('data-line="12"');
    expect(html).toContain('data-line="14"');
    expect(html).toContain('<span class="hljs-keyword">const</span>');
    expect(html).toContain('<span class="hljs-comment">// sum</span>');
    // The numbers live in attributes only; the selectable text is the code.
    expect(textOf(html)).toBe('const total = 1; // sum\n' + '\n' + 'return "x";');
  });

  it('keeps a file it does not know as plain text, still with its line numbers', () => {
    const code = parseNumberedCode('1\tconst x = "y";\n2\tdone');
    const html = renderToStaticMarkup(<CodeView rows={code?.rows ?? []} language={null} />);
    expect(classNames(html)).toEqual([]);
    expect(html).toContain('data-line="2"');
    expect(textOf(html)).toBe('const x = "y";\ndone');
  });

  it('renders an edit as a diff, each side highlighted in the file language', () => {
    const html = renderToStaticMarkup(
      <CodeView
        rows={replacementDiff('const total = 1;', 'const total = 2;\n// doubled')}
        language="typescript"
      />,
    );
    expect(html).toContain('data-code-view="diff"');
    expect(html.match(/data-diff="deletion"/g)).toHaveLength(1);
    expect(html.match(/data-diff="addition"/g)).toHaveLength(2);
    expect(html).toContain('data-marker="-"');
    expect(html).toContain('data-marker="+"');
    expect(html.match(/<span class="hljs-keyword">const<\/span>/g)).toHaveLength(2);
    expect(html).toContain('<span class="hljs-comment">// doubled</span>');
    // The markers are generated content: copying an edit gives its code back.
    expect(textOf(html)).not.toMatch(/^[-+]/m);
    // Deleting text adds no empty "+" line.
    expect(replacementDiff('gone', '')).toEqual([{ text: 'gone', diff: 'deletion' }]);
  });

  it('reads a unified diff into rows without their marker column', () => {
    expect(
      parseUnifiedDiff('@@ -1,2 +1,2 @@\n keep\n-old\n+new\n').map((row) => [row.diff, row.text]),
    ).toEqual([
      ['hunk', '@@ -1,2 +1,2 @@'],
      ['context', 'keep'],
      ['deletion', 'old'],
      ['addition', 'new'],
    ]);
  });

  it('bounds what it draws and counts the lines it left out', () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({
      text: `line ${index}`,
      number: index + 1,
    }));
    // Each "line N" row costs 7 characters with its newline: ten fit in 72.
    const html = renderToStaticMarkup(<CodeView rows={rows} language={null} maxChars={72} />);
    expect(html).toContain('data-line="10"');
    expect(html).not.toContain('data-line="11"');
    expect(html).toContain('data-code-hidden-lines="40"');
    expect(html).toContain('… and 40 more lines');

    const minified = renderToStaticMarkup(
      <CodeView rows={[{ text: 'x'.repeat(500), number: 1 }]} language={null} maxChars={80} />,
    );
    expect(textOf(minified)).toBe(`${'x'.repeat(80)}…`);
  });
});
