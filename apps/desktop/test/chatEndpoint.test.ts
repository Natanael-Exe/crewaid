import { describe, expect, it } from 'vitest';
import { API_PREFIX, API_ROUTES, WIRE_VERSION } from '@crewaid/shared';

import { resolveRoute } from '../src/renderer/api/apiClient';
import { chatEndpoint, ChatEndpointError } from '../src/renderer/chat/chatEndpoint';

/**
 * The chat routes cannot go through `ApiClient`, so the properties D-025 asks
 * for have to be established here instead.
 *
 * The risk this covers is the one the attachment Download action already shipped
 * once: a request that reaches the orchestrator outside `fetch`, carrying no
 * `Authorization` header, which `AuthGuard` answers 401. The streaming client is
 * handed a URL and a header bag, so these are the two things that must be right
 * before it is built — and the one thing it must never be handed is a guess at
 * where the orchestrator lives.
 */

const BOT = 'clx1a2b3c4d5e6f7g8h9i0j1';
const TOKEN = 'orch-token-abc';

describe('MOD-AI-08 — the chat endpoint', () => {
  it('builds the URL from API_ROUTES under the prefix, never a path literal', () => {
    const { url } = chatEndpoint(
      { orchestratorBaseUrl: 'https://orch.example', orchestratorToken: TOKEN },
      BOT,
    );
    const { path } = resolveRoute(API_ROUTES.bots.chat, { id: BOT });
    expect(url).toBe(`https://orch.example${API_PREFIX}${path}`);
  });

  it('keeps a reverse proxy’s subpath, which is why the URL resolves relatively', () => {
    // A base of `https://host/crewaid` is one install behind a path prefix. An
    // absolute resolve would drop `/crewaid` and address a host that is not
    // serving the orchestrator at all.
    const { url } = chatEndpoint(
      { orchestratorBaseUrl: 'https://host/crewaid', orchestratorToken: TOKEN },
      BOT,
    );
    expect(url).toContain('/crewaid/api/v1/bots/');
    const trailing = chatEndpoint(
      { orchestratorBaseUrl: 'https://host/crewaid/', orchestratorToken: TOKEN },
      BOT,
    );
    // A base the operator typed with and without a trailing slash is the same
    // install, so it must resolve to the same place.
    expect(trailing.url).toBe(url);
  });

  it('carries the bearer token and the wire version it speaks', () => {
    const { headers } = chatEndpoint(
      { orchestratorBaseUrl: 'https://orch.example', orchestratorToken: TOKEN },
      BOT,
    );
    expect(headers['Authorization']).toBe(`Bearer ${TOKEN}`);
    // D-188: a client built against another contract must fail plainly rather
    // than half-parse a stream it does not understand.
    expect(headers['x-crewaid-wire-version']).toBe(String(WIRE_VERSION));
  });

  it('fails closed on an empty store rather than defaulting to localhost', () => {
    // A misconfigured install must not be able to look like a server outage —
    // the same reason `ApiClient` refuses an empty bag.
    expect(() => chatEndpoint({}, BOT)).toThrow(ChatEndpointError);
    expect(() =>
      chatEndpoint({ orchestratorBaseUrl: '   ', orchestratorToken: TOKEN }, BOT),
    ).toThrow(ChatEndpointError);
    expect(() =>
      chatEndpoint({ orchestratorBaseUrl: 'https://orch.example', orchestratorToken: '  ' }, BOT),
    ).toThrow(ChatEndpointError);
  });

  it('refuses a base that is not HTTP or HTTPS', () => {
    // `file:` and `data:` resolve happily and would send the bearer token
    // somewhere no orchestrator is listening.
    expect(() =>
      chatEndpoint({ orchestratorBaseUrl: 'file:///etc', orchestratorToken: TOKEN }, BOT),
    ).toThrow(ChatEndpointError);
    expect(() =>
      chatEndpoint({ orchestratorBaseUrl: 'not a url', orchestratorToken: TOKEN }, BOT),
    ).toThrow(ChatEndpointError);
  });

  it('says what is wrong without naming a path or a token', () => {
    // The message reaches the screen, so it carries no credential and no local
    // path — the same rule `tokenStore` failures follow.
    try {
      chatEndpoint({ orchestratorToken: TOKEN }, BOT);
      expect.unreachable('an unconfigured base must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ChatEndpointError);
      expect((error as Error).message).not.toContain(TOKEN);
    }
  });
});
