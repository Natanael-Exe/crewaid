/**
 * The shared ElevenLabs agent that is the voice on a call.
 *
 * Two REST calls and nothing else, and the only file that makes them: a signed
 * URL for one conversation, and the conversation itself once it ends, whose
 * `call_duration_secs` is what a call's minutes settle to. TanStack's
 * `elevenlabsRealtimeToken()` would mint the URL, but it reads its key only
 * from `process.env.ELEVENLABS_API_KEY`, and a key here is always passed in.
 *
 * A failure is reported by kind, never with ElevenLabs' response body.
 */
export interface CallAgent {
  /** A single-use signed URL for one conversation, and that conversation's id. */
  signedUrl(signal?: AbortSignal): Promise<SignedConversation>;
  /**
   * How long a conversation lasted by ElevenLabs' own count, or null while it
   * has not finished. Throws `CallAgentError` when ElevenLabs cannot answer.
   */
  conversationSeconds(conversationId: string, signal?: AbortSignal): Promise<number | null>;
}

/**
 * The address that starts one conversation with the agent, and the id that
 * conversation will have.
 *
 * Asked for with `include_conversation_id`, which makes the address work ONCE:
 * a call is exactly one conversation, and the server knows which before the
 * client connects. Left to the client, the id was the client's to report — so
 * not reporting it settled a call to zero, and reporting a shorter one settled
 * it to that.
 */
export type SignedConversation = { readonly url: string; readonly conversationId: string };

/** How long a signed URL can start its conversation, by ElevenLabs' own limit. */
export const SIGNED_URL_TTL_MS = 15 * 60 * 1000;

const CONVERSATION_ID = /^conv_[A-Za-z0-9]{1,128}$/;

export type CallAgentFactory = (apiKey: string, agentId: string) => CallAgent;
export const CALL_AGENT_FACTORY = Symbol('CALL_AGENT_FACTORY');

export class CallAgentError extends Error {
  constructor(readonly kind: 'unreachable' | 'refused' | 'not_found' | 'malformed') {
    super(`ElevenLabs agent request failed: ${kind}`);
    this.name = 'CallAgentError';
  }
}

const API = 'https://api.elevenlabs.io/v1/convai';
const TIMEOUT_MS = 15_000;

export function elevenLabsCallAgent(
  apiKey: string,
  agentId: string,
  fetchFn: typeof fetch = fetch,
): CallAgent {
  async function get(path: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const bound = AbortSignal.timeout(TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchFn(`${API}${path}`, {
        headers: { 'xi-api-key': apiKey },
        signal: signal === undefined ? bound : AbortSignal.any([signal, bound]),
      });
    } catch {
      throw new CallAgentError('unreachable');
    }
    if (res.status === 404) throw new CallAgentError('not_found');
    if (!res.ok) throw new CallAgentError(res.status >= 500 ? 'unreachable' : 'refused');
    const body: unknown = await res.json().catch(() => null);
    if (typeof body !== 'object' || body === null) throw new CallAgentError('malformed');
    return body as Record<string, unknown>;
  }

  return {
    async signedUrl(signal) {
      const body = await get(
        `/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}&include_conversation_id=true`,
        signal,
      );
      const url = body['signed_url'];
      if (typeof url !== 'string' || !url.startsWith('wss://')) {
        throw new CallAgentError('malformed');
      }
      // The id rides in the URL's own query; a URL without one is a call the
      // server could not settle, so it is refused rather than handed out.
      let conversationId: string | null;
      try {
        conversationId = new URL(url).searchParams.get('conversation_id');
      } catch {
        conversationId = null;
      }
      if (conversationId === null || !CONVERSATION_ID.test(conversationId)) {
        throw new CallAgentError('malformed');
      }
      return { url, conversationId };
    },

    async conversationSeconds(conversationId, signal) {
      const body = await get(`/conversations/${encodeURIComponent(conversationId)}`, signal);
      // Still running or still being processed: not a duration yet.
      if (body['status'] !== 'done' && body['status'] !== 'failed') return null;
      const metadata = body['metadata'];
      const seconds =
        typeof metadata === 'object' && metadata !== null
          ? (metadata as Record<string, unknown>)['call_duration_secs']
          : undefined;
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
        throw new CallAgentError('malformed');
      }
      return Math.ceil(seconds);
    },
  };
}
