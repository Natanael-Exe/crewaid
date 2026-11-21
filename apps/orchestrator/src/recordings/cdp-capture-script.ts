import { CDP_EVENT_TYPES, CDP_PAYLOAD_LIMITS, type CdpSelectorCandidate } from './cdp-events.js';
import { generateSelectorCandidates, type SelectorTarget } from './cdp-selectors.js';

/**
 * The capture script, and the source string that gets injected into the page
 * (M4-BE-02; selector candidates added by M4-BE-03).
 *
 * WHY THE SCRIPT IS A FUNCTION AND THE INJECTION IS ITS `toString`
 *
 * The script has to exist twice: as something this repo can type-check and
 * test, and as a string Chrome evaluates inside the page before the page's own
 * scripts run. The obvious shortcut — author the string here, test its effects
 * elsewhere — leaves the one artifact that matters (the string) unexercised,
 * and leaves the repo no way to test what the page will actually run.
 *
 * CC-06 forbids evaluating strings in this process (§7.3: the orchestrator
 * never executes dynamic code, and that ban is worth keeping unbroken even in
 * tests). So the string cannot be produced by `eval`-ing anything at boot
 * either. What works in both directions: write the script as a completely
 * self-contained function, test it by CALLING it with a stand-in window, and
 * inject `(f.toString())(window, options, selectors)` — the same code,
 * serialised. The third argument is the selector generator (`cdp-selectors.ts`),
 * itself a self-contained function serialized the same way: the two artifacts
 * are composed into one call rather than one file reaching into the other,
 * because neither may reference the other's module.
 *
 * The cost is the discipline these files must keep: the serialized bodies may
 * reference nothing from module scope (no imports, no constants, no helpers),
 * because the emitted source runs in a page where none of them exist. Every
 * name they use is either their own parameter, their own inner function, or a
 * browser global. A second installation REPLACES the first rather than
 * doubling it — tracked by a function on `window` rather than by any shared
 * state here.
 *
 * WHY ONLY THE MAIN FRAME REPORTS ( fix wave)
 *
 * `Page.addScriptToEvaluateOnNewDocument` has no frame filter — this script
 * runs in every frame's document — so the one place that can tell a main
 * frame from a subframe for sure is the script itself, in the frame. A click
 * inside an iframe would otherwise be reported from the IFRAME's window,
 * with candidates relative to a document the replay side cannot address:
 * `ctx.page` resolves selectors in the page's main frame only, so such a
 * report compiles into a step that can never run — or, when its chosen rung
 * is a bare tag, one that silently clicks a DIFFERENT element in the main
 * frame and reports success. A frame-relative report is worse than no
 * report: only a window that IS its own `top` installs anything. A subframe
 * leaves the declined marker and stays silent; what happened there is still
 * recorded — at the X11 layer, which nothing here can reach — and compiles
 * to the coordinate click that replays correctly regardless of frames.
 *
 * Why the options are injected rather than inlined
 *
 * The binding name, the event names and the length ceilings are facts the
 * orchestrator and the script must agree on. Passing them as a JSON literal
 * attached to the call — built from `cdp-events.ts`, the parser's module —
 * keeps them defined exactly once. The alternative inlines them in the
 * function body, where they become a second copy free to drift from the one
 * the parser enforces.
 */

/** The binding the script reports over. `Runtime.addBinding` must use this name. */
export const CAPTURE_BINDING_NAME = '__crewaidCapture';

/**
 * The name an installation leaves behind: the function that undoes it.
 *
 * NOT referenced from `installCaptureScript` — that function may reference
 * nothing from module scope, because its emitted source runs in a page where
 * this module does not exist. (The first draft DID reference a module constant
 * here, and a real-Chrome probe caught it throwing `ReferenceError` at install
 * time while every in-process unit test stayed green — the serialized copy
 * resolves names in the page, not in this module.) The function spells the
 * literal `'__crewaidCaptureTeardown'` inline; a unit test pins both so a rename
 * cannot drift them apart.
 *
 * Every window this script reaches can be reached more than once, and for two
 * different reasons: `Page.addScriptToEvaluateOnNewDocument` re-runs it in
 * every new document, and `runImmediately` runs it in the frames that already
 * exist. A document kept open across two recordings is the case that makes
 * replacement load-bearing rather than cosmetic — its listeners from the
 * previous recording are wired to a binding whose session is gone, and only a
 * fresh installation binds them to the new transport. So a run REPLACES what
 * is installed here: the previous teardown removes the previous listeners
 * first, and no interaction is ever reported twice.
 */
export const CAPTURE_TEARDOWN_KEY = '__crewaidCaptureTeardown';

/**
 * The marker a SUBFRAME window carries once the script ran there and declined
 * to install (M4-BE-06 fix wave).
 *
 * The fence itself is the `top` check in `installCaptureScript`; this marker
 * exists so the fact "the script reached this frame and chose not to capture
 * it" stays observable. A real-Chrome fence test can then tell a declined
 * frame from a frame the registration never reached, and a guard that had
 * quietly stopped being delivered to subframes could not pass it vacuously.
 * Set from the literal spelled inline, like the teardown: the serialized
 * copy resolves names in a page, not in this module.
 */
export const CAPTURE_DECLINED_KEY = '__crewaidCaptureDeclined';

/** A DOM event, as much of one as this script reads. */
export interface CaptureScriptEvent {
  readonly target?: unknown;
  readonly clientX?: unknown;
  readonly clientY?: unknown;
  readonly pageX?: unknown;
  readonly pageY?: unknown;
  /**
   * The event's position on the desktop, in CSS pixels — the fact M4-BE-05
   * correlates against. Read from the EVENT rather than from the window (see
   * `geometry`).
   */
  readonly screenX?: unknown;
  readonly screenY?: unknown;
  readonly button?: unknown;
}

/** An element, as much of one as this script reads. */
export interface CaptureScriptElement extends SelectorTarget {
  readonly value?: unknown;
  readonly checked?: unknown;
}

/**
 * The window, as much of one as this script reads.
 *
 * Deliberately structural: this interface is also the seam the unit test
 * substitutes for a browser. The index signature is what lets the script look
 * its binding up by the name it was given, and it is writable because the
 * teardown function is stored on the window itself.
 */
export interface CaptureScriptWindow {
  [key: string]: unknown;
  readonly location?: { readonly href?: unknown } | undefined;
  /**
   * The window's own `top`. Every real browser window has one, and it equals
   * the window itself only in a frame's top frame — the fact the main-frame
   * fence reads. Optional in the type because a stand-in window in a test
   * may omit it: a window that cannot prove it is the main frame is treated
   * as a subframe, which costs capture (the X11 layer still records
   * everything) and can never cause a wrong click.
   */
  readonly top?: unknown;
  addEventListener?(
    type: string,
    listener: (event: CaptureScriptEvent) => void,
    capture?: boolean,
  ): void;
  /** The uninstall half; `removeEventListener` ignores a mismatched phase. */
  removeEventListener?(
    type: string,
    listener: (event: CaptureScriptEvent) => void,
    capture?: boolean,
  ): void;
}

/** What the injection passes to the script. Kept in sync with the parser's module. */
export interface CaptureScriptOptions {
  readonly binding: string;
  readonly types: readonly string[];
  readonly limits: {
    readonly url: number;
    readonly attribute: number;
    readonly text: number;
    readonly value: number;
    readonly selector: number;
  };
}

/**
 * The selector generator as this script calls it: the serialized third
 * artifact, handed in rather than imported — its body may reference nothing
 * from a module either (see `cdp-selectors.ts`).
 */
export type SelectorGenerator = (
  element: unknown,
  limit: number,
) => readonly CdpSelectorCandidate[];

/**
 * Installs the capture into one window. Runs inside the page.
 *
 * Reads four event types §6/M4 fixes — `click`, `input`, `change`, `submit` —
 * in the CAPTURE phase, so a page that stops propagation in a bubble handler
 * cannot hide an interaction from the recorder. Each event is reported over
 * the CDP binding as one JSON object; what the page does with its own errors
 * is the page's business, and nothing here is allowed to add to it.
 */
export function installCaptureScript(
  w: CaptureScriptWindow,
  options: CaptureScriptOptions,
  buildCandidates: SelectorGenerator,
): void {
  // The main-frame fence (see the section above): only the frame whose own
  // `top` is itself reports. Identity comparison on the WindowProxy needs no
  // privilege and works the same for same-process, out-of-process and
  // sandboxed frames — where `top` is unreachable ANY OTHER way, comparing it
  // is still allowed. A window that cannot prove it is a top frame is
  // treated as a subframe: declining costs capture for that frame only, and
  // a wrong candidate never leaves the page.
  const top = w['top'];
  if (top !== w) {
    try {
      w['__crewaidCaptureDeclined'] = true;
    } catch {
      // A window that refuses the write still must not be captured from a
      // subframe; declining is the whole answer either way.
    }
    return;
  }

  // Snapshot the binding now rather than looking it up per event. The binding
  // is installed before this script runs (the service adds it first), so a
  // snapshot is always available; looking it up later would let a page that
  // happens to define a same-named global silently replace the transport.
  const reporter = w[options.binding];
  if (typeof reporter !== 'function') return;
  const report = reporter as (payload: string) => void;

  // Whatever a previous run left in this document comes out first: its
  // listeners are wired to a transport that is gone, and leaving them in
  // would double every event the installation below reports. The page owns
  // this function and may have deleted or replaced it — that is the page's
  // business, and the install proceeds either way.
  // The literal, not the exported name: this body is serialized and
  // evaluated in a page, where nothing outside itself exists (see the
  // comment on the constant above).
  const previous = w['__crewaidCaptureTeardown'];
  if (typeof previous === 'function') {
    try {
      (previous as () => void)();
    } catch {
      // A page's tampering with its own window must not block a reinstall.
    }
  }

  const bounded = (value: unknown, limit: number): string | null => {
    if (typeof value !== 'string' || value.length === 0) return null;
    return value.length > limit ? value.slice(0, limit) : value;
  };

  const attribute = (el: CaptureScriptElement, name: string): string | null => {
    if (typeof el.getAttribute !== 'function') return null;
    return bounded(el.getAttribute(name), options.limits.attribute);
  };

  /**
   * Whether a `type` attribute names a password field.
   *
   * Case-folded, because HTML attribute VALUES are ASCII case-insensitive:
   * `type="Password"` is a password field exactly as much as the lowercase
   * spelling is — the browser masks it, autofills it, and a user typing into
   * one has typed a password. Comparing the attribute verbatim answered "not
   * a password" for every other spelling and wrote the secret into a trace
   * that is stored, rendered to the operator and sent to a model provider
   * (M4-RV-01). The attribute is still REPORTED exactly as the page spelled
   * it; only the judgement is folded.
   */
  const isPasswordType = (value: string | null): boolean =>
    value !== null && value.toLowerCase() === 'password';

  const elementOf = (target: unknown): CaptureScriptElement | null => {
    if (typeof target !== 'object' || target === null) return null;
    const node = target as CaptureScriptElement;
    return typeof node.tagName === 'string' && node.tagName.length > 0 ? node : null;
  };

  /**
   * The raw facts the selector generator and the correlator
   * build on: what the element IS, never a selector and never a
   * ranking. Candidates and their uniqueness are the generator's job, and it
   * runs beside this one in the same page — the live document is the only
   * place where "this matches exactly one element" is a fact.
   */
  const describe = (el: CaptureScriptElement): Record<string, number | boolean | string> => {
    const found: Record<string, number | boolean | string> = {};
    if (typeof el.tagName === 'string' && el.tagName.length > 0) {
      found['tag'] = el.tagName.toLowerCase();
    }
    const id = attribute(el, 'id');
    if (id !== null) found['id'] = id;
    const testid = attribute(el, 'data-testid');
    if (testid !== null) found['testid'] = testid;
    const ariaLabel = attribute(el, 'aria-label');
    if (ariaLabel !== null) found['ariaLabel'] = ariaLabel;
    const role = attribute(el, 'role');
    if (role !== null) found['role'] = role;
    const name = attribute(el, 'name');
    if (name !== null) found['name'] = name;
    const inputType = attribute(el, 'type');
    if (inputType !== null) found['inputType'] = inputType;
    // `textContent` builds a string from the WHOLE subtree, so on a click that
    // lands on a container it is the cost of the page's entire text. Reading it
    // only for leaves keeps the interaction path cheap; the deep targets that
    // text-matching exists for — buttons, links, labels — are leaves.
    if (el.childElementCount === 0) {
      const text = bounded(el.textContent, options.limits.text);
      if (text !== null) found['text'] = text;
    }
    return found;
  };

  const integer = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;

  /**
   * The geometry a click carries.
   *
   * `screenX`/`screenY` come from the EVENT: under X11 a mouse event's screen
   * coordinates are the pointer's position on the desktop, which is exactly
   * what the X11 layer recorded for the same click — the one pair of numbers
   * both layers genuinely share, and what lets M4-BE-05 line the two rows up.
   * (Probed on the sandbox's Chrome 152: an RFB click at framebuffer (x, y)
   * reports these as (x, y), exact.) The WINDOW's `screenX`/`screenY` are
   * deliberately not used — they are the WM-placed window origin, and the
   * viewport sits below the browser's own chrome by a distance neither side
   * of the correlation can derive.
   *
   * The viewport coordinates, scroll and device pixel ratio stay: they
   * describe where the click landed in the PAGE and how CSS pixels scale to
   * desktop pixels (`dpr`), which is what a replay needs.
   */
  const geometry = (event: CaptureScriptEvent): Record<string, number> => {
    const pairs: ReadonlyArray<readonly [string, unknown]> = [
      ['clientX', event.clientX],
      ['clientY', event.clientY],
      ['pageX', event.pageX],
      ['pageY', event.pageY],
      ['button', event.button],
      ['screenX', event.screenX],
      ['screenY', event.screenY],
      ['scrollX', w['scrollX']],
      ['scrollY', w['scrollY']],
    ];
    const found: Record<string, number> = {};
    for (const [key, value] of pairs) {
      const rounded = integer(value);
      if (rounded !== null) found[key] = rounded;
    }
    const dpr = w['devicePixelRatio'];
    if (typeof dpr === 'number' && Number.isFinite(dpr) && dpr > 0) found['dpr'] = dpr;
    return found;
  };

  const handle = (type: string, event: CaptureScriptEvent): void => {
    try {
      const body: Record<string, unknown> = { type };
      const url = bounded(w.location?.href, options.limits.url);
      if (url !== null) body['url'] = url;

      const el = elementOf(event.target);
      let inputType: string | null = null;
      if (el !== null) {
        const facts = describe(el);
        for (const [key, value] of Object.entries(facts)) body[key] = value;
        const reported = facts['inputType'];
        inputType = typeof reported === 'string' ? reported : null;
        // The selector ladder, generated here because this is the only moment
        // the element and its live document both exist. A generator that
        // throws loses the candidates, never the interaction: the facts were
        // gathered before it ran, and the event is worth more than its rungs.
        try {
          body['candidates'] = buildCandidates(el, options.limits.selector);
        } catch {
          // Candidates are an enrichment; the report stands without them.
        }
      }

      if (type === 'click') {
        for (const [key, value] of Object.entries(geometry(event))) body[key] = value;
      }
      if (el !== null && (type === 'input' || type === 'change') && !isPasswordType(inputType)) {
        // A password field's contents never enter the trace. The trace is
        // stored, rendered to the operator and sent to a model when the
        // recording compiles; there is no step of that journey a password
        // should make. The field's identity is still recorded, which is what
        // a generated skill needs.
        const value = bounded(el.value, options.limits.value);
        if (value !== null) body['value'] = value;
        if (typeof el.checked === 'boolean') body['checked'] = el.checked;
      }

      report(JSON.stringify(body));
    } catch {
      // Nothing this script does may throw into the page: a recorder that
      // breaks the page it records is worse than no recorder. A binding that
      // throws (the frame is going away, the page replaced the global) and a
      // payload that cannot stringify both land here.
    }
  };

  if (typeof w.addEventListener !== 'function') return;
  const installed: Array<readonly [string, (event: CaptureScriptEvent) => void]> = [];
  const teardown = (): void => {
    for (const [type, listener] of installed) {
      w.removeEventListener?.(type, listener, true);
    }
  };
  // Claimed before the first listener lands, so a run that follows always
  // finds an undo for whatever the run before it managed to add. The literal
  // again, for the same reason as the snapshot above.
  w['__crewaidCaptureTeardown'] = teardown;
  for (const type of options.types) {
    // Capture phase (`true`): the recorder sees an interaction before any
    // handler the page installed can stop its propagation.
    const listener = (event: CaptureScriptEvent): void => handle(type, event);
    installed.push([type, listener]);
    w.addEventListener(type, listener, true);
  }
}

/** The binding name, its event vocabulary and its ceilings, as the page receives them. */
function captureScriptOptions(): CaptureScriptOptions {
  return {
    binding: CAPTURE_BINDING_NAME,
    types: [...CDP_EVENT_TYPES],
    limits: { ...CDP_PAYLOAD_LIMITS },
  };
}

/**
 * The exact source `Page.addScriptToEvaluateOnNewDocument` receives, and the
 * exact thing the unit suites exercise through the functions it came from:
 * the script, its options, and the selector generator composed into one call.
 *
 * Both functions are serialized from their own `toString()` — there is no
 * second copy of either in this file to drift, and CC-06 keeps the process
 * from ever evaluating either. The structure of this string is what the
 * source-pin tests slice apart; a test asserts the pieces are the three the
 * assembly documents.
 */
export const CAPTURE_SCRIPT_SOURCE = `(${installCaptureScript.toString()})(window, ${JSON.stringify(
  captureScriptOptions(),
)}, (${generateSelectorCandidates.toString()}));`;
