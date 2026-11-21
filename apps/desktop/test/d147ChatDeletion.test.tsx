import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Bot, ServerFrame } from '@crewaid/shared';
import { ServerFrameSchema } from '@crewaid/shared';
import type { UIMessage } from '@tanstack/ai';

import { chatReducer, initialChatState, type ChatState } from '../src/renderer/state/chatReducer';
import { toTranscriptMessage } from '../src/renderer/chat/uiMessage';
import { Transcript } from '../src/renderer/components/Transcript';
import {
  deleteFailureMessage,
  deleteMessagesCopy,
} from '../src/renderer/components/DeleteMessagesDialog';
import {
  NEW_TOPIC_COMMAND,
  commandOfDraft,
  filterCommands,
  withoutSlashToken,
} from '../src/renderer/components/composer/composerCommands';

/**
 * D-147 in the renderer: what a deletion leaves behind, and what `/new` is.
 *
 * The messages themselves belong to the chat client, which takes the same
 * `message.deleted` frame and drops the named ids out of its own thread. What
 * is left for the reducer is the badge, and the badge is the half that can
 * read the conversation wrong after it is gone: a cleared chat with an unread
 * count beside it invites the operator back into an empty room. So a clear
 * zeroes it, a partial deletion leaves the number to the server's next answer
 * — and changes nothing here at all, by identity, because a frame that is not
 * news must not re-render the sidebar.
 *
 * `/new` is the other half: a palette command that removes its own token
 * instead of completing it, a boundary that reaches the transcript as a
 * divider rather than a system note, and a confirmation that asks about
 * memory in the words the server's own behaviour justifies.
 */

const BOT = 'clx1a2b3c4d5e6f7g8h9i0j1';
const OTHER_BOT = 'clx1a2b3c4d5e6f7g8h9i0j9';
const MSG_1 = 'clxaaaaaaaaaaaaaaaaaaaa1';
const MSG_2 = 'clxaaaaaaaaaaaaaaaaaaaa2';
const UUID = '3f1a5c2e-9b47-4d81-a6f2-0e5c7b8d1234';

function deletedFrame(payload: unknown): ServerFrame {
  // Parsed, not cast: the frame under test must be one the socket would admit.
  return ServerFrameSchema.parse({
    id: UUID,
    type: 'message.deleted',
    botId: BOT,
    ts: 1_759_000_000_000,
    payload,
  });
}

const apply = (state: ChatState, frame: ServerFrame) =>
  chatReducer(state, { type: 'ws/frame', frame });

/** A bot with messages the operator has not read yet. */
const unread = (counts: Record<string, number>): ChatState => ({
  ...initialChatState,
  unreadByBot: counts,
});

/**
 * One stored row as the thread's operator view hands it over. A SYSTEM row
 * has no role of its own to travel in — the projection's `author` is what
 * says so — and `role` is passed in because the same row reaches the client
 * two ways: `system` from a hydrate, `assistant` when this window appends the
 * boundary it just created.
 */
function systemRow(
  id: string,
  content: string,
  startsTopic: boolean,
  role: UIMessage['role'] = 'system',
): UIMessage {
  return {
    id,
    role,
    parts: [{ type: 'text', content }],
    createdAt: new Date('2026-09-01T12:00:00.000Z'),
    metadata: {
      crewaid: {
        author: 'SYSTEM',
        fromBotId: null,
        runId: null,
        sequence: 0,
        stopReason: null,
        taskId: null,
        routineId: null,
        chainId: null,
        hopCount: 0,
        startsTopic,
        attachments: [],
      },
    },
  };
}

describe('message.deleted', () => {
  it('zeroes the unread badge on a clear', () => {
    const next = apply(
      unread({ [BOT]: 2 }),
      deletedFrame({ botId: BOT, messageIds: [], cleared: true }),
    );
    expect(next.unreadByBot[BOT]).toBe(0);
  });

  it('leaves the count to the server when only some messages go', () => {
    // A deletion that is not a clear says nothing reliable about how many of
    // what is left the operator has read — the server answers that on the
    // next `GET /bots`. So the frame is a no-op here, BY IDENTITY: it arrives
    // once from the socket and once as this window's own echo, and neither
    // must re-render consumers for a change that did not happen.
    const state = unread({ [BOT]: 2 });
    const next = apply(state, deletedFrame({ botId: BOT, messageIds: [MSG_1] }));
    expect(next).toBe(state);
    expect(next.unreadByBot[BOT]).toBe(2);
  });

  it('is a no-op on a second clear, so an echoed frame changes nothing', () => {
    const cleared = apply(
      unread({ [BOT]: 2 }),
      deletedFrame({ botId: BOT, messageIds: [], cleared: true }),
    );
    expect(apply(cleared, deletedFrame({ botId: BOT, messageIds: [], cleared: true }))).toBe(
      cleared,
    );
  });

  it('leaves another bot alone', () => {
    const next = apply(
      unread({ [BOT]: 2, [OTHER_BOT]: 3 }),
      deletedFrame({ botId: BOT, messageIds: [], cleared: true }),
    );
    expect(next.unreadByBot[OTHER_BOT]).toBe(3);
  });
});

describe('a /new boundary', () => {
  it('reaches the view marked as a boundary, whichever role carried it', () => {
    // A hydrate reads it as `system`; the append this window makes for the
    // boundary it just created reads as `assistant`, because there is no
    // system role to put a product row in. Either way the column decides.
    for (const role of ['system', 'assistant'] as const) {
      const view = toTranscriptMessage(systemRow(MSG_1, 'New topic', true, role), BOT);
      expect(view.author, role).toBe('SYSTEM');
      expect(view.startsTopic, role).toBe(true);
    }
    const plain = toTranscriptMessage(systemRow(MSG_2, 'Model changed', false), BOT);
    expect(plain.author).toBe('SYSTEM');
    expect(plain.startsTopic).toBeUndefined();
  });

  it('draws as a divider with an undo, not as a system note', () => {
    const html = renderToStaticMarkup(
      <Transcript
        bot={
          {
            id: BOT,
            name: 'Paul',
            role: 'CTO',
            avatarColor: '#e0447c',
            modelId: 'default',
            approvalMode: 'AUTO',
          } as unknown as Bot
        }
        historyLoaded
        connection={{ status: 'connected', attempt: 0, retryDelayMs: null }}
        messages={[toTranscriptMessage(systemRow(MSG_1, 'New topic', true), BOT)]}
        pending={[]}
        onSend={() => {}}
        onStop={() => {}}
        onFiles={() => {}}
        onRemovePending={() => {}}
        onRetryPending={() => {}}
        work={{ onOpenTask: () => {}, filedTask: () => undefined, onRemoveTopic: () => {} }}
      />,
    );
    expect(html).toContain('data-topic-boundary');
    expect(html).toContain('data-topic-undo');
  });
});

describe('the /new command', () => {
  it('is offered for its name and its label', () => {
    expect(filterCommands([NEW_TOPIC_COMMAND], 'ne')).toEqual([NEW_TOPIC_COMMAND]);
    expect(filterCommands([NEW_TOPIC_COMMAND], 'new t')).toEqual([NEW_TOPIC_COMMAND]);
    expect(filterCommands([NEW_TOPIC_COMMAND], 'read')).toEqual([]);
  });

  it('removes only its own token when picked', () => {
    const draft = 'keep this /ne';
    expect(withoutSlashToken(draft, draft.length)).toEqual({ draft: 'keep this ', caret: 10 });
  });

  it('runs from a draft that is exactly the command, and from nothing else', () => {
    expect(commandOfDraft([NEW_TOPIC_COMMAND], '  /new ')).toBe(NEW_TOPIC_COMMAND);
    expect(commandOfDraft([NEW_TOPIC_COMMAND], '/new please')).toBeNull();
    expect(commandOfDraft([NEW_TOPIC_COMMAND], 'what is /new')).toBeNull();
    expect(commandOfDraft([], '/new')).toBeNull();
  });
});

describe('the confirmation', () => {
  it('asks about memory for both a message and a clear, naming the bot', () => {
    expect(deleteMessagesCopy('message', 'Paul').forget).toBe(
      'Also forget what Paul learned from this message',
    );
    expect(deleteMessagesCopy('clear', 'Paul').forget).toBe(
      'Also forget what Paul learned from this chat',
    );
    expect(deleteMessagesCopy('clear', 'Paul').body).toContain('Deliverables stay.');
  });

  it('turns the running-turn refusal into what to do about it', () => {
    expect(
      deleteFailureMessage({ code: 'CONFLICT', message: 'x', detail: null } as never, 'Paul'),
    ).toBe('Paul is working. Stop it or wait for the reply, then try again.');
  });
});
