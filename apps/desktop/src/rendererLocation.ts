/**
 * Where this app's own renderer lives, and whether a URL is it.
 *
 * The preload — and with it the token store — is attached to a WINDOW, not to
 * a page: whatever document that window shows gets `window.crewaid`. So "is
 * this one of our windows" is not enough for the IPC fence, and a window that
 * may navigate anywhere is a window that hands the session bearer to whatever
 * it navigated to. Both checks ask this file the same question.
 *
 * Pure, so the rule is tested without Electron.
 */

import { pathToFileURL } from 'node:url';

/**
 * The URL a renderer window loads.
 *
 * `ELECTRON_START_URL` is the Vite dev server, and only an unpackaged build
 * reads it: honoured in a shipped app, one environment variable points the
 * preload-bearing window at any page on the internet.
 */
export function rendererEntryUrl(options: {
  readonly packaged: boolean;
  readonly startUrl: string | undefined;
  readonly indexPath: string;
}): string {
  if (!options.packaged && options.startUrl !== undefined && options.startUrl !== '') {
    return options.startUrl;
  }
  return pathToFileURL(options.indexPath).href;
}

/**
 * Whether `candidate` is a document of the renderer loaded from `entry`.
 *
 * A file entry admits exactly that file, whatever its hash or query (the app
 * routes in-page); any other `file:` URL is a different document. A dev
 * server entry admits its origin. Anything unparseable is not ours.
 */
export function isRendererUrl(candidate: unknown, entry: string): boolean {
  if (typeof candidate !== 'string') return false;
  let target: URL;
  let expected: URL;
  try {
    target = new URL(candidate);
    expected = new URL(entry);
  } catch {
    return false;
  }
  if (expected.protocol === 'file:') {
    return (
      target.protocol === 'file:' && target.host === '' && target.pathname === expected.pathname
    );
  }
  if (expected.protocol === 'http:' || expected.protocol === 'https:') {
    return target.origin === expected.origin;
  }
  return false;
}
