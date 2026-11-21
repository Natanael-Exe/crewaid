/**
 * The last step of an authenticated download: put fetched bytes where the
 * operator asked for them.
 *
 * Attachments arrive as a Blob rather than as a link (see `api/attachments.ts`
 * for why), so the browser's own "follow this href" path is not available. A
 * blob URL on a `download` anchor hands the transfer back to Electron's
 * download manager, which is where the download shelf, the save location and
 * the "Show in Finder" affordance already live — the bytes take a detour
 * through the renderer, but the operator's experience does not change.
 *
 * The ports exist for the reason `wsClient` injects its socket factory: the
 * desktop suite renders with `renderToStaticMarkup` and has no DOM, so a module
 * that reached for `document` directly would be untestable here.
 */
export interface BlobSaverPorts {
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  /** Starts the transfer. Split from URL lifetime so revocation is observable. */
  startDownload: (url: string, filename: string) => void;
  setTimeoutFn: (handler: () => void, ms: number) => void;
}

export const domBlobSaverPorts: BlobSaverPorts = {
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
  startDownload: (url, filename) => {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  },
  setTimeoutFn: (handler, ms) => {
    globalThis.setTimeout(handler, ms);
  },
};

/**
 * Revocation is deferred by a task rather than run in a `finally`.
 *
 * `click()` only *starts* the transfer; a blob URL revoked in the same task can
 * be gone before the download manager reads it, and the failure mode is a
 * silently truncated file rather than an error. A URL leaked by a failed
 * timer costs one blob until the window closes — the cheaper of the two.
 */
const REVOKE_AFTER_MS = 0;

export function saveBlobAs(
  blob: Blob,
  filename: string,
  ports: BlobSaverPorts = domBlobSaverPorts,
): void {
  const url = ports.createObjectURL(blob);
  try {
    ports.startDownload(url, filename);
  } catch (error: unknown) {
    // Nothing was started, so the URL can go back immediately.
    ports.revokeObjectURL(url);
    throw error;
  }
  ports.setTimeoutFn(() => ports.revokeObjectURL(url), REVOKE_AFTER_MS);
}
