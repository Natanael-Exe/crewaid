import { electron } from '@better-auth/electron';
import { stripe } from '@better-auth/stripe';
import { betterAuth, type BetterAuthPlugin } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { admin } from 'better-auth/plugins/admin';
import { bearer } from 'better-auth/plugins/bearer';
import { magicLink } from 'better-auth/plugins/magic-link';
import { Logger } from '@nestjs/common';
import {
  AUTH_BASE_PATH,
  DESKTOP_AUTH_CLIENT_ID,
  desktopAuthDeepLink,
  desktopAuthOrigin,
  type Edition,
} from '@crewaid/shared';
import { processBillingConfig, type BillingConfig } from '../billing/billing.config.js';
import { createStripeClient } from '../billing/stripe-client.js';
import { handleStripeEvent } from '../billing/stripe-events.js';
import { readEdition } from '../common/edition.config.js';
import { createPrismaClient } from '../prisma/prisma-client.factory.js';
import { desktopSignInPage, type DesktopSignInProvider } from './desktop-sign-in-page.js';
import { sendMagicLinkEmail } from './magic-link-email.js';

/**
 * The Better Auth instance (V1-08, D-083 adjacent).
 *
 * THIS FILE IS THE SCHEMA'S SOURCE OF TRUTH. Which plugins are enabled here
 * decides which tables exist, so `prisma/schema.prisma`'s auth block is
 * GENERATED from this config with `@better-auth/cli generate` — never written
 * by hand. Adding a plugin and hand-adding its table is how the two drift into
 * a runtime "column does not exist" that looks like a migration problem.
 *
 * Crewaid account authentication and provider connection authorization are two
 * different things and this is only the first. The `Account` rows below
 * hold Google/GitHub tokens proving WHO IS SIGNED IN. A `ProviderConnection`
 * holds a key for calling a model provider. They never mix: no inference
 * credential is read from here, and no sign-in token is ever handed to a turn.
 *
 * Wiring into Nest is the job. This file exists at V1-02 because the
 * schema cannot be generated without it.
 */

/**
 * Better Auth owns its own client instance rather than sharing
 * `PrismaService`.
 *
 * PrismaService is a Nest provider with a lifecycle tied to the application
 * context, and this module is imported by the Better Auth CLI outside any Nest
 * context at all — generating the schema would boot the DI container. The
 * adapter only ever touches the four auth tables, which no Crewaid service reads,
 * so the two clients cannot contend over a row.
 */
const authPrisma = createPrismaClient();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required (see infra/compose/.env.example)`);
  }
  return value;
}

/**
 * Optional at construction, required at use.
 *
 * A social provider with no credentials configured must not stop the
 * orchestrator booting — an install that only uses magic links is a supported
 * install. What it must not do is silently offer a broken button, so the
 * provider is omitted entirely rather than registered with empty strings.
 */
function socialProvider(
  idVar: string,
  secretVar: string,
): { clientId: string; clientSecret: string } | undefined {
  const clientId = process.env[idVar];
  const clientSecret = process.env[secretVar];
  if (clientId === undefined || clientId === '') return undefined;
  if (clientSecret === undefined || clientSecret === '') return undefined;
  return { clientId, clientSecret };
}

// `@better-auth/utils` is a direct dependency that nothing here imports. Do not
// remove it as unused: better-auth, its Electron and Stripe plugins and
// `@better-auth/core` all take it as a peer, and pnpm may satisfy that peer
// twice. Two utils means two cores, two `APIError` classes and a type error on
// the plugins array below. Declaring it here collapses them; `pnpm.overrides`
// does not, because it leaves an auto-installed peer alone.

/**
 * Widened to `BetterAuthPlugin` deliberately, and this is not tidiness.
 *
 * The electron plugin's own return type carries every endpoint's input and
 * output schema plus its error-code table. Left inferred, that type flows into
 * `typeof auth` and the declaration emitter gives up on it: TS7056, "the
 * inferred type of this node exceeds the maximum length the compiler will
 * serialize", pointing at `auth` and naming no cause. Annotating here keeps
 * `auth.api` fully typed for everything the orchestrator actually calls.
 *
 * Nothing is lost that is used. `auth.api.electronToken` and friends are HTTP
 * routes the BROWSER and the desktop reach; no server-side code calls them,
 * and the middleware serves them from the route tree either way.
 */
/**
 * The cookie prefix, named once and handed to BOTH halves of the handoff.
 *
 * The plugin sets a cookie called `<prefix>.<clientID>`; the sign-in page has
 * to read that exact name to find the authorization code. Each side defaults
 * to the string 'better-auth' on its own, so they agreed only because two
 * independent defaults happened to match — set a prefix on the plugin and the
 * page goes on looking for the old name, finds nothing, and sign-in hangs
 * until the poll times out with no error anywhere.
 *
 * Passed explicitly to both so the two cannot drift, which is the same failure
 * that let the auth routes mount at a path nothing requests.
 */
const DESKTOP_AUTH_COOKIE_PREFIX = 'better-auth';

const desktopSignIn: BetterAuthPlugin = electron({
  clientID: DESKTOP_AUTH_CLIENT_ID,
  cookiePrefix: DESKTOP_AUTH_COOKIE_PREFIX,
  /**
   * Five minutes to spend the code, two to bounce it.
   *
   * The bounce is a `location.replace` that happens the instant the page
   * loads, so two minutes is already generous; it is short because that cookie
   * is readable by script, by design, and its whole job is to survive one
   * navigation.
   */
  codeExpiresIn: 60 * 5,
  redirectCookieExpiresIn: 120,
});

const magicLinkPlugin: BetterAuthPlugin = magicLink({
  storeToken: 'hashed',
  sendMagicLink: async ({ email, url }) => {
    await sendMagicLinkEmail({ email, url });
  },
  /**
   * Five minutes, and single use.
   *
   * A magic link is a bearer credential sitting in an inbox: it is
   * forwardable, it is often synced to another device, and it is indexed
   * by the mail provider. The default hour is an hour in which a forwarded
   * thread is an account takeover. V1-15 asserts the replay case, because
   * a link that works twice is a shareable password and it is the failure
   * that looks most like success when tested by hand.
   */
  expiresIn: 60 * 5,
});

/**
 * Operator accounts for the hosted service.
 *
 * An admin is a user whose `role` is `admin`, set by hand in the database —
 * there is no route that grants it to yourself, and the plugin's own routes
 * that change roles answer only to an existing admin. The billing module puts
 * an admin on the `internal` plan: no Stripe, no limits, for running and
 * testing production without paying it. The plugin also brings banning and
 * impersonation, both admin-only; nothing in Crewaid calls either yet.
 */
const adminPlugin: BetterAuthPlugin = admin({ defaultRole: 'user', adminRoles: ['admin'] });

/**
 * Stripe's webhook, verified.
 *
 * The plugin is here for one thing: `POST /api/v1/auth/stripe/webhook`, which
 * checks Stripe's signature over the raw body and hands each event on. Its own
 * subscription handling is OFF, and that is deliberate. Its handlers trust each
 * event's payload in the order events arrive — which Stripe does not guarantee
 * — so a cancellation delivered before its creation was lost, and an update
 * arriving first could overwrite an older subscription's row with a newer
 * one's. They also log a failed write and answer 200, so Stripe never retried
 * it. The billing module syncs instead (`handleStripeEvent`): it re-reads the
 * subscription from Stripe on every event, so order stops mattering, and a
 * failure throws, which the plugin answers with 400 and Stripe retries.
 *
 * With subscriptions off the plugin adds no table and none of its checkout,
 * cancel or portal routes work; checkout and the portal are the billing
 * module's, because the $1 trial is a charge added to an account's first
 * Starter checkout only.
 */
function billingPlugin(config: BillingConfig): BetterAuthPlugin {
  return stripe({
    stripeClient: createStripeClient(config),
    stripeWebhookSecret: config.webhookSecret,
    createCustomerOnSignUp: false,
    onEvent: handleStripeEvent,
  });
}

/**
 * Which sign-in methods an edition offers, decided from the same values that
 * decide what actually works.
 *
 * One answer to "is this configured", shared by the auth config and the page:
 * a page that renders a Google button an install cannot honour sends the
 * operator to Google's console to debug a Crewaid misconfiguration, and the
 * round trip that discovers it is a browser redirect into a 500.
 *
 * Magic links need BOTH halves — a key to send with and an address to send
 * from — because `magic-link-email.ts` requires both at first send, and the
 * failure it produces arrives after the operator has already typed an email
 * address and been told to check their inbox.
 *
 * A self-hosted server signs in with email and password only: no
 * identity provider to register an app with, no mail service to pay for. It
 * ignores Google, GitHub and Resend settings even when they are present — an
 * edition that grew a sign-in method because someone copied a hosted `.env`
 * would no longer be the product it names — and says so at boot.
 */
function signInMethods(edition: Edition): {
  readonly providers: readonly DesktopSignInProvider[];
  readonly google: ReturnType<typeof socialProvider>;
  readonly github: ReturnType<typeof socialProvider>;
  readonly magicLink: boolean;
  readonly password: boolean;
} {
  const google = socialProvider('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET');
  const github = socialProvider('GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET');
  const magicLink =
    (process.env['RESEND_API_KEY'] ?? '') !== '' && (process.env['MAGIC_LINK_FROM'] ?? '') !== '';
  if (edition === 'cloud') {
    const providers = [
      ...(google ? (['google'] as const) : []),
      ...(github ? (['github'] as const) : []),
    ];
    return { providers, google, github, magicLink, password: false };
  }

  const ignored = [
    ...(google ? ['GOOGLE_CLIENT_ID'] : []),
    ...(github ? ['GITHUB_CLIENT_ID'] : []),
    ...(magicLink ? ['RESEND_API_KEY'] : []),
  ];
  if (ignored.length > 0) {
    new Logger('Auth').warn(
      `CREWAID_EDITION=selfhosted signs in with email and password only; ignoring ${ignored.join(', ')}`,
    );
  }
  return { providers: [], google: undefined, github: undefined, magicLink: false, password: true };
}

/**
 * Whether cookies are `Secure`, which decides whether a browser keeps them at
 * all on a plain-http origin.
 *
 * The hosted service is always https in production, so it keeps the rule it
 * has always had. A self-hosted server is often reached over plain http on a
 * home or office network while running as production (the image sets
 * `NODE_ENV=production`), and a browser silently drops a `Secure` cookie there.
 * That includes the desktop's one-time code, which `@better-auth/electron` sets
 * with the session cookie's attributes — so sign-up succeeded and the app
 * never got its code. A self-hosted server therefore follows its own address,
 * and says at boot when that address puts passwords on the wire in clear.
 */
function useSecureCookies(edition: Edition, baseURL: string): boolean {
  if (edition === 'cloud') return process.env['NODE_ENV'] === 'production';
  const url = new URL(baseURL);
  if (url.protocol === 'https:') return true;
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!loopback) {
    new Logger('Auth').warn(
      `BETTER_AUTH_URL is ${url.origin}: passwords and sessions cross the network unencrypted. ` +
        'Serve the orchestrator over https for anything beyond a network you trust.',
    );
  }
  return false;
}

/**
 * Built per edition so a test can stand up a self-hosted instance beside the
 * default one. The application and the schema generator use `auth` below.
 */
export function createAuth(
  edition: Edition,
  billing: BillingConfig | null = processBillingConfig(edition),
) {
  const methods = signInMethods(edition);
  const { google, github } = methods;
  const secureCookies = useSecureCookies(edition, requireEnv('BETTER_AUTH_URL'));

  return betterAuth({
    appName: 'Crewaid',
    database: prismaAdapter(authPrisma, { provider: 'postgresql' }),

    /**
     * §4.4 mounts the auth surface under the same `/api/v1` prefix as every
     * other route, so the desktop client has ONE base URL to configure and the
     * §4.2 socket's origin check has one origin to trust.
     */
    basePath: AUTH_BASE_PATH,

    /**
     * Off on the hosted service. The plan names three ways in there — Google,
     * GitHub, and a magic link — and each of them leaves the credential with a
     * provider that already does account recovery, rate limiting and breach
     * detection. Owning passwords there means owning all three badly.
     *
     * On a self-hosted server it is the ONLY way in: the operator has no
     * identity provider or mail service by default, and the account lives on
     * hardware they run. Signing up signs in at once, and there is no email to
     * verify because nothing could send one.
     */
    emailAndPassword: { enabled: methods.password, autoSignIn: true },

    socialProviders: {
      ...(google ? { google } : {}),
      ...(github ? { github } : {}),
    },

    plugins: [
      /**
       * `Authorization: Bearer <session token>` in addition to the cookie.
       *
       * The desktop renderer is not a browser tab on this origin: it holds its
       * credential in the CC-07 store and attaches it per request, which is the
       * same shape §4.4 has always had. A cookie-only orchestrator would force
       * an Electron session-partition dance to authenticate a plain `fetch`.
       *
       * This is NOT the static token returning under another name. What travels
       * here is a `Session.token` — issued by a sign-in, revocable row by row,
       * and expiring — where `ORCH_API_TOKEN` was one process-wide secret that
       * authenticated everybody as the same user and could only be rotated by a
       * restart.
       */
      bearer(),
      // Hosted only: a self-hosted server has no mail service to send a link with.
      ...(methods.magicLink ? [magicLinkPlugin] : []),
      // Hosted only: operator accounts, then billing once Stripe is configured.
      ...(edition === 'cloud' ? [adminPlugin] : []),
      ...(edition === 'cloud' && billing !== null ? [billingPlugin(billing)] : []),

      /**
       * Browser sign-in for the desktop app.
       *
       * This is the half of the flow that has to be right and is not obvious:
       * after the provider redirects a BROWSER, the session it creates lives in
       * that browser. Getting it into Electron means minting a one-shot
       * authorization code, binding it to a PKCE challenge the desktop generated
       * and never transmitted, and refusing to spend it without the matching
       * verifier — RFC 8252 for native apps, and the reason a stolen callback is
       * worth nothing.
       *
       * Taken from the library rather than written here on purpose. The blob the
       * browser hands back is `base64url({ identifier, state })`, which no
       * document specifies: it is an implementation detail shared by this plugin
       * and `@better-auth/electron/client`. Re-deriving it by hand would pin the
       * desktop to an internal shape that can change in a minor release with
       * nothing to notice — so both ends are pinned to the same version instead.
       *
       * It adds NO TABLE. The code is a row in `verification`, which already
       * exists, so the schema generator's output is unchanged by this plugin.
       */
      desktopSignIn,

      /**
       * The page the desktop opens. Last in the list because it depends on what
       * the entries above resolved to — which providers exist at all.
       */
      desktopSignInPage({
        providers: methods.providers,
        magicLink: methods.magicLink,
        password: methods.password,
        deepLink: desktopAuthDeepLink(edition),
        cookiePrefix: DESKTOP_AUTH_COOKIE_PREFIX,
      }),
    ],

    /**
     * The desktop is not a browser tab on this origin, and its exchange request
     * says so: `@better-auth/electron/client` sends `Origin: crewaid:/` from the
     * main process. Better Auth's CSRF check refuses an origin it was not told
     * about, which is exactly what it should do — so the custom scheme is named
     * here, once, from the shared contract both sides read.
     */
    trustedOrigins: [desktopAuthOrigin(edition)],

    /**
     * THESE ARE PRISMA CLIENT PROPERTIES, NOT TABLE NAMES, AND NOT THE PRISMA
     * MODEL NAMES EITHER.
     *
     * The Prisma model is `User` and the table is `"User"`; the generated client
     * exposes it as `prisma.user`. The adapter addresses models through that
     * property — `clientProperty` in `@better-auth/prisma-adapter` lowercases
     * the first character, and `introspectPrismaDataModel` keys its view of the
     * schema the same way — so `modelName: 'User'` makes it reach for
     * `prisma['User']`, which is `undefined`.
     *
     * That failure does not look like a naming problem. The startup check
     * compares the same two lists and reports `Missing tables User, Session,
     * Account, Verification`, advising a `generate` and a migration, against a
     * database where all four tables exist and are correct. Every authenticated
     * request answers 500 until it is set right.
     *
     * V1-02 set these to PascalCase for the SCHEMA GENERATOR — Better Auth's
     * default lowercase names make `@better-auth/cli generate` emit
     * `@@map("user")` on the existing `User` model, and that `@@map` is a table
     * rename of a PRD §3 table, which §3 makes contractual and
     * `schema-contract.test.ts` enforces. Both facts are real and they pull in
     * opposite directions; the runtime one wins because it is the one that
     * breaks the running orchestrator. The generated schema is already in the
     * tree and correct, so re-running the generator after a plugin change means
     * checking its diff for a `@@map` on these four models and dropping it.
     */
    user: { modelName: 'user' },
    account: { modelName: 'account' },
    verification: { modelName: 'verification' },

    session: {
      // The client property, for the reason spelled out on `user` above.
      modelName: 'session',
      /**
       * Seven days, refreshed once a day of use.
       *
       * The desktop client is long-lived and reconnects rather than re-signing
       * in, so a short absolute expiry would sign people out mid-week for no
       * security gain — revocation, not expiry, is what ends a compromised
       * session, and V1-09 makes revocation take effect at the next frame.
       */
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },

    /**
     * Public personal registration. No organizations, no teams, no invitations —
     * the plan scopes V1 to personal accounts, and an organization plugin added
     * "for later" brings six tables and a membership model that every
     * owner-scoped query would then have to be re-audited against.
     */
    advanced: {
      useSecureCookies: secureCookies,

      /**
       * Explicitly ON, because its default is not.
       *
       * `create-context.ts` reads
       * `disableOriginCheck: options.advanced?.disableOriginCheck ?? (isTest ? true: false)`
       * — so under `NODE_ENV=test`, which is what vitest sets, Better Auth turns
       * the origin check OFF. Left at the default, the request a test makes and
       * the request a user makes go down different branches, and every case that
       * claims "this origin is refused" passes for free: it is not asserting a
       * refusal, it is asserting a check that was never armed.
       *
       * V1-11 is the first task that depends on that check — `trustedOrigins`
       * has exactly one entry and it exists for the desktop's `crewaid:/` — so the
       * divergence is closed here rather than worked around in the suite. The
       * value is what production already used; only the test path moves.
       */
      disableOriginCheck: false,
    },

    secret: requireEnv('BETTER_AUTH_SECRET'),
    baseURL: requireEnv('BETTER_AUTH_URL'),
  });
}

/** The process's instance, for the edition this server was booted as. */
export const auth = createAuth(readEdition(process.env));

export type Auth = typeof auth;
