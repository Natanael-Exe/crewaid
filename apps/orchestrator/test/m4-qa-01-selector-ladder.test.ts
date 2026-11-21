/**
 * M4-QA-01 — the selector generator's priority ladder and uniqueness claims,
 * verified INDEPENDENTLY on QA-authored fixtures (the M4-BE-03 suite keeps its
 * own; this one shares no substrate with it).
 *
 * Three layers of truth meet here, so no single layer can vouch for itself:
 *
 *   • the hand pins in `m4-qa-01-fixtures.ts` — what §6/M4 says the ladder
 *     must emit for each tree, written down before anything ran;
 *   • the from-spec oracle (`deriveCandidates`) — the ladder re-derived with
 *     separate code, compared rung by rung;
 *   • real Chromium verification of the same fixtures, where the CSS engine
 *     and shadow semantics are Chrome's, not this file's.
 *
 * The fake-only fixtures (hostile stand-ins, junk values) have no real-page
 * equivalent — a page cannot produce a throwing `getAttribute` — and are
 * verified here only, which is where they belong.
 */

import { describe, expect, it } from 'vitest';

import { CDP_PAYLOAD_LIMITS, CDP_SELECTOR_KINDS } from '../src/recordings/cdp-events.js';
import { generateSelectorCandidates } from '../src/recordings/cdp-selectors.js';
import { buildFixture, deriveCandidates, QaElement, QaRoot } from './m4-qa-01-fixture-dom.js';
import { FIXTURES, LIMIT, type QaFixture } from './m4-qa-01-fixtures.js';

/** Stand-ins a real page cannot produce, keyed by fixture name. */
function standIn(name: string): { root: QaRoot | null; element: unknown } {
  switch (name) {
    case 'detached-element-flagged': {
      // No getRootNode at all — the shape of a detached element.
      const element = {
        tagName: 'BUTTON',
        childElementCount: 0,
        textContent: 'Go',
        getAttribute: (attr: string): string | null =>
          attr === 'data-testid' || attr === 'id' ? 'go' : null,
      };
      return { root: null, element };
    }
    case 'hostile-attribute-throws': {
      const root = new QaRoot('document');
      const button = new QaElement('button', { id: 'go', 'data-testid': 'go' }, 'Go', root, null, [
        'getAttribute',
      ]);
      root.elements.push(button);
      return { root, element: button };
    }
    case 'hostile-text-throws': {
      const root = new QaRoot('document');
      const button = new QaElement('button', { id: 'go' }, 'Go', root, null, ['textContent']);
      root.elements.push(button);
      return { root, element: button };
    }
    case 'hostile-root-throws': {
      const root = new QaRoot('document');
      const button = new QaElement('button', { id: 'go' }, 'Go', root, null, ['getRootNode']);
      root.elements.push(button);
      return { root, element: button };
    }
    case 'non-string-attributes': {
      const root = new QaRoot('document');
      const button = new QaElement('button', {}, 'Go', root, null, ['nonString']);
      root.elements.push(button);
      return { root, element: button };
    }
    case 'wildcard-tag': {
      const root = new QaRoot('document');
      const weird = new QaElement('my weird tag', {}, 'X', root);
      root.elements.push(weird);
      return { root, element: weird };
    }
    default:
      throw new Error(`no stand-in for ${name}`);
  }
}

function resolveTarget(fixture: QaFixture): unknown {
  if (fixture.fakeOnly) return standIn(fixture.name).element;
  const built = buildFixture(fixture.tree);
  return built.byRef(fixture.target);
}

/** Kinds must follow the vocabulary strictly — no rung twice, no rung out of order. */
function expectLadderOrder(candidates: readonly { kind: string }[]): void {
  const positions = candidates.map((candidate) =>
    CDP_SELECTOR_KINDS.indexOf(candidate.kind as never),
  );
  for (let i = 0; i < positions.length; i += 1) {
    expect(
      positions[i],
      `kind ${candidates[i]!.kind} is not in the vocabulary`,
    ).toBeGreaterThanOrEqual(0);
    if (i > 0) {
      expect(
        positions[i]!,
        `rung ${candidates[i]!.kind} after ${candidates[i - 1]!.kind} breaks priority order`,
      ).toBeGreaterThan(positions[i - 1]!);
    }
  }
}

describe('M4-QA-01 selector ladder — fixtures', () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.name}: ${fixture.why}`, () => {
      const element = resolveTarget(fixture);
      const candidates = generateSelectorCandidates(element, LIMIT);

      expectLadderOrder(candidates);

      // Layer 1 — the hand pin, exactly.
      if (fixture.pin !== undefined) {
        expect(candidates).toEqual([...fixture.pin]);
      }
      if (fixture.pinKinds !== undefined) {
        expect(candidates.map((candidate) => candidate.kind)).toEqual([...fixture.pinKinds]);
      }

      // Layer 2 — the from-spec oracle, rung by rung.
      expect(candidates).toEqual(deriveCandidates(element, LIMIT));

      // The PRD's own required clause: the chosen selector is the first
      // unique rung in priority order.
      if (fixture.pin !== undefined) {
        expect(candidates.find((candidate) => candidate.unique)?.selector).toBe(
          fixture.pin.find((candidate) => candidate.unique)?.selector,
        );
      }
    });
  }
});

describe('M4-QA-01 selector ladder — limits and junk', () => {
  it('returns nothing for values a page could hand it, and never throws', () => {
    for (const junk of [
      null,
      undefined,
      0,
      42,
      'button',
      true,
      [],
      Symbol('s'),
      {},
      { tagName: 42 },
    ]) {
      expect(() => generateSelectorCandidates(junk, LIMIT)).not.toThrow();
      expect(generateSelectorCandidates(junk, LIMIT)).toEqual([]);
    }
  });

  it('generates nothing when the caller agreed no usable ceiling', () => {
    const built = buildFixture(FIXTURES[0]!.tree);
    const target = built.byRef('target');
    for (const limit of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(generateSelectorCandidates(target, limit)).toEqual([]);
    }
  });

  it('drops the CSS rung when the walk outgrows the depth bound — never hangs, never guesses', () => {
    // A detached chain 140 levels deep: every candidate fails to match (no
    // root) and the walk hits the 128-segment bound before the top — the CSS
    // rung is absent, while the text rung is still recorded (flagged).
    let node = new QaElement('span', { id: 'deep-desc' }, 'Deep', null);
    const target = node;
    for (let i = 0; i < 139; i += 1) {
      const parent = new QaElement('div', {}, '', null);
      parent.childElements.push(node);
      node.parentElement = parent;
      node = parent;
    }
    const candidates = generateSelectorCandidates(target, LIMIT);
    expectLadderOrder(candidates);
    expect(candidates).toEqual([
      { kind: 'id', selector: '#deep-desc', unique: false },
      { kind: 'text', selector: 'text="Deep"', unique: false },
    ]);
    expect(candidates).toEqual(deriveCandidates(target, LIMIT));
  });

  it('a selector at the ceiling is kept; one past it is dropped cleanly (boundary, whole list)', () => {
    // The boundary is already pinned by fixtures; this asserts the LIMIT the
    // fixtures were computed against is the one the parser will accept.
    expect(LIMIT).toBe(CDP_PAYLOAD_LIMITS.selector);
    const built = buildFixture(FIXTURES.find((f) => f.name === 'ceiling-exact-kept')!.tree);
    const at = generateSelectorCandidates(built.byRef('target'), LIMIT);
    expect(at[0]!.selector.length).toBe(LIMIT);
    const over = buildFixture(FIXTURES.find((f) => f.name === 'ceiling-over-dropped')!.tree);
    expect(
      generateSelectorCandidates(over.byRef('target'), LIMIT).map((candidate) => candidate.kind),
    ).not.toContain('aria');
  });
});
