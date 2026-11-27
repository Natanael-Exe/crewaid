import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';

/**
 * Importing the guard reaches `better-auth.ts`, which builds its own Prisma
 * client at module scope — and that throws without `DATABASE_URL`. That throw
 * is right for production (a misconfigured orchestrator must fail at boot) and
 * it would otherwise make this suite need Postgres just to construct a class.
 *
 * A placeholder is enough because nothing here connects: every case below is
 * decided from the request path, before any session lookup. A real value is
 * left alone so this reads identically on a developer machine and in CI.
 */
process.env['DATABASE_URL'] ??= 'postgresql://unused:unused@127.0.0.1:1/never-connected';

/**
 * M1-BE-01 / V1-08 — what the AuthGuard decides BEFORE it looks anything up
 * (§4.4, R7).
 *
 * ── WHY THIS SUITE SHRANK, AND WHAT TOOK THE REST ───────────────────────────
 *
 * It used to prove the whole guard without a database, because the guard was
 * a string comparison against `ORCH_API_TOKEN`. A session cannot be judged
 * that way: `auth.api.getSession` reads a row, so every case about a
 * CREDENTIAL now needs Postgres and lives in
 * `auth-session.integration.test.ts` — accepting a live session, refusing an
 * expired or revoked one, refusing a forged token, and resolving two sessions
 * to two principals.
 *
 * What is left here is the part that still decides on the request alone: which
 * paths skip authentication entirely. That is deliberately the part kept
 * DB-free, because it is the only logic in the guard that can fail OPEN. A
 * wrong answer about a credential is a 401 someone reports within the hour; a
 * wrong answer about an exemption is a route nobody is asked to authenticate
 * for, and nothing about the response says so. Keeping it runnable without a
 * database means it also runs on the checkouts where the integration suite
 * silently skips.
 */
describe('AuthGuard exemptions (§4.4, no database)', () => {
  interface FakeRequest {
    method: string;
    path?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    principal?: unknown;
  }

  function contextFor(request: FakeRequest): ExecutionContext {
    return {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }

  async function newGuard(): Promise<{
    canActivate: (c: ExecutionContext) => boolean | Promise<boolean>;
  }> {
    const { AuthGuard } = await import('../src/auth/auth.guard.js');
    return new AuthGuard();
  }

  it.each([
    ['GET /health', { method: 'GET', path: '/health' }],
    [
      'Telegram manager webhook',
      { method: 'POST', path: '/api/v1/channels/telegram/manager/webhook' },
    ],
    [
      'Telegram manager webhook without prefix',
      { method: 'POST', path: '/channels/telegram/manager/webhook' },
    ],
    [
      'Telegram bot webhook',
      { method: 'POST', path: '/api/v1/channels/telegram/bots/123/webhook' },
    ],
    [
      'Telegram bot webhook without prefix',
      { method: 'POST', path: '/channels/telegram/bots/123/webhook' },
    ],
    ['GET /health with a query string', { method: 'GET', path: '/health?probe=1' }],
    ['GET /api/v1/health (prefix-enabled bootstraps)', { method: 'GET', path: '/api/v1/health' }],
    // Nest populates `path`; a bare Node request carries only `url`.
    ['GET /health via url alone', { method: 'GET', url: '/health?ready=1' }],
  ])('exempts %s without a credential, and attaches no Principal', async (_name, details) => {
    const guard = await newGuard();
    const request: FakeRequest = { ...details, headers: {} };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    // An exemption that attached a Principal would be worse than the 401 it
    // replaced: the handler would run as somebody.
    expect(request.principal).toBeUndefined();
  });

  /**
   * Signing in cannot require being signed in, so this tree is exempt — which
   * makes its EDGES the thing to pin. A `startsWith('/api/v1/auth')` with no
   * separator check also exempts `/api/v1/authorised-only`, and a route added
   * under that name months from now would ship unauthenticated with nothing to
   * notice it.
   */
  it.each([
    ['the base path itself', '/api/v1/auth'],
    ['a sign-in route', '/api/v1/auth/sign-in/magic-link'],
    ['an OAuth callback', '/api/v1/auth/callback/google'],
    ['the session read', '/api/v1/auth/session'],
    ['a query string', '/api/v1/auth/callback/github?code=abc123'],
  ])('exempts %s', async (_name, path) => {
    const guard = await newGuard();
    const request: FakeRequest = { method: 'GET', path, headers: {} };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.principal).toBeUndefined();
  });

  /**
   * M6-BE-03's callback is the third exemption and the only one that is a
   * single PATH rather than a tree. Both spellings, because the request path
   * depends on whether the app booted with the global prefix — and both are
   * exact equalities, which is the property the cases below pin.
   */
  it.each([
    ['GET /api/v1/mcp/oauth/callback', '/api/v1/mcp/oauth/callback'],
    ['GET /mcp/oauth/callback (prefix-less bootstraps)', '/mcp/oauth/callback'],
    ['GET /api/v1/mcp/oauth/callback with a query', '/api/v1/mcp/oauth/callback?state=s&code=c'],
  ])('exempts %s, and attaches no Principal', async (_name, path) => {
    const guard = await newGuard();
    const request: FakeRequest = { method: 'GET', path, headers: {} };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    // The `state` in the query is the whole authority on this path; a
    // Principal here would mean the guard had invented one.
    expect(request.principal).toBeUndefined();
  });

  it.each([
    // Not the method the redirect uses: an OAuth callback is a GET, and a
    // POST to this path is somebody else's request.
    ['POST /api/v1/mcp/oauth/callback', { method: 'POST', path: '/api/v1/mcp/oauth/callback' }],
    // The separator cases. A `startsWith` exemption would wave all three of
    // these through, and the third is the one a future route could be added
    // under without anybody revisiting this list.
    [
      'GET /api/v1/mcp/oauth/callback/extra',
      { method: 'GET', path: '/api/v1/mcp/oauth/callback/extra' },
    ],
    ['GET /api/v1/mcp/oauth/callback-x', { method: 'GET', path: '/api/v1/mcp/oauth/callback-x' }],
    ['GET /mcp/oauth/callback/extra', { method: 'GET', path: '/mcp/oauth/callback/extra' }],
    ['GET /api/v1/mcp/oauth', { method: 'GET', path: '/api/v1/mcp/oauth' }],
  ])('does not exempt %s', async (_name, details) => {
    const guard = await newGuard();
    const request: FakeRequest = { ...details, headers: {} };

    await expect(guard.canActivate(contextFor(request))).rejects.toThrow('Unauthorized');
    expect(request.principal).toBeUndefined();
  });

  it.each([
    ['POST /health', { method: 'POST', path: '/health' }],
    [
      'GET Telegram manager webhook',
      { method: 'GET', path: '/api/v1/channels/telegram/manager/webhook' },
    ],
    [
      'GET Telegram bot webhook',
      { method: 'GET', path: '/api/v1/channels/telegram/bots/1/webhook' },
    ],
    [
      'Telegram bot webhook with a non-numeric id',
      { method: 'POST', path: '/api/v1/channels/telegram/bots/abc/webhook' },
    ],
    [
      'Telegram bot webhook descendant',
      { method: 'POST', path: '/api/v1/channels/telegram/bots/1/webhook/x' },
    ],
    [
      'Telegram bot webhook with two segments',
      { method: 'POST', path: '/api/v1/channels/telegram/bots/1/2/webhook' },
    ],
    [
      'Telegram manager webhook descendant',
      { method: 'POST', path: '/api/v1/channels/telegram/manager/webhook/other' },
    ],
    ['the retired shared webhook', { method: 'POST', path: '/api/v1/channels/telegram/webhook' }],
    ['Telegram link', { method: 'POST', path: '/api/v1/channels/telegram/link' }],
    ['Telegram bot token', { method: 'POST', path: '/api/v1/channels/telegram/bot' }],
    ['Telegram confirm', { method: 'POST', path: '/api/v1/channels/telegram/confirm' }],
    ['Telegram status', { method: 'GET', path: '/api/v1/channels/telegram' }],
    ['Telegram disconnect', { method: 'DELETE', path: '/api/v1/channels/telegram' }],
    ['GET /api/v1/bots/health', { method: 'GET', path: '/api/v1/bots/health' }],
    ['GET /v2/health', { method: 'GET', path: '/v2/health' }],
    // The separator cases. Both share the exempt prefix as a STRING and
    // neither is inside the tree.
    ['GET /api/v1/authorised-only', { method: 'GET', path: '/api/v1/authorised-only' }],
    ['GET /api/v1/authors', { method: 'GET', path: '/api/v1/authors' }],
  ])('does not exempt %s', async (_name, details) => {
    const guard = await newGuard();
    const request: FakeRequest = { ...details, headers: {} };

    // Reaches the session lookup rather than returning early. With no
    // credential on the request there is nothing to look up, so this is still
    // a decision and not a database round trip — but the assertion is only
    // that the request was NOT waved through.
    await expect(guard.canActivate(contextFor(request))).rejects.toThrow('Unauthorized');
    expect(request.principal).toBeUndefined();
  });

  it('passes through WebSocket contexts (authenticated at Upgrade and per-frame by WsGateway)', async () => {
    const guard = await newGuard();
    const wsContext = {
      getType: () => 'ws',
      switchToHttp: () => ({ getRequest: () => ({}) }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(wsContext)).resolves.toBe(true);
  });

  it('fails closed on non-HTTP, non-WS execution contexts', async () => {
    const guard = await newGuard();
    const rpcContext = {
      getType: () => 'rpc',
      switchToHttp: () => ({ getRequest: () => ({}) }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(rpcContext)).rejects.toThrow('Unauthorized');
  });
});
