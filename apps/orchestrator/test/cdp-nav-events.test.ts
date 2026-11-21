import { describe, expect, it } from 'vitest';

import { CDP_PAYLOAD_LIMITS } from '../src/recordings/cdp-events.js';
import {
  createNavPairingState,
  MAX_TRACKED_DOCUMENT_REQUESTS,
  NAV_TRACE_TYPES,
  noteDocumentRequest,
  noteFrameNavigated,
  takeDocumentLoadFinished,
  type NavPairingState,
} from '../src/recordings/cdp-nav-events.js';

/**
 * M4-BE-04 — the navigation rows and the pairing behind them.
 *
 * Pure: each case is a params object, a state, and the row (or null) the
 * sequence earns. The shapes below are what the sandbox's Chrome 152 actually
 * sent in the probe (`cdp-nav-docker.integration.test.ts` re-proves them
 * against a live browser); what is pinned here is the judgement applied to
 * them — which commits become rows, which completions pair with which
 * documents, and that a hostile peer can only ever make this module say less.
 */

const MAIN_FRAME = 'B2C63F2C9268E500995BE2683802B740';
const IFRAME = '79070386EC3D4B56CAFF5628669FE74E';

/** A `Page.frameNavigated` params object as Chrome 152 sends one. */
function commit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'Navigation',
    frame: {
      id: MAIN_FRAME,
      loaderId: 'loader-1',
      url: 'https://example.test/',
      mimeType: 'text/html',
      securityOrigin: 'https://example.test',
      ...overrides,
    },
  };
}

/** A `Network.requestWillBeSent` params object for a document load. */
function documentRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'request-1',
    loaderId: 'loader-1',
    frameId: MAIN_FRAME,
    type: 'Document',
    request: { url: 'https://example.test/', method: 'GET' },
    ...overrides,
  };
}

describe('the navigation vocabulary', () => {
  it('is exactly the two row types §6/M4 asks the trace to carry', () => {
    expect(NAV_TRACE_TYPES).toEqual(['navigate', 'load']);
  });
});

describe('noteFrameNavigated', () => {
  it('turns a main-frame commit into a navigate row', () => {
    const state = createNavPairingState();

    const row = noteFrameNavigated(state, commit({ url: 'https://example.test/checkout?step=2' }));

    expect(row).toEqual({
      type: 'navigate',
      payload: { url: 'https://example.test/checkout?step=2' },
    });
    // The commit is the pairing key for this session's later completions.
    expect(state.mainFrames.has(MAIN_FRAME)).toBe(true);
  });

  it('drops a subframe commit — an iframe is not a page wait condition', () => {
    const state = createNavPairingState();

    const row = noteFrameNavigated(
      state,
      commit({ id: IFRAME, parentId: MAIN_FRAME, url: 'https://ads.test/frame' }),
    );

    expect(row).toBeNull();
    // And its frame is not remembered as main, so its document load cannot
    // pair either (see the pairing suite below).
    expect(state.mainFrames.has(IFRAME)).toBe(false);
  });

  it('falls back to unreachableUrl for a commit whose navigation failed', () => {
    const state = createNavPairingState();

    const row = noteFrameNavigated(
      state,
      commit({ url: '', unreachableUrl: 'https://gone.test/nothing' }),
    );

    // The operator did navigate — the address is what the compiler can read
    // and pair, page or error page.
    expect(row).toEqual({
      type: 'navigate',
      payload: { url: 'https://gone.test/nothing' },
    });
  });

  it('clamps the URL to the trace ceiling', () => {
    const state = createNavPairingState();

    const row = noteFrameNavigated(
      state,
      commit({ url: `https://example.test/${'a'.repeat(600)}` }),
    );

    expect(row?.payload['url']).toBe(
      `https://example.test/${'a'.repeat(600)}`.slice(0, CDP_PAYLOAD_LIMITS.url),
    );
    expect((row?.payload['url'] as string).length).toBe(CDP_PAYLOAD_LIMITS.url);
  });

  it('drops a commit that carries no frame or no address', () => {
    const state = createNavPairingState();

    for (const params of [
      {},
      { frame: null },
      { frame: 'main' },
      { frame: [] },
      { frame: { url: 'https://example.test/' } }, // no id
      { frame: { id: MAIN_FRAME } }, // no url at all
      { frame: { id: '', url: 'https://example.test/' } },
      { frame: { id: 'x'.repeat(200), url: 'https://example.test/' } }, // not an id
    ]) {
      expect(noteFrameNavigated(state, params)).toBeNull();
    }
    // Nothing remembered: a dropped commit must not become a pairing key.
    expect(state.mainFrames.size).toBe(0);
  });
});

describe('the document pairing', () => {
  /** A state where the main frame has committed. */
  function committed(): NavPairingState {
    const state = createNavPairingState();
    noteFrameNavigated(state, commit());
    return state;
  }

  it('pairs a completion with the main-frame document request it finishes', () => {
    const state = createNavPairingState();
    const url = 'https://example.test/checkout';

    noteDocumentRequest(state, documentRequest({ requestId: 'r9', request: { url } }));
    noteFrameNavigated(state, commit({ url }));
    const row = takeDocumentLoadFinished(state, { requestId: 'r9', encodedDataLength: 535 });

    expect(row).toEqual({ type: 'load', payload: { url } });
  });

  it('remembers nothing but documents — an image completion is not evidence', () => {
    const state = committed();
    noteDocumentRequest(state, documentRequest({ type: 'Image' }));

    expect(state.documents.size).toBe(0);
    expect(takeDocumentLoadFinished(state, { requestId: 'request-1' })).toBeNull();
  });

  it('drops a subframe document load even though its request was tracked', () => {
    const state = committed();
    noteDocumentRequest(
      state,
      documentRequest({
        requestId: 'sub-1',
        frameId: IFRAME,
        request: { url: 'https://ads.test/' },
      }),
    );

    // The request is a document; its frame is not the page. Both halves of
    // the filter are required, and this is the second one doing its job.
    expect(takeDocumentLoadFinished(state, { requestId: 'sub-1' })).toBeNull();
  });

  it('drops a completion for a request it never saw', () => {
    const state = committed();
    expect(takeDocumentLoadFinished(state, { requestId: 'never-seen' })).toBeNull();
  });

  it('never reports the same document load twice', () => {
    const state = committed();
    noteDocumentRequest(state, documentRequest({ requestId: 'r1' }));

    expect(takeDocumentLoadFinished(state, { requestId: 'r1' })).not.toBeNull();
    expect(takeDocumentLoadFinished(state, { requestId: 'r1' })).toBeNull();
  });

  it('keeps the newest hop of a redirect chain', () => {
    const state = createNavPairingState();
    noteDocumentRequest(
      state,
      documentRequest({ requestId: 'r1', request: { url: 'https://a.test/' } }),
    );
    noteDocumentRequest(
      state,
      documentRequest({ requestId: 'r1', request: { url: 'https://b.test/landed' } }),
    );
    noteFrameNavigated(state, commit({ url: 'https://b.test/landed' }));

    expect(takeDocumentLoadFinished(state, { requestId: 'r1' })).toEqual({
      type: 'load',
      payload: { url: 'https://b.test/landed' },
    });
  });

  it('earns nothing for a completion that arrives before its frame committed', () => {
    // Real Chrome commits before a document can finish loading (probe order:
    // requestWillBeSent -> frameNavigated -> loadingFinished), so this is a
    // hostile or broken peer — and the answer is still "not evidence".
    const state = createNavPairingState();
    noteDocumentRequest(state, documentRequest({ requestId: 'r1' }));

    expect(takeDocumentLoadFinished(state, { requestId: 'r1' })).toBeNull();
  });

  it('stays bounded: the oldest tracked document is evicted first', () => {
    const state = committed();

    for (let index = 0; index < MAX_TRACKED_DOCUMENT_REQUESTS + 5; index += 1) {
      noteDocumentRequest(
        state,
        documentRequest({
          requestId: `r${String(index)}`,
          request: { url: `https://example.test/${String(index)}` },
        }),
      );
    }
    expect(state.documents.size).toBe(MAX_TRACKED_DOCUMENT_REQUESTS);

    // The five oldest fell off — a page cannot make this process remember
    // more document loads than it will ever complete.
    for (let index = 0; index < 5; index += 1) {
      expect(takeDocumentLoadFinished(state, { requestId: `r${String(index)}` })).toBeNull();
    }
    // The newest is still there, and still pairs.
    const newest = MAX_TRACKED_DOCUMENT_REQUESTS + 4;
    expect(takeDocumentLoadFinished(state, { requestId: `r${String(newest)}` })).toEqual({
      type: 'load',
      payload: { url: `https://example.test/${String(newest)}` },
    });
  });
});

describe('the trust boundary', () => {
  it('never throws on hostile params, and every row it emits is well formed', () => {
    const state = createNavPairingState();
    const hostile: ReadonlyArray<Record<string, unknown>> = [
      {},
      { frame: null },
      { frame: { id: 42, url: {} } },
      { frame: { id: 'F'.repeat(10_000), url: 'https://example.test/' } },
      { frame: { id: 'F', url: 'x'.repeat(100_000) } },
      { requestId: { toString: 'nope' }, frameId: [], type: 'Document' },
      {
        requestId: 'r'.repeat(10_000),
        frameId: MAIN_FRAME,
        type: 'Document',
        request: { url: 'https://e.test/' },
      },
      { requestId: 'r1', frameId: 5, type: 'Document', request: { url: {} } },
      { requestId: null, type: 'Document' },
      { requestId: 'x'.repeat(10_000) },
    ];

    for (const params of hostile) {
      expect(() => noteDocumentRequest(state, params)).not.toThrow();
      for (const row of [
        noteFrameNavigated(state, params),
        takeDocumentLoadFinished(state, params),
      ]) {
        if (row !== null) {
          expect(NAV_TRACE_TYPES).toContain(row.type);
          expect(typeof row.payload['url']).toBe('string');
          expect((row.payload['url'] as string).length).toBeLessThanOrEqual(CDP_PAYLOAD_LIMITS.url);
        }
      }
    }
    // An oversized token is dropped, not truncated into a lookup key.
    expect(state.documents.size).toBe(0);
  });
});
