import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { groupReasoning, ReasoningPart } from '../src/renderer/components/ReasoningPart';
import { renderPart, resolvePartRenderer } from '../src/renderer/components/PartRenderer';
import type { AnyPart } from '../src/renderer/components/PartRenderer';

/**
 * D-091 — thinking in the transcript.
 *
 * The defect this closes was visible to the operator on every single turn: a
 * reasoning model emits `reasoning` parts, no renderer was registered for
 * them, and the registry's fallback printed `[unsupported part type:
 * reasoning]` between every paragraph of every reply.
 */

function render(part: AnyPart): string {
  return renderToStaticMarkup(<ReasoningPart part={part} />);
}

const thinking: AnyPart = { type: 'reasoning', text: 'Checking the footer first.' };

describe('ReasoningPart', () => {
  it('is what the registry resolves for a reasoning part, and prints no part type', () => {
    expect(resolvePartRenderer('reasoning')).toBe(ReasoningPart);
    expect(resolvePartRenderer('reasoning-block')).toBe(ReasoningPart);
    const html = renderToStaticMarkup(<>{renderPart(thinking)}</>);
    expect(html).not.toContain('unsupported part type');
    expect(html).toContain('Checking the footer first.');
  });

  it('collapses settled thinking behind one line', () => {
    const settled = render(thinking);
    expect(settled).toContain('data-reasoning="settled"');
    expect(settled).toContain('Thought about this');
    expect(settled).toContain('data-slot="chain-of-thought-trigger"');
    // Closed by default: the thinking is evidence to open, not part of the
    // conversation, and a turn's worth of it must not stand between two
    // answers.
    expect(settled).toContain('aria-expanded="false"');
    expect(settled).not.toContain('aria-expanded="true"');
    expect(settled).toContain('Checking the footer first.');
  });

  it('is collapsed while it streams too, and says so in the present tense', () => {
    const live = render({ ...thinking, state: 'streaming' });
    expect(live).toContain('data-reasoning="streaming"');
    // A disclosure that can be opened DURING the turn: a reasoning model can
    // think for minutes, and an operator who wants to watch it work must not
    // have to wait for the answer to be able to fold the wall of text away.
    expect(live).toContain('data-slot="chain-of-thought-trigger"');
    expect(live).toContain('aria-expanded="false"');
    expect(live).not.toContain('aria-expanded="true"');
    expect(live).toContain('Thinking');
    expect(live).toContain('Checking the footer first.');
  });

  it('caps the opened body and scrolls it on its own', () => {
    // Unbounded, expanding one thought turned the transcript into a page of
    // working-out and took the answer above it off screen.
    const settled = render(thinking);
    expect(settled).toContain('data-reasoning-body');
    expect(settled).toContain('max-h-[320px]');
    expect(settled).toContain('overflow-y-auto');
    // Reaching the end of the box must not hand the gesture to the transcript
    // underneath, which is following the tail.
    expect(settled).toContain('overscroll-contain');
  });

  it('renders nothing for a reasoning part with no text', () => {
    expect(render({ type: 'reasoning', text: '' })).toBe('');
  });
});

describe('groupReasoning', () => {
  it('folds an ADJACENT run into one row and keeps the paragraphs apart', () => {
    const folded = groupReasoning([
      { type: 'reasoning', text: 'one' },
      { type: 'reasoning', text: 'two' },
      { type: 'text', text: 'Here is what I found.' },
    ]);
    expect(folded).toEqual([
      { type: 'reasoning-block', text: 'one\n\ntwo' },
      { type: 'text', text: 'Here is what I found.' },
    ]);
  });

  it('does NOT merge across something the bot said or did', () => {
    // Thinking before an action and thinking after it are two pauses. Merging
    // them would attach the reasoning from before a tool call to the reasoning
    // that reacted to its result, and move it above the action in the process.
    const folded = groupReasoning([
      { type: 'reasoning', text: 'before' },
      { type: 'tool-activity', calls: [] },
      { type: 'reasoning', text: 'after' },
    ]);
    expect(folded.map((part) => part.type)).toEqual([
      'reasoning-block',
      'tool-activity',
      'reasoning-block',
    ]);
  });

  it('carries the streaming flag onto the run, so a live fold stays live', () => {
    const folded = groupReasoning([
      { type: 'reasoning', text: 'settled' },
      { type: 'reasoning', text: 'still arriving', state: 'streaming' },
    ]);
    expect(folded[0]).toMatchObject({ state: 'streaming' });
  });

  it('leaves a run of empty thinking out entirely', () => {
    expect(groupReasoning([{ type: 'reasoning', text: '' }])).toEqual([]);
  });
});
