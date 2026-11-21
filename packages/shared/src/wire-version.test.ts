import { describe, expect, it } from 'vitest';

import {
  WIRE_VERSION,
  WIRE_VERSION_UNSTAMPED,
  readClientEnvelope,
  readServerFrame,
  readWireVersion,
  stampWireVersion,
} from './ws.js';

/**
 * CC-19 / D-071 — the envelope's version, and the failure it exists to name.
 *
 * The §4.2 envelope carried no version, so a desktop meeting a frame it did
 * not understand reported "invalid server event" — indistinguishable from a
 * corrupt frame, with no way for the operator to learn their build is behind.
 * Everything below is about keeping those two answers apart.
 */
const FRAME = {
  id: '5c3f1d6a-21a4-4a7b-9f05-0c9c2a6b1f2e',
  type: 'bot.status' as const,
  ts: 1_700_000_000_000,
  payload: { botId: 'clx1a2b3c4d5e6f7g8h9i0j1', status: 'IDLE' },
};

describe('CC-19 the wire version is stamped on write', () => {
  it('puts the current version on an outgoing frame and changes nothing else', () => {
    const stamped = stampWireVersion(FRAME);
    expect(stamped.wireVersion).toBe(WIRE_VERSION);
    // The rest of the envelope is untouched: stamping is an addition, not a
    // rewrite, and a frame that lost its id on the way out would be worse
    // than one with no version.
    expect(stamped).toMatchObject(FRAME);
  });
});

describe('CC-19 an unstamped frame is version zero, not "unknown"', () => {
  it('reads a missing version as zero', () => {
    // Every frame written before D-071 is a v0 frame. A reader that treated
    // "no version" as "current" could not normalise one, which is what makes
    // a newer desktop able to read an older orchestrator at all.
    expect(readWireVersion({ ...FRAME })).toBe(WIRE_VERSION_UNSTAMPED);
  });

  it('reads a version that is not a whole number as zero', () => {
    // The sender is not trusted to send a sane value any more than it is
    // trusted to send a sane payload. A garbage version must not become NaN
    // and compare false against every bound.
    for (const wireVersion of ['2', 1.5, -1, null, {}, Number.NaN]) {
      expect(readWireVersion({ ...FRAME, wireVersion })).toBe(WIRE_VERSION_UNSTAMPED);
    }
  });

  it('accepts an unstamped frame and reports the version it was read at', () => {
    const read = readServerFrame({ ...FRAME });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.wireVersion).toBe(WIRE_VERSION_UNSTAMPED);
    expect(read.frame.type).toBe('bot.status');
  });

  it('accepts a frame stamped with the current version', () => {
    const read = readServerFrame(stampWireVersion(FRAME));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.wireVersion).toBe(WIRE_VERSION);
  });
});

describe('CC-19 a newer frame is an actionable failure, not a broken one', () => {
  it('refuses a frame from a newer build and names both versions', () => {
    const read = readServerFrame({ ...FRAME, wireVersion: WIRE_VERSION + 1 });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe('unsupported-version');
    if (read.reason !== 'unsupported-version') return;
    // Both numbers, because "update your app" without saying from what to
    // what is the same dead end in nicer words.
    expect(read.wireVersion).toBe(WIRE_VERSION + 1);
    expect(read.supported).toBe(WIRE_VERSION);
  });

  it('refuses it BEFORE parsing, so an unknown member does not read as broken', () => {
    // The case this ordering is for: a v2 frame whose `type` this build has
    // never heard of. Parsed first, it fails the union and reports
    // "malformed" — which is the unactionable answer CC-19 replaces.
    const read = readServerFrame({
      id: FRAME.id,
      type: 'something.this.build.has.never.heard.of',
      ts: FRAME.ts,
      wireVersion: WIRE_VERSION + 1,
      payload: {},
    });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe('unsupported-version');
  });

  it('still calls a broken frame at a supported version malformed', () => {
    // The other direction, and the one that would make the code useless if it
    // were wrong: a corrupt frame must not be reported as a version problem
    // and send an operator off to update a build that is already current.
    const read = readServerFrame({ ...FRAME, payload: { messageId: 'not-a-cuid' } });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe('malformed');
  });
});

describe('CC-19 the client envelope is read the same way', () => {
  const CLIENT = {
    id: '5c3f1d6a-21a4-4a7b-9f05-0c9c2a6b1f2e',
    type: 'bot.cancel',
    ts: 1_700_000_000_000,
    payload: { botId: 'clx1a2b3c4d5e6f7g8h9i0j1' },
  };

  it('accepts an unstamped client frame — an existing desktop keeps working', () => {
    // The whole reason the field is optional on read. Requiring it would
    // refuse every frame from an existing client the moment this shipped.
    expect(readClientEnvelope(CLIENT).ok).toBe(true);
  });

  it('refuses a client frame from a newer build', () => {
    const read = readClientEnvelope({ ...CLIENT, wireVersion: WIRE_VERSION + 1 });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe('unsupported-version');
  });
});
