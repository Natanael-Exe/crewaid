import { describe, expect, it } from 'vitest';

import {
  CAPTURE_BINDING_NAME,
  CAPTURE_DECLINED_KEY,
  CAPTURE_SCRIPT_SOURCE,
  CAPTURE_TEARDOWN_KEY,
  installCaptureScript,
  type CaptureScriptElement,
  type CaptureScriptEvent,
  type CaptureScriptWindow,
} from '../src/recordings/cdp-capture-script.js';
import {
  CDP_EVENT_TYPES,
  CDP_MAX_REPORT_CHARS,
  CDP_PAYLOAD_LIMITS,
  CDP_SELECTOR_KINDS,
} from '../src/recordings/cdp-events.js';
import { generateSelectorCandidates } from '../src/recordings/cdp-selectors.js';
import { fakeDocument } from './selector-dom-fakes.js';

/**
 * M4-BE-02 — the capture script, exercised the way the page will run it.
 * (M4-BE-03 extends the same artifact with the selector ladder.)
 *
 * The script is CALLED here with a stand-in window; the one thing this suite
 * cannot do is run the serialized copy (CC-06 forbids evaluating it, and
 * `cdp-capture-docker.integration.test.ts` runs the real string in a real
 * page instead). What the stand-in window keeps faithful is what the script
 * actually relies on: listeners that can be added AND removed, and a binding
 * looked up by the name it was given. The elements it reads come from
 * `selector-dom-fakes.ts`, so the candidates in a report are computed against
 * a real (small) node graph rather than a stub that echoes expectations.
 */

interface RecordedListener {
  readonly type: string;
  readonly listener: (event: CaptureScriptEvent) => void;
  readonly capture: boolean;
}

function fakeWindow(
  options: { binding?: (payload: string) => void; noBinding?: boolean; subframe?: boolean } = {},
) {
  const listeners: RecordedListener[] = [];
  const removed: RecordedListener[] = [];
  const reports: string[] = [];
  const binding =
    options.noBinding === true
      ? undefined
      : (options.binding ?? ((payload: string): void => void reports.push(payload)));
  const window = {
    location: { href: 'https://example.test/checkout?step=2' },
    // Deliberately NO window.screenX/screenY: a click's corner of the
    // desktop comes from the EVENT's own screen coordinates (M4-BE-05), and a
    // window-origin reading would leave the report's fields absent — which the
    // geometry test's exact equality would catch.
    scrollX: 0,
    scrollY: 700,
    devicePixelRatio: 2,
    [CAPTURE_BINDING_NAME]: binding,
    addEventListener: (
      type: string,
      listener: (event: CaptureScriptEvent) => void,
      capture?: boolean,
    ) => {
      listeners.push({ type, listener, capture: capture === true });
    },
    removeEventListener: (
      type: string,
      listener: (event: CaptureScriptEvent) => void,
      capture?: boolean,
    ) => {
      const index = listeners.findIndex(
        (entry) =>
          entry.type === type &&
          entry.listener === listener &&
          entry.capture === (capture === true),
      );
      if (index >= 0) removed.push(...listeners.splice(index, 1));
    },
  } as unknown as CaptureScriptWindow;

  // A real window always carries `top`, and it equals the window itself only
  // in a frame's top frame — the identity the main-frame fence reads (M4-BE-06
  // fix wave). `subframe` swaps in a different object, which is what an
  // iframe's window sees.
  const underTest = window as unknown as Record<string, unknown>;
  underTest['top'] = options.subframe === true ? {} : underTest;

  const fire = (type: string, event: CaptureScriptEvent): void => {
    for (const entry of [...listeners]) {
      if (entry.type === type) entry.listener(event);
    }
  };
  return { window, listeners, removed, reports, fire };
}

/**
 * One element in its own document. The document matters: the candidates in a
 * report are the generator's answer about a live root, so an element that is
 * alone in its tree is unique by construction — the suites that care about
 * sharing build a full document instead (see the ladder test below).
 */
function element(
  attributes: Record<string, string>,
  overrides: {
    readonly tag?: string;
    readonly text?: string;
    readonly childCount?: number;
    readonly value?: string;
    readonly checked?: boolean;
  } = {},
): CaptureScriptElement {
  const root = fakeDocument({
    tag: overrides.tag ?? 'button',
    attrs: attributes,
    ...(overrides.text === undefined ? { text: 'Pay now' } : { text: overrides.text }),
    ...(overrides.childCount === undefined
      ? {}
      : {
          children: Array.from({ length: overrides.childCount }, (_, index) => ({
            tag: 'li',
            text: `item ${index}`,
          })),
        }),
  });
  const built = root.elements[0]!;
  // `value`/`checked` are form-field state the fake DOM does not model for
  // every element; the script reads them as optional, so they are attached
  // only where the case under test carries them.
  if (overrides.value !== undefined) Object.assign(built, { value: overrides.value });
  if (overrides.checked !== undefined) Object.assign(built, { checked: overrides.checked });
  return built;
}

const options = (): Parameters<typeof installCaptureScript>[1] => ({
  binding: CAPTURE_BINDING_NAME,
  types: [...CDP_EVENT_TYPES],
  limits: { ...CDP_PAYLOAD_LIMITS },
});

describe('installCaptureScript — reading interactions', () => {
  it('listens for all four types in the capture phase', () => {
    const { window, listeners } = fakeWindow();

    installCaptureScript(window, options(), generateSelectorCandidates);

    expect(listeners.map((entry) => entry.type)).toEqual([...CDP_EVENT_TYPES]);
    // Capture phase, so a page that stops propagation in a bubble handler
    // cannot hide an interaction from the recorder.
    expect(listeners.every((entry) => entry.capture)).toBe(true);
  });

  it('reports a click with identity, the selector ladder, and geometry as one JSON object', () => {
    const { window, reports, fire } = fakeWindow();
    installCaptureScript(window, options(), generateSelectorCandidates);

    fire('click', {
      target: element(
        {
          id: 'pay',
          'data-testid': 'pay-now',
          'aria-label': 'Pay now',
          role: 'button',
          name: 'pay',
        },
        { tag: 'button' },
      ),
      clientX: 640.4,
      clientY: 480,
      pageX: 640.4,
      pageY: 1180,
      // The desktop position of the click, from the EVENT: under X11 this is
      // the pointer's position on the framebuffer, the same pixels the X11
      // layer recorded (M4-BE-05). The window stub has none, so a window-
      // origin reading could not even produce these fields.
      screenX: 652,
      screenY: 994,
      button: 0,
    });

    expect(reports).toHaveLength(1);
    expect(JSON.parse(reports[0]!)).toEqual({
      type: 'click',
      url: 'https://example.test/checkout?step=2',
      tag: 'button',
      id: 'pay',
      testid: 'pay-now',
      ariaLabel: 'Pay now',
      role: 'button',
      name: 'pay',
      text: 'Pay now',
      // The ladder travels beside the facts, in priority order, each rung
      // carrying the uniqueness the page saw at this moment (M4-BE-03).
      candidates: [
        { kind: 'testid', selector: '[data-testid="pay-now"]', unique: true },
        { kind: 'id', selector: '#pay', unique: true },
        { kind: 'aria', selector: '[role="button"][aria-label="Pay now"]', unique: true },
        { kind: 'css', selector: 'button', unique: true },
        { kind: 'text', selector: 'text="Pay now"', unique: true },
      ],
      clientX: 640,
      clientY: 480,
      pageX: 640,
      pageY: 1180,
      button: 0,
      screenX: 652,
      screenY: 994,
      scrollX: 0,
      scrollY: 700,
      dpr: 2,
    });
  });

  it('keeps a shared name as a flagged rung rather than dropping it', () => {
    const document = fakeDocument({
      tag: 'html',
      children: [
        {
          tag: 'body',
          children: [
            { tag: 'button', attrs: { id: 'row' }, text: 'A' },
            { tag: 'button', attrs: { id: 'row' }, text: 'B' },
          ],
        },
      ],
    });
    const first = document.querySelectorAll('button')[0]!;
    const { window, reports, fire } = fakeWindow();
    installCaptureScript(window, options(), generateSelectorCandidates);

    fire('click', { target: first });

    const report = JSON.parse(reports[0]!) as { candidates: Array<Record<string, unknown>> };
    expect(report.candidates[0]).toEqual({ kind: 'id', selector: '#row', unique: false });
    expect(report.candidates[1]).toEqual({
      kind: 'css',
      selector: 'button:nth-of-type(1)',
      unique: true,
    });
  });

  it('carries a form field’s value and state — except a password’s', () => {
    const { window, reports, fire } = fakeWindow();
    installCaptureScript(window, options(), generateSelectorCandidates);

    fire('input', {
      target: element(
        { id: 'email', type: 'email' },
        { tag: 'input', text: '', value: 'a@b.test', checked: true },
      ),
    });
    fire('change', {
      target: element(
        { id: 'secret', type: 'password' },
        { tag: 'input', text: '', value: 'hunter2', checked: false },
      ),
    });

    const email = JSON.parse(reports[0]!);
    expect(email).toMatchObject({ type: 'input', id: 'email', value: 'a@b.test', checked: true });

    // A password field's contents never enter the trace — it is stored,
    // rendered to the operator and sent to a model — but its identity is
    // still recorded, which is what a generated skill needs.
    const secret = JSON.parse(reports[1]!);
    expect(secret).toMatchObject({ type: 'change', id: 'secret', inputType: 'password' });
    expect(secret).not.toHaveProperty('value');
    expect(secret).not.toHaveProperty('checked');
  });

  it('keeps a password out of the trace whatever case its type is written in', () => {
    // HTML attribute VALUES are ASCII case-insensitive, so `type="Password"`
    // and `type="PASSWORD"` are password fields exactly as much as the
    // lowercase spelling is — Chrome masks them, browsers autofill them, and
    // a user typing into one has typed a password. A guard that compares the
    // attribute verbatim answers "not a password" for both and writes the
    // secret into a trace that is stored, rendered to the operator and sent
    // to a model provider (M4-RV-01).
    const { window, reports, fire } = fakeWindow();
    installCaptureScript(window, options(), generateSelectorCandidates);

    for (const spelling of ['Password', 'PASSWORD', 'pAsSwOrD']) {
      fire('change', {
        target: element(
          { id: `secret-${spelling}`, type: spelling },
          { tag: 'input', text: '', value: 'hunter2', checked: false },
        ),
      });
    }

    for (const raw of reports) {
      const report = JSON.parse(raw) as Record<string, unknown>;
      expect(report, `a password leaked as ${String(report['inputType'])}`).not.toHaveProperty(
        'value',
      );
      expect(report).not.toHaveProperty('checked');
      // The field's identity still travels — that is what a skill needs, and
      // it is recorded exactly as the page spelled it.
      expect(report['id']).toBe(`secret-${String(report['inputType'])}`);
    }
  });

  it('reads text only for leaves, where text-matching happens', () => {
    const { window, reports, fire } = fakeWindow();
    installCaptureScript(window, options(), generateSelectorCandidates);

    fire('click', {
      target: element({ id: 'list' }, { childCount: 12 }),
    });

    const report = JSON.parse(reports[0]!);
    expect(report['id']).toBe('list');
    expect(report).not.toHaveProperty('text');
    // No text rung either: a container's textContent is its whole subtree,
    // which matches everything inside it and names nothing.
    expect(
      (report['candidates'] as Array<{ kind: string }>).map((candidate) => candidate.kind),
    ).toEqual(['id', 'css']);
  });

  it('truncates what it sends to the same ceilings the parser enforces', () => {
    const { window, reports, fire } = fakeWindow();
    installCaptureScript(window, options(), generateSelectorCandidates);

    fire('click', {
      target: element(
        {
          id: 'x'.repeat(CDP_PAYLOAD_LIMITS.attribute + 50),
          'aria-label': 'x'.repeat(CDP_PAYLOAD_LIMITS.attribute + 50),
        },
        { text: 't'.repeat(CDP_PAYLOAD_LIMITS.text + 50) },
      ),
    });

    const report = JSON.parse(reports[0]!);
    expect(report['id']).toHaveLength(CDP_PAYLOAD_LIMITS.attribute);
    expect(report['ariaLabel']).toHaveLength(CDP_PAYLOAD_LIMITS.attribute);
    expect(report['text']).toHaveLength(CDP_PAYLOAD_LIMITS.text);
  });

  it('never lets its own failures reach the page', () => {
    const { window, fire } = fakeWindow({
      binding: () => {
        throw new Error('the frame is going away');
      },
    });
    installCaptureScript(window, options(), generateSelectorCandidates);

    // A recorder that breaks the page it records is worse than no recorder.
    expect(() => fire('click', { target: element({}) })).not.toThrow();
  });

  it('loses the candidates, never the event, when the generator throws', () => {
    const { window, reports, fire } = fakeWindow();
    installCaptureScript(window, options(), () => {
      throw new Error('generator exploded');
    });

    fire('click', { target: element({ id: 'go' }) });

    // The facts were gathered before the generator ran, and an interaction
    // with no rungs is still an interaction; a throwing generator is an
    // enrichment that did not happen, not a lost event.
    expect(reports).toHaveLength(1);
    const report = JSON.parse(reports[0]!);
    expect(report).toMatchObject({ type: 'click', id: 'go' });
    expect(report).not.toHaveProperty('candidates');
  });

  it('installs nothing when the transport is not there', () => {
    const { window, listeners } = fakeWindow({ noBinding: true });

    installCaptureScript(window, options(), generateSelectorCandidates);

    // The binding is installed before the script runs, so this means the
    // window is one the script should not be touching; claiming anything —
    // listeners, a teardown — would misrepresent it as armed.
    expect(listeners).toEqual([]);
    expect(window[CAPTURE_TEARDOWN_KEY]).toBeUndefined();
  });

  it('installs nothing on a window that cannot listen', () => {
    const window = { location: { href: 'about:blank' } } as unknown as CaptureScriptWindow;
    // Without a `top` the fence would decline first; this fixture models a
    // MAIN frame that happens to lack the listener API, which is the case
    // this test is about.
    (window as unknown as Record<string, unknown>)['top'] = window;
    expect(() => installCaptureScript(window, options(), generateSelectorCandidates)).not.toThrow();
  });
});

describe('installCaptureScript — the main-frame fence (M4-BE-06 fix wave)', () => {
  it('installs nothing in a subframe, and leaves the declined marker', () => {
    const { window, listeners, reports, fire } = fakeWindow({ subframe: true });

    installCaptureScript(window, options(), generateSelectorCandidates);

    // The registration that carries the script into a page has no frame
    // filter — every frame runs it — and every frame that is not its own
    // `top` must decline. No listeners, no teardown, no reports: what
    // happened in a subframe is still recorded at the X11 layer, while a
    // frame-relative report (candidates the main-frame resolver can never
    // execute) must never be produced at all.
    expect(listeners).toEqual([]);
    expect(window[CAPTURE_TEARDOWN_KEY]).toBeUndefined();
    expect(window[CAPTURE_DECLINED_KEY]).toBe(true);
    fire('click', { target: element({ id: 'inner' }) });
    expect(reports).toEqual([]);
  });

  it('still installs in the main frame — the window whose top is itself', () => {
    const { window, listeners } = fakeWindow();

    installCaptureScript(window, options(), generateSelectorCandidates);

    expect(listeners.map((entry) => entry.type)).toEqual([...CDP_EVENT_TYPES]);
    expect(window[CAPTURE_TEARDOWN_KEY]).toBeTypeOf('function');
    expect(window[CAPTURE_DECLINED_KEY]).toBeUndefined();
  });

  it('treats a window that cannot prove it is a top frame as a subframe', () => {
    // A real browser window always has `top`; the fence's answer to one that
    // cannot prove itself is still "do not report" — declining costs capture
    // for that one window, and a frame-relative candidate can cost a whole
    // skill a wrong click.
    const window = { location: { href: 'about:blank' } } as unknown as CaptureScriptWindow;

    expect(() => installCaptureScript(window, options(), generateSelectorCandidates)).not.toThrow();
    expect((window as unknown as Record<string, unknown>)[CAPTURE_DECLINED_KEY]).toBe(true);
  });
});

describe('installCaptureScript — replacement', () => {
  it('replaces a previous installation instead of doubling it', () => {
    const first = fakeWindow();
    installCaptureScript(first.window, options(), generateSelectorCandidates);
    const firstReports = first.reports.length;

    // The same window, a later recording: a new binding arrives, and the run
    // that follows it must be the only one listening. Two live installations
    // would report every interaction twice, once over a transport that is
    // gone.
    const second = fakeWindow();
    const window = first.window;
    window[CAPTURE_BINDING_NAME] = (payload: string): void => void second.reports.push(payload);
    installCaptureScript(window, options(), generateSelectorCandidates);

    expect(first.removed).toHaveLength(CDP_EVENT_TYPES.length);
    first.fire('click', { target: element({ id: 'go' }) });

    expect(second.reports).toHaveLength(1);
    expect(first.reports).toHaveLength(firstReports);
    expect(JSON.parse(second.reports[0]!)).toMatchObject({ type: 'click', id: 'go' });
  });

  it('replaces itself cleanly when the same binding runs it twice', () => {
    const { window, reports, fire, removed } = fakeWindow();
    installCaptureScript(window, options(), generateSelectorCandidates);
    installCaptureScript(window, options(), generateSelectorCandidates);

    // Both injection paths can meet on one document (the registration and
    // `runImmediately`); the second run takes the first's listeners out, so
    // one interaction is still one report.
    expect(removed).toHaveLength(CDP_EVENT_TYPES.length);
    fire('click', { target: element({ id: 'go' }) });
    expect(reports).toHaveLength(1);
  });

  it('survives a page tampering with the teardown slot', () => {
    const { window, listeners } = fakeWindow();
    window[CAPTURE_TEARDOWN_KEY] = (): void => {
      throw new Error('the page owns this window');
    };

    expect(() => installCaptureScript(window, options(), generateSelectorCandidates)).not.toThrow();
    expect(listeners).toHaveLength(CDP_EVENT_TYPES.length);
  });
});

describe('CAPTURE_SCRIPT_SOURCE — the artifact Chrome receives', () => {
  /** The three pieces the assembly documents: script source, options, generator. */
  function sliceSource(source: string): { install: string; options: string; generator: string } {
    const callAt = source.indexOf('(window, ');
    // The options JSON is `JSON.stringify` output — no parentheses anywhere —
    // so the first `, (` after the call IS the boundary before the generator.
    const generatorAt = source.indexOf(', (', callAt);
    return {
      install: source.slice(1, callAt - 1),
      options: source.slice(callAt + '(window, '.length, generatorAt),
      generator: source.slice(generatorAt + ', ('.length, -3),
    };
  }

  it('is exactly the two functions, serialized, plus their options', () => {
    const parts = sliceSource(CAPTURE_SCRIPT_SOURCE);

    // The serialized copy and the function the tests call are the same code
    // by construction — if either came from somewhere else, the real-Chrome
    // suite would be exercising a string nothing in this repo tests.
    expect(parts.install).toBe(installCaptureScript.toString());
    expect(parts.generator).toBe(generateSelectorCandidates.toString());
    expect(CAPTURE_SCRIPT_SOURCE.startsWith('(function installCaptureScript')).toBe(true);
    expect(CAPTURE_SCRIPT_SOURCE.endsWith('}));')).toBe(true);
  });

  it('spells the teardown name as a literal, twice, matching the exported constant', () => {
    // The functions may reference nothing from module scope — their serialized
    // copies resolve names in a page, where this module does not exist. The
    // first draft of the script referenced a module constant here and the
    // real-Chrome probe caught it throwing ReferenceError while every
    // in-process call stayed green. This test and the docker one are the two
    // halves of that guard.
    expect(CAPTURE_TEARDOWN_KEY).toBe('__crewaidCaptureTeardown');
    const occurrences = CAPTURE_SCRIPT_SOURCE.split(CAPTURE_TEARDOWN_KEY).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('spells the declined marker as a literal, matching the exported constant', () => {
    // Same discipline as the teardown name: the fence's marker is set from a
    // literal in the serialized body, and the constant in this module is
    // what the tests read back through. A rename on one side that missed
    // the other would make the real-Chrome fence test unable to tell a
    // declined subframe from an unreached one.
    expect(CAPTURE_DECLINED_KEY).toBe('__crewaidCaptureDeclined');
    const occurrences = CAPTURE_SCRIPT_SOURCE.split(CAPTURE_DECLINED_KEY).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(1);
  });

  it('carries no identifier from this module into the page', () => {
    // The serialized bodies are what run in the page, so a module-scope name
    // anywhere in them — code or comment, comments serialize too — is a name
    // that resolves to nothing there. Both halves are pinned; the generator
    // gets to carry its own name (a named function expression is self-scoped)
    // and nothing else.
    const parts = sliceSource(CAPTURE_SCRIPT_SOURCE);
    const moduleNames = [
      'TEARDOWN_KEY',
      'INSTALLED_FLAG',
      'CAPTURE_TEARDOWN_KEY',
      'CAPTURE_DECLINED_KEY',
      'CAPTURE_BINDING_NAME',
      'CAPTURE_SCRIPT_SOURCE',
      'CDP_EVENT_TYPES',
      'CDP_PAYLOAD_LIMITS',
      'CDP_SELECTOR_KINDS',
      'CDP_MAX_REPORT_CHARS',
      'captureScriptOptions',
      'generateSelectorCandidates',
      'parseCaptureReport',
      'isSelectorKind',
    ];
    for (const leaked of moduleNames) {
      expect(parts.install).not.toContain(leaked);
    }
    for (const leaked of moduleNames.filter((name) => name !== 'generateSelectorCandidates')) {
      expect(parts.generator).not.toContain(leaked);
    }
  });

  it('injects the parser’s vocabulary, not a second copy of it', () => {
    const { options: json } = sliceSource(CAPTURE_SCRIPT_SOURCE);
    const injected = JSON.parse(json) as {
      binding: string;
      types: string[];
      limits: Record<string, number>;
    };

    // One source for both: the script truncates to what the parser enforces,
    // because both read the module the parser lives in. The selector ceiling
    // takes the same road — the generator drops what it cannot fit under it.
    expect(injected.binding).toBe(CAPTURE_BINDING_NAME);
    expect(injected.types).toEqual([...CDP_EVENT_TYPES]);
    expect(injected.limits).toEqual({ ...CDP_PAYLOAD_LIMITS });
    expect(injected.limits['selector']).toBeGreaterThan(0);
    expect(injected.limits['selector']).toBeLessThan(CDP_MAX_REPORT_CHARS);
  });

  it('sends no more candidates than the ladder has rungs', () => {
    // The ceiling the parser enforces and the ladder the generator builds
    // come from the same vocabulary; the parser drops a list longer than
    // rungs exist, so a drift here would silently drop real reports.
    expect(CDP_SELECTOR_KINDS.length).toBe(5);
  });
});
