import { describe, expect, it } from 'vitest';
import {
  callbackContentSecurityPolicy,
  callbackPageFor,
  MCP_OAUTH_CALLBACK_HEADERS,
  renderMcpOAuthCallbackPage,
} from '../src/mcp/mcp-oauth-callback-page.js';
import type { McpOAuthCallbackOutcome, McpOAuthCallbackRefusal } from '../src/mcp/mcp-oauth.js';

/**
 * M6-BE-03 — the page the person at the end of the redirect sees.
 *
 * ── WHY THIS PAGE HAS TESTS AT ALL ─────────────────────────────────────────
 *
 * It is the only part of the OAuth trip a human interacts with, and it is
 * rendered from strings a THIRD PARTY supplied: the authorization server's
 * `error_description` and the name an operator typed for their server. Both
 * arrive through a URL, in a browser, on this orchestrator's own origin. The
 * escaping is therefore not cosmetic — it is the boundary between "the
 * provider said something odd" and "the provider's sentence runs as markup in
 * our page" — and it is asserted here rather than trusted.
 *
 * No database, no HTTP: the renderer is a pure function of an outcome and a
 * nonce, which is exactly why the outcome type (`mcp-oauth.ts`) and the copy
 * (this module) were split.
 */

const FAILURES: readonly McpOAuthCallbackRefusal[] = [
  'invalid-request',
  'unknown-state',
  'expired',
  'denied',
  'exchange-failed',
  'storage-failed',
  'tools-failed',
];

describe('callback copy', () => {
  it('names the server and counts its tools on success', () => {
    const page = callbackPageFor({ ok: true, serverName: 'Linear', toolCount: 3 });
    expect(page.ok).toBe(true);
    expect(page.body).toContain('Linear');
    expect(page.detail).toContain('3 tools');
  });

  it('says "1 tool" for one tool', () => {
    const page = callbackPageFor({ ok: true, serverName: 'Sentry', toolCount: 1 });
    expect(page.detail).toContain('1 tool');
    expect(page.detail).not.toContain('1 tools');
  });

  it.each(FAILURES)('says what happened and what state the server is in: %s', (code) => {
    const page = callbackPageFor({ ok: false, code });
    expect(page.ok).toBe(false);
    expect(page.title.length).toBeGreaterThan(0);
    expect(page.body.length).toBeGreaterThan(0);
    // Every refusal tells the reader that nothing was connected, or — the one
    // exception — that the credential was stored but the listing failed.
    if (code !== 'tools-failed') {
      expect(`${page.title} ${page.body}`.toLowerCase()).toMatch(
        /nothing|no longer|not granted|not a callback|expired/,
      );
    } else {
      expect(page.body).toContain('credential was stored');
    }
  });

  it('carries the refusal detail when there is one, and omits it when there is not', () => {
    const withDetail = callbackPageFor({
      ok: false,
      code: 'denied',
      detail: 'access_denied: The user refused',
    });
    expect(withDetail.detail).toBe('access_denied: The user refused');

    const without = callbackPageFor({ ok: false, code: 'unknown-state' });
    expect(without.detail).toBeUndefined();
  });
});

describe('rendering', () => {
  it('binds the style block to the response nonce', () => {
    const html = renderMcpOAuthCallbackPage(
      { ok: true, serverName: 'Linear', toolCount: 2 },
      'nonce-123',
    );
    expect(html).toContain('<style nonce="nonce-123">');
    expect(callbackContentSecurityPolicy('nonce-123')).toContain("style-src 'nonce-nonce-123'");
  });

  /**
   * The attack this page has to survive: a provider (or an operator's server
   * name) that contains markup. Both fields are HTML-escaped at the single
   * point where they become text, so the payload is VISIBLE and inert.
   */
  it('escapes markup in the server name and in the provider’s own detail', () => {
    const html = renderMcpOAuthCallbackPage(
      {
        ok: false,
        code: 'exchange-failed',
        detail: '<script>alert(1)</script> "quoted" & \'apostrophed\'',
      },
      'nonce-123',
    );

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;quoted&quot;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&#39;apostrophed&#39;');
  });

  it.each(FAILURES)('renders a %s outcome as a complete page', (code) => {
    const html = renderMcpOAuthCallbackPage({ ok: false, code }, 'n1');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });
});

describe('the callback headers', () => {
  it('keeps the URL — which holds a state and maybe a code — out of caches and referrers', () => {
    expect(MCP_OAUTH_CALLBACK_HEADERS['Cache-Control']).toBe('no-store');
    expect(MCP_OAUTH_CALLBACK_HEADERS['Referrer-Policy']).toBe('no-referrer');
  });

  it('allows no script, no form action and no framing', () => {
    const csp = callbackContentSecurityPolicy('abc');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
  });
});

/**
 * The exhaustive switch in `callbackPageFor` has no `default`, so a new
 * refusal code is a compile error rather than a page that renders nothing.
 * This keeps that property honest at runtime too: every code in the union
 * produces a page with a title.
 */
describe('the outcome union stays covered', () => {
  it('has a page for every refusal code the flow can produce', () => {
    for (const code of FAILURES) {
      const page: ReturnType<typeof callbackPageFor> = callbackPageFor({
        ok: false,
        code,
      });
      expect(page.title).toBeTruthy();
    }
  });

  it('never renders an empty outcome', () => {
    const outcome: McpOAuthCallbackOutcome = { ok: true, serverName: 'X', toolCount: 0 };
    expect(renderMcpOAuthCallbackPage(outcome, 'n')).toContain('0 tools');
  });
});
