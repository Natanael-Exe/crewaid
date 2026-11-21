import { describe, expect, it } from 'vitest';

import {
  CDP_EVENT_TYPES,
  CDP_MAX_REPORT_CHARS,
  CDP_PAYLOAD_LIMITS,
  CDP_SELECTOR_KINDS,
  parseCaptureReport,
} from '../src/recordings/cdp-events.js';

/**
 * M4-BE-02 — the parser for what the page reports.
 *
 * The reporter is the page and the page is the untrusted side (§7.3): every
 * case below is something a hostile page could put on the wire, and the only
 * two acceptable answers are the validated subset or `null`. Nothing here
 * reaches the trace as an assumed shape.
 */
describe('parseCaptureReport', () => {
  it('accepts exactly the four interactions §6/M4 fixes', () => {
    expect(CDP_EVENT_TYPES).toEqual(['click', 'input', 'change', 'submit']);
    for (const type of CDP_EVENT_TYPES) {
      expect(parseCaptureReport(JSON.stringify({ type }))).toEqual({ type, payload: {} });
    }
  });

  it('carries a full click through field by field', () => {
    const parsed = parseCaptureReport(
      JSON.stringify({
        type: 'click',
        url: 'https://example.test/checkout?step=2',
        // As the script sends it — the script lowercases `tagName`; the
        // parser's job is validation and bounding, not normalisation.
        tag: 'button',
        id: 'pay',
        testid: 'pay-now',
        ariaLabel: 'Pay now',
        role: 'button',
        name: 'pay',
        inputType: 'submit',
        text: 'Pay now',
        clientX: 640,
        clientY: 480,
        pageX: 640,
        pageY: 1180,
        button: 0,
        screenX: 12,
        screenY: 34,
        scrollX: 0,
        scrollY: 700,
        dpr: 1.5,
      }),
    );

    expect(parsed).toEqual({
      type: 'click',
      payload: {
        url: 'https://example.test/checkout?step=2',
        tag: 'button',
        id: 'pay',
        testid: 'pay-now',
        ariaLabel: 'Pay now',
        role: 'button',
        name: 'pay',
        inputType: 'submit',
        text: 'Pay now',
        clientX: 640,
        clientY: 480,
        pageX: 640,
        pageY: 1180,
        button: 0,
        screenX: 12,
        screenY: 34,
        scrollX: 0,
        scrollY: 700,
        dpr: 1.5,
      },
    });
  });

  it('drops a report that names anything other than the four types', () => {
    // The vocabulary is closed here because `RecordingEvent.type` is read by
    // the compiler: an unknown type is a sentence the model has no schema for.
    // `navigate` and `load` are trace types too — M4-BE-04's rows — but the
    // page is not their author: they come from the protocol side, so a page
    // cannot report a navigation it did not perform.
    for (const type of ['scroll', 'CLICK', 'Click', '', 'keydown', 'navigate', 'load']) {
      expect(parseCaptureReport(JSON.stringify({ type }))).toBeNull();
    }
  });

  it('drops anything that is not a JSON object', () => {
    for (const raw of [
      'not json at all',
      '',
      '[{"type":"click"}]',
      '"click"',
      'null',
      '42',
      'true',
    ]) {
      expect(parseCaptureReport(raw)).toBeNull();
    }
  });

  it('drops an oversized report before parsing it', () => {
    // `JSON.parse` is the one unbounded-cost operation on this path, so the
    // ceiling runs first — here the payload would parse perfectly well.
    const oversized = JSON.stringify({ type: 'click', text: 'x'.repeat(CDP_MAX_REPORT_CHARS) });
    expect(oversized.length).toBeGreaterThan(CDP_MAX_REPORT_CHARS);
    expect(parseCaptureReport(oversized)).toBeNull();
  });

  it('truncates every string fact to its ceiling', () => {
    const long = (n: number): string => 'x'.repeat(n);
    const parsed = parseCaptureReport(
      JSON.stringify({
        type: 'input',
        url: long(CDP_PAYLOAD_LIMITS.url + 10),
        tag: long(CDP_PAYLOAD_LIMITS.attribute + 10),
        id: long(CDP_PAYLOAD_LIMITS.attribute + 10),
        text: long(CDP_PAYLOAD_LIMITS.text + 10),
        value: long(CDP_PAYLOAD_LIMITS.value + 10),
      }),
    );

    expect(parsed?.payload).toMatchObject({
      url: 'x'.repeat(CDP_PAYLOAD_LIMITS.url),
      tag: 'x'.repeat(CDP_PAYLOAD_LIMITS.attribute),
      id: 'x'.repeat(CDP_PAYLOAD_LIMITS.attribute),
      text: 'x'.repeat(CDP_PAYLOAD_LIMITS.text),
      value: 'x'.repeat(CDP_PAYLOAD_LIMITS.value),
    });
  });

  it('rounds pixel facts and keeps a positive dpr as the ratio it is', () => {
    const parsed = parseCaptureReport(
      JSON.stringify({ type: 'click', clientX: 10.4, clientY: 10.5, dpr: 1.5 }),
    );

    // Rounded because these are compared against X11 coordinates (M4-BE-05),
    // which are integers by construction. `dpr` is not a pixel: rounding a
    // 150%-scaled page to 1 would point the correlator at the wrong pixel.
    expect(parsed?.payload).toEqual({ clientX: 10, clientY: 11, dpr: 1.5 });
  });

  it('rejects the number forms JSON can carry but a sensor cannot', () => {
    // `1e999` parses to Infinity, and a coordinate of Infinity would sort
    // nonsense into the trace the correlator reads.
    const parsed = parseCaptureReport(
      JSON.stringify({ type: 'click', clientX: 1e999, dpr: 1e999 }),
    );
    expect(parsed?.payload).toEqual({});

    for (const bad of [0, -1, -0.5]) {
      expect(parseCaptureReport(JSON.stringify({ type: 'click', dpr: bad }))?.payload).toEqual({});
    }
  });

  it('keeps real booleans and drops lookalikes', () => {
    expect(parseCaptureReport(JSON.stringify({ type: 'change', checked: false }))?.payload).toEqual(
      { checked: false },
    );
    expect(
      parseCaptureReport(JSON.stringify({ type: 'change', checked: 'false' }))?.payload,
    ).toEqual({});
  });

  it('drops empty strings and wrongly-typed fields rather than guessing', () => {
    const parsed = parseCaptureReport(
      JSON.stringify({
        type: 'click',
        id: '',
        text: 42,
        clientX: '30',
        button: null,
        value: {},
      }),
    );
    // A field that is absent is a fact the event did not carry; a field
    // coerced from junk is a fact the event never had.
    expect(parsed?.payload).toEqual({});
  });

  it('keeps only known fields — a report cannot add its own', () => {
    const parsed = parseCaptureReport(
      JSON.stringify({
        type: 'click',
        id: 'ok',
        evil: { nested: true },
        selector: '#not-from-the-script',
        correlatedWithId: 'forged',
      }),
    );
    expect(parsed?.payload).toEqual({ id: 'ok' });
  });
});

/**
 * M4-BE-03 — the selector candidates, which cross the same trust boundary as
 * every fact above and get the same treatment: entry by entry, against a
 * closed vocabulary and bounded lengths, with nothing assumed because the
 * script "would" have sent it.
 */
describe('parseCaptureReport — selector candidates', () => {
  it('keeps the whole ladder, including rungs flagged non-unique', () => {
    const candidates = [
      { kind: 'testid', selector: '[data-testid="go"]', unique: true },
      { kind: 'id', selector: '#pay', unique: false },
      { kind: 'aria', selector: '[role="button"][aria-label="Pay now"]', unique: true },
      { kind: 'css', selector: 'form > button:nth-of-type(2)', unique: true },
      { kind: 'text', selector: 'text="Pay now"', unique: true },
    ];
    const parsed = parseCaptureReport(JSON.stringify({ type: 'click', id: 'pay', candidates }));

    // The list survives in the order the page sent it — that order IS the
    // priority ladder, and reordering or dropping the non-unique rung would
    // lose exactly the information M4-BE-03 exists to keep.
    expect(parsed?.payload).toEqual({ id: 'pay', candidates });
    // All five rungs of the vocabulary are accepted: a rename on one side
    // would otherwise read as "the page sent an unknown kind".
    expect(candidates.map((candidate) => candidate.kind)).toEqual([...CDP_SELECTOR_KINDS]);
  });

  it('drops entries that fail validation and keeps the ones that do not', () => {
    const parsed = parseCaptureReport(
      JSON.stringify({
        type: 'click',
        candidates: [
          { kind: 'testid', selector: '[data-testid="go"]', unique: true },
          { kind: 'xpath', selector: '//button', unique: true },
          'not an object',
          { kind: 'css', selector: 'button', unique: 'yes' },
          { kind: 'aria', selector: 'y'.repeat(CDP_PAYLOAD_LIMITS.selector), unique: false },
        ],
      }),
    );

    // One bad entry is one bad entry: the page's own report is still evidence
    // about everything that survived. The kept selector sits exactly at the
    // ceiling (kept, not clipped).
    expect(parsed?.payload).toEqual({
      candidates: [
        { kind: 'testid', selector: '[data-testid="go"]', unique: true },
        { kind: 'aria', selector: 'y'.repeat(CDP_PAYLOAD_LIMITS.selector), unique: false },
      ],
    });
  });

  it('keeps the shadow marker only when it is exactly true, and only as a boolean', () => {
    const parsed = parseCaptureReport(
      JSON.stringify({
        type: 'click',
        candidates: [
          { kind: 'id', selector: '#in-shadow', unique: true, shadow: true },
          { kind: 'css', selector: 'button', unique: true, shadow: false },
          { kind: 'id', selector: '#dropped', unique: true, shadow: 'yes' },
          { kind: 'css', selector: 'div', unique: false },
        ],
      }),
    );

    // The marker (M4-BE-06 fix wave) is the fact that sets a rung aside at
    // compile: `true` is kept as-is, an explicit `false` normalizes away —
    // absence is how an ordinary document-scoped rung is spelled — and a
    // non-boolean is an entry the parser cannot trust, so it falls with the
    // same strictness as every other field.
    expect(parsed?.payload).toEqual({
      candidates: [
        { kind: 'id', selector: '#in-shadow', unique: true, shadow: true },
        { kind: 'css', selector: 'button', unique: true },
        { kind: 'css', selector: 'div', unique: false },
      ],
    });
  });

  it('drops an empty selector and an oversized one rather than clipping either', () => {
    const parsed = parseCaptureReport(
      JSON.stringify({
        type: 'click',
        candidates: [
          { kind: 'id', selector: '', unique: true },
          { kind: 'css', selector: 'z'.repeat(CDP_PAYLOAD_LIMITS.selector + 1), unique: true },
        ],
      }),
    );

    // A truncated selector is a different selector; the entry goes, the
    // report stays — but with nothing left to keep, the field is absent.
    expect(parsed?.payload).toEqual({});
  });

  it('drops a list longer than the ladder has rungs', () => {
    const rung = (kind: string): Record<string, unknown> => ({
      kind,
      selector: '#' + kind,
      unique: true,
    });
    const parsed = parseCaptureReport(
      JSON.stringify({
        type: 'click',
        candidates: ['testid', 'id', 'aria', 'css', 'text', 'id'].map(rung),
      }),
    );

    // Six rungs did not come from the five-rung ladder; a page saying "here
    // is more" is saying something the vocabulary cannot represent, and the
    // whole list is discarded rather than capped.
    expect(parsed?.payload).toEqual({});
  });

  it('drops the field when it is not a list at all', () => {
    for (const junk of ['#pay', 42, {}, [[]], true, null]) {
      const parsed = parseCaptureReport(JSON.stringify({ type: 'click', candidates: junk }));
      expect(parsed?.payload).toEqual({});
    }
  });
});
