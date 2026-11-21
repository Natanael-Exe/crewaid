/**
 * The selector generator.
 *
 * What one interaction leaves behind
 *
 * §6/M4 fixes the ladder: `data-testid` → `id` → `aria-label` + role → unique
 * CSS path → text match — and "record all candidates, not only the winner".
 * The candidates exist because a selector is a bet on a page that will have
 * changed by replay time: an id that was unique during the recording can be
 * duplicated after one more render, a testid survives a redesign that a CSS
 * path does not. Whoever resolves a step later (the compiler emits one of
 * these; a replay can fall to the next when the first stops matching) needs
 * the whole ladder, so the report keeps every rung — the winner included, in
 * priority order, each with the one fact that decided it: whether it matched
 * EXACTLY ONE element at the moment of the interaction.
 *
 * Why it runs in the page, beside the capture script
 *
 * Uniqueness is a fact about the LIVE document, and the element node only
 * exists while that document does — a click that navigates destroys the
 * document the selector was supposed to describe, one millisecond after it
 * happens. There is no later moment at which the orchestrator could ask.
 * So this function is a second self-contained artifact that the capture
 * script carries into the page and runs per interaction, and the candidates
 * travel in the same report as the facts (see `cdp-capture-script.ts` for
 * how the two functions are composed into one injected source).
 *
 * The scope of a uniqueness check is the element's OWN ROOT — the document
 * for ordinary content, the shadow root for shadow content: `querySelectorAll`
 * does not see across a shadow boundary, so a selector generated inside one
 * is checked and reported against the tree it can actually be resolved in.
 *
 * A rung generated in a shadow root carries `shadow: true` (M4-BE-06 fix
 * wave): the selector was checked against the tree it can be resolved in,
 * but the replayer's resolver is a document-level query — it can never cross
 * that boundary, and the same text against the light DOM may name a
 * different element. The flag is what lets the compile fence set the rung
 * aside; the recording still keeps it, because the ladder is a fact about
 * the page rather than a promise about replay.
 *
 * The discipline this file shares with the capture script
 *
 * `generateSelectorCandidates` is serialized via `toString()` and evaluated
 * in a page — CC-06 forbids `eval` here, which is exactly why the source is
 * composed rather than evaluated. So its body may reference only its own
 * parameters, its own inner functions and browser built-ins: never a
 * module-scope name, never anything from `cdp-events.ts`. A unit test pins
 * that the serialized body carries no module identifier, the same fence the
 * capture script's own source gets.
 *
 * The ladder's shape (`CDP_SELECTOR_KINDS`) and the selector ceiling
 * (`CDP_PAYLOAD_LIMITS.selector`) live in the parser's module — one source
 * for what this emits and what the orchestrator will accept — but the body
 * cannot read them, so it spells them inline and a test pins the two together
 * so a rename on either side cannot drift them apart.
 */

import type { CdpSelectorCandidate } from './cdp-events.js';

/**
 * An element, as much of one as the generator reads.
 *
 * Structural on purpose, like the capture script's own interfaces: the unit
 * suite substitutes an in-memory DOM for the live document, and the page
 * passes the real one. Every member is optional because a hostile or exotic
 * page may lack any of them, and absence must degrade, never throw.
 */
export interface SelectorTarget {
  readonly tagName?: unknown;
  readonly childElementCount?: unknown;
  readonly textContent?: unknown;
  readonly parentElement?: unknown;
  readonly children?: unknown;
  getAttribute?(name: string): unknown;
  getRootNode?(): unknown;
}

/**
 * The selector ladder, one candidate per rung that can be built.
 *
 * Never throws and never returns a selector longer than the ceiling it was
 * given: a selector past the ceiling is DROPPED, not truncated — a truncated
 * selector is not a shorter way to say the same thing, it is a different
 * selector that may well resolve, to the wrong element. A candidate that
 * cannot be built (no attribute, no text, no usable tag) is simply absent.
 *
 * `unique` means "matched exactly one element in the element's own root when
 * this ran". It is a fact about one instant, not a promise — the same
 * selector can match twice two seconds later — and a non-unique candidate is
 * still kept: "this id exists but every copy of it shares the name" is
 * information a later reader can use, where an absent candidate says nothing.
 */
export function generateSelectorCandidates(
  element: unknown,
  limit: number,
): readonly CdpSelectorCandidate[] {
  const candidates: CdpSelectorCandidate[] = [];
  if (typeof element !== 'object' || element === null) return candidates;
  // A caller that agreed no ceiling gets no generation: every selector below
  // is longer than zero, so a nonsense ceiling degrades to an empty list
  // rather than to an unbounded one.
  const ceiling = typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? limit : 0;
  const el = element as SelectorTarget;

  /**
   * Read one property without betting that its getter behaves.
   *
   * A page can define a throwing getter for anything an element exposes, and
   * this function's contract is that nothing it touches can throw — a
   * recorder that breaks the page it records is worse than no recorder. Every
   * structural read goes through here, so a hostile property costs its own
   * rung and nothing else.
   */
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
      if (typeof el.getAttribute !== 'function') return null;
      const value = el.getAttribute(name);
      return typeof value === 'string' && value.length > 0 ? value : null;
    } catch {
      return null;
    }
  };

  /** The node `getRootNode` answered — the document or a shadow root — or null. */
  const rootNode = ((): unknown => {
    try {
      return typeof el.getRootNode === 'function' ? el.getRootNode() : null;
    } catch {
      return null;
    }
  })();

  const root = ((): { querySelectorAll(selector: string): ArrayLike<unknown> } | null => {
    if (typeof rootNode !== 'object' || rootNode === null) return null;
    const query = (rootNode as { querySelectorAll?: unknown }).querySelectorAll;
    return typeof query === 'function'
      ? (rootNode as { querySelectorAll(selector: string): ArrayLike<unknown> })
      : null;
  })();

  /**
   * Whether this element lives in a shadow tree rather than the document —
   * the one fact that says its rungs cannot cross back: `getRootNode` then
   * answers a shadow root (nodeType 11) instead of the document (nodeType
   * 9), and a document-level query can never see past that boundary. Every
   * rung built below carries the flag, so the compile fence can set them
   * aside before a step is emitted from one — the same selector text run
   * against the light DOM can match a DIFFERENT element, which is the
   * silent wrong-click a dropped rung prevents. Read defensively: a root
   * without a numeric nodeType (a stand-in in a test, an exotic embedding)
   * flags nothing.
   */
  const shadowScoped = ((): boolean => {
    const nodeType = property(rootNode, 'nodeType');
    return typeof nodeType === 'number' && nodeType !== 9;
  })();

  /** Whether `selector` matches exactly this element and nothing else, here. */
  const matchesOnce = (selector: string): boolean => {
    if (root === null) return false;
    try {
      const found = root.querySelectorAll(selector);
      return found.length === 1 && found[0] === element;
    } catch {
      return false;
    }
  };

  /** Whitespace-collapsed text, or null when there is none to match on. */
  const collapsed = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.replace(/\s+/g, ' ').trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  /**
   * One CSS string literal's contents for a double-quoted context.
   *
   * Control characters become hex escapes (`\a `); a literal newline cannot
   * live inside a CSS string at all, and a raw quote or backslash would end
   * the value early and leave the remainder of the selector parsed as
   * something else entirely.
   */
  const quoted = (value: string): string => {
    let out = '';
    for (const ch of value) {
      if (ch === '\\') out += '\\\\';
      else if (ch === '"') out += '\\"';
      else {
        const code = ch.codePointAt(0) ?? 0;
        out += code < 0x20 || code === 0x7f ? '\\' + code.toString(16) + ' ' : ch;
      }
    }
    return out;
  };

  /** `#id` where an id is an identifier, the attribute form where it is not. */
  const idSelector = (id: string): string =>
    /^[A-Za-z_][A-Za-z0-9_-]*$/.test(id) ? '#' + id : '[id="' + quoted(id) + '"]';

  /** Keep one rung of the ladder — unless its selector cannot be trusted. */
  const keep = (
    kind: 'testid' | 'id' | 'aria' | 'css' | 'text',
    selector: string,
    unique: boolean,
  ): void => {
    if (selector.length === 0 || selector.length > ceiling) return;
    candidates.push(
      shadowScoped ? { kind, selector, unique, shadow: true } : { kind, selector, unique },
    );
  };

  // 1. data-testid
  const testid = attribute('data-testid');
  if (testid !== null) {
    const selector = '[data-testid="' + quoted(testid) + '"]';
    keep('testid', selector, matchesOnce(selector));
  }

  // 2. id — kept though a document may repeat it (that is what `unique` says)
  const id = attribute('id');
  if (id !== null) {
    const selector = idSelector(id);
    keep('id', selector, matchesOnce(selector));
  }

  // 3. aria-label + role, together when both exist: the role narrows the
  // match and the label names it. A role with no label is every element of
  // that role, which names nothing — so it is not a rung.
  const label = attribute('aria-label');
  if (label !== null) {
    const role = attribute('role');
    const selector =
      role !== null
        ? '[role="' + quoted(role) + '"][aria-label="' + quoted(label) + '"]'
        : '[aria-label="' + quoted(label) + '"]';
    keep('aria', selector, matchesOnce(selector));
  }

  // 4. the shortest unique CSS path: grow the path toward the root one
  // segment at a time and stop at the first length that matches exactly once.
  // A segment disambiguates among same-tag siblings only when it must.
  const segmentOf = (node: unknown): string | null => {
    const rawTag = property(node, 'tagName');
    if (typeof rawTag !== 'string' || rawTag.length === 0) return null;
    const tag = rawTag.toLowerCase();
    const safe = /^[a-z][a-z0-9-]*$/.test(tag) ? tag : '*';
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

  const cssPath = ((): { selector: string; unique: boolean } | null => {
    const parts: string[] = [];
    let node: unknown = element;
    // A parent chain is a tree — cycles are impossible in a DOM and only a
    // broken substitute could produce one; the bound turns that into a
    // missing candidate instead of a hung page.
    for (let depth = 0; depth <= 128; depth += 1) {
      if (depth === 128) return null;
      const segment = segmentOf(node);
      if (segment === null) return null;
      parts.unshift(segment);
      const candidate = parts.join(' > ');
      if (candidate.length > ceiling) return null;
      if (matchesOnce(candidate)) return { selector: candidate, unique: true };
      const parent = property(node, 'parentElement');
      if (parent === null || parent === undefined) break;
      if (typeof parent !== 'object') return null;
      node = parent;
    }
    if (parts.length === 0) return null;
    const full = parts.join(' > ');
    if (full.length > ceiling) return null;
    // The walk reached the top without a single-match path. On a healthy
    // document that cannot happen; where uniqueness cannot be verified (no
    // root to query, a detached element) the path is still recorded, flagged
    // as what it is.
    return { selector: full, unique: false };
  })();
  if (cssPath !== null) {
    keep('css', cssPath.selector, cssPath.unique);
  }

  // 5. text match — only for a leaf, where the text is the element's own
  // (the capture script reads text the same way; a container's textContent is
  // its whole subtree, which matches everything inside it and names nothing).
  if (property(el, 'childElementCount') === 0) {
    const text = collapsed(property(el, 'textContent'));
    if (text !== null) {
      const selector = 'text="' + quoted(text) + '"';
      // Uniqueness as a text match would read it: whitespace collapsed and
      // case-insensitive, so the scan below can only be stricter than a
      // matcher, never laxer. The rung is engine syntax the shipped
      // document-level resolver cannot parse (M4-BE-06 fix wave) — it is
      // still recorded, because §6/M4's ladder says so, and the compile
      // fence sets it aside before any step is emitted from it. The scan
      // walks the root's leaves, which makes it the one unbounded-ish read
      // here; it stops at the second match, and only leaf targets reach it.
      const needle = text.toLowerCase();
      const textUnique = ((): boolean => {
        if (root === null) return false;
        try {
          const all = root.querySelectorAll('*');
          let seen = 0;
          let hit: unknown = null;
          for (let i = 0; i < all.length; i += 1) {
            const node = all[i];
            if (property(node, 'childElementCount') !== 0) continue;
            const other = collapsed(property(node, 'textContent'));
            if (other === null || other.toLowerCase() !== needle) continue;
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

  return candidates;
}
