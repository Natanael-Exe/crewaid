import type { SearchResponse, SearchType } from '@crewaid/shared';
import { t } from '../i18n/i18n';

/**
 * The search palette's pure parts: excerpts split on D-077's
 * `<<`/`>>` markers — never parsed as HTML — and the tabs' meaning.
 */

export type ExcerptPart = { readonly text: string; readonly match: boolean };

export function excerptParts(excerpt: string): ExcerptPart[] {
  const parts: ExcerptPart[] = [];
  let rest = excerpt;
  while (rest.length > 0) {
    const open = rest.indexOf('<<');
    if (open === -1) {
      parts.push({ text: rest, match: false });
      break;
    }
    const close = rest.indexOf('>>', open + 2);
    if (close === -1) {
      parts.push({ text: rest, match: false });
      break;
    }
    if (open > 0) parts.push({ text: rest.slice(0, open), match: false });
    parts.push({ text: rest.slice(open + 2, close), match: true });
    rest = rest.slice(close + 2);
  }
  return parts;
}

export type SearchTab = 'all' | 'tasks' | 'files' | 'chat';

export const SEARCH_TABS: ReadonlyArray<{ readonly id: SearchTab; readonly label: string }> = [
  {
    id: 'all',
    get label() {
      return t('work.search.all');
    },
  },
  {
    id: 'tasks',
    get label() {
      return t('work.search.tasks');
    },
  },
  {
    id: 'files',
    get label() {
      return t('work.search.files');
    },
  },
  {
    id: 'chat',
    get label() {
      return t('work.search.chat');
    },
  },
];

/** Which record types a tab searches; undefined is every type. */
export function typesOf(tab: SearchTab): SearchType[] | undefined {
  if (tab === 'tasks') return ['task', 'goal', 'project'];
  if (tab === 'files') return ['deliverable'];
  if (tab === 'chat') return ['message'];
  return undefined;
}

export function hitCount(response: SearchResponse): number {
  return (
    response.tasks.length +
    response.goals.length +
    response.projects.length +
    response.deliverables.length +
    response.messages.length
  );
}
