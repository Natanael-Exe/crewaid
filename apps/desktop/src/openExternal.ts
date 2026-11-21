import { guardedIpc, type GuardedIpcOptions } from './tokenStore.js';

/**
 * Handing a URL to the operating system's browser.
 *
 * "The OAuth redirect target is an orchestrator route, not an Electron
 * deep link. Electron opens the authorize URL in the system browser and polls
 * `GET /mcp/servers/:id` for status." So the renderer, which is where the
 * authorize URL arrives, needs one thing it cannot do itself — and this is it.
 *
 * ⚠️ why the scheme is checked here and not in the renderer
 *
 * `shell.openExternal` is the widest capability in this app. It hands a string
 * to the OS, which decides what to run: `file:` opens a file manager,
 * `smb:`/`vbscript:`/a registered custom scheme can launch a program, and on
 * some platforms the handler is chosen by the string alone. The URL reaching
 * it here is a THIRD PARTY'S — it comes from an MCP server's own OAuth
 * discovery document, by way of the orchestrator — so it is exactly
 * the class of input that must not be trusted.
 *
 * The renderer could check it, and a renderer check is worth nothing: the
 * check has to be on the side of the boundary that holds the capability, or a
 * compromised renderer simply does not perform it. `https:` only, because that
 * is the only scheme an authorize URL can legitimately have and every
 * additional one is a capability nobody asked for.
 *
 * The result is a normalized verdict rather than a throw, like every other
 * channel behind `guardedIpc`: the renderer has to tell an operator something
 * either way, and "the browser did not open" is a sentence, not an exception.
 */

export type OpenExternalResult =
  | { readonly status: 'opened' }
  /** The URL was not one this app will hand to the OS. */
  | { readonly status: 'refused' }
  /** The OS was asked and said no, or the sender was not trusted. */
  | { readonly status: 'failed' };

const REFUSED: OpenExternalResult = { status: 'refused' };
const FAILED: OpenExternalResult = { status: 'failed' };
const OPENED: OpenExternalResult = { status: 'opened' };

export const OPEN_EXTERNAL_CHANNEL = 'crewaid:shell:openExternal';

/**
 * The URL this app will hand to the OS, or `null` for one it will not.
 *
 * It returns the url rather than a boolean, and that is the point
 *
 * A predicate would leave the caller opening the string it was GIVEN while
 * having checked the string as PARSED, and those are not always the same: the
 * URL parser trims surrounding whitespace, folds the scheme's case, and
 * rewrites `https:/\host` to `https://host`. Validating one value and handing
 * over another is the shape of every bypass this check exists to prevent, so
 * what comes back is the normalized href — what was judged is what is opened.
 *
 * Exported because it is the whole security property of this file, and a
 * property that can only be exercised through Electron is a property nobody
 * tests.
 *
 * The fence is about the SCHEME: an authorize URL is legitimately any host on
 * the internet, so there is nothing to allowlist there, and what must not get
 * through is a value the OS would hand to something other than a browser.
 */
export function openableUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  // Credentials in the authority are a phishing shape — the eye reads
  // `accounts.google.com` and the browser goes to `evil.test` — and no
  // authorize URL has them. Refused rather than stripped: rewriting a URL
  // somebody is about to be sent to is worse than declining to send them.
  if (url.username !== '' || url.password !== '') return null;
  return url.toString();
}

export type RegisterOpenExternalOptions = GuardedIpcOptions & {
  /** `shell.openExternal`, injected so the decision above is testable. */
  readonly open: (url: string) => Promise<void>;
};

export function registerOpenExternalIpc(options: RegisterOpenExternalOptions): void {
  const register = guardedIpc(options);
  register(
    OPEN_EXTERNAL_CHANNEL,
    async (value: unknown): Promise<OpenExternalResult> => {
      const url = openableUrl(value);
      if (url === null) return REFUSED;
      await options.open(url);
      return OPENED;
    },
    // An untrusted sender and a failed launch are both `failed` to the
    // renderer, deliberately: the second is something an operator can act on
    // (open it by hand), and the first must not be distinguishable from it by
    // anything that is probing this channel.
    { unauthorized: FAILED, failed: FAILED },
  );
}
