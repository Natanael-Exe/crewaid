/**
 * M4-QA-01 — the fixture matrix the selector generator's verification runs on.
 *
 * Authored independently from `cdp-selectors.test.ts`'s fakes (M4-BE-03): every
 * fixture here is a DECLARATIVE TREE that two substrates render — a real
 * Chromium page (Blink's own `querySelectorAll`) in `real-dom-verify.mts`, and
 * an in-memory DOM (`m4-qa-01-fixture-dom.ts`) in the unit suite. Both must
 * agree with the hand-pinned expectations below and with the from-spec oracle,
 * so a wrong assumption in any one layer is caught by the others.
 *
 * Hand pins are the ladder's output exactly as §6/M4 defines it: rungs in
 * priority order (`data-testid` → `id` → `aria-label` + role → unique CSS path
 * → text), each with the uniqueness fact the generator must report, every
 * rung kept (non-unique included). `pin` is absent only where the oracle
 * derivation is the intended check (the deep-ceiling case, whose would-be
 * selector is too long to state compactly).
 */

import {
  CDP_PAYLOAD_LIMITS,
  type CdpSelectorCandidate,
  type CdpSelectorKind,
} from '../src/recordings/cdp-events.js';

/** One node of a fixture tree. `ref` marks an element the harness navigates to. */
export interface FixtureNode {
  readonly tag: string;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly text?: string;
  readonly ref?: string;
  readonly children?: readonly FixtureNode[];
  /** Attached as this element's (open) shadow root. */
  readonly shadow?: readonly FixtureNode[];
}

export interface QaFixture {
  readonly name: string;
  /** What this fixture pins, one line. */
  readonly why: string;
  readonly tree: FixtureNode;
  /** `ref` of the element the generator runs on. */
  readonly target: string;
  /** When set, the target lives in this host-ref's shadow root. */
  readonly targetInShadow?: string;
  /** Fake DOM only (hostile stand-ins a real page cannot produce). */
  readonly fakeOnly?: boolean;
  /** Hand-pinned ladder; absent = oracle derivation is the check. */
  readonly pin?: readonly CdpSelectorCandidate[];
  /** Kinds-only pin, for cases where the selectors are oracle-derived. */
  readonly pinKinds?: readonly CdpSelectorKind[];
  /** Skip the playwright winner-resolution check (DOM piercing, shadow case). */
  readonly skipPwResolve?: boolean;
}

export const LIMIT = CDP_PAYLOAD_LIMITS.selector;

export function node(
  tag: string,
  attrs?: Readonly<Record<string, string>>,
  text?: string,
  extra?: Partial<Pick<FixtureNode, 'ref' | 'children' | 'shadow'>>,
): FixtureNode {
  return {
    tag,
    ...(attrs === undefined ? {} : { attrs }),
    ...(text === undefined ? {} : { text }),
    ...extra,
  };
}

/** `n` nested elements of one tag chain, the leaf last. */
export function nested(tag: string, n: number, leaf: FixtureNode): FixtureNode {
  let current = leaf;
  for (let i = 0; i < n; i += 1) current = node(tag, undefined, undefined, { children: [current] });
  return current;
}

function body(children: readonly FixtureNode[]): FixtureNode {
  return node('html', undefined, undefined, {
    children: [node('body', undefined, undefined, { children })],
  });
}

/** Something no CSS identifier can start with. */
const FRAMEWORK_ID = ':r0:';

/** A label at exactly (LIMIT - the fixed wrapper) so the selector lands on LIMIT. */
const ARIA_WRAPPER_LEN = '[aria-label=""]'.length;
export const AT_LIMIT_LABEL = 'a'.repeat(LIMIT - ARIA_WRAPPER_LEN);
export const OVER_LIMIT_LABEL = 'a'.repeat(LIMIT - ARIA_WRAPPER_LEN + 1);

/** The html/body-only wrapper every fixture shares. */
export function wrap(children: readonly FixtureNode[]): FixtureNode {
  return body(children);
}

export const FIXTURES: readonly QaFixture[] = [
  {
    name: 'all-rungs-unique',
    why: 'a clean element reports all five rungs in priority order; the top rung is chosen',
    tree: wrap([
      node(
        'button',
        { 'data-testid': 'primary action', id: 'go-btn', role: 'button', 'aria-label': 'Go now' },
        'Go',
        { ref: 'target' },
      ),
    ]),
    target: 'target',
    pin: [
      { kind: 'testid', selector: '[data-testid="primary action"]', unique: true },
      { kind: 'id', selector: '#go-btn', unique: true },
      { kind: 'aria', selector: '[role="button"][aria-label="Go now"]', unique: true },
      { kind: 'css', selector: 'button', unique: true },
      { kind: 'text', selector: 'text="Go"', unique: true },
    ],
  },
  {
    name: 'shared-top-rungs-aria-wins',
    why: 'a duplicated testid and id are kept+flagged, and the winner skips to the first unique rung (aria)',
    tree: wrap([
      node(
        'button',
        { 'data-testid': 'row', id: 'dup', role: 'button', 'aria-label': 'First row action' },
        'Alpha',
        { ref: 'target' },
      ),
      node('button', { 'data-testid': 'row', id: 'dup' }, 'Beta'),
    ]),
    target: 'target',
    pin: [
      { kind: 'testid', selector: '[data-testid="row"]', unique: false },
      { kind: 'id', selector: '#dup', unique: false },
      { kind: 'aria', selector: '[role="button"][aria-label="First row action"]', unique: true },
      { kind: 'css', selector: 'button:nth-of-type(1)', unique: true },
      { kind: 'text', selector: 'text="Alpha"', unique: true },
    ],
  },
  {
    name: 'shared-top-rungs-css-nth',
    why: 'the same shared top rungs without an aria label pick the nth-of-type CSS rung',
    tree: wrap([
      node('button', { 'data-testid': 'row', id: 'dup' }, 'Alpha'),
      node('button', { 'data-testid': 'row', id: 'dup' }, 'Beta', { ref: 'target' }),
    ]),
    target: 'target',
    pin: [
      { kind: 'testid', selector: '[data-testid="row"]', unique: false },
      { kind: 'id', selector: '#dup', unique: false },
      { kind: 'css', selector: 'button:nth-of-type(2)', unique: true },
      { kind: 'text', selector: 'text="Beta"', unique: true },
    ],
  },
  {
    name: 'aria-pair-beats-shared-label',
    why: 'role+label together name one element where the label alone names two',
    tree: wrap([
      node('button', { role: 'button', 'aria-label': 'Close' }, 'x', { ref: 'target' }),
      node('div', { role: 'dialog', 'aria-label': 'Close' }, 'y'),
    ]),
    target: 'target',
    pin: [
      { kind: 'aria', selector: '[role="button"][aria-label="Close"]', unique: true },
      { kind: 'css', selector: 'button', unique: true },
      { kind: 'text', selector: 'text="x"', unique: true },
    ],
  },
  {
    name: 'aria-label-without-role',
    why: 'a label with no role collapses to the label-only form',
    tree: wrap([node('span', { 'aria-label': 'Status badge' }, 'OK', { ref: 'target' })]),
    target: 'target',
    pin: [
      { kind: 'aria', selector: '[aria-label="Status badge"]', unique: true },
      { kind: 'css', selector: 'span', unique: true },
      { kind: 'text', selector: 'text="OK"', unique: true },
    ],
  },
  {
    name: 'role-without-label',
    why: 'a role with no label names every element of that role and is not a rung',
    tree: wrap([node('div', { role: 'dialog' }, 'Are you sure?', { ref: 'target' })]),
    target: 'target',
    pin: [
      { kind: 'css', selector: 'div', unique: true },
      { kind: 'text', selector: 'text="Are you sure?"', unique: true },
    ],
  },
  {
    name: 'css-nth-own-level',
    why: 'same-tag siblings are disambiguated by :nth-of-type on the element itself',
    tree: wrap([
      node('div', undefined, undefined, {
        children: [
          node('span', undefined, 'One'),
          node('span', undefined, 'Two', { ref: 'target' }),
        ],
      }),
    ]),
    target: 'target',
    pin: [
      { kind: 'css', selector: 'span:nth-of-type(2)', unique: true },
      { kind: 'text', selector: 'text="Two"', unique: true },
    ],
  },
  {
    name: 'css-grow-nth-only-where-needed',
    why: 'the path grows one level at a time; :nth-of-type lands only on the branching level',
    tree: wrap([
      node('div', undefined, undefined, {
        children: [
          node('div', undefined, undefined, { children: [node('button', undefined, 'First')] }),
        ],
      }),
      node('div', undefined, undefined, {
        children: [
          node('div', undefined, undefined, {
            children: [node('button', undefined, 'Second', { ref: 'target' })],
          }),
        ],
      }),
    ]),
    target: 'target',
    pin: [
      { kind: 'css', selector: 'div:nth-of-type(2) > div > button', unique: true },
      { kind: 'text', selector: 'text="Second"', unique: true },
    ],
  },
  {
    name: 'id-framework-shape',
    why: 'an id no CSS identifier can express takes the attribute form',
    tree: wrap([node('input', { id: FRAMEWORK_ID }, undefined, { ref: 'target' })]),
    target: 'target',
    pin: [
      { kind: 'id', selector: '[id=":r0:"]', unique: true },
      { kind: 'css', selector: 'input', unique: true },
    ],
  },
  {
    name: 'id-leading-digit',
    why: 'an id starting with a digit also goes to the attribute form',
    tree: wrap([node('div', { id: '1st-panel' }, 'Panel', { ref: 'target' })]),
    target: 'target',
    pin: [
      { kind: 'id', selector: '[id="1st-panel"]', unique: true },
      { kind: 'css', selector: 'div', unique: true },
      { kind: 'text', selector: 'text="Panel"', unique: true },
    ],
  },
  {
    name: 'id-escapes',
    why: 'quotes, backslashes and control characters are escaped so a CSS parser still reads the id',
    tree: wrap([node('div', { id: 'a b"c\\d\t' }, 'esc', { ref: 'target' })]),
    target: 'target',
    pin: [
      { kind: 'id', selector: '[id="a b\\"c\\\\d\\9 "]', unique: true },
      { kind: 'css', selector: 'div', unique: true },
      { kind: 'text', selector: 'text="esc"', unique: true },
    ],
  },
  {
    name: 'text-collapsed',
    why: 'the text rung records collapsed whitespace',
    tree: wrap([node('button', undefined, '  Pay\n   now  ', { ref: 'target' })]),
    target: 'target',
    pin: [
      { kind: 'css', selector: 'button', unique: true },
      { kind: 'text', selector: 'text="Pay now"', unique: true },
    ],
  },
  {
    name: 'text-twin-case-space',
    why: 'a case/whitespace twin makes the text rung shared (kept, flagged)',
    tree: wrap([
      node('button', undefined, 'Pay now', { ref: 'target' }),
      node('button', undefined, 'PAY  NOW'),
    ]),
    target: 'target',
    pin: [
      { kind: 'css', selector: 'button:nth-of-type(1)', unique: true },
      { kind: 'text', selector: 'text="Pay now"', unique: false },
    ],
  },
  {
    name: 'text-container-no-rung',
    why: 'a container has no text rung — its textContent names everything inside it',
    tree: wrap([
      node('div', undefined, undefined, {
        children: [node('span', undefined, 'inner')],
        ref: 'target',
      }),
    ]),
    target: 'target',
    pin: [{ kind: 'css', selector: 'div', unique: true }],
  },
  {
    name: 'empty-leaf-no-text-rung',
    why: 'a leaf with no text has no text rung',
    tree: wrap([node('button', undefined, undefined, { ref: 'target' })]),
    target: 'target',
    pin: [{ kind: 'css', selector: 'button', unique: true }],
  },
  {
    name: 'shadow-scope',
    why: 'uniqueness is checked in the element’s own root — a document twin of the shadow id is not seen',
    tree: wrap([
      node('div', { id: 'host' }, undefined, {
        ref: 'host',
        shadow: [node('button', { id: 'x' }, 'In shadow', { ref: 'target' })],
      }),
      node('span', { id: 'x' }, 'doc twin'),
    ]),
    target: 'target',
    targetInShadow: 'host',
    skipPwResolve: true,
    pin: [
      { kind: 'id', selector: '#x', unique: true },
      { kind: 'css', selector: 'button', unique: true },
      { kind: 'text', selector: 'text="In shadow"', unique: true },
    ],
  },
  {
    name: 'ceiling-exact-kept',
    why: 'a selector exactly at the ceiling is kept',
    tree: wrap([node('button', { 'aria-label': AT_LIMIT_LABEL }, 'ok', { ref: 'target' })]),
    target: 'target',
    pin: [
      { kind: 'aria', selector: '[aria-label="' + AT_LIMIT_LABEL + '"]', unique: true },
      { kind: 'css', selector: 'button', unique: true },
      { kind: 'text', selector: 'text="ok"', unique: true },
    ],
  },
  {
    name: 'ceiling-over-dropped',
    why: 'a selector one past the ceiling is dropped whole — the other rungs survive',
    tree: wrap([
      node('button', { id: 'keep', 'aria-label': OVER_LIMIT_LABEL }, 'axe', { ref: 'target' }),
    ]),
    target: 'target',
    pin: [
      { kind: 'id', selector: '#keep', unique: true },
      { kind: 'css', selector: 'button', unique: true },
      { kind: 'text', selector: 'text="axe"', unique: true },
    ],
  },
  {
    name: 'ceiling-css-path-dropped',
    why: 'a CSS path that outgrows the ceiling mid-walk is dropped, never truncated',
    tree: wrap([
      nested('section', 30, node('span', undefined, 'Head')),
      nested('section', 30, node('span', undefined, 'Tail', { ref: 'target' })),
    ]),
    target: 'target',
    pinKinds: ['text'],
  },
  {
    name: 'detached-element-flagged',
    why: 'with no root to query, every rung is reported unverified — never guessed unique',
    tree: node('div'), // unused; the fake test builds this stand-in directly
    target: 'target',
    fakeOnly: true,
    pin: [
      { kind: 'testid', selector: '[data-testid="go"]', unique: false },
      { kind: 'id', selector: '#go', unique: false },
      { kind: 'css', selector: 'button', unique: false },
      { kind: 'text', selector: 'text="Go"', unique: false },
    ],
  },
  {
    name: 'hostile-attribute-throws',
    why: 'a throwing getAttribute costs the three attribute rungs only — css/text still verify',
    tree: node('div'),
    target: 'target',
    fakeOnly: true,
    pin: [
      { kind: 'css', selector: 'button', unique: true },
      { kind: 'text', selector: 'text="Go"', unique: true },
    ],
  },
  {
    name: 'hostile-text-throws',
    why: 'a throwing textContent costs the text rung only',
    tree: node('div'),
    target: 'target',
    fakeOnly: true,
    pin: [
      { kind: 'id', selector: '#go', unique: true },
      { kind: 'css', selector: 'button', unique: true },
    ],
  },
  {
    name: 'hostile-root-throws',
    why: 'a throwing getRootNode cannot verify anything — all present rungs are flagged, none throws',
    tree: node('div'),
    target: 'target',
    fakeOnly: true,
    pin: [
      { kind: 'id', selector: '#go', unique: false },
      { kind: 'css', selector: 'button', unique: false },
      { kind: 'text', selector: 'text="Go"', unique: false },
    ],
  },
  {
    name: 'non-string-attributes',
    why: 'a non-string attribute value is no rung (absence must degrade, never throw)',
    tree: node('div'),
    target: 'target',
    fakeOnly: true,
    pin: [
      { kind: 'css', selector: 'button', unique: true },
      { kind: 'text', selector: 'text="Go"', unique: true },
    ],
  },
  {
    name: 'wildcard-tag',
    why: 'a tag that is no CSS identifier falls back to * in the path',
    tree: node('div'),
    target: 'target',
    fakeOnly: true,
    pin: [
      { kind: 'css', selector: '*', unique: true },
      { kind: 'text', selector: 'text="X"', unique: true },
    ],
  },
];
