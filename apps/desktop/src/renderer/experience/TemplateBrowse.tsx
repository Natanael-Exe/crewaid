import { Button, SearchField, Tabs } from '@heroui/react';
import { IconArrowRight, IconSearch } from '@tabler/icons-react';
import { useMemo } from 'react';
import { templateMatches, type Template } from '@crewaid/shared';
import { BotAvatar } from '../components/BotAvatar';
import { EmptyState } from '../components/ui';
import { useT } from '../i18n/i18n';

export type BrowseState = {
  readonly kind: 'crew' | 'bot';
  readonly query: string;
  readonly category: string;
};

export const INITIAL_BROWSE: BrowseState = { kind: 'crew', query: '', category: '' };

export function visibleTemplates(templates: readonly Template[], state: BrowseState): Template[] {
  return templates.filter(
    (entry) =>
      entry.kind === state.kind &&
      (state.category === '' || entry.category === state.category) &&
      templateMatches(entry, state.query),
  );
}

/** Crews and Bots, one search, category chips, and a row per template. */
export function TemplateBrowse({
  templates,
  state,
  onChange,
  onOpen,
}: {
  templates: readonly Template[];
  state: BrowseState;
  onChange: (next: BrowseState) => void;
  onOpen: (id: string) => void;
}) {
  const t = useT();
  // Crew order is the catalog's, so the chips read in the same order as the list.
  const categories = useMemo(
    () => [...new Set(templates.filter((t) => t.kind === 'crew').map((t) => t.category))],
    [templates],
  );
  const shown = visibleTemplates(templates, state);
  const total = templates.filter((entry) => entry.kind === state.kind).length;
  return (
    <>
      <div className="flex flex-wrap items-center gap-4 px-8 pb-4">
        <Tabs
          selectedKey={state.kind}
          onSelectionChange={(key) => onChange({ ...state, kind: key === 'bot' ? 'bot' : 'crew' })}
        >
          <Tabs.ListContainer>
            <Tabs.List aria-label={t('experience.templateBrowse.templateType')}>
              <Tabs.Tab id="crew">
                {t('experience.templateBrowse.crews')}
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="bot">
                {t('experience.templateBrowse.bots')}
                <Tabs.Indicator />
              </Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
        </Tabs>
        <SearchField
          variant="secondary"
          aria-label={t('experience.templateBrowse.searchTemplates')}
          value={state.query}
          onChange={(query) => onChange({ ...state, query })}
          className="min-w-[220px] flex-1"
        >
          <SearchField.Group className="h-11 rounded-[10px]">
            <SearchField.SearchIcon />
            <SearchField.Input
              placeholder={t('experience.templateBrowse.searchByRoleTaskOutcome')}
            />
            <SearchField.ClearButton />
          </SearchField.Group>
        </SearchField>
      </div>
      <div
        role="group"
        aria-label={t('experience.templateBrowse.category')}
        className="flex flex-wrap gap-2 border-b border-separator px-8 pb-5"
      >
        {['', ...categories].map((category) => (
          <button
            key={category || 'all'}
            type="button"
            aria-pressed={state.category === category}
            onClick={() => onChange({ ...state, category })}
            className="crewaid-template-chip cursor-pointer rounded-full px-3.5 py-1.5 text-footnote transition-colors hover:opacity-90"
          >
            {category || t('experience.templateBrowse.all')}
          </button>
        ))}
      </div>
      <p className="px-8 pb-1 pt-[18px] text-caption text-muted tabular-nums">
        {state.kind === 'crew'
          ? shown.length === total
            ? t('experience.templateBrowse.crewCount', { count: total })
            : t('experience.templateBrowse.crewShownOf', { shown: shown.length, count: total })
          : shown.length === total
            ? t('experience.templateBrowse.botCount', { count: total })
            : t('experience.templateBrowse.botShownOf', { shown: shown.length, count: total })}
      </p>
      {shown.length === 0 ? (
        <EmptyState size="sm" className="px-8 py-10">
          <EmptyState.Header>
            <EmptyState.Media variant="icon">
              <IconSearch className="size-5 text-muted" aria-hidden />
            </EmptyState.Media>
            <EmptyState.Title>
              {state.query.trim()
                ? t('experience.templateBrowse.noTemplatesMatch', { query: state.query.trim() })
                : t('experience.templateBrowse.noTemplatesHereYet')}
            </EmptyState.Title>
            <EmptyState.Description>
              {t('experience.templateBrowse.tryARoleTaskOr')}
            </EmptyState.Description>
          </EmptyState.Header>
          <EmptyState.Content>
            <Button variant="ghost" onPress={() => onChange({ ...state, query: '', category: '' })}>
              {t('experience.templateBrowse.clearSearchFilters')}
            </Button>
          </EmptyState.Content>
        </EmptyState>
      ) : (
        <ul className="flex flex-col px-8">
          {shown.map((entry) => (
            <li key={entry.id} className="border-b border-separator last:border-b-0">
              <button
                type="button"
                onClick={() => onOpen(entry.id)}
                className="crewaid-template-entry flex w-full items-center gap-5 py-5 text-start cursor-pointer hover:opacity-90"
              >
                {entry.kind === 'bot' && entry.bots[0] ? (
                  <span className="w-14 shrink-0">
                    <BotAvatar bot={entry.bots[0]} size="md" />
                  </span>
                ) : null}
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex flex-wrap items-baseline gap-1.5">
                    <span className="text-headline font-semibold">{entry.title}</span>
                    {entry.kind === 'bot' ? (
                      <span className="text-footnote text-muted">· {entry.bots[0]?.role}</span>
                    ) : null}
                  </span>
                  <span className="text-callout leading-[21px] text-muted">{entry.summary}</span>
                  <span className="text-caption text-muted">
                    {entry.kind === 'crew'
                      ? entry.bots.map((bot) => bot.role).join(' · ')
                      : entry.memberOf.length > 0
                        ? t('experience.templateBrowse.alsoIn', { list: entry.memberOf.join(', ') })
                        : t('experience.templateBrowse.worksOnItsOwn')}
                  </span>
                </span>
                {entry.kind === 'crew' ? (
                  <span className="flex shrink-0 items-center" aria-hidden>
                    {entry.bots.map((bot) => (
                      <BotAvatar key={bot.key} bot={bot} size="sm" />
                    ))}
                  </span>
                ) : (
                  <span className="hidden w-[175px] shrink-0 flex-col gap-1 sm:flex">
                    <span className="text-caption text-muted">
                      {t('experience.templateBrowse.supportedTools')}
                    </span>
                    <span className="text-footnote">
                      {entry.tools
                        .slice(0, 2)
                        .map((tool) => tool.label)
                        .join(' · ')}
                    </span>
                  </span>
                )}
                <IconArrowRight
                  className="size-5 shrink-0 text-muted rtl:-scale-x-100"
                  aria-hidden
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
