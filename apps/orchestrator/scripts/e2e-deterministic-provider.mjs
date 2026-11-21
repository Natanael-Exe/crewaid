import { randomUUID } from 'node:crypto';
import { EventType } from '@tanstack/ai';
import { BaseTextAdapter } from '@tanstack/ai/adapters';

/**
 * The only fake in M1-QA-05. Everything around this model — HTTP, auth,
 * persistence, WebSocket delivery, and the Electron renderer — is real.
 * Delays are deliberate: the E2E must be able to observe a partial reply
 * before the final chunk arrives, not merely the settled database row.
 */
export const E2E_REPLY = 'Deterministic stream reply.';

/** The three deltas the reply arrives in, one per word boundary. */
const E2E_REPLY_WORDS = ['Deterministic ', 'stream ', 'reply.'];

/** Before the first delta, and between two of them. */
const FIRST_DELTA_MS = 100;
const BETWEEN_DELTAS_MS = 400;

/**
 * The fact the approval-gated reply asks to remember, as the model proposes it.
 * A spec edits it in the prompt and then looks for its own wording, so the two
 * must differ in a way a substring check cannot confuse.
 */
export const E2E_APPROVAL_FACT = 'The staging site is staging-proposed.example.test';

/** What the bot says once the approved call has run and its result is back. */
export const E2E_APPROVAL_REPLY = 'Noted, as you approved it.';

/**
 * The reply, as the TanStack text adapter the run engine calls (D-191, D-199):
 * an `AnyTextAdapter` yielding AG-UI events against `chat()`.
 *
 * The delays are the point here too: `WordBoundaryStrategy` in the renderer
 * emits on word boundaries, so a delta ending in a space is a repaint, and a
 * spec can observe a partial reply before the last word lands.
 *
 * `approvalTool` makes every reply to an operator's message a `remember` call
 * before any text (see `approvalCall`); off, the adapter only ever streams
 * `E2E_REPLY`.
 *
 * @param {{ readonly approvalTool?: boolean }} [options]
 */
export function createDeterministicTextAdapter(options = {}) {
  return new DeterministicTextAdapter(options.approvalTool === true);
}

class DeterministicTextAdapter extends BaseTextAdapter {
  name = 'crewaid-e2e-deterministic';
  #approvalTool;

  constructor(approvalTool) {
    super({}, 'crewaid-e2e-deterministic');
    this.#approvalTool = approvalTool;
  }

  async *chatStream(options) {
    const runId = options.runId ?? randomUUID();
    const threadId = options.threadId ?? randomUUID();
    const signal = options.abortController?.signal;
    const messageId = `e2e-${randomUUID()}`;
    const last = options.messages[options.messages.length - 1];
    const now = () => Date.now();

    yield { type: EventType.RUN_STARTED, runId, threadId, timestamp: now() };
    yield {
      type: EventType.TEXT_MESSAGE_START,
      messageId,
      role: 'assistant',
      timestamp: now(),
    };

    // A reply to the operator is the call; anything after a tool result is the
    // closing text. Keyed on the newest message rather than on a counter, so a
    // resumed run — a new process-level call with the same history — picks the
    // same branch a live one would.
    if (this.#approvalTool && last?.role === 'user') {
      yield* approvalCall({ runId, threadId, messageId, now });
      return;
    }

    const words =
      this.#approvalTool && last?.role === 'tool' ? [E2E_APPROVAL_REPLY] : E2E_REPLY_WORDS;
    let first = true;
    for (const delta of words) {
      await new Promise((resolve) =>
        setTimeout(resolve, first ? FIRST_DELTA_MS : BETWEEN_DELTAS_MS),
      );
      first = false;
      // A Stop must leave the partial reply that was already streamed, so the
      // adapter stops yielding rather than throwing: the engine's abort path
      // settles the run and the persisted message keeps what it has.
      if (signal?.aborted === true) return;
      yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta, timestamp: now() };
    }
    yield { type: EventType.TEXT_MESSAGE_END, messageId, timestamp: now() };
    yield {
      type: EventType.RUN_FINISHED,
      runId,
      threadId,
      finishReason: 'stop',
      usage: { promptTokens: 2, completionTokens: words.length, totalTokens: 2 + words.length },
      timestamp: now(),
    };
  }

  structuredOutput() {
    return Promise.reject(new Error('the deterministic e2e adapter has no structured output'));
  }
}

/**
 * One `remember` call, in the AG-UI events a provider adapter yields for a
 * tool call (the shape `ScriptedAdapter` in `test/mod-02-tanstack-harness.ts`
 * uses), ending `tool_calls` so the engine reaches its `beforeTools` boundary.
 *
 * `remember` because it is the one tool whose whole effect lives in the
 * orchestrator's own database: this harness owns no computer, so a shell or
 * browser call would fail at dispatch and prove nothing about the arguments it
 * was given. It is a `draft` effect, so it asks under "Ask for approval" and
 * is allowed under the default mode — the spec that opts in sets the mode, and
 * the prompt it sees is the policy's own decision, not this script's.
 */
function* approvalCall({ runId, threadId, messageId, now }) {
  const toolCallId = `e2e-call-${randomUUID()}`;
  yield { type: EventType.REASONING_MESSAGE_START, messageId, timestamp: now() };
  yield {
    type: EventType.REASONING_MESSAGE_CONTENT,
    messageId,
    delta: 'This fact should be saved after approval.',
    timestamp: now(),
  };
  yield { type: EventType.REASONING_MESSAGE_END, messageId, timestamp: now() };
  yield {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId,
    delta: 'I will remember that. ',
    timestamp: now(),
  };
  yield { type: EventType.TEXT_MESSAGE_END, messageId, timestamp: now() };
  yield {
    type: EventType.TOOL_CALL_START,
    toolCallId,
    toolCallName: 'remember',
    parentMessageId: messageId,
    index: 0,
    timestamp: now(),
  };
  yield {
    type: EventType.TOOL_CALL_ARGS,
    toolCallId,
    delta: JSON.stringify({ fact: E2E_APPROVAL_FACT, kind: 'fact', scope: 'mine' }),
    timestamp: now(),
  };
  yield { type: EventType.TOOL_CALL_END, toolCallId, timestamp: now() };
  yield {
    type: EventType.RUN_FINISHED,
    runId,
    threadId,
    finishReason: 'tool_calls',
    usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
    timestamp: now(),
  };
}
