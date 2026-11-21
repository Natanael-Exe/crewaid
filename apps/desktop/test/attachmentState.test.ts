import { describe, expect, it } from 'vitest';
import {
  botSwitched,
  canSend,
  draftChanged,
  send,
  stop,
  type ComposerState,
} from '../src/renderer/components/composer/composerState';
import {
  ALLOWED_MIME,
  MAX_UPLOAD_BYTES,
  attachmentErrorTone,
  claimableIds,
  hasInFlight,
  normalizeAttachmentError,
  pendingAdded,
  pendingRemoved,
  pendingStatus,
  validateFile,
  type PendingAttachment,
  type PendingMap,
} from '../src/renderer/components/attachments/attachmentState';

/**
 * M1-FE-08 — attachment state machine + error normalization tests.
 * The 404/409/410 cases encode the D-020/D-021 fences; 400/413 the upload
 * guards. The UI contract: normalized copy only, never a raw server string.
 */

describe('validateFile (client pre-flight mirrors server guards)', () => {
  it('accepts every MIME on the server allowlist', () => {
    for (const type of ALLOWED_MIME) {
      expect(validateFile({ size: 10, type })).toBeNull();
    }
  });

  it('rejects empty files before the network', () => {
    expect(validateFile({ size: 0, type: 'text/plain' })?.code).toBe('INVALID_FILE');
  });

  it('rejects files over 25 MB before the network', () => {
    expect(validateFile({ size: MAX_UPLOAD_BYTES + 1, type: 'image/png' })?.code).toBe('TOO_LARGE');
  });

  it('rejects non-allowlisted MIME types', () => {
    expect(validateFile({ size: 10, type: 'application/x-msdownload' })?.code).toBe('INVALID_FILE');
  });

  it('lets the server decide unknown browser MIME (empty string)', () => {
    expect(validateFile({ size: 10, type: '' })).toBeNull();
  });
});

describe('normalizeAttachmentError (status → normalized copy)', () => {
  it('400 → INVALID_FILE with neutral copy', () => {
    const e = normalizeAttachmentError(400, 'Unsupported media type: application/x-evil');
    expect(e.code).toBe('INVALID_FILE');
    expect(e.message).not.toContain('x-evil'); // vendor string never surfaces
    expect(e.detail).toBe('Unsupported media type: application/x-evil'); // logs only
  });

  it('413 → TOO_LARGE', () => {
    expect(normalizeAttachmentError(413).code).toBe('TOO_LARGE');
  });

  it('404 → NOT_FOUND (non-leaking: unknown ≡ foreign)', () => {
    expect(normalizeAttachmentError(404).code).toBe('NOT_FOUND');
  });

  it('409 → ALREADY_CLAIMED (D-020 addendum fence)', () => {
    expect(normalizeAttachmentError(409).code).toBe('ALREADY_CLAIMED');
  });

  it('410 → EXPIRED (24h interim TTL, D-020 ratified)', () => {
    expect(normalizeAttachmentError(410).code).toBe('EXPIRED');
  });

  it('transport failure → NETWORK', () => {
    expect(normalizeAttachmentError(undefined).code).toBe('NETWORK');
  });

  it('unexpected status → UNKNOWN with neutral copy', () => {
    expect(normalizeAttachmentError(503).code).toBe('UNKNOWN');
  });
});

describe('attachmentErrorTone (PO chip mapping on M1-FE-08)', () => {
  it('404 NOT_FOUND and 409 ALREADY_CLAIMED are danger (hard failures)', () => {
    expect(attachmentErrorTone('NOT_FOUND')).toEqual({ color: 'danger', variant: 'soft' });
    expect(attachmentErrorTone('ALREADY_CLAIMED')).toEqual({ color: 'danger', variant: 'soft' });
  });

  it('410 EXPIRED and 413 TOO_LARGE are warning (recoverable by re-attaching)', () => {
    expect(attachmentErrorTone('EXPIRED')).toEqual({ color: 'warning', variant: 'soft' });
    expect(attachmentErrorTone('TOO_LARGE')).toEqual({ color: 'warning', variant: 'soft' });
  });

  it('400/NETWORK/UNKNOWN land on danger', () => {
    expect(attachmentErrorTone('INVALID_FILE').color).toBe('danger');
    expect(attachmentErrorTone('NETWORK').color).toBe('danger');
    expect(attachmentErrorTone('UNKNOWN').color).toBe('danger');
  });
});

describe('pending attachment lifecycle', () => {
  const file = new File(['col1,col2\n1,2\n'], 'leads.csv', { type: 'text/csv' });
  const a: PendingAttachment = { localId: 'l1', file, status: 'queued' };
  const b: PendingAttachment = { localId: 'l2', file, status: 'ready', remoteId: 'att_9' };

  it('add → status → ready exposes claimable ids', () => {
    let list: PendingMap = pendingAdded({}, a);
    list = pendingStatus(list, 'l1', 'uploading');
    expect(claimableIds(list)).toEqual([]);
    list = pendingStatus(list, 'l1', 'ready', { remoteId: 'att_1' });
    expect(claimableIds(list)).toEqual(['att_1']);
    expect(hasInFlight(list)).toBe(false);
  });

  it('ready requires a remote id to be claimable', () => {
    const list = pendingStatus(pendingAdded({}, a), 'l1', 'ready');
    expect(claimableIds(list)).toEqual([]);
  });

  it('error keeps the item visible for retry/remove, never claimable', () => {
    let list: PendingMap = pendingAdded({}, a);
    list = pendingStatus(list, 'l1', 'error', {
      error: { code: 'TOO_LARGE', message: 'File exceeds the 25 MB limit.' },
    });
    expect(claimableIds(list)).toEqual([]);
    expect(hasInFlight(list)).toBe(false);
    expect(list['l1']?.error?.code).toBe('TOO_LARGE');
  });

  it('remove drops the chip', () => {
    let list: PendingMap = pendingAdded(pendingAdded({}, a), b);
    list = pendingRemoved(list, 'l1');
    expect(Object.keys(list)).toEqual(['l2']);
  });
});

describe('D-023 send gate — text OR attachment, never empty-nothing', () => {
  const idleEmpty: ComposerState = { mode: 'idle', draft: '' };
  const idleText: ComposerState = { mode: 'idle', draft: 'hello' };
  const active: ComposerState = { mode: 'active', draft: 'hello' };

  it('text alone sends', () => {
    expect(canSend(idleText)).toBe(true);
    expect(send(idleText)).not.toBeNull();
  });

  it('attachment alone sends (absent or empty text, per the D-023 ruling)', () => {
    expect(canSend(idleEmpty, true)).toBe(true);
    expect(send(idleEmpty, true)).toEqual({ mode: 'active', draft: '' });
    expect(canSend({ mode: 'idle', draft: '   ' }, true)).toBe(true);
  });

  it('empty-nothing never sends and never reaches the network', () => {
    expect(canSend(idleEmpty, false)).toBe(false);
    expect(send(idleEmpty, false)).toBeNull();
    expect(canSend({ mode: 'idle', draft: '   ' }, false)).toBe(false);
  });

  it('streaming mode blocks send regardless of attachments', () => {
    expect(canSend(active, true)).toBe(false);
    expect(send(active, true)).toBeNull();
  });
});
