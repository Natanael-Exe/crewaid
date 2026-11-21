import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { startBriefClosing, type Routine } from '@crewaid/shared';

import { deleteBotConsequence } from '../src/renderer/bots/BotRowMenu';
import { AttachmentCardRow } from '../src/renderer/components/attachments/AttachmentCard';
import {
  createBodyOf,
  draftFromRoutine,
  updateBodyOf,
} from '../src/renderer/routines/routinesState';
import { TaskBriefCard, parseBrief } from '../src/renderer/work/TaskBriefCard';

/** M10-FE-04 — Work inside a bot's chat (PRD-WORK §7.4). */

describe('a Start brief in the transcript', () => {
  const brief =
    'Task: API auth\nProject: Acme SaaS · Goal: Ship the MVP · Due: 2026-10-03\n\nJWT with **refresh** tokens.';

  it('reads back into its title, context and body', () => {
    expect(parseBrief(brief)).toEqual({
      title: 'API auth',
      context: 'Project: Acme SaaS · Goal: Ship the MVP · Due: 2026-10-03',
      body: 'JWT with **refresh** tokens.',
    });
    expect(parseBrief('Task: Water plants')).toEqual({
      title: 'Water plants',
      context: null,
      body: '',
    });
    expect(parseBrief('just words')).toEqual({ title: '', context: null, body: 'just words' });
  });

  it('leaves out the closing line addressed to the bot', () => {
    const sent = `${brief}\n\n${startBriefClosing('clx1a2b3c4d5e6f7g8h9i0j1')}`;
    expect(parseBrief(sent)).toEqual(parseBrief(brief));
    const html = renderToStaticMarkup(
      <TaskBriefCard text={sent} taskId="t1" timeLabel="4:19 PM" onOpenTask={() => {}} />,
    );
    expect(html).toContain('refresh');
    expect(html).not.toContain('task_update');
    // Without a body, the closing line is still not shown as one.
    expect(parseBrief(`Task: Water plants\n\n${startBriefClosing('c1')}`).body).toBe('');
  });

  it('renders as the task’s card, with a way into the task', () => {
    const html = renderToStaticMarkup(
      <TaskBriefCard text={brief} taskId="t1" timeLabel="4:19 PM" onOpenTask={() => {}} />,
    );
    expect(html).toContain('Task started');
    expect(html).toContain('API auth');
    expect(html).toContain('Ship the MVP');
    expect(html).toMatch(/<strong[^>]*>(<span>)?refresh/);
    expect(html).toContain('Open task');
    expect(html).toContain('data-task-brief="t1"');
  });
});

describe('a filed attachment', () => {
  const attachment = { id: 'a1', filename: 'auth.md', mimeType: 'text/markdown', sizeBytes: 10 };
  it('names the task it is filed under, and nothing when it is unfiled', () => {
    const filed = renderToStaticMarkup(
      <AttachmentCardRow
        attachments={[attachment]}
        filedTask={() => ({ taskId: 't1', title: 'API auth' })}
        onOpenTask={() => {}}
      />,
    );
    expect(filed).toContain('→ API auth');
    const unfiled = renderToStaticMarkup(
      <AttachmentCardRow
        attachments={[attachment]}
        filedTask={() => undefined}
        onOpenTask={() => {}}
      />,
    );
    expect(unfiled).not.toContain('→');
  });
});

describe('a routine’s goal', () => {
  const routine: Routine = {
    id: 'r1',
    botId: 'b1',
    name: 'Sunday review',
    cron: '0 20 * * 0',
    timezone: 'America/New_York',
    endsOn: null,
    prompt: 'How did my week go?',
    skillId: null,
    skillParams: null,
    enabled: true,
    lastRunAt: null,
    lastStatus: null,
    origin: 'OPERATOR',
    goalId: null,
  };

  it('is sent only when chosen, and changed only when it changed', () => {
    const draft = draftFromRoutine(routine);
    expect(createBodyOf(draft, 'b1')).not.toHaveProperty('goalId');
    expect(createBodyOf({ ...draft, goalId: 'g1' }, 'b1')).toMatchObject({ goalId: 'g1' });
    expect(updateBodyOf(draft, routine)).toBeNull();
    expect(updateBodyOf({ ...draft, goalId: 'g1' }, routine)).toEqual({ goalId: 'g1' });
    expect(
      updateBodyOf(draftFromRoutine({ ...routine, goalId: 'g1' }), { ...routine, goalId: 'g1' }),
    ).toBeNull();
  });
});

describe('deleting a bot', () => {
  it('says how many deliverables go with it, and that its tasks stay', () => {
    expect(deleteBotConsequence(3)).toBe(
      'This removes the bot, its whole conversation history and its 3 deliverables. It cannot be undone. Tasks assigned to it stay, unassigned.',
    );
    expect(deleteBotConsequence(1)).toContain('and its 1 deliverable.');
    for (const none of [0, null]) {
      expect(deleteBotConsequence(none)).toBe(
        'This removes the bot, its whole conversation history. It cannot be undone. Tasks assigned to it stay, unassigned.',
      );
    }
  });
});
