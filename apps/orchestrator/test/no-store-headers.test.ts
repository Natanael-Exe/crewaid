import { describe, expect, it } from 'vitest';
import { API_PREFIX } from '@crewaid/shared';
import { NoStoreMiddleware } from '../src/common/no-store.middleware.js';
import { BetterAuthMiddleware } from '../src/auth/auth.middleware.js';
import { AppModule } from '../src/app.module.js';
import { RequestLoggingMiddleware } from '../src/logging/request-logging.middleware.js';
import { HttpHardeningMiddleware } from '../src/common/http-hardening.middleware.js';

/**
 * The regression: Chromium cached a `GET /bots` body, replayed it after a
 * column shipped, and the renderer reported that the server had sent a
 * response it could not read — while the server was answering correctly.
 * Express's weak ETag plus an absent `Cache-Control` is what licensed the
 * copy, so the fence is the header, asserted here without a live socket.
 */
describe('NoStoreMiddleware', () => {
  it('marks the response uncacheable and continues the chain', () => {
    const headers = new Map<string, string>();
    let nexted = false;

    new NoStoreMiddleware().use(
      {},
      { setHeader: (name, value) => void headers.set(name, value) },
      () => {
        nexted = true;
      },
    );

    expect(headers.get('Cache-Control')).toBe('no-store');
    expect(nexted).toBe(true);
  });

  /**
   * `forRoutes('*')` rather than the `/api/v1` prefix, and registered ahead of
   * the logger: a 401 from AuthGuard and a 500 from a filter are responses
   * too, and an interceptor would never see either.
   *
   * V1-08 added a second registration for Better Auth's route tree. ORDER is
   * what this asserts: a sign-in response carries a `Set-Cookie` for a
   * session, and it must reach `no-store` like every other response.
   * Registering it first would have exempted exactly the responses that must
   * never be cached.
   *
   * ── WHAT THIS DELIBERATELY NO LONGER PINS ─────────────────────────────────
   *
   * It used to assert the auth registration's route spec verbatim, and the
   * value it pinned was wrong: `setGlobalPrefix` rewrites middleware paths, so
   * `'api/v1/auth/*path'` bound the tree at `/api/v1/api/v1/auth/*` and every
   * sign-in route 404'd for the whole of V1. This test READ that registration
   * and agreed with it, because a spec copied out of the module under test
   * agrees with the module by construction — it can only catch a change, never
   * a mistake.
   *
   * Whether the tree is reachable is now asserted where it can actually be
   * observed, against a booted app, in `auth-session.integration.test.ts`.
   */
  it('is registered for every route, before request logging', () => {
    const applied: unknown[][] = [];
    const routed: unknown[][] = [];
    const consumer = {
      apply: (...middleware: unknown[]) => {
        applied.push(middleware);
        return {
          forRoutes: (...routes: unknown[]) => {
            routed.push(routes);
            return consumer;
          },
        };
      },
    };

    new AppModule().configure(consumer as never);

    expect(applied).toEqual([
      [NoStoreMiddleware, RequestLoggingMiddleware, HttpHardeningMiddleware],
      [BetterAuthMiddleware],
    ]);
    expect(routed[0]).toEqual(['*']);

    // The auth registration is asserted by PROPERTY, not by value. Copying the
    // spec out of the module and asserting it back is what this test used to
    // do, and it agreed with the bug for a whole milestone: a literal lifted
    // from the code under test matches that code by construction, so it can
    // catch a change and never a mistake.
    //
    // The property that was violated is that the path must NOT carry the
    // global prefix — Nest adds it back, and spelling it out bound the tree at
    // `/api/v1/api/v1/auth/*`, where nothing ever knocked.
    const authRoute = routed[1]?.[0] as { path?: string } | undefined;
    expect(authRoute?.path).toBeDefined();
    expect(authRoute?.path).not.toContain(API_PREFIX);
    expect(authRoute?.path).not.toContain('api/v1');
  });
});
