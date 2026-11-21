/**
 * M4-QA-01 — an in-memory DOM and a from-spec oracle, written independently
 * from `selector-dom-fakes.ts` (the M4-BE-03 suite's substrate).
 *
 * Two jobs:
 *
 * 1. A FAKE SUBSTRATE for the unit suite. Trees are built from the declarative
 *    fixtures in `m4-qa-01-fixtures.ts`; the matcher implements the CSS subset
 *    the generator emits (tags, `*`, `#id`, `[attr="…"]` with CSS escapes
 *    decoded, `tag:nth-of-type(k)`, ` > ` chains). A selector outside that
 *    subset throws — a silent no-match would make every clause vacuous.
 *
 * 2. AN ORACLE. `deriveCandidates` re-derives the whole ladder from the §6/M4
 *    spec (priority order, uniqueness per rung, ceiling drop) and is compared
 *    against the generator's own output. Because both run on the same
 *    substrate, the oracle is a drift/falsification guard, not independent
 *    ground truth — the real-Blink layer (`real-dom-verify.mts`) anchors that,
 *    and the hand pins in the fixtures anchor both.
 */

import type { CdpSelectorCandidate, CdpSelectorKind } from '../src/recordings/cdp-events.js';
import type { FixtureNode } from './m4-qa-01-fixtures.js';

/** Hostile behaviours a page can hand the generator (fake only). */
export type HostileFlag =
  | 'getAttribute'
  | 'getRootNode'
  | 'textContent'
  | 'childElementCount'
  | 'parentElement'
  | 'tagName'
  | 'children'
  | 'nonString';

export class QaRoot {
  readonly kind: 'document' | 'shadow';
  readonly elements: QaElement[] = [];

  constructor(kind: 'document' | 'shadow') {
    this.kind = kind;
  }

  querySelectorAll(selector: string): QaElement[] {
    return this.elements.filter((element) => matchesSelector(element, selector));
  }
}

export class QaElement {
  private readonly rawTag: string;
  private readonly attrs: Record<string, string>;
  private readonly ownText: string;
  private readonly hostileFlags: Set<HostileFlag>;
  private parentRef: QaElement | null = null;

  readonly ref: string | null;
  readonly childElements: QaElement[] = [];
  shadowRoot: QaRoot | null = null;
  rootPtr: QaRoot | null;

  constructor(
    tag: string,
    attrs: Record<string, string>,
    text: string,
    root: QaRoot | null,
    ref: string | null = null,
    hostile: readonly HostileFlag[] = [],
  ) {
    // Uppercase like a real HTML DOM; the generator is what lowercases.
    this.rawTag = tag.toUpperCase();
    this.attrs = attrs;
    this.ownText = text;
    this.rootPtr = root;
    this.ref = ref;
    this.hostileFlags = new Set(hostile);
  }

  private hostile(flag: HostileFlag): boolean {
    return this.hostileFlags.has(flag);
  }

  get tagName(): string {
    if (this.hostile('tagName')) throw new Error('hostile tagName');
    return this.rawTag;
  }

  get parentElement(): QaElement | null {
    if (this.hostile('parentElement')) throw new Error('hostile parentElement');
    return this.parentRef;
  }

  set parentElement(node: QaElement | null) {
    this.parentRef = node;
  }

  get children(): QaElement[] {
    if (this.hostile('children')) throw new Error('hostile children');
    return this.childElements;
  }

  get childElementCount(): number {
    if (this.hostile('childElementCount')) throw new Error('hostile childElementCount');
    return this.childElements.length;
  }

  get textContent(): string {
    if (this.hostile('textContent')) throw new Error('hostile textContent');
    return this.ownText + this.childElements.map((child) => child.textContent).join('');
  }

  getAttribute(name: string): string | number | null {
    if (this.hostile('getAttribute')) throw new Error('hostile getAttribute');
    if (this.hostile('nonString')) return 42;
    const value = this.attrs[name];
    return value === undefined ? null : value;
  }

  getRootNode(): QaRoot | null {
    if (this.hostile('getRootNode')) throw new Error('hostile getRootNode');
    return this.rootPtr;
  }
}

export interface BuiltFixture {
  readonly root: QaRoot;
  readonly all: QaElement[];
  byRef(ref: string): QaElement;
}

/** Build the fake document for a fixture tree; refs mark navigable elements. */
export function buildFixture(tree: FixtureNode): BuiltFixture {
  const root = new QaRoot('document');
  const all: QaElement[] = [];

  const build = (spec: FixtureNode, parent: QaElement | null, owner: QaRoot | null): QaElement => {
    const element = new QaElement(
      spec.tag,
      { ...(spec.attrs ?? {}) },
      spec.text ?? '',
      owner,
      spec.ref ?? null,
    );
    all.push(element);
    if (parent !== null) {
      element.parentElement = parent;
      parent.childElements.push(element);
    }
    if (owner !== null) owner.elements.push(element);
    if (spec.shadow !== undefined) {
      const shadow = new QaRoot('shadow');
      element.shadowRoot = shadow;
      for (const child of spec.shadow) build(child, null, shadow);
    }
    for (const child of spec.children ?? []) build(child, element, owner);
    return element;
  };

  build(tree, null, root);
  return {
    root,
    all,
    byRef: (ref: string): QaElement => {
      const found = all.find((element) => element.ref === ref);
      if (found === undefined) throw new Error(`fixture has no ref ${ref}`);
      return found;
    },
  };
}

// ── the matcher ─────────────────────────────────────────────────────────────

export function matchesSelector(element: QaElement, selector: string): boolean {
  const parts = selector.split(' > ');
  let node: QaElement | null = element;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (node === null || !compoundMatches(node, parts[i]!)) return false;
    if (i > 0) node = node.parentElement;
  }
  return true;
}

function compoundMatches(element: QaElement, compound: string): boolean {
  let rest = compound;
  let consumed = false;

  if (rest.startsWith('*')) {
    rest = rest.slice(1);
    consumed = true;
  } else {
    const tag = /^[A-Za-z][A-Za-z0-9-]*/.exec(rest);
    if (tag !== null) {
      if (element.tagName.toLowerCase() !== tag[0].toLowerCase()) return false;
      rest = rest.slice(tag[0].length);
      consumed = true;
    }
  }

  while (rest.length > 0) {
    if (rest.startsWith('#')) {
      const id = /^#([A-Za-z0-9_-]+)/.exec(rest);
      if (id === null) throw new Error(`qa01 matcher cannot parse: ${compound}`);
      if (element.getAttribute('id') !== id[1]) return false;
      rest = rest.slice(id[0].length);
      consumed = true;
      continue;
    }
    if (rest.startsWith('[')) {
      const open = /^\[([A-Za-z-]+)="/.exec(rest);
      if (open === null) throw new Error(`qa01 matcher cannot parse: ${compound}`);
      let at = open[0].length;
      let raw = '';
      let closed = false;
      while (at < rest.length) {
        const ch = rest[at]!;
        if (ch === '\\') {
          raw += ch + (rest[at + 1] ?? '');
          at += 2;
          continue;
        }
        if (ch === '"') {
          closed = true;
          at += 1;
          break;
        }
        raw += ch;
        at += 1;
      }
      if (!closed || rest[at] !== ']') throw new Error(`qa01 matcher cannot parse: ${compound}`);
      if (element.getAttribute(open[1]!) !== decodeCssString(raw)) return false;
      rest = rest.slice(at + 1);
      consumed = true;
      continue;
    }
    const nth = /^:nth-of-type\((\d+)\)/.exec(rest);
    if (nth !== null) {
      const parent = element.parentElement;
      if (parent === null) return false;
      let position = 0;
      let found = false;
      for (const sibling of parent.childElements) {
        if (sibling.tagName !== element.tagName) continue;
        position += 1;
        if (sibling === element) {
          found = true;
          break;
        }
      }
      if (!found || position !== Number(nth[1])) return false;
      rest = rest.slice(nth[0].length);
      consumed = true;
      continue;
    }
    throw new Error(`qa01 matcher cannot parse: ${compound}`);
  }
  if (!consumed) throw new Error(`qa01 matcher cannot parse: ${compound}`);
  return true;
}

/** `\X` → X; `\HH …` (1–6 hex digits, optional one terminating space) → codepoint. */
function decodeCssString(raw: string): string {
  let out = '';
  let at = 0;
  while (at < raw.length) {
    const ch = raw[at]!;
    if (ch !== '\\') {
      out += ch;
      at += 1;
      continue;
    }
    const next = raw[at + 1];
    if (next === undefined) throw new Error(`qa01 matcher cannot parse escape: ${raw}`);
    if (/[0-9a-fA-F]/.test(next)) {
      let hex = next;
      let cursor = at + 2;
      while (hex.length < 6 && cursor < raw.length && /[0-9a-fA-F]/.test(raw[cursor]!)) {
        hex += raw[cursor]!;
        cursor += 1;
      }
      if (raw[cursor] === ' ') cursor += 1;
      out += String.fromCodePoint(Number.parseInt(hex, 16));
      at = cursor;
      continue;
    }
    out += next;
    at += 2;
  }
  return out;
}

// ── the oracle ──────────────────────────────────────────────────────────────

const IDENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const SAFE_TAG = /^[a-z][a-z0-9-]*$/;

/**
 * Re-derive the ladder from the spec, reading the element the way a page
 * would: attribute reads, an own-root `querySelectorAll`, sibling positions.
 * Mirrors §6/M4's rules — priority order, uniqueness = exactly-one-match in
 * the element's own root, ceiling drops whole, text only for leaves.
 */
export function deriveCandidates(element: unknown, limit: number): CdpSelectorCandidate[] {
  const out: CdpSelectorCandidate[] = [];
  if (typeof element !== 'object' || element === null) return out;
  const ceiling = Number.isFinite(limit) && limit > 0 ? limit : 0;

  const property = (node: unknown, key: string): unknown => {
    try {
      return typeof node === 'object' && node !== null
        ? (node as Record<string, unknown>)[key]
        : undefined;
    } catch {
      return undefined;
    }
  };

  const attribute = (name: string): string | null => {
    try {
      const read = property(element, 'getAttribute');
      if (typeof read !== 'function') return null;
      const value = (element as { getAttribute(name: string): unknown }).getAttribute(name);
      return typeof value === 'string' && value.length > 0 ? value : null;
    } catch {
      return null;
    }
  };

  const root = ((): { querySelectorAll(selector: string): ArrayLike<unknown> } | null => {
    try {
      const read = property(element, 'getRootNode');
      if (typeof read !== 'function') return null;
      const node = (element as { getRootNode(): unknown }).getRootNode();
      if (typeof node !== 'object' || node === null) return null;
      const query = (node as { querySelectorAll?: unknown }).querySelectorAll;
      return typeof query === 'function'
        ? (node as { querySelectorAll(selector: string): ArrayLike<unknown> })
        : null;
    } catch {
      return null;
    }
  })();

  const once = (selector: string): boolean => {
    if (root === null) return false;
    try {
      const hits = root.querySelectorAll(selector);
      return hits.length === 1 && hits[0] === element;
    } catch {
      return false;
    }
  };

  const quote = (value: string): string => {
    let text = '';
    for (const ch of value) {
      if (ch === '\\') text += '\\\\';
      else if (ch === '"') text += '\\"';
      else {
        const code = ch.codePointAt(0) ?? 0;
        text += code < 0x20 || code === 0x7f ? '\\' + code.toString(16) + ' ' : ch;
      }
    }
    return text;
  };

  const keep = (kind: CdpSelectorKind, selector: string, unique: boolean): void => {
    if (selector.length === 0 || selector.length > ceiling) return;
    out.push({ kind, selector, unique });
  };

  const testid = attribute('data-testid');
  if (testid !== null) {
    const selector = '[data-testid="' + quote(testid) + '"]';
    keep('testid', selector, once(selector));
  }

  const id = attribute('id');
  if (id !== null) {
    const selector = IDENT.test(id) ? '#' + id : '[id="' + quote(id) + '"]';
    keep('id', selector, once(selector));
  }

  const label = attribute('aria-label');
  if (label !== null) {
    const role = attribute('role');
    const selector =
      role !== null
        ? '[role="' + quote(role) + '"][aria-label="' + quote(label) + '"]'
        : '[aria-label="' + quote(label) + '"]';
    keep('aria', selector, once(selector));
  }

  const segmentOf = (node: unknown): string | null => {
    const rawTag = property(node, 'tagName');
    if (typeof rawTag !== 'string' || rawTag.length === 0) return null;
    const tag = rawTag.toLowerCase();
    const safe = SAFE_TAG.test(tag) ? tag : '*';
    const parent = property(node, 'parentElement');
    if (typeof parent !== 'object' || parent === null) return safe;
    const siblings = property(parent, 'children');
    if (typeof siblings !== 'object' || siblings === null) return safe;
    const list = siblings as ArrayLike<unknown>;
    let sameTag = 0;
    let position = 0;
    for (let i = 0; i < list.length; i += 1) {
      const sibling = list[i];
      if (typeof sibling !== 'object' || sibling === null) continue;
      const siblingTag = property(sibling, 'tagName');
      if (typeof siblingTag !== 'string' || siblingTag.toLowerCase() !== tag) continue;
      sameTag += 1;
      if (sibling === node) position = sameTag;
    }
    return sameTag > 1 && position > 0 ? safe + ':nth-of-type(' + position + ')' : safe;
  };

  const css = ((): { selector: string; unique: boolean } | null => {
    const parts: string[] = [];
    let node: unknown = element;
    for (let depth = 0; depth <= 128; depth += 1) {
      if (depth === 128) return null;
      const segment = segmentOf(node);
      if (segment === null) return null;
      parts.unshift(segment);
      const candidate = parts.join(' > ');
      if (candidate.length > ceiling) return null;
      if (once(candidate)) return { selector: candidate, unique: true };
      const parent = property(node, 'parentElement');
      if (parent === null || parent === undefined) break;
      if (typeof parent !== 'object') return null;
      node = parent;
    }
    if (parts.length === 0) return null;
    const full = parts.join(' > ');
    if (full.length > ceiling) return null;
    return { selector: full, unique: false };
  })();
  if (css !== null) keep('css', css.selector, css.unique);

  if (property(element, 'childElementCount') === 0) {
    const raw = property(element, 'textContent');
    const collapsed = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
    if (collapsed.length > 0) {
      const selector = 'text="' + quote(collapsed) + '"';
      const needle = collapsed.toLowerCase();
      const textUnique = ((): boolean => {
        if (root === null) return false;
        try {
          const all = root.querySelectorAll('*');
          let seen = 0;
          let hit: unknown = null;
          for (let i = 0; i < all.length; i += 1) {
            const node = all[i];
            if (property(node, 'childElementCount') !== 0) continue;
            const otherRaw = property(node, 'textContent');
            const other = typeof otherRaw === 'string' ? otherRaw.replace(/\s+/g, ' ').trim() : '';
            if (other.length === 0 || other.toLowerCase() !== needle) continue;
            seen += 1;
            if (seen > 1) return false;
            hit = node;
          }
          return seen === 1 && hit === element;
        } catch {
          return false;
        }
      })();
      keep('text', selector, textUnique);
    }
  }

  return out;
}
