import { describe, expect, it } from 'vitest';
import { createModelControlTagFilter, stripModelControlTags } from './model-control-tags.js';

function streamChunks(chunks: readonly string[]): string {
  const filter = createModelControlTagFilter();
  let out = '';
  for (const chunk of chunks) {
    out += filter.push(chunk);
  }
  out += filter.flush();
  return out;
}

describe('stripModelControlTags', () => {
  it('removes leaked budget:token_budget directives completely', () => {
    expect(stripModelControlTags('<budget:token_budget>200000</budget:token_budget>')).toBe('');
    expect(
      stripModelControlTags(
        'Payment confirmed.\n\n<budget:token_budget>200000</budget:token_budget>',
      ),
    ).toBe('Payment confirmed.');
    expect(
      stripModelControlTags(
        '<budget:token_budget>200000</budget:token_budget>\nDone with the update.',
      ),
    ).toBe('Done with the update.');
  });

  it('removes stray opening or closing budget tags and system-reminder blocks', () => {
    expect(stripModelControlTags('Hello <system-reminder>internal note</system-reminder>world')).toBe(
      'Hello world',
    );
    expect(stripModelControlTags('Before </budget:token_budget> after')).toBe('Before  after');
  });

  it('preserves fenced code blocks, inline code, and ordinary HTML or comparisons', () => {
    const fenced = '```xml\n<budget:token_budget>200000</budget:token_budget>\n```';
    expect(stripModelControlTags(fenced)).toBe(fenced);

    const inline = 'Ignore `<budget:token_budget>200000</budget:token_budget>` in logs.';
    expect(stripModelControlTags(inline)).toBe(inline);

    const ordinary = 'If a < b and x <button>click</button>, proceed.';
    expect(stripModelControlTags(ordinary)).toBe(ordinary);
  });
});

describe('createModelControlTagFilter', () => {
  it('strips leaked budget directives split arbitrarily across stream chunks', () => {
    expect(
      streamChunks(['<bud', 'get:token_', 'budget>200', '000</bud', 'get:token_budget>']),
    ).toBe('');

    expect(
      streamChunks([
        'All set. ',
        '<budget:',
        'token_budget>200000</budget:token_budget>\n',
        'Next step.',
      ]),
    ).toBe('All set. Next step.');
  });

  it('drops a truncated budget directive at end-of-stream without dropping ordinary prose', () => {
    expect(streamChunks(['<budget:token_budget>', '200000'])).toBe('');
    expect(streamChunks(['x < ', 'b and ', '<div>ok</div>'])).toBe('x < b and <div>ok</div>');
  });

  it('keeps budget tags literal inside fenced code blocks across chunks', () => {
    const out = streamChunks([
      'Example:\n``',
      '`xml\n<budget:token_budget>200000</budget:token_budget>\n```',
    ]);
    expect(out).toBe('Example:\n```xml\n<budget:token_budget>200000</budget:token_budget>\n```');
  });
});
