import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';
import {
  API_PREFIX,
  MCP_OAUTH_CALLBACK_PATH,
  TELEGRAM_MANAGER_WEBHOOK_PATH,
  telegramBotWebhookId,
  type Principal,
} from '@crewaid/shared';
import { auth } from './better-auth.js';

/**
 * Read off the instance rather than repeated as a literal.
 *
 * This prefix decides which requests skip authentication, so a copy of it that
 * drifts from `betterAuth({ basePath })` is an exemption pointing at the wrong
 * tree — the one mistake in this file that fails OPEN. Better Auth exposes the
 * resolved options, so there is nothing to keep in step.
 */
const AUTH_BASE_PATH = auth.options.basePath;

/** This server's own origin: the one a cookie-authenticated write must come from. */
const OWN_ORIGIN = new URL(auth.options.baseURL ?? 'http://invalid.invalid').origin;
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

function hasBearer(header: string | string[] | undefined): boolean {
  return typeof header === 'string' && /^bearer\s+\S/i.test(header);
}

/**
 * The auth boundary.
 *
 * THE ONLY place in the codebase that reads `req.headers.authorization`.
 * No handler may touch the header directly; handlers receive the
 * resolved Principal via `@CurrentUser` instead.
 *
 * The swap promised
 *
 * v1 resolved one static `ORCH_API_TOKEN` to one hardcoded user. This resolves
 * a Better Auth session to its own owner. Every handler already read
 * `principal.userId` rather than assuming a constant, so the change stops
 * here: no controller signature moves, and `ResourceOwnershipGuard` keeps
 * reading the same `request.principal` the same way.
 *
 * What changed underneath is the whole security model. The static token
 * authenticated EVERYBODY as the same person, could not be revoked without a
 * restart, and made "which user is this" a question with one possible answer.
 * A session belongs to exactly one `User` row, can be revoked individually,
 * and expires.
 *
 * Why there is no constructor check any more
 *
 * The old guard threw on an unset `ORCH_API_TOKEN` so misconfiguration failed
 * at boot rather than at the first request. That property is kept, moved to
 * where the configuration actually lives: `better-auth.ts` calls `requireEnv`
 * for `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` at module scope, so importing
 * this file at all fails a misconfigured boot. Repeating the check here would
 * be a second place to keep the variable list correct.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      method?: string;
      path?: string;
      url?: string;
      headers: Record<string, string | string[] | undefined>;
      principal?: Principal;
    }>();

    const rawPath = request.path ?? request.url ?? '';
    const pathname = rawPath.split('?')[0] ?? '';

    // Only the liveness controller's GET route is exempt. The
    // `/api/v1/health` form exists only in prefix-enabled test bootstraps;
    // production excludes `health` from the global prefix and serves `/health`.
    const isHealthLivenessRoute =
      request.method === 'GET' && (pathname === '/health' || pathname === '/api/v1/health');
    if (isHealthLivenessRoute) {
      return true;
    }

    // Signing in cannot require being signed in. `BetterAuthMiddleware` answers
    // this tree and never calls `next`, so in practice a request that reaches
    // the guard here is one the middleware declined — and Nest has no
    // controller on these paths, so it 404s rather than falling through to
    // anything. The exemption exists so that a path the middleware does not
    // claim reports "no such route" instead of "unauthorized", which is the
    // difference between finding a misconfigured base URL in a minute and
    // hunting a credential bug for an afternoon.
    if (pathname === AUTH_BASE_PATH || pathname.startsWith(`${AUTH_BASE_PATH}/`)) {
      return true;
    }

    // The third exemption, and the only one that is not a tree
    //
    // The `GET /mcp/oauth/callback` — the MCP authorization redirect
    //. The caller is a browser this orchestrator just sent to a
    // third party, so there is no session cookie to send and nothing to
    // authenticate WITH: the authority is the single-use `state` in the query,
    // which names one `McpOAuthFlow` row that only a signed-in user's
    // `connect` could have created and that the callback deletes as it reads
    // it.
    //
    // EQUALITY, NOT A PREFIX, AND THAT IS THE WHOLE FENCE. The sign-in tree
    // above is exempted as a PREFIX because Better Auth owns everything under
    // it; this route owns one pathname and nothing beneath it. A
    // `startsWith` here would hand every future `/mcp/oauth/callback/...`
    // route to an unauthenticated caller the day somebody added one, and an
    // exemption that grows itself is the failure this file exists to avoid.
    //
    // Both spellings, because the path a request arrives at depends on how the
    // app was bootstrapped: production and the integration harnesses apply
    // `setGlobalPrefix('api/v1')`, while a bare `Test.createTestingModule(...)`
    // bootstrap like the ones over this guard does not. Both are exact
    // comparisons against the constant that also builds the `redirect_uri`, so
    // the two readers of that string cannot drift apart.
    const isMcpOAuthCallback =
      request.method === 'GET' &&
      (pathname === MCP_OAUTH_CALLBACK_PATH ||
        pathname === `${API_PREFIX}${MCP_OAUTH_CALLBACK_PATH}`);
    if (isMcpOAuthCallback) {
      return true;
    }

    // Telegram's two webhooks check their own secret header before reading
    // anything. POST only, the manager path exactly, and a person's bot
    // path as exactly one numeric segment: every other Telegram route, from
    // status to Confirm, still needs a session.
    if (request.method === 'POST') {
      const route = pathname.startsWith(`${API_PREFIX}/`)
        ? pathname.slice(API_PREFIX.length)
        : pathname;
      if (route === TELEGRAM_MANAGER_WEBHOOK_PATH || telegramBotWebhookId(route) !== null)
        return true;
    }

    // Reads the session cookie OR the `Authorization: Bearer <session token>`
    // the bearer plugin accepts. One call covers both, so there is no second
    // code path here that could diverge on what counts as authenticated.
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });

    if (session === null) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }

    // A session cookie is sent by the browser on its own, so a write that it
    // alone authenticates is one any page could have caused. Every client of
    // this API sends a bearer; a cookie-only write must at least come from
    // this server's own origin, the one Better Auth's routes already require.
    if (
      !hasBearer(request.headers['authorization']) &&
      !SAFE_METHODS.has((request.method ?? 'GET').toUpperCase()) &&
      request.headers['origin'] !== OWN_ORIGIN
    ) {
      throw new HttpException('Forbidden', HttpStatus.FORBIDDEN);
    }

    // R7: every request resolves to a Principal before reaching a handler.
    request.principal = { userId: session.user.id, scopes: ['*'] };
    return true;
  }
}
