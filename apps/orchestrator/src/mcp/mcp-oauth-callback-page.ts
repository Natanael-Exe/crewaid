import type { McpOAuthCallbackOutcome } from './mcp-oauth.js';

/**
 * What the user's browser shows when the redirect comes back.
 *
 * Why a page, and why this page holds nothing
 *
 * The redirect lands in the SYSTEM browser — MCP plugins makes that explicit: the
 * flow is browser-based (RFC 8252's premise is that a native app cannot hold a
 * session) and Electron learns the outcome by polling, not by being the
 * redirect target. So this page is the only thing a person sees at the end of
 * the trip, and it has exactly one job: say whether it worked.
 *
 * It carries no script, no form, no cookie and no secret. Every decision was
 * made server-side before the HTML was rendered; a page that could not act on
 * anything is a page that cannot be made to act.
 *
 * The copy is here because the facts are not
 *
 * The flow decides what happened (`McpOAuthCallbackOutcome`, in mcp-oauth.ts);
 * which sentence that becomes is decided here. One file to read when the
 * wording is wrong, and no wording in the module that also touches a token.
 *
 * The escaping is the security boundary
 *
 * `detail` is a sentence built from an authorization server's `error` and
 * `error_description`, and `serverName` is whatever an operator typed. Both
 * are third-party strings arriving through a URL, and both are escaped here —
 * at the single point where either becomes markup. CSP `default-src 'none'`
 * would not save a page from a `</p><script>` that a provider had put in its
 * own error text.
 */

const CALLBACK_STYLE = `
  :root { color-scheme: dark; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0b0b0f; color: #f4f4f6;
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  main { max-width: 30rem; padding: 2.5rem; }
  h1 { margin: 0 0 0.5rem; font-size: 1.35rem; letter-spacing: -0.01em; }
  p { margin: 0 0 0.5rem; color: #b9b9c4; }
  main.ok h1 { color: #7ee0a8; }
  main.failed h1 { color: #f0a8a8; }
  .detail { color: #8f8f9c; font-size: 0.9rem; }
`;

type Page = {
  readonly ok: boolean;
  readonly title: string;
  readonly body: string;
  readonly detail?: string;
};

/**
 * One sentence per outcome, in the order the reader needs them.
 *
 * Every refusal says the same three things — what did not happen, what state
 * the server is in because of it, and what to do next — because the person
 * reading this is in a browser tab with no other information, and "an error
 * occurred" would send them to the plugin modal to guess.
 */
export function callbackPageFor(outcome: McpOAuthCallbackOutcome): Page {
  if (outcome.ok) {
    return {
      ok: true,
      title: 'Connected',
      body: `“${outcome.serverName}” is connected.`,
      detail: `Crewaid already knows about ${count(outcome.toolCount, 'tool')} on it — you can close this tab.`,
    };
  }

  const detail = outcome.detail;
  switch (outcome.code) {
    case 'invalid-request':
      return {
        ok: false,
        title: 'This link is not a callback',
        body: 'It arrived without the parameters that name a connection attempt, so nothing was changed.',
        ...(detail === undefined ? {} : { detail }),
      };
    case 'unknown-state':
      return {
        ok: false,
        title: 'This link is no longer valid',
        body:
          'The connection attempt it names was already finished, replaced by a newer one, or is ' +
          'not one this orchestrator started. Nothing was connected — start it again from Crewaid.',
      };
    case 'expired':
      return {
        ok: false,
        title: 'This link expired',
        body:
          'A connection attempt is good for ten minutes, and this one took longer. Nothing was ' +
          'connected — start it again from Crewaid.',
      };
    case 'other-account':
      return {
        ok: false,
        title: 'This connection belongs to another account',
        body:
          'This browser is signed in to a different Crewaid account than the one that started ' +
          'the connection, so nothing was connected. If you did not start it, you can ignore ' +
          'this page. Otherwise, start Connect again from Crewaid while signed in to that account.',
      };
    case 'denied':
      return {
        ok: false,
        title: 'Access was not granted',
        body: 'The provider did not grant access. Any previous connection was left unchanged.',
        ...(detail === undefined ? {} : { detail }),
      };
    case 'exchange-failed':
      return {
        ok: false,
        title: 'The authorization code was rejected',
        body:
          'The provider sent a code back, but this orchestrator could not turn it into a token. ' +
          'Nothing was stored. Any previous connection was left unchanged.',
        ...(detail === undefined ? {} : { detail }),
      };
    case 'storage-failed':
      return {
        ok: false,
        title: 'The credential could not be saved',
        body: 'Nothing was connected by this attempt. Start Connect again from Crewaid after the storage problem is resolved.',
        ...(detail === undefined ? {} : { detail }),
      };
    case 'tools-failed':
      return {
        ok: false,
        title: 'Connected, but the server did not answer',
        body:
          'The credential was stored. Listing this server’s tools failed, so Crewaid shows the ' +
          'error on its card and the listing can be retried there.',
        ...(detail === undefined ? {} : { detail }),
      };
  }
}

/**
 * Render one page.
 *
 * The nonce is per response and the style block is the only inline content the
 * browser will run: this is the orchestrator's own origin, and an allowance
 * for every response is an allowance for every response.
 */
export function renderMcpOAuthCallbackPage(
  outcome: McpOAuthCallbackOutcome,
  nonce: string,
): string {
  const page = callbackPageFor(outcome);
  const detail =
    page.detail === undefined ? '' : `\n<p class="detail">${escapeHtml(page.detail)}</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(page.title)}</title>
<style nonce="${escapeHtml(nonce)}">${CALLBACK_STYLE}</style>
</head>
<body>
<main class="${page.ok ? 'ok' : 'failed'}">
<h1>${escapeHtml(page.title)}</h1>
<p>${escapeHtml(page.body)}</p>${detail}
</main>
</body>
</html>
`;
}

/**
 * The headers this page is served with.
 *
 * `no-store` because the URL carries a state and a code, and a cached copy of
 * the page is a copy of that URL in a disk cache. `no-referrer` for the reason
 * the sign-in page sets it: any link followed from here would hand the whole
 * query string to whoever is linked.
 */
export const MCP_OAUTH_CALLBACK_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
} as const;

/** CSP for a page whose only inline content is a nonce-bound style block. */
export function callbackContentSecurityPolicy(nonce: string): string {
  return (
    `default-src 'none'; style-src 'nonce-${nonce}'; img-src data:; ` +
    `form-action 'none'; base-uri 'none'; frame-ancestors 'none'`
  );
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

/** Escape for an HTML text position. The one place third-party text becomes markup. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
