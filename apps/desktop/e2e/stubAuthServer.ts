import { createServer, type Server } from 'node:http';
import { API_PREFIX, AUTH_BASE_PATH } from '@crewaid/shared';

/**
 * A real HTTP server answering the one route the sign-in gate asks for.
 *
 * ── WHY A SERVER AND NOT A MOCK ─────────────────────────────────────────────
 *
 * V1-18 put a gate in front of the shell, and the gate resolves the account by
 * asking the orchestrator who the stored token belongs to. That request is
 * made by the MAIN process — `SignInController.status` runs beside the CC-07
 * store, because the renderer is not trusted with the exchange — so Playwright's
 * `page.route` never sees it. Every renderer-level mock in these specs stays
 * exactly as it was; this covers the one call that leaves the main process.
 *
 * Standing up a socket rather than adding a bypass is deliberate. A flag that
 * let the gate skip its round trip would be a production code path whose only
 * purpose is to be open, and the gate's whole job is to be closed — a test
 * suite that disables the thing under test proves the shell renders, which was
 * never in doubt.
 *
 * It answers `get-session` and nothing else: these specs mock every §4.1 route
 * in the renderer, so a second implementation of them here would be a copy to
 * keep in step for no benefit.
 */
export type StubAuthServer = {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
};

export const STUB_USER = {
  id: 'usr_e2e_singleton',
  email: 'e2e@crewaid.localhost',
  name: 'E2E Operator',
} as const;

export async function startStubAuthServer(port: number): Promise<StubAuthServer> {
  const server: Server = createServer((req, res) => {
    const pathname = (req.url ?? '').split('?')[0] ?? '';

    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    // Renderer-fixture suites still traverse the real experience gate. Their roster
    // fixtures own selection; new-assistant scenarios supply their own bootstrap.
    if (pathname === `${API_PREFIX}/onboarding/bootstrap`) {
      const now = new Date().toISOString();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          bot: {
            id: 'bot_e2e_main',
            userId: STUB_USER.id,
            kind: 'MAIN',
            name: 'Crewaid',
            role: 'Main assistant',
            avatarColor: '#4c6ef5',
            avatarShape: 'egg',
            avatarUrl: null,
            systemPrompt: '',
            modelId: 'default',
            status: 'IDLE',
            sortOrder: 0,
            pinned: true,
            hiddenFromSidebar: false,
            autoReviewRules: [],
            sandboxId: null,
            createdAt: now,
            updatedAt: now,
          },
          onboarding: {
            userId: STUB_USER.id,
            welcomeSeen: true,
            discovery: 'SKIPPED',
            createdAt: now,
            updatedAt: now,
          },
          isNewAccount: false,
        }),
      );
      return;
    }

    if (pathname === `${AUTH_BASE_PATH}/get-session`) {
      // Better Auth's own shape: the session envelope with its user. The
      // controller narrows this without trusting it, so a body that drifted
      // from the real one would surface as "signed out" rather than a crash.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ session: { id: 'ses_e2e' }, user: STUB_USER }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('stub auth server did not bind a TCP port');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
