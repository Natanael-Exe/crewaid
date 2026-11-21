import { describe, expect, it } from 'vitest';
import type { UIMessage } from '@tanstack/ai';
import type { CrewaidMessageMetadata } from '@crewaid/shared';
import { toTranscriptMessage } from '../src/renderer/chat/uiMessage';

/**
 * A file a bot attached, on the row the operator reads.
 *
 * The defect behind this suite: a bot attaches DURING its turn, so nothing the
 * reply started with mentions the file, and for a while the only path that
 * ever carried an attachment to a running client was a REST history fetch —
 * the operator watched the bot say "I've attached the file" and saw nothing
 * until an app restart.
 *
 * D-192 moved where the claim arrives: a message's attachments ride
 * `metadata.crewaid` (the §3.4 projection the operator's hydrate adds), and
 * the chat client is what keeps a message current as its run writes to it. So
 * what is left to prove here is the projection at the end of that path —
 * `toTranscriptMessage` is the one place a `UIMessage` becomes a rendered row,
 * and a card that is not built there is a card nobody sees.
 */

const BOT = 'clx1a2b3c4d5e6f7g8h9i0j1';
const MSG = 'clxaaaaaaaaaaaaaaaaaaaa1';

const EMPTY: CrewaidMessageMetadata = {
  author: 'BOT',
  fromBotId: BOT,
  runId: 'run-1',
  sequence: 3,
  stopReason: null,
  taskId: null,
  routineId: null,
  chainId: null,
  hopCount: 0,
  startsTopic: false,
  attachments: [],
};

/** A claimed upload as the hydrate projects it: the card's four fields. */
function attachment(id: string) {
  return { id, filename: `${id}.png`, mimeType: 'image/png', sizeBytes: 2048 };
}

function reply(crewaid: Partial<CrewaidMessageMetadata>): UIMessage {
  return {
    id: MSG,
    role: 'assistant',
    parts: [{ type: 'text', content: "I've attached the file." }],
    createdAt: new Date('2026-09-18T09:00:00.000Z'),
    metadata: { crewaid: { ...EMPTY, ...crewaid } },
  };
}

describe('a claimed file on the reply that claimed it', () => {
  it('renders every claim as a card, and leaves the server plumbing behind', () => {
    const row = toTranscriptMessage(
      reply({
        attachments: [attachment('clxattach00000000000001'), attachment('clxattach00000000000002')],
      }),
      BOT,
    );

    // In the order the turn claimed them, with the fields the card reads. An
    // attachment with no kind is a plain file (D-221).
    expect(row.attachments).toEqual([
      {
        id: 'clxattach00000000000001',
        filename: 'clxattach00000000000001.png',
        mimeType: 'image/png',
        sizeBytes: 2048,
        kind: 'FILE',
        durationMs: null,
      },
      {
        id: 'clxattach00000000000002',
        filename: 'clxattach00000000000002.png',
        mimeType: 'image/png',
        sizeBytes: 2048,
        kind: 'FILE',
        durationMs: null,
      },
    ]);
    // `storageKey` is the one field that must not travel: D-025 fetches bytes
    // through the download route, so a key on a rendered row is an invitation
    // to address the store directly.
    expect(JSON.stringify(row.attachments)).not.toContain('storageKey');
  });

  it('shows the claim on a reply that ended badly — the evidence survives the failure', () => {
    // The tool ran and the file exists; what failed was the turn around it.
    // Dropping the card here would leave the operator with a half-written
    // reply mentioning a file they cannot find.
    const row = toTranscriptMessage(
      reply({ stopReason: 'RATE_LIMITED', attachments: [attachment('clxattach00000000000001')] }),
      BOT,
    );

    expect(row.stopReason).toBe('RATE_LIMITED');
    expect(row.attachments?.map((a) => a.id)).toEqual(['clxattach00000000000001']);
  });

  it('omits the key entirely when a message claimed nothing', () => {
    // Absent rather than empty: the transcript renders its card area on the
    // presence of the key, so `[]` would put an empty frame under every reply.
    expect(toTranscriptMessage(reply({}), BOT).attachments).toBeUndefined();
  });

  it('renders a message with no projection yet, rather than failing on it', () => {
    // This window's own send, painted the instant the operator pressed enter:
    // the server's metadata arrives with the next hydrate, and until it does
    // the role is all there is to go on.
    const optimistic: UIMessage = {
      id: MSG,
      role: 'user',
      parts: [{ type: 'text', content: 'Have a look at this.' }],
    };

    const row = toTranscriptMessage(optimistic, BOT);
    expect(row.author).toBe('USER');
    expect(row.attachments).toBeUndefined();
  });
});
