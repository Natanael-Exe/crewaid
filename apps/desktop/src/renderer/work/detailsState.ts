import type { TaskEvent } from '@crewaid/shared';
import { STATUS_LABELS } from './boardState';
import { t, currentLocale, type PlainKey } from '../i18n/i18n';

/**
 * The activity log in words: who, what, and — for a note —
 * what they said. Pure, so every row reads the same wherever it is drawn.
 */

const FIELD_WORDS: Readonly<Record<string, PlainKey>> = {
  title: 'work.field.title',
  brief: 'work.field.brief',
  dueOn: 'work.field.dueOn',
  projectId: 'work.field.projectId',
  goalId: 'work.field.goalId',
};

/**
 * "the title, the due date and the goal", joined the language's way. English
 * reads through en-GB's list rule, which has no serial comma — the sentence
 * this log always printed.
 */
function listWords(words: readonly string[]): string {
  const locale = currentLocale();
  return new Intl.ListFormat(locale === 'en' ? 'en-GB' : locale, { type: 'conjunction' }).format(
    words,
  );
}

function fieldWord(field: string): string {
  const key = FIELD_WORDS[field];
  return key === undefined ? field : t(key);
}

/** "moved it to Done", "assigned it to Backend", "added a note". */
export function eventText(event: TaskEvent): string {
  switch (event.type) {
    case 'CREATED':
      return t('work.detailsState.createdIt');
    case 'EDITED':
      return t('work.event.changed', { fields: listWords(event.payload.fields.map(fieldWord)) });
    case 'ASSIGNED':
      return t('work.event.assigned', { bot: event.payload.botName });
    case 'UNASSIGNED':
      return event.payload.reason === 'BOT_DELETED'
        ? t('work.event.botDeleted', { bot: event.payload.botName })
        : t('work.event.unassigned', { bot: event.payload.botName });
    case 'STARTED':
      return t('work.detailsState.startedIt');
    case 'STATUS_CHANGED':
      return t('work.event.moved', { status: STATUS_LABELS[event.payload.to] });
    case 'NOTE':
      return t('work.detailsState.addedANote');
    case 'DELIVERABLE_LINKED':
      return t('work.event.delivered', { title: event.payload.title });
  }
}

/** The text shown under an activity row, if any: a note, or why it is blocked. */
export function eventDetail(event: TaskEvent): string | null {
  if (event.type === 'NOTE') return event.payload.text;
  if (event.type === 'STATUS_CHANGED') return event.payload.blockedReason ?? null;
  return null;
}

/**
 * Which conversation an activity row's message lives in: a bot's reply is in
 * the acting bot's own transcript; a Start brief is in the assignee's.
 */
export function eventConversation(event: TaskEvent, assigneeBotId: string | null): string | null {
  if (event.messageId === null) return null;
  if (event.actor === 'BOT') return event.actorBotId;
  return event.type === 'STARTED' ? assigneeBotId : null;
}
