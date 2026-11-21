/**
 * An in-memory DOM for the selector generator's suites (M4-BE-03).
 *
 * The generator reads a live document — attributes, ancestors, sibling
 * positions, a root whose `querySelectorAll` answers "how many elements match
 * this" — and none of that exists in Node. So this module is the smallest
 * thing that has all of it: a node graph and a matcher for the CSS subset the
 * generator emits (tag names, `*`, `#id`, `[name="value"]` with escaped
 * strings decoded, `tag:nth-of-type(k)`, and ` > ` child combinators).
 *
 * The matcher is the point. A stand-in that echoes an expected selector back
 * as "unique, yes" would make every test vacuously green — the claims under
 * test ARE the uniqueness counts, so the counts are computed from the tree.
 * A selector outside the subset throws rather than quietly matching nothing:
 * if the generator ever emits something this cannot parse, the suite fails
 * loudly instead of reading it as "no match".
 */

export interface FakeNodeSpec {
  readonly tag: string;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly text?: string;
  readonly children?: readonly FakeNodeSpec[];
}

/** The root a node belongs to: a document, or a shadow root's subtree. */
export class FakeRoot {
  readonly kind: 'document' | 'shadow';
  readonly elements: FakeElement[] = [];

  /**
   * The root a node belongs to: a document, or a shadow root's subtree.
   * `nodeType` is the DOM's own discriminator between the two (9 vs 11) —
   * the generator reads it to mark shadow-scoped rungs (M4-BE-06 fix wave).
   */
  readonly nodeType: number;

  constructor(kind: 'document' | 'shadow') {
    this.kind = kind;
    this.nodeType = kind === 'document' ? 9 : 11;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.elements.filter((element) => matches(element, selector));
  }
}

export class FakeElement {
  readonly tagName: string;
  readonly attributes: Readonly<Record<string, string>>;
  /**
   * Mutable, unlike the DOM's: the only way to build a parent chain that is
   * NOT a tree — the shape the generator's walk-bound exists for — is for a
   * test to wire one up after construction.
   */
  parentElement: FakeElement | null;
  readonly childElements: FakeElement[] = [];
  readonly ownText: string;
  private readonly root: FakeRoot;

  constructor(
    tag: string,
    attrs: Readonly<Record<string, string>>,
    text: string,
    parent: FakeElement | null,
    root: FakeRoot,
  ) {
    // Uppercase, like a real HTML DOM: the generator is what lowercases.
    this.tagName = tag.toUpperCase();
    this.attributes = attrs;
    this.ownText = text;
    this.parentElement = parent;
    this.root = root;
    root.elements.push(this);
  }

  get children(): FakeElement[] {
    return this.childElements;
  }

  get childElementCount(): number {
    return this.childElements.length;
  }

  get textContent(): string {
    return this.ownText + this.childElements.map((child) => child.textContent).join('');
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  getRootNode(): FakeRoot {
    return this.root;
  }
}

/** Build a document from one spec tree. */
export function fakeDocument(spec: FakeNodeSpec): FakeRoot {
  const root = new FakeRoot('document');
  build(spec, null, root);
  return root;
}

/**
 * Attach a shadow subtree to `host`, whose elements belong to a shadow root
 * rather than to the document — the two scopes `querySelectorAll` keeps apart.
 */
export function attachShadow(host: FakeElement, children: readonly FakeNodeSpec[]): FakeRoot {
  const shadow = new FakeRoot('shadow');
  for (const child of children) build(child, null, shadow);
  return shadow;
}

/** Find one element by attribute, failing the test rather than returning null. */
export function findByAttr(root: FakeRoot, name: string, value: string): FakeElement {
  const found = root.elements.filter((element) => element.getAttribute(name) === value);
  if (found.length === 0) throw new Error(`no element with ${name}="${value}"`);
  return found[0]!;
}

function build(spec: FakeNodeSpec, parent: FakeElement | null, root: FakeRoot): FakeElement {
  const element = new FakeElement(spec.tag, spec.attrs ?? {}, spec.text ?? '', parent, root);
  if (parent !== null) parent.childElements.push(element);
  for (const child of spec.children ?? []) build(child, element, root);
  return element;
}

// ── the matcher ─────────────────────────────────────────────────────────────

function matches(element: FakeElement, selector: string): boolean {
  const chain = selector.trim().split(' > ');
  const target = chain[chain.length - 1];
  if (target === undefined || !matchesCompound(element, target)) return false;
  let node: FakeElement | null = element;
  for (let i = chain.length - 2; i >= 0; i -= 1) {
    node = node.parentElement;
    if (node === null || !matchesCompound(node, chain[i]!)) return false;
  }
  return true;
}

/** One compound: an optional tag (or `*`), then `#id`, `[attr="v"]` or `:nth-of-type(k)`. */
function matchesCompound(element: FakeElement, compound: string): boolean {
  let rest = compound;
  let consumed = false;
  if (rest.startsWith('*')) {
    rest = rest.slice(1);
    consumed = true;
  } else {
    const tag = /^[a-z][a-z0-9-]*/.exec(rest);
    if (tag !== null) {
      if (element.tagName.toLowerCase() !== tag[0]) return false;
      rest = rest.slice(tag[0].length);
      consumed = true;
    }
  }

  while (rest.length > 0) {
    if (rest.startsWith('#')) {
      const id = /^#([A-Za-z0-9_-]+)/.exec(rest);
      if (id === null) throw new Error(`fake DOM cannot parse segment: ${compound}`);
      if (element.getAttribute('id') !== id[1]) return false;
      rest = rest.slice(id[0].length);
      consumed = true;
      continue;
    }
    if (rest.startsWith('[')) {
      const attribute = /^\[([a-z-]+)="/.exec(rest);
      if (attribute === null) throw new Error(`fake DOM cannot parse segment: ${compound}`);
      let at = attribute[0].length;
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
      if (!closed || rest[at] !== ']')
        throw new Error(`fake DOM cannot parse segment: ${compound}`);
      if (element.getAttribute(attribute[1]!) !== decodeCssString(raw)) return false;
      rest = rest.slice(at + 1);
      consumed = true;
      continue;
    }
    const nth = /^:nth-of-type\((\d+)\)/.exec(rest);
    if (nth !== null) {
      const parent = element.parentElement;
      if (parent === null) return false;
      let position = 0;
      for (const sibling of parent.childElements) {
        if (sibling.tagName !== element.tagName) continue;
        position += 1;
        if (sibling === element) break;
      }
      if (position !== Number(nth[1])) return false;
      rest = rest.slice(nth[0].length);
      consumed = true;
      continue;
    }
    throw new Error(`fake DOM cannot parse segment: ${compound}`);
  }
  if (!consumed) throw new Error(`fake DOM cannot parse segment: ${compound}`);
  return true;
}

/**
 * The escapes the generator writes, decoded the way a CSS parser would:
 * `\X` is the character itself, `\HH ` is codepoint HH (the trailing space is
 * a terminator).
 */
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
    if (next === undefined) throw new Error(`fake DOM cannot parse escape in: ${raw}`);
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
