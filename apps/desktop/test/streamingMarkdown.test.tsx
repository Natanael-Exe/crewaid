import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StreamingMarkdown } from '../src/renderer/components/markdown/StreamingMarkdown';
import { codeHighlighter } from '../src/renderer/components/markdown/highlight';
import { renderPart } from '../src/renderer/components/PartRenderer';

function markup(source: string): string {
  return renderToStaticMarkup(<StreamingMarkdown source={source} />);
}
function streamed(source: string): string {
  return renderToStaticMarkup(<StreamingMarkdown source={source} streaming />);
}

const codeBlocks = (output: string) => output.match(/data-streamdown="code-block"/g) ?? [];

describe('StreamingMarkdown', () => {
  it('highlights roster-backed @mentions as conversation buttons, outside code', () => {
    const output = renderToStaticMarkup(
      <StreamingMarkdown
        source={'Ask @Nathan Bot, but keep `@Nathan Bot` literal.'}
        mentionBots={[
          {
            id: 'bot-nathan',
            name: 'Nathan Bot',
            role: 'Frontend engineer',
            avatarColor: '#16a3b6',
          },
        ]}
        onBotMention={() => undefined}
      />,
    );

    expect(output.match(/data-bot-mention="bot-nathan"/g)).toHaveLength(1);
    expect(output).toContain('Open Nathan Bot&#x27;s conversation');
    expect(output).toContain('<code');
    expect(output).toContain('@Nathan Bot</code>');
  });

  it('keeps a message on the lines it was typed on, and code on its own', () => {
    const output = markup('first line\nsecond line\n\n```\na\nb\n```');
    expect(output).toMatch(/first line<br\/?>\s*second line/);
    expect(output).not.toMatch(/a<br\/?>b/);
  });

  it('leaves a mention of a bot outside the roster as text', () => {
    const output = renderToStaticMarkup(
      <StreamingMarkdown source="Ask @Nobody please" mentionBots={[]} />,
    );
    expect(output).not.toContain('data-bot-mention');
    expect(output).toContain('Ask @Nobody please');
  });

  it('renders fenced code as a labelled block with copy and download, without fences', () => {
    const output = markup('# Reply\n\n```ts\nconst answer: number = 42;\n```\n');

    expect(output).toContain('data-markdown-renderer="streaming"');
    expect(codeBlocks(output)).toHaveLength(1);
    expect(output).toContain('data-language="ts"');
    expect(output).toContain('aria-label="Copy Code"');
    expect(output).toContain('aria-label="Download file"');
    expect(output).toContain('const answer: number = 42;');
    expect(output).not.toContain('```');
  });

  it('highlights code into allowlisted token classes, one line per row', () => {
    const result = codeHighlighter.highlight(
      {
        code: 'const answer = 42; // done\nreturn "x";',
        language: 'ts',
        themes: ['github-light', 'github-dark'],
      },
      () => undefined,
    );
    const lines = result?.tokens ?? [];
    expect(lines).toHaveLength(2);
    const classes = lines.flat().map((token) => token.htmlAttrs?.['className']);
    expect(classes).toEqual(
      expect.arrayContaining(['hljs-keyword', 'hljs-number', 'hljs-comment', 'hljs-string']),
    );
    expect(classes.every((name) => name === undefined || /^hljs-[a-z]+$/.test(name))).toBe(true);
    expect(lines.map((line) => line.map((token) => token.content).join(''))).toEqual([
      'const answer = 42; // done',
      'return "x";',
    ]);
    expect(codeHighlighter.supportsLanguage('typescript')).toBe(true);
    expect(codeHighlighter.supportsLanguage('brainfuck')).toBe(false);
  });

  it('keeps an unterminated fence inside the same escaped code-block shape', () => {
    const output = streamed('Before\n\n```tsx\nconst node = <div>hello</div>');

    expect(codeBlocks(output)).toHaveLength(1);
    expect(output).toContain('data-language="tsx"');
    expect(output).toContain('const node = &lt;div&gt;hello&lt;/div&gt;');
    expect(output).not.toContain('```');
    expect(output).not.toContain('<div>hello</div>');
  });

  it('keeps the code block shape stable as the closing fence arrives', () => {
    const partial = streamed('```ts\nconst answer = 42;');
    const complete = markup('```ts\nconst answer = 42;\n```');

    expect(codeBlocks(partial)).toHaveLength(1);
    expect(codeBlocks(complete)).toHaveLength(1);
    expect(partial).not.toContain('```');
    expect(complete).not.toContain('```');
  });

  it('keeps partial lists, nested lists and tables structured while they stream', () => {
    const output = streamed(
      '- first\n  - nested\n- second\n\n| Name | Value |\n| --- | --- |\n| Quill |',
    );

    expect(output.match(/<ul(?:\s|>)/g)).toHaveLength(2);
    expect(output).toMatch(/<table(?:\s|>)/);
    expect(output).toContain('Name');
    expect(output).toContain('Quill');
    expect(output).not.toContain('| Name |');
    expect(streamed('-')).toMatch(/<ul(?:\s|>)/);
  });

  it('closes emphasis that has not finished streaming, and only while it streams', () => {
    expect(streamed('This is **bold text')).toContain('<strong');
    expect(streamed('This is **bold text')).not.toContain('**');
    expect(markup('This is **bold text')).toContain('**bold text');
  });

  it('renders settled text as written: an unclosed link hides nothing after it', () => {
    const source = 'Start [unclosed]( more\n\nNext paragraph\n\n- item';
    const settled = markup(source);
    expect(settled).toContain('[unclosed]( more');
    expect(settled).toContain('Next paragraph');
    expect(settled).toMatch(/<ul(?:\s|>)/);
    // Mid-stream the same text is a link still being typed, and is not followed.
    expect(streamed('Start [unclosed](')).not.toMatch(/<a\s/);
  });

  it('survives malformed and long streamed input', () => {
    const malformed = markup('[x](\n\n> > >\n\n|||\n\n***\n\n<<<>>>\n\n```');
    expect(malformed).toContain('data-markdown-renderer="streaming"');
    expect(malformed).toMatch(/<blockquote(?:\s|>)/);
    expect(malformed).toContain('&lt;&lt;&lt;&gt;&gt;&gt;');
    expect(codeBlocks(malformed)).toHaveLength(1);

    const long = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} with **bold** text.`).join(
      '\n\n',
    );
    const output = streamed(long);
    expect(output.match(/<p(?:\s|>)/g)).toHaveLength(400);
    expect(output).toContain('Paragraph 399');
  });

  it('renders hostile HTML as text and opens only https links', () => {
    const output = markup(
      '<img src=x onerror=alert(1)>\n\n<script>alert(2)</script>\n\n[click](javascript:alert(3))\n\n[safe](https://example.com/docs) [encoded](java%73cript:alert(4)) [plain](http://example.com) [mail](mailto:a@b.c) [rel](/settings)',
    );

    expect(output).not.toContain('<img');
    expect(output).not.toContain('<script');
    expect(output).not.toMatch(/<[^>]*\bonerror=/i);
    expect(output).not.toContain('javascript:');
    expect(output).toContain('&lt;img');
    expect(output).toContain('&lt;script&gt;');
    expect(output.match(/<a\s/g)).toHaveLength(1);
    expect(output).toContain('href="https://example.com/docs"');
    expect(output).not.toContain('target="_blank"');
    for (const text of ['click', 'plain', 'mail', 'rel']) expect(output).toContain(text);
  });

  it('never loads a remote or data image; it shows the description instead', () => {
    const output = markup(
      '![chart](https://example.com/chart.png) ![pixel](data:image/png;base64,AAAA)',
    );
    expect(output).not.toContain('<img');
    expect(output).not.toContain('example.com/chart.png');
    expect(output).not.toContain('data:image');
  });

  it('repairs a text part only when the render context says it is streaming', () => {
    const part = { type: 'text', text: 'Half **written' };
    expect(renderToStaticMarkup(renderPart(part, { streaming: true }))).toContain('<strong');
    expect(renderToStaticMarkup(renderPart(part))).toContain('Half **written');
  });

  it('routes text parts through the registry into the markdown renderer', () => {
    const output = renderToStaticMarkup(
      renderPart({ type: 'text', text: '**streamed** `content`' }),
    );

    expect(output).toContain('data-markdown-renderer="streaming"');
    expect(output).toContain('<strong');
    expect(output).toContain('streamed');
    expect(output).toContain('<code');
    expect(output).toContain('content');
  });
});
