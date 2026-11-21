import { Resend } from 'resend';

/**
 * Magic-link delivery.
 *
 * Its own module rather than an inline closure in `better-auth.ts` so the
 * Better Auth CLI can import that config to generate the schema without
 * constructing a Resend client — and so this can be tested without one.
 */

export type MagicLinkEmail = {
  readonly email: string;
  readonly url: string;
};

/** The narrow surface used, so a test can supply a fake without the SDK. */
export type MagicLinkSender = {
  readonly send: (message: MagicLinkEmail) => Promise<void>;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required to send magic links (infra/compose/.env.example)`);
  }
  return value;
}

let cached: MagicLinkSender | undefined;

/**
 * Built on first send, not at import.
 *
 * An install that only uses Google and GitHub has no Resend key, and it must
 * still boot. Constructing the client at module scope would turn "magic links
 * are not configured" into "the orchestrator will not start", which is the
 * same failure the AuthGuard's constructor check exists to AVOID producing for
 * features an operator did not ask for.
 */
function resendSender(): MagicLinkSender {
  const resend = new Resend(requireEnv('RESEND_API_KEY'));
  const from = requireEnv('MAGIC_LINK_FROM');
  return {
    send: async ({ email, url }) => {
      const { error } = await resend.emails.send({
        from,
        to: email,
        subject: 'Your Crewaid sign-in link',
        text: signInText(url),
        html: signInHtml(url),
      });
      if (error) {
        // The provider's message is operator-facing and safe to surface: it
        // describes a delivery failure, never the link. The LINK is the
        // credential here and it appears in no log line on any path.
        throw new Error(`magic link delivery failed: ${error.message}`);
      }
    },
  };
}

/** Test seam. Passing `undefined` restores the real Resend sender. */
export function setMagicLinkSender(sender: MagicLinkSender | undefined): void {
  cached = sender;
}

export async function sendMagicLinkEmail(message: MagicLinkEmail): Promise<void> {
  cached ??= resendSender();
  await cached.send(message);
}

function signInText(url: string): string {
  return [
    'Sign in to Crewaid.',
    '',
    url,
    '',
    'This link expires in 5 minutes and can be used once.',
    'If you did not ask to sign in, you can ignore this email — nothing has happened to your account.',
  ].join('\n');
}

function signInHtml(url: string): string {
  // Hand-written rather than templated: this is the only email the product
  // sends, and a template engine here would be a dependency whose output
  // nobody reviews. The URL is interpolated into an href and its text, both
  // escaped, because a magic link carries a token that must survive intact.
  const safe = escapeHtml(url);
  return [
    '<p>Sign in to Crewaid.</p>',
    `<p><a href="${safe}">Sign in</a></p>`,
    `<p style="word-break:break-all"><small>${safe}</small></p>`,
    '<p><small>This link expires in 5 minutes and can be used once. ',
    'If you did not ask to sign in, you can ignore this email — nothing has ',
    'happened to your account.</small></p>',
  ].join('');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
