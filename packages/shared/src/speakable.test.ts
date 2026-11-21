import { describe, expect, it } from 'vitest';
import { SPOKEN_REMAINDER, SPOKEN_REPLY_MAX_CHARS, speakable } from './speakable.js';

describe('D-221 — a reply rewritten to be heard', () => {
  it('names a fenced code block instead of reading it', () => {
    const spoken = speakable(
      'Run this:\n\n```ts\nconst a = 1;\nexport { a };\n```\n\nThen restart.',
    );
    expect(spoken).toBe('Run this: (a TypeScript code block). Then restart.');
    expect(spoken).not.toContain('const');
  });

  it('names an unlabelled code block without a language', () => {
    expect(speakable('```\nls -la\n```')).toBe('(a code block).');
  });

  it('announces a table once, however many rows it has', () => {
    const table = '| Lead | Status |\n| --- | --- |\n| Acme | won |\n| Globex | lost |';
    const spoken = speakable(`Here is the sheet:\n\n${table}\n\nTwo leads.`);
    expect(spoken).toBe('Here is the sheet: (a table). Two leads.');
  });

  it('keeps a link’s words and drops its address', () => {
    expect(speakable('See [the pricing page](https://example.com/pricing) for more.')).toBe(
      'See the pricing page for more.',
    );
    expect(speakable('It is at https://example.com/x?y=1 now')).toBe('It is at a link now.');
  });

  it('says a file’s name, not its directories', () => {
    expect(speakable('I changed `apps/orchestrator/src/main.ts` and docs/VOICE.md')).toBe(
      'I changed main.ts and VOICE.md.',
    );
  });

  it('drops emphasis, headings, quotes and list markers, ending each line as a sentence', () => {
    const spoken = speakable(
      '## Summary\n\n- **Three** leads replied\n- one *bounced*\n1. Follow up\n> quoted line',
    );
    expect(spoken).toBe('Summary. Three leads replied. one bounced. Follow up. quoted line.');
  });

  it('keeps an ordinary sentence exactly as written', () => {
    expect(speakable('Done! The export finished and every check passed.')).toBe(
      'Done! The export finished and every check passed.',
    );
  });

  it('says nothing for a reply that is only markup', () => {
    expect(speakable('---\n\n')).toBe('');
  });

  it('cuts a long reply at a sentence and says where the rest is', () => {
    const sentence = 'This sentence is about forty characters. ';
    const spoken = speakable(sentence.repeat(200));
    expect(spoken.length).toBeLessThanOrEqual(SPOKEN_REPLY_MAX_CHARS);
    expect(spoken.endsWith(`characters. ${SPOKEN_REMAINDER}`)).toBe(true);
  });
});
