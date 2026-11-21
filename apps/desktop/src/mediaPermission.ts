/**
 * The microphone, for dictation and voice messages — and every other
 * permission a page in this app could ask for.
 *
 * Electron grants every permission request by default, the camera included,
 * and from any page a window ever shows. The renderer needs three: audio
 * capture for voice, clipboard writes and a video's fullscreen, all asked for
 * by this app's own renderer. Those are granted to it and nothing is
 * granted to anything else — geolocation, notifications, MIDI or a clipboard
 * READ are capabilities nobody here asked for, and a default that hands them
 * to whatever page a window shows is the wrong default.
 *
 * The decisions are pure and exported, because a rule that can only be
 * exercised through Electron is a rule nobody tests.
 */

export type MediaRequest = {
  readonly permission: string;
  /** `details.mediaTypes` on a request; a check names one `mediaType`. */
  readonly mediaTypes: readonly string[];
  /** The asking contents is one of this app's own renderer windows. */
  readonly trusted: boolean;
};

/**
 * Permissions the renderer uses that carry no media types: its copy buttons,
 * and the fullscreen button on a video preview's native controls.
 */
const RENDERER_PERMISSIONS: ReadonlySet<string> = new Set([
  'clipboard-sanitized-write',
  'fullscreen',
]);

/** Whether a permission request or check is granted. */
export function permitMedia(request: MediaRequest): boolean {
  if (request.permission !== 'media') {
    return request.trusted && RENDERER_PERMISSIONS.has(request.permission);
  }
  return (
    request.trusted &&
    request.mediaTypes.length > 0 &&
    request.mediaTypes.every((type) => type === 'audio')
  );
}

type ContentsLike = { readonly id: number };

/** The slice of Electron's `Session` this file uses. */
export type PermissionSessionLike = {
  setPermissionRequestHandler(
    handler: (
      contents: ContentsLike,
      permission: string,
      callback: (granted: boolean) => void,
      // Electron's is a union over request kinds; only a media request has types.
      details: object,
    ) => void,
  ): void;
  setPermissionCheckHandler(
    handler: (
      contents: ContentsLike | null,
      permission: string,
      requestingOrigin: string,
      details: { readonly mediaType?: string },
    ) => boolean,
  ): void;
};

export function registerMediaPermissions(options: {
  readonly session: PermissionSessionLike;
  /** Whether these contents belong to one of this app's renderer windows. */
  readonly isRendererContents: (contents: ContentsLike) => boolean;
}): void {
  const { session, isRendererContents } = options;
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(
      permitMedia({
        permission,
        mediaTypes: mediaTypesOf(details),
        trusted: isRendererContents(contents),
      }),
    );
  });
  session.setPermissionCheckHandler((contents, permission, _origin, details) =>
    permitMedia({
      permission,
      mediaTypes: details.mediaType === undefined ? [] : [details.mediaType],
      trusted: contents !== null && isRendererContents(contents),
    }),
  );
}

function mediaTypesOf(details: object): readonly string[] {
  const types: unknown = 'mediaTypes' in details ? details.mediaTypes : undefined;
  return Array.isArray(types)
    ? types.filter((type): type is string => typeof type === 'string')
    : [];
}
