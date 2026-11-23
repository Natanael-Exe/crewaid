import { describe, expect, it } from 'vitest';
import { CallAgentError, elevenLabsCallAgent } from '../../src/ee/voice/elevenlabs-agent.js';

/** A fetch that answers one canned response and records what it was asked. */
function fakeFetch(status: number, body: unknown) {
  const asked: Array<{ url: string; key: string | null }> = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push({
      url: String(input),
      key: new Headers(init?.headers).get('xi-api-key'),
    });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fn, asked };
}

describe('D-222 — the call agent, over ElevenLabs’ REST API', () => {
  it('mints a single-use signed URL for the configured agent, and the conversation it starts', async () => {
    const signed =
      'wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_1&conversation_signature=s&conversation_id=conv_01abc';
    const { fn, asked } = fakeFetch(200, { signed_url: signed });
    const agent = elevenLabsCallAgent('sk_el_1', 'agent_1', fn);
    expect(await agent.signedUrl()).toEqual({ url: signed, conversationId: 'conv_01abc' });
    expect(asked).toEqual([
      {
        url: 'https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=agent_1&include_conversation_id=true',
        key: 'sk_el_1',
      },
    ]);
  });

  it('refuses a signed URL that does not name its conversation', async () => {
    for (const signed of [
      'wss://api.elevenlabs.io/v1/convai/conversation?conversation_signature=s',
      'wss://api.elevenlabs.io/v1/convai/conversation?conversation_id=not-a-conversation',
    ]) {
      const { fn } = fakeFetch(200, { signed_url: signed });
      await expect(elevenLabsCallAgent('k', 'a', fn).signedUrl()).rejects.toMatchObject({
        kind: 'malformed',
      });
    }
  });

  it('reads a finished conversation’s duration, rounded up to the second', async () => {
    const { fn } = fakeFetch(200, { status: 'done', metadata: { call_duration_secs: 20.2 } });
    expect(await elevenLabsCallAgent('k', 'a', fn).conversationSeconds('conv_1')).toBe(21);
  });

  it('says nothing yet about a conversation still running or processing', async () => {
    for (const status of ['in-progress', 'processing', 'initiated']) {
      const { fn } = fakeFetch(200, { status, metadata: { call_duration_secs: 5 } });
      expect(await elevenLabsCallAgent('k', 'a', fn).conversationSeconds('conv_1')).toBeNull();
    }
  });

  it('reports a failure by kind, never with ElevenLabs’ own words', async () => {
    const cases = [
      [401, 'refused'],
      [404, 'not_found'],
      [503, 'unreachable'],
    ] as const;
    for (const [status, kind] of cases) {
      const { fn } = fakeFetch(status, { detail: 'invalid api key sk_el_secret' });
      const failure = await elevenLabsCallAgent('k', 'a', fn)
        .signedUrl()
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CallAgentError);
      expect(failure).toMatchObject({ kind });
      expect(String((failure as Error).message)).not.toContain('sk_el_secret');
    }
  });

  it('refuses a signed URL that is not a socket address', async () => {
    const { fn } = fakeFetch(200, { signed_url: 'https://elsewhere.example/call' });
    await expect(elevenLabsCallAgent('k', 'a', fn).signedUrl()).rejects.toMatchObject({
      kind: 'malformed',
    });
  });
});
