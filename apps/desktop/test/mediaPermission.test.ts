import { describe, expect, it } from 'vitest';
import { permitMedia, registerMediaPermissions } from '../src/mediaPermission';

describe('D-221 — the microphone is the only media the app grants', () => {
  it('grants audio capture to the app’s own renderer', () => {
    expect(permitMedia({ permission: 'media', mediaTypes: ['audio'], trusted: true })).toBe(true);
  });

  it('refuses the camera, even alongside the microphone', () => {
    expect(permitMedia({ permission: 'media', mediaTypes: ['video'], trusted: true })).toBe(false);
    expect(
      permitMedia({ permission: 'media', mediaTypes: ['audio', 'video'], trusted: true }),
    ).toBe(false);
  });

  it('refuses a request that names no media type', () => {
    expect(permitMedia({ permission: 'media', mediaTypes: [], trusted: true })).toBe(false);
  });

  it('refuses contents that are not one of the app’s windows', () => {
    expect(permitMedia({ permission: 'media', mediaTypes: ['audio'], trusted: false })).toBe(false);
  });

  it('grants clipboard writes and fullscreen to the app’s own renderer only', () => {
    for (const permission of ['clipboard-sanitized-write', 'fullscreen']) {
      expect(permitMedia({ permission, mediaTypes: [], trusted: true })).toBe(true);
      expect(permitMedia({ permission, mediaTypes: [], trusted: false })).toBe(false);
    }
  });

  it('refuses every permission the renderer does not use, even to the renderer', () => {
    for (const permission of [
      'notifications',
      'geolocation',
      'clipboard-read',
      'midi',
      'midiSysex',
      'openExternal',
      'pointerLock',
      'hid',
      'serial',
      'usb',
    ]) {
      expect(permitMedia({ permission, mediaTypes: [], trusted: true })).toBe(false);
    }
  });

  it('wires both the request and the check through the same rule', () => {
    let request:
      | Parameters<
          Parameters<typeof registerMediaPermissions>[0]['session']['setPermissionRequestHandler']
        >[0]
      | undefined;
    let check:
      | Parameters<
          Parameters<typeof registerMediaPermissions>[0]['session']['setPermissionCheckHandler']
        >[0]
      | undefined;
    registerMediaPermissions({
      session: {
        setPermissionRequestHandler: (handler) => (request = handler),
        setPermissionCheckHandler: (handler) => (check = handler),
      },
      isRendererContents: (contents) => contents.id === 1,
    });
    const answers: boolean[] = [];
    request?.({ id: 1 }, 'media', (granted) => answers.push(granted), { mediaTypes: ['audio'] });
    request?.({ id: 2 }, 'media', (granted) => answers.push(granted), { mediaTypes: ['audio'] });
    expect(answers).toEqual([true, false]);
    expect(check?.({ id: 1 }, 'media', 'file://', { mediaType: 'audio' })).toBe(true);
    expect(check?.({ id: 1 }, 'media', 'file://', { mediaType: 'video' })).toBe(false);
    expect(check?.(null, 'media', 'file://', { mediaType: 'audio' })).toBe(false);
  });
});
