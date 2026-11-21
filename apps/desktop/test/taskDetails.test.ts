import { describe, expect, it } from 'vitest';
import type { TaskEvent } from '@crewaid/shared';

import { eventConversation, eventDetail, eventText } from '../src/renderer/work/detailsState';

/** M10-FE-03 — the activity log in words (PRD-WORK §7.3). */
const base = {
  id: 'e1',
  taskId: 't1',
  userId: 'u',
  actor: 'BOT' as const,
  actorBotId: 'b1',
  actorLabel: 'Backend',
  startKey: null,
  messageId: 'm1',
  createdAt: new Date('2026-09-23T12:00:00Z'),
};
const event = (over: Partial<TaskEvent>): TaskEvent =>
  ({ ...base, type: 'CREATED', payload: {}, ...over }) as TaskEvent;

describe('activity rows', () => {
  it('say what happened, in the actor’s voice', () => {
    expect(
      eventText(event({ type: 'STATUS_CHANGED', payload: { from: 'IN_PROGRESS', to: 'DONE' } })),
    ).toBe('moved it to Done');
    expect(
      eventText(event({ type: 'EDITED', payload: { fields: ['title', 'dueOn', 'goalId'] } })),
    ).toBe('changed the title, the due date and the goal');
    expect(
      eventText(event({ type: 'ASSIGNED', payload: { botId: 'b2', botName: 'Frontend' } })),
    ).toBe('assigned it to Frontend');
    expect(
      eventText(
        event({
          type: 'UNASSIGNED',
          payload: { botId: 'b2', botName: 'Frontend', reason: 'BOT_DELETED' },
        }),
      ),
    ).toBe('deleted Frontend, its assignee');
    expect(
      eventText(
        event({ type: 'DELIVERABLE_LINKED', payload: { deliverableId: 'd', title: 'auth.md' } }),
      ),
    ).toBe('delivered auth.md');
  });

  it('show a note, or why it is blocked, under the row', () => {
    expect(eventDetail(event({ type: 'NOTE', payload: { text: 'JWT + refresh' } }))).toBe(
      'JWT + refresh',
    );
    expect(
      eventDetail(
        event({
          type: 'STATUS_CHANGED',
          payload: { from: 'TODO', to: 'BLOCKED', blockedReason: 'keys' },
        }),
      ),
    ).toBe('keys');
    expect(eventDetail(event({ type: 'CREATED', payload: {} }))).toBeNull();
  });

  it('jump to the bot’s own reply, or to the assignee’s brief for a Start, and nowhere for a board edit', () => {
    expect(eventConversation(event({ type: 'NOTE', payload: { text: 'x' } }), 'b9')).toBe('b1');
    expect(
      eventConversation(
        event({ type: 'STARTED', payload: {}, actor: 'USER', actorBotId: null }),
        'b9',
      ),
    ).toBe('b9');
    expect(
      eventConversation(
        event({
          type: 'NOTE',
          payload: { text: 'x' },
          actor: 'USER',
          actorBotId: null,
          messageId: null,
        }),
        'b9',
      ),
    ).toBeNull();
  });
});
