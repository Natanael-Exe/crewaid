import { describe, expect, it } from 'vitest';

import { CDP_PAYLOAD_LIMITS, CDP_SELECTOR_KINDS } from '../src/recordings/cdp-events.js';
import { generateSelectorCandidates } from '../src/recordings/cdp-selectors.js';
import {
  attachShadow,
  fakeDocument,
  FakeElement,
  FakeRoot,
  findByAttr,
  type FakeNodeSpec,
} from './selector-dom-fakes.js';

/**
 * M4-BE-03 — the selector generator, against a fixture DOM.
 *
 * §6/M4: `data-testid` → `id` → `aria-label` + role → unique CSS path → text
 * match, "record all candidates, not only the winner". The PRD's required
 * test is "asserts priority order and uniqueness of the chosen selector" —
 * the chosen one being the first unique rung — and this suite checks the
 * rest of the contract too: which rungs exist for which elements, that a
 * non-unique name is kept and flagged rather than dropped, that escaping
 * produces selectors a CSS parser can actually read (the fake matcher throws
 * on anything it cannot parse, so the suite fails loudly rather than
 * silently), and that nothing a page can hand it makes it throw.
 */

const LIMIT = CDP_PAYLOAD_LIMITS.selector;

/** The rungs, as kinds. */
function kindsOf(element: unknown): readonly string[] {
  return generateSelectorCandidates(element, LIMIT).map((candidate) => candidate.kind);
}

/** One rung, or a failed test — a missing rung is what most cases assert about. */
function rung(element: unknown, kind: string) {
  const found = generateSelectorCandidates(element, LIMIT).find((c) => c.kind === kind);
  if (found === undefined) throw new Error(`no ${kind} candidate`);
  return found;
}

/** The selector the ladder would hand a replay: the first unique rung. */
function chosen(element: unknown): string {
  const winner = generateSelectorCandidates(element, LIMIT).find((candidate) => candidate.unique);
  if (winner === undefined) throw new Error('no unique candidate');
  return winner.selector;
}

function leaf(tag: string, attrs: Readonly<Record<string, string>>, text?: string): FakeNodeSpec {
  return text === undefined ? { tag, attrs } : { tag, attrs, text };
}

function bodyOf(children: readonly FakeNodeSpec[]): FakeRoot {
  return fakeDocument({ tag: 'html', children: [{ tag: 'body', children }] });
}

describe('generateSelectorCandidates — the ladder', () => {
  it('reports every rung, in the priority order the vocabulary fixes', () => {
    const doc = bodyOf([
      leaf('button', { 'data-testid': 'go', id: 'go', role: 'button', 'aria-label': 'Go' }, 'Go'),
    ]);
    const button = findByAttr(doc, 'id', 'go');

    const candidates = generateSelectorCandidates(button, LIMIT);

    // Both sides of the contract in one assertion: the generator emitted the
    // rungs in this order, and the vocabulary the parser validates against is
    // the same order. Neither may drift from the other — the generator cannot
    // read the constant (its body runs in a page), so this test is the fence.
    expect(candidates.map((candidate) => candidate.kind)).toEqual([...CDP_SELECTOR_KINDS]);
    expect(candidates).toEqual([
      { kind: 'testid', selector: '[data-testid="go"]', unique: true },
      { kind: 'id', selector: '#go', unique: true },
      { kind: 'aria', selector: '[role="button"][aria-label="Go"]', unique: true },
      { kind: 'css', selector: 'button', unique: true },
      { kind: 'text', selector: 'text="Go"', unique: true },
    ]);
    // PRD §6/M4's required test: the first unique rung is the ladder's top.
    expect(chosen(button)).toBe('[data-testid="go"]');
  });

  it('keeps every rung it can build when higher rungs are shared', () => {
    const doc = bodyOf([
      leaf('button', { 'data-testid': 'row', id: 'dup' }, 'A'),
      leaf('button', { 'data-testid': 'row', id: 'dup' }, 'B'),
    ]);
    const [first, second] = doc.querySelectorAll('button');

    // A page repeating testid and id is exactly what the ladder is for: the
    // shared rungs are still reported (flagged), and the ones that name the
    // element alone still resolve it.
    expect(kindsOf(first)).toEqual(['testid', 'id', 'css', 'text']);
    expect(rung(first, 'testid')).toEqual({
      kind: 'testid',
      selector: '[data-testid="row"]',
      unique: false,
    });
    expect(rung(first, 'id')).toEqual({ kind: 'id', selector: '#dup', unique: false });
    expect(rung(first, 'css').selector).toBe('button:nth-of-type(1)');
    expect(rung(first, 'css').unique).toBe(true);
    expect(rung(second, 'css').selector).toBe('button:nth-of-type(2)');

    // The chosen selector skips the two shared rungs and lands on the first
    // one that names ONE element.
    expect(chosen(first)).toBe('button:nth-of-type(1)');
  });

  it('drops absent rungs instead of substituting weaker forms', () => {
    const doc = bodyOf([{ tag: 'span', text: 'Hello' }]);
    const span = doc.querySelectorAll('span')[0]!;

    expect(kindsOf(span)).toEqual(['css', 'text']);
    expect(rung(span, 'css')).toEqual({ kind: 'css', selector: 'span', unique: true });
    expect(rung(span, 'text')).toEqual({ kind: 'text', selector: 'text="Hello"', unique: true });
  });

  it('treats a role with no aria-label as no rung — it names every element of that role', () => {
    const doc = bodyOf([leaf('div', { role: 'dialog' }, 'Are you sure?')]);
    const dialog = findByAttr(doc, 'role', 'dialog');

    expect(kindsOf(dialog)).toEqual(['css', 'text']);
  });

  it('collapses the aria rung to the label alone when there is no role', () => {
    const doc = bodyOf([leaf('button', { 'aria-label': 'Close' }, 'x')]);
    const button = doc.querySelectorAll('button')[0]!;

    expect(rung(button, 'aria')).toEqual({
      kind: 'aria',
      selector: '[aria-label="Close"]',
      unique: true,
    });
  });
});

describe('generateSelectorCandidates — ids that are not identifiers', () => {
  it('escapes a framework-generated id into the attribute form', () => {
    // React's useId shape: no CSS identifier can start with `:`.
    const doc = bodyOf([leaf('input', { id: ':r0:' })]);
    const input = findByAttr(doc, 'id', ':r0:');

    expect(rung(input, 'id')).toEqual({ kind: 'id', selector: '[id=":r0:"]', unique: true });
  });

  it('escapes quotes and backslashes so the selector still parses', () => {
    const doc = bodyOf([
      leaf('div', { id: 'a"b' }, 'quoted'),
      leaf('div', { id: 'back\\slash' }, 'slashed'),
    ]);
    const quoted = findByAttr(doc, 'id', 'a"b');
    const slashed = findByAttr(doc, 'id', 'back\\slash');

    // The fake matcher decodes these exactly as a CSS parser would; if the
    // escaping were wrong the match count would be 0 and `unique` false.
    expect(rung(quoted, 'id')).toEqual({ kind: 'id', selector: '[id="a\\"b"]', unique: true });
    expect(rung(slashed, 'id')).toEqual({
      kind: 'id',
      selector: '[id="back\\\\slash"]',
      unique: true,
    });
  });

  it('escapes an aria-label past a quote the same way', () => {
    const doc = bodyOf([leaf('button', { role: 'button', 'aria-label': 'Say "hi"' }, 'x')]);
    const button = doc.querySelectorAll('button')[0]!;

    expect(rung(button, 'aria')).toEqual({
      kind: 'aria',
      selector: '[role="button"][aria-label="Say \\"hi\\""]',
      unique: true,
    });
  });
});

describe('generateSelectorCandidates — the CSS path', () => {
  it('walks only as far up as uniqueness requires', () => {
    const doc = bodyOf([
      {
        tag: 'main',
        attrs: { id: 'app' },
        children: [
          { tag: 'section', children: [{ tag: 'span', text: 'target' }] },
          { tag: 'aside', children: [{ tag: 'span', text: 'decoy' }] },
        ],
      },
    ]);
    const target = doc.querySelectorAll('span').find((s) => s.textContent === 'target')!;

    // `span` matches twice, so the walk grows one segment — and stops at the
    // first path that matches once, rather than dragging `main > ...` in.
    expect(rung(target, 'css')).toEqual({ kind: 'css', selector: 'section > span', unique: true });
  });

  it('disambiguates same-tag siblings with :nth-of-type only when it must', () => {
    const doc = bodyOf([
      { tag: 'form', children: [{ tag: 'button', text: 'First' }] },
      { tag: 'form', children: [{ tag: 'button', text: 'Second' }] },
    ]);
    const second = doc.querySelectorAll('button')[1]!;

    expect(rung(second, 'css')).toEqual({
      kind: 'css',
      selector: 'form:nth-of-type(2) > button',
      unique: true,
    });
    // The single-child case stays bare: there is one button per form, so no
    // nth-of-type is needed at either level.
    expect(rung(doc.querySelectorAll('button')[0]!, 'css').selector).toBe(
      'form:nth-of-type(1) > button',
    );
  });

  it('flags a path it could not verify rather than omitting it', () => {
    // No getRootNode in this stand-in: uniqueness cannot be checked at all,
    // which is the shape of a detached element too. The full structural path
    // is still recorded — flagged as unverified, never guessed unique.
    const detached = {
      tagName: 'BUTTON',
      childElementCount: 0,
      textContent: 'Go',
      getAttribute: (name: string): string | null => (name === 'id' ? 'go' : null),
    };

    expect(generateSelectorCandidates(detached, LIMIT)).toEqual([
      { kind: 'id', selector: '#go', unique: false },
      { kind: 'css', selector: 'button', unique: false },
      { kind: 'text', selector: 'text="Go"', unique: false },
    ]);
  });
});

describe('generateSelectorCandidates — the text rung', () => {
  it('matches the way the replay engine will: collapsed whitespace, no case', () => {
    const doc = bodyOf([{ tag: 'button', text: '  Pay\n   now  ' }]);
    const button = doc.querySelectorAll('button')[0]!;

    expect(rung(button, 'text')).toEqual({
      kind: 'text',
      selector: 'text="Pay now"',
      unique: true,
    });
  });

  it('sees a case/whitespace twin as a shared name', () => {
    const doc = bodyOf([
      { tag: 'button', text: 'Pay now' },
      { tag: 'button', text: 'PAY  NOW' },
    ]);
    const first = doc.querySelectorAll('button')[0]!;

    // Playwright's text engine ignores case and collapses whitespace, so both
    // buttons answer `text="Pay now"` — the rung is kept, and is not unique.
    expect(rung(first, 'text')).toEqual({
      kind: 'text',
      selector: 'text="Pay now"',
      unique: false,
    });
  });

  it('is not a rung for a container — a subtree of text names everything inside it', () => {
    const doc = bodyOf([{ tag: 'div', children: [{ tag: 'span', text: 'inner' }] }]);
    const div = doc.querySelectorAll('div')[0]!;

    expect(kindsOf(div)).toEqual(['css']);
  });

  it('escapes a quote in the text', () => {
    const doc = bodyOf([{ tag: 'button', text: 'Say "hi"' }]);
    const button = doc.querySelectorAll('button')[0]!;

    expect(rung(button, 'text')).toEqual({
      kind: 'text',
      selector: 'text="Say \\"hi\\""',
      unique: true,
    });
  });
});

describe('generateSelectorCandidates — shadow roots', () => {
  it('checks uniqueness within the element’s own root, not the whole page', () => {
    const doc = bodyOf([leaf('div', { id: 'host' }, '')]);
    const host = findByAttr(doc, 'id', 'host');
    const shadow = attachShadow(host, [leaf('button', { id: 'x' }, 'In the shadow')]);
    const inside = findByAttr(shadow, 'id', 'x');

    // `#x` cannot be seen from the document at all — querySelectorAll does not
    // cross the boundary — so the claim is made against the shadow root the
    // element actually lives in. Every rung carries `shadow: true` (M4-BE-06
    // fix wave): the compile fence sets shadow-scoped rungs aside, because the
    // replayer's resolver is a document-level query — it can never cross this
    // boundary, and a root-scoped `button` against the light DOM can even
    // click a DIFFERENT element.
    expect(shadow.kind).toBe('shadow');
    expect(rung(inside, 'id')).toEqual({ kind: 'id', selector: '#x', unique: true, shadow: true });
    expect(rung(inside, 'css')).toEqual({
      kind: 'css',
      selector: 'button',
      unique: true,
      shadow: true,
    });
    expect(rung(inside, 'text').unique).toBe(true);
    expect(rung(inside, 'text').shadow).toBe(true);
  });

  it('does not walk a shadow element’s path across the boundary', () => {
    const doc = bodyOf([leaf('div', { id: 'host' }, '')]);
    const host = findByAttr(doc, 'id', 'host');
    const shadow = attachShadow(host, [
      {
        tag: 'section',
        children: [
          { tag: 'div', children: [{ tag: 'span', text: 'inner' }] },
          { tag: 'div', children: [{ tag: 'span', text: 'other' }] },
        ],
      },
    ]);
    const target = shadow.querySelectorAll('span').find((s) => s.textContent === 'inner')!;

    // The walk stops where `parentElement` stops — the shadow boundary — so
    // no `html > body > …` prefix leaks in from a document this element is
    // not part of, and the same-tag divs still disambiguate inside the shadow.
    expect(rung(target, 'css')).toEqual({
      kind: 'css',
      selector: 'div:nth-of-type(1) > span',
      unique: true,
      shadow: true,
    });
    // The document's own query cannot see the shadow content at all — which
    // is exactly why the rung above is marked and never emitted as a step.
    expect(doc.querySelectorAll('span')).toHaveLength(0);
  });
});

describe('generateSelectorCandidates — ceilings and hostile input', () => {
  it('keeps a selector at the ceiling and drops one past it, never truncating', () => {
    const exact = 'a'.repeat(LIMIT - '[aria-label=""]'.length);
    const over = 'a'.repeat(LIMIT - '[aria-label=""]'.length + 1);
    const inDoc = bodyOf([leaf('button', { 'aria-label': exact }, '')]);
    const outDoc = bodyOf([leaf('button', { 'aria-label': over }, '')]);

    expect(rung(inDoc.querySelectorAll('button')[0]!, 'aria').selector.length).toBe(LIMIT);
    // A truncated selector is a DIFFERENT selector; the candidate is dropped.
    expect(kindsOf(outDoc.querySelectorAll('button')[0]!)).toEqual(['css']);
  });

  it('drops a text rung whose selector cannot fit, rather than clipping the text', () => {
    const doc = bodyOf([{ tag: 'button', text: 'x'.repeat(LIMIT) }]);
    const button = doc.querySelectorAll('button')[0]!;

    expect(kindsOf(button)).toEqual(['css']);
  });

  it('returns nothing for values a page could hand it, and never throws', () => {
    for (const junk of [null, undefined, 0, 42, 'button', true, [], Symbol('s')]) {
      expect(() => generateSelectorCandidates(junk, LIMIT)).not.toThrow();
      expect(generateSelectorCandidates(junk, LIMIT)).toEqual([]);
    }

    const hostile = {
      tagName: 'DIV',
      childElementCount: 0,
      get textContent(): string {
        throw new Error('hostile');
      },
      getAttribute(): string {
        throw new Error('hostile');
      },
      getRootNode(): never {
        throw new Error('hostile');
      },
    };
    const candidates = generateSelectorCandidates(hostile, LIMIT);
    // Every read failed, so nothing is claimed unique — but the element with
    // a readable tag still leaves a path, flagged.
    expect(candidates).toEqual([{ kind: 'css', selector: 'div', unique: false }]);
  });

  it('generates nothing when the caller agreed no ceiling', () => {
    const doc = bodyOf([leaf('button', { id: 'go' }, 'Go')]);
    const button = findByAttr(doc, 'id', 'go');

    expect(generateSelectorCandidates(button, 0)).toEqual([]);
    expect(generateSelectorCandidates(button, Number.NaN)).toEqual([]);
    expect(generateSelectorCandidates(button, -10)).toEqual([]);
  });

  it('never walks past a parent chain that is somehow not a tree', () => {
    // Not reachable in a real DOM — cycles are what the walk's depth bound
    // exists for, and only a broken substitute can build one. Without the
    // bound this test would not fail; it would hang the runner.
    const root = new FakeRoot('document');
    const first = new FakeElement('DIV', {}, '', null, root);
    const second = new FakeElement('DIV', {}, '', first, root);
    first.parentElement = second;

    expect(generateSelectorCandidates(first, LIMIT)).toEqual([]);
  });
});
