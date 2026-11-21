import { createAuthEndpoint } from 'better-auth/api';
import type { BetterAuthPlugin } from 'better-auth';
import { DESKTOP_AUTH_CLIENT_ID } from '@crewaid/shared';
import { BRAND_MARK_DATA_URI } from './brand-mark.js';

/**
 * The page the desktop opens in the system browser.
 *
 * Why there is a page at all
 *
 * A native app cannot hold an OAuth session: the provider redirects a BROWSER,
 * and whatever it sets lands in that browser's cookie jar, not in Electron's.
 * So the exchange has to cross back out, and the only thing that may cross is
 * an authorization code — a one-shot string bound to a PKCE challenge the
 * desktop generated and never sent (RFC 8252). `@better-auth/electron` mints
 * that code server-side and drops it in a short-lived, non-httpOnly cookie;
 * something rendered in the browser has to read it and hand it to the scheme.
 *
 * Better Auth's own guide has a web app doing that with its proxy client. A
 * self-hosted Crewaid has no web app, so the orchestrator serves this instead —
 * one page, no bundler, no framework, no build step.
 *
 * Why it is a better auth endpoint and not a nest controller
 *
 * Signing in cannot require being signed in, so this page must be reachable
 * unauthenticated. A Nest route would need a third exemption in `AuthGuard` —
 * and that guard's exemption list is the one place in the codebase where a
 * mistake fails OPEN. Mounting the page inside `basePath` instead puts it
 * under the exemption that already exists for the auth tree, so the set of
 * unauthenticated paths does not grow at all.
 *
 * What this page is trusted with
 *
 * Nothing. It holds no secret and makes no security decision. It forwards the
 * `state` and `code_challenge` the desktop put in its own query, and reads
 * back a code that is worthless without the verifier — which never leaves the
 * main process. Every check that matters (client id, state match, PKCE
 * verification, single use, expiry) happens at `/electron/token`, server-side.
 */

export type DesktopSignInProvider = 'google' | 'github';

export type DesktopSignInPageOptions = {
  /** Only the providers actually configured — a button that cannot work is worse than no button. */
  readonly providers: readonly DesktopSignInProvider[];
  /** Whether magic-link delivery is configured; the email form is hidden when it is not. */
  readonly magicLink: boolean;
  /**
   * Whether this server signs in with email and password — a self-hosted one,
   * and only a self-hosted one. Exclusive with the two above: the
   * edition that has a password has neither providers nor mail.
   */
  readonly password: boolean;
  /** Where the code goes back to: the deep link of this server's edition. */
  readonly deepLink: string;
  /** Matches `electron({ cookiePrefix })`; names the cookie the bounce reads. */
  readonly cookiePrefix?: string;
};

/**
 * Two labels per provider, because the button has two jobs.
 *
 * `short` is what the button reads beside the provider's mark when the
 * buttons sit side by side — "Continue with Google" wraps to two lines in
 * half a card, and a wrapped label next to a logo looks broken. `label` is
 * the accessible name, which still has to say what pressing it DOES: "Google"
 * alone, announced on its own, is a noun and not an action.
 */
const PROVIDER_LABELS: Record<DesktopSignInProvider, { label: string; short: string }> = {
  google: { label: 'Continue with Google', short: 'Google' },
  github: { label: 'Continue with GitHub', short: 'GitHub' },
};

/**
 * How long the page keeps looking for the authorization cookie.
 *
 * Six minutes because the magic link expires in five: the case this covers is
 * a person who asks for a link here, opens their mail, and comes back to a tab
 * that has been sitting idle. A poll that gave up sooner than the credential
 * does would strand exactly that person, and the failure would look like a
 * link that did not work.
 */
const POLL_WINDOW_MS = 6 * 60 * 1000;
const POLL_INTERVAL_MS = 500;

/**
 * Serialize server-side config for the page without a string-escaping hazard.
 *
 * It travels as JSON in a `type="application/json"` block rather than as
 * interpolated JavaScript, and `<` is escaped so no value can close the script
 * element early. None of these values is user input today; writing it this way
 * means none of them becomes an injection point when one of them is.
 */
function embeddedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * The email and password half of the page, rendered only for a self-hosted
 * server — not rendered and hidden. A hosted page never carries a
 * password field or the code that posts one, so no stylesheet change or script
 * error can surface a way in that the hosted service does not have.
 *
 * Unlike a magic link, sign-in and sign-up are DIFFERENT requests here: one
 * checks a password, the other creates the account, and creating one for a
 * mistyped address would be wrong. Either way the session is made in the
 * response, so the electron plugin's after-hook (it matches every `/sign-in`
 * and `/sign-up` path carrying the desktop's client id) has already set the
 * code cookie when it returns — `handBack` picks it up at once rather than
 * waiting for the poll.
 */
const PASSWORD_FORM = `      <form id="password-form" hidden>
        <div id="pw-name-field" hidden>
          <label for="pw-name">Name</label>
          <input id="pw-name" name="name" type="text" autocomplete="name" placeholder="Ada Lovelace">
        </div>
        <div>
          <label for="pw-email">Email</label>
          <input id="pw-email" name="email" type="email" autocomplete="email" required
                 placeholder="you@example.com">
        </div>
        <div>
          <label for="pw-password">Password</label>
          <input id="pw-password" name="password" type="password" required minlength="8"
                 autocomplete="current-password">
        </div>
      </form>
`;

const PASSWORD_SCRIPT = `  // No link is emailed, so the sign-up copy must not promise one; the
  // autofill hint follows the mode so a password manager offers to save a new
  // password rather than fill an old one.
  COPY['sign-up'].lede = 'Welcome! Choose a name, email and password for this server.';
  onMode.push(function (copy) {
    show('pw-name-field', copy.name);
    el('pw-password').setAttribute('autocomplete', copy.name ? 'new-password' : 'current-password');
  });
  show('password-form', true);
  show('magic-footer', true);
  el('submit').setAttribute('form', 'password-form');
  applyMode();
  el('password-form').addEventListener('submit', function (event) {
    event.preventDefault();
    show('error-tray', false);
    busy(true);
    var body = { email: el('pw-email').value, password: el('pw-password').value };
    // Better Auth requires a name on the User row; the email stands in when
    // none was typed, rather than refusing the form over an optional field.
    if (mode === 'sign-up') body.name = el('pw-name').value.trim() || el('pw-email').value;
    post(mode === 'sign-up' ? '/sign-up/email' : '/sign-in/email', body)
      .then(function () {
        if (!handBack()) throw new Error('Signed in, but the server returned no code for the app.');
      })
      .catch(function (error) { busy(false); fail(error.message); });
  });
`;

/** Only where a server could be missing every method: a hosted one with none configured. */
const NO_METHOD_CHECK = `  if (!cfg.providers.length && !cfg.magicLink) {
    fail('No sign-in method is configured on this orchestrator. Set GOOGLE_CLIENT_ID, ' +
         'GITHUB_CLIENT_ID or RESEND_API_KEY and restart it.');
  }
`;

/**
 * Exported so the page can be asserted without an HTTP round trip.
 *
 * What a test can actually hold this to is what the browser is TOLD: which
 * buttons exist, that the script is nonce-bound, that no value escapes its
 * JSON block. The behaviour after that is JavaScript in a browser and this
 * repo has no DOM to run it in — which is exactly why every decision that
 * matters was pushed server-side, to `/electron/token`.
 */
export function renderDesktopSignInPage(
  options: DesktopSignInPageOptions,
  basePath: string,
  nonce: string,
): string {
  const config = embeddedJson({
    basePath,
    clientId: DESKTOP_AUTH_CLIENT_ID,
    cookieName: `${options.cookiePrefix ?? 'better-auth'}.${DESKTOP_AUTH_CLIENT_ID}`,
    deepLink: options.deepLink,
    providers: options.providers.map((id) => ({ id, ...PROVIDER_LABELS[id] })),
    magicLink: options.magicLink,
    pollWindowMs: POLL_WINDOW_MS,
    pollIntervalMs: POLL_INTERVAL_MS,
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in to Crewaid</title>
<style nonce="${nonce}">
/*
 * Why this is hand-written css and not heroui
 *
 * The renderer is React + HeroUI v3 + Tailwind. This page is not the renderer:
 * the orchestrator serves it to whatever browser the OS opens, which has never
 * loaded this origin and holds none of the app's assets. Pulling HeroUI in
 * would mean a React bundle built and served by the orchestrator — a build
 * step, a second component system, and a sign-in screen that fails to render
 * when an asset request fails. So the page stays one self-contained file.
 *
 * What it does NOT do is look like a different product. Every colour below is
 * the Crewaid theme's own token converted to sRGB — "renderer/styles/themes/crewaid.css" is the source, and the accent, surfaces, border and radii are the
 * same values the desktop shell paints with. Converted rather than written as
 * oklch because this page is the entry point to the entire product: if a
 * colour function does not parse, the operator gets an unstyled form as their
 * first impression of Crewaid.
 *
 * The layered card is four nested 1px borders alternating light and dark over
 * a vertical gradient, which is why the radii step DOWN a pixel per layer —
 * equal radii on nested boxes leave visible gaps at the corners.
 */
:root {
  color-scheme: light;
  --background: #f7f6f4;
  --foreground: #1a1a1a;
  --surface: #ffffff;
  --surface-secondary: #efeeec;
  --border: #e5e4e1;
  --muted: #8a8a86;
  --faint: #b5b4b0;
  --accent: #2563eb;
  /* The desktop's B+ buttons: a pill, and the primary one in its ink. */
  --button: #1d1830;
  --button-hover: #2e2848;
  --pill-radius: 999px;
  --danger: #dc2626;
  --card-radius: 14px;
  --field-radius: 12px;
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
  background: var(--background); color: var(--foreground);
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto,
    "Helvetica Neue", sans-serif;
  -webkit-font-smoothing: antialiased; }

main { width: min(400px, 100%); }
.l0 { border-radius: calc(var(--card-radius) + 10px); border: 1px solid rgba(255,255,255,.6);
  background: linear-gradient(to bottom, var(--surface-secondary), rgba(255,255,255,.7)); }
.l1 { border-radius: calc(var(--card-radius) + 9px); border: 1px solid rgba(0,0,0,.08); }
.l2 { border-radius: calc(var(--card-radius) + 8px); border: 1px solid rgba(255,255,255,.5); }
.l3 { border-radius: calc(var(--card-radius) + 7px); border: 1px solid rgba(26,26,26,.16); }
.inner { border-radius: calc(var(--card-radius) + 6px); border: 1px solid rgba(255,255,255,.5);
  overflow: hidden; }

/* Light above, dark below: an engraved rule rather than a drawn line. */
.sep { border-top: 1px solid rgba(255,255,255,.75); border-bottom: 1px solid var(--border); }

header { padding: 24px 24px 20px; text-align: center; }
/* The icon is already a squircle with its own transparent corners, so this
   must NOT re-round it — a border-radius here clips the glass rim and the
   artwork picks up a second, tighter corner inside its own. */
.mark { width: 56px; height: 56px; margin: 0 auto 12px; display: block;
  filter: drop-shadow(0 8px 20px rgba(20, 18, 16, .22)); }
h1 { margin: 0 0 4px; font-size: 18px; font-weight: 600; line-height: 1.25;
  letter-spacing: -.01em; color: var(--foreground); }
header p { margin: 0; font-size: 13px; color: var(--muted); }

.content { padding: 20px 24px; }
.providers { display: flex; justify-content: center; gap: 8px; margin-bottom: 14px; }
.providers:empty { display: none; }

button { font: inherit; cursor: pointer; }
button[disabled] { opacity: .55; cursor: default; }

.social { flex: 1 1 0; min-width: 0; display: inline-flex; align-items: center; justify-content: center;
  gap: 8px; padding: 9px 14px; font-weight: 500; color: var(--foreground);
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--pill-radius);
  box-shadow: 0 1px 2px rgb(0 0 0 / 4%); }
.social:hover:not([disabled]) { background: var(--background); }
.social svg { width: 18px; height: 18px; flex: none; }

.or { position: relative; text-align: center; font-size: 13px; color: var(--faint); margin: 0 0 14px; }
.or::before, .or::after { content: ""; position: absolute; top: 50%; width: calc(50% - 18px);
  border-top: 1px solid var(--border); }
.or::before { left: 0; } .or::after { right: 0; }

form { margin: 0; display: flex; flex-direction: column; gap: 14px; }
label { display: block; margin-bottom: 5px; font-size: 13px; font-weight: 500; color: var(--foreground); }
input { display: block; width: 100%; padding: 9px 12px; font: inherit; color: var(--foreground);
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--field-radius);
  box-shadow: 0 1px 2px rgb(0 0 0 / 4%); }
input::placeholder { color: var(--faint); }
input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgb(37 99 235 / 15%); }

footer { padding: 16px 24px; }
.accent { width: 100%; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  padding: 10px 16px; font-weight: 500; color: #fff;
  background: var(--button); border: 1px solid var(--button); border-radius: var(--pill-radius);
  box-shadow: 0 1px 2px rgb(0 0 0 / 12%); }
.accent:hover:not([disabled]) { background: var(--button-hover); border-color: var(--button-hover); }
.accent svg { width: 15px; height: 15px; }

.tray { padding: 14px 24px; text-align: center; background: var(--surface-secondary); }
.note { margin: 0; font-size: 12px; color: var(--muted); }
.note + .note { margin-top: 6px; }
.err { margin: 0; font-size: 12px; color: var(--danger); }
/* A real button, styled as a link: it changes what this page shows and
   navigates nowhere, so an anchor with no href would be a lie to a keyboard. */
.link { padding: 0; font: inherit; font-weight: 500; color: var(--accent);
  background: none; border: 0; text-decoration: underline; text-underline-offset: 2px; }
code { display: block; margin-top: 8px; padding: 10px 12px; word-break: break-all; text-align: left;
  background: var(--surface); border: 1px solid var(--border); border-radius: 10px; font-size: 12px; }
[hidden] { display: none !important; }
</style>
</head>
<body>
<main>
 <div class="l0"><div class="l1"><div class="l2"><div class="l3"><div class="inner">

  <header>
    <!-- The same mark the desktop shell paints on its own launch screen: this
         page opens in a different application, so it is the only thing telling
         the operator the tab belongs to the app that sent them. Inlined as a
         data URI because this page is a single string and nothing serves
         assets beside it; adding a route for one PNG would be inventing an
         endpoint the contract does not have. -->
    <img class="mark" src="${BRAND_MARK_DATA_URI}" alt="" aria-hidden>
    <h1 id="title">Sign in to Crewaid</h1>
    <p id="lede">Welcome back! This window hands the result back to the app.</p>
  </header>

  <div class="sep"></div>

  <div id="choices">
    <div class="content">
      <div id="providers" class="providers"></div>
      <div id="or" class="or" hidden>or</div>

      <form id="magic" hidden>
        <div id="name-field" hidden>
          <label for="name">Name</label>
          <input id="name" name="name" type="text" autocomplete="name" placeholder="Ada Lovelace">
        </div>
        <div>
          <label for="email">Email</label>
          <input id="email" name="email" type="email" autocomplete="email" required
                 placeholder="you@example.com">
        </div>
      </form>

${options.password ? PASSWORD_FORM : ''}    </div>

    <div id="magic-footer" hidden>
      <div class="sep"></div>
      <footer>
        <button type="submit" form="magic" id="submit" class="accent">
          Continue
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden>
            <path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path>
          </svg>
        </button>
      </footer>
      <div class="sep"></div>
      <div class="tray">
        <p class="note">
          <span id="mode-prompt">New to Crewaid?</span>
          <button type="button" class="link" id="mode-toggle">Create an account</button>
        </p>
      </div>
    </div>
  </div>

  <div id="done" hidden>
    <div class="sep"></div>
    <div class="tray">
      <p class="note">Signed in. Returning you to Crewaid&hellip;</p>
      <p class="note">If nothing happens, paste this code into the app:</p>
      <code id="code"></code>
    </div>
  </div>

  <div id="sent" hidden>
    <div class="sep"></div>
    <div class="tray">
      <p class="note">Check your email. Open the link in <strong>this</strong> browser &mdash;
        the code it returns is tied to this window.</p>
    </div>
  </div>

  <div id="error-tray" hidden>
    <div class="sep"></div>
    <div class="tray"><p class="err" id="error"></p></div>
  </div>

 </div></div></div></div></div>
</main>
<script type="application/json" id="cfg">${config}</script>
<script nonce="${nonce}">
(function () {
  var cfg = JSON.parse(document.getElementById('cfg').textContent);
  var q = new URLSearchParams(location.search);
  var el = function (id) { return document.getElementById(id); };
  var show = function (id, on) { el(id).hidden = !on; };
  var fail = function (message) {
    el('error').textContent = message;
    show('error-tray', true);
  };

  // Brand marks, inline because the page may be the first thing this browser
  // ever loads from this origin and a request for an icon file is a request
  // that can fail. Each is the provider's own mark — a generic glyph beside
  // "Google" is the kind of detail that makes a sign-in page look forged.
  var ICONS = {
    google: '<svg viewBox="0 0 256 262" xmlns="http://www.w3.org/2000/svg" aria-hidden>' +
      '<path fill="#4285F4" d="M255.878 133.451c0-10.734-.871-18.567-2.756-26.69H130.55v48.448h71.947c-1.45 12.04-9.283 30.172-26.69 42.356l-.244 1.622 38.755 30.023 2.685.268c24.659-22.774 38.875-56.282 38.875-96.027"/>' +
      '<path fill="#34A853" d="M130.55 261.1c35.248 0 64.839-11.605 86.453-31.622l-41.196-31.913c-11.024 7.688-25.82 13.055-45.257 13.055-34.523 0-63.824-22.773-74.269-54.25l-1.531.13-40.298 31.187-.527 1.465C35.393 231.798 79.49 261.1 130.55 261.1"/>' +
      '<path fill="#FBBC05" d="M56.281 156.37c-2.756-8.123-4.351-16.827-4.351-25.82 0-8.994 1.595-17.697 4.206-25.82l-.073-1.73L15.26 71.312l-1.335.635C5.077 89.644 0 109.517 0 130.55s5.077 40.905 13.925 58.602l42.356-32.782"/>' +
      '<path fill="#EB4335" d="M130.55 50.479c24.514 0 41.05 10.589 50.479 19.438l36.844-35.974C195.245 12.91 165.798 0 130.55 0 79.49 0 35.393 29.301 13.925 71.947l42.211 32.783c10.59-31.477 39.891-54.251 74.414-54.251"/></svg>',
    github: '<svg viewBox="0 0 256 250" xmlns="http://www.w3.org/2000/svg" aria-hidden>' +
      '<path fill="#24292F" d="M128.001 0C57.317 0 0 57.307 0 128.001c0 56.554 36.676 104.535 87.535 121.46 6.397 1.185 8.746-2.777 8.746-6.158 0-3.052-.12-13.135-.174-23.83-35.61 7.742-43.124-15.103-43.124-15.103-5.823-14.795-14.213-18.73-14.213-18.73-11.613-7.944.876-7.78.876-7.78 12.853.902 19.621 13.19 19.621 13.19 11.417 19.568 29.945 13.911 37.249 10.64 1.149-8.272 4.466-13.92 8.127-17.116-28.431-3.236-58.318-14.212-58.318-63.258 0-13.975 5-25.394 13.188-34.358-1.329-3.224-5.71-16.242 1.24-33.874 0 0 10.749-3.44 35.21 13.121 10.21-2.836 21.16-4.258 32.038-4.307 10.878.049 21.837 1.47 32.066 4.307 24.431-16.56 35.165-13.12 35.165-13.12 6.967 17.63 2.584 30.65 1.255 33.873 8.207 8.964 13.173 20.383 13.173 34.358 0 49.163-29.944 59.988-58.447 63.157 4.591 3.972 8.682 11.762 8.682 23.704 0 17.126-.148 30.91-.148 35.126 0 3.407 2.304 7.398 8.792 6.14C219.37 232.5 256 184.537 256 128.002 256 57.307 198.691 0 128.001 0Z"/></svg>'
  };

  // The desktop put these in the URL it opened. Without them there is nothing
  // to sign in FOR: a code minted with no challenge to bind it to could be
  // spent by whoever picked it up, so the page refuses to start a flow rather
  // than starting one that is weaker than it looks.
  var state = q.get('state');
  var challenge = q.get('code_challenge');
  var ready = Boolean(state && challenge && q.get('client_id') === cfg.clientId);

  function readCode() {
    var match = document.cookie.match(
      new RegExp('(?:^|; )' + cfg.cookieName.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&') + '=([^;]*)')
    );
    return match ? decodeURIComponent(match[1]) : null;
  }

  // Found the code: clear it, show it, and hand it to the app. Clearing first
  // matters — the cookie is readable by script by design, and leaving it
  // behind means a later page on this origin can still pick it up.
  function handBack() {
    var code = readCode();
    if (!code) return false;
    document.cookie = cfg.cookieName + '=; Max-Age=0; Path=/';
    show('choices', false);
    show('sent', false);
    show('done', true);
    el('code').textContent = code;
    location.replace(cfg.deepLink + '#token=' + code);
    return true;
  }

  function poll() {
    var started = Date.now();
    var id = setInterval(function () {
      if (handBack() || Date.now() - started > cfg.pollWindowMs) clearInterval(id);
    }, cfg.pollIntervalMs);
  }

  // Every request carries the desktop's client id, state and challenge, which
  // is what tells the server plugin to mint a code for THIS sign-in.
  function authUrl(path) {
    return cfg.basePath + path + '?client_id=' + encodeURIComponent(cfg.clientId) +
      '&state=' + encodeURIComponent(state) + '&code_challenge=' + encodeURIComponent(challenge);
  }

  function post(path, body) {
    return fetch(authUrl(path), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      // Back to this exact URL, query included, so the return trip still knows
      // which sign-in it belongs to. Same-origin by construction, which is
      // also why it needs no entry in trustedOrigins.
      body: JSON.stringify(Object.assign({ callbackURL: location.href }, body))
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data && data.message ? data.message : 'Sign-in failed.');
        return data;
      });
    });
  }

  function busy(on) {
    var buttons = document.querySelectorAll('#choices button, #magic-footer button');
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = on;
  }

  cfg.providers.forEach(function (provider) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'social';
    // innerHTML over a parsed string, not over anything a request supplied:
    // both halves come from this module's own constants.
    button.innerHTML = (ICONS[provider.id] || '') + '<span></span>';
    button.lastChild.textContent = provider.short;
    button.setAttribute('aria-label', provider.label);
    button.addEventListener('click', function () {
      show('error-tray', false);
      busy(true);
      post('/sign-in/social', { provider: provider.id })
        .then(function (data) {
          if (!data.url) throw new Error('The server did not return a sign-in URL.');
          location.href = data.url;
        })
        .catch(function (error) { busy(false); fail(error.message); });
    });
    el('providers').appendChild(button);
  });

  /**
   * Sign in and sign up are the SAME request.
   *
   * A magic link to an unknown address creates the account; to a known one it
   * signs in. So this is presentation, and it earns its place by removing a
   * box: a returning person has a name on their account already, and asking
   * for it again implies it is being changed. The new person needs it, because
   * Better Auth only reads a name when there is no row yet — without the field
   * their account's only label is their email address, which is what the
   * sidebar then had to show.
   */
  var COPY = {
    'sign-in': {
      title: 'Sign in to Crewaid',
      lede: 'Welcome back! This window hands the result back to the app.',
      prompt: 'New to Crewaid?',
      toggle: 'Create an account',
      name: false
    },
    'sign-up': {
      title: 'Create your account',
      lede: 'Welcome! Fill in your details and we will email you a sign-in link.',
      prompt: 'Already have an account?',
      toggle: 'Sign in',
      name: true
    }
  };
  var mode = 'sign-in';
  var onMode = [];

  function applyMode() {
    var copy = COPY[mode];
    el('title').textContent = copy.title;
    el('lede').textContent = copy.lede;
    el('mode-prompt').textContent = copy.prompt;
    el('mode-toggle').textContent = copy.toggle;
    show('name-field', copy.name);
    onMode.forEach(function (hook) { hook(copy); });
  }

  el('mode-toggle').addEventListener('click', function () {
    mode = mode === 'sign-in' ? 'sign-up' : 'sign-in';
    show('error-tray', false);
    applyMode();
  });

  if (cfg.magicLink) {
    show('magic', true);
    show('magic-footer', true);
    show('or', cfg.providers.length > 0);
    applyMode();
    el('magic').addEventListener('submit', function (event) {
      event.preventDefault();
      show('error-tray', false);
      busy(true);
      // A name is only read when the address has no account yet, so sending it
      // every time is harmless and sending it never is not: Better Auth
      // requires a name on the User row, and a magic-link sign-up that omits
      // one creates an account whose only label is its email address.
      var body = { email: el('email').value };
      // Only from the sign-up form. Sending a stale value from a hidden field
      // would rename nothing — Better Auth ignores a name for an existing
      // account — but it would still be this page asserting something about a
      // person it was not shown by them.
      var name = mode === 'sign-up' ? el('name').value.trim() : '';
      if (name) body.name = name;
      post('/sign-in/magic-link', body)
        .then(function () { show('choices', false); show('sent', true); })
        .catch(function (error) { busy(false); fail(error.message); });
    });
  }

${options.password ? PASSWORD_SCRIPT : NO_METHOD_CHECK}
  // The return trip lands here with the cookie already set, so this is not a
  // race — the poll is for the person who asked for a magic link and comes
  // back to this tab after opening it.
  if (!handBack()) {
    if (!ready) {
      show('choices', false);
      el('lede').textContent =
        'Open this page from Crewaid rather than directly — it needs the one-time ' +
        'challenge the app generates, and there is none in this URL.';
    } else {
      poll();
    }
  }
})();
</script>
</body>
</html>
`;
}

/**
 * A first-party Better Auth plugin that serves nothing but the page above.
 *
 * It adds no table, no hook and no session behaviour — `@better-auth/electron`
 * owns all of that. This exists only so the HTML lives inside `basePath`.
 */
export function desktopSignInPage(options: DesktopSignInPageOptions): BetterAuthPlugin {
  return {
    id: 'crewaid-desktop-sign-in',
    endpoints: {
      crewaidDesktopSignInPage: createAuthEndpoint(
        '/electron/sign-in',
        { method: 'GET', metadata: { scope: 'http' } },
        // The endpoint contract is a promise-returning handler and there is
        // nothing here to await, so the promise is made explicitly rather than
        // with an `async` that would have to be excused from a lint rule.
        (ctx) => {
          // A nonce per response, so the inline script and style are the only
          // ones the browser will run on this origin. The page is the last hop
          // before a credential, and it is also the hop an attacker would most
          // like to get a script onto.
          const nonce = crypto.randomUUID();
          const basePath = ctx.context.options.basePath ?? '/api/auth';
          return Promise.resolve(
            new Response(renderDesktopSignInPage(options, basePath, nonce), {
              headers: {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'no-store',
                'content-security-policy':
                  // `img-src data:` and nothing wider: the only image on this page is
                  // the brand mark, which is inlined. Under `default-src 'none'` an
                  // omitted img-src blocks it outright and the browser reports it only
                  // in the console, so the page would simply render with no logo.
                  `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
                  `img-src data:; connect-src 'self'; form-action 'none'; base-uri 'none'; ` +
                  `frame-ancestors 'none'`,
                // The URL of this page carries the PKCE challenge and the
                // state. Sending it as a Referer to an identity provider would
                // put both in someone else's logs for no benefit at all.
                'referrer-policy': 'no-referrer',
                'x-content-type-options': 'nosniff',
                'x-frame-options': 'DENY',
              },
            }),
          );
        },
      ),
    },
  };
}
