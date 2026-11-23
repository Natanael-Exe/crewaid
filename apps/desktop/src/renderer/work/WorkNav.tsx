import { Tabs } from '@heroui/react';
import { WORK_VIEWS, WORK_VIEW_LABELS, type WorkView } from './workState';
import { useT } from '../i18n/i18n';

/** Controlled navigation; the shell owns the page contents. */
export function WorkNav({
  active,
  attention,
  onSelect,
  onCrew,
}: {
  active: WorkView | null;
  attention: number;
  onSelect: (view: WorkView) => void;
  onCrew: () => void;
}) {
  const t = useT();
  return (
    <nav aria-label={t('work.workNav.work')} className="window-no-drag">
      <Tabs
        className="crewaid-room-nav"
        selectedKey={active ?? 'crew'}
        onSelectionChange={(key) => {
          if (key === 'crew') onCrew();
          else if (WORK_VIEWS.some((view) => view === key)) onSelect(key as WorkView);
        }}
      >
        <Tabs.ListContainer>
          <Tabs.List aria-label={t('work.workNav.pages')}>
            <Tabs.Tab id="crew">
              {t('work.workNav.crew')}
              <Tabs.Indicator />
            </Tabs.Tab>
            {WORK_VIEWS.map((view) => (
              <Tabs.Tab key={view} id={view}>
                {WORK_VIEW_LABELS[view]}
                {view === 'tasks' && attention > 0 ? (
                  <span
                    aria-label={t('work.nav.attention', { count: attention })}
                    className="min-w-4 rounded-full bg-warning/15 px-1.5 text-micro font-medium leading-4 tabular-nums text-warning"
                  >
                    {attention > 99 ? '99+' : attention}
                  </span>
                ) : null}
                <Tabs.Indicator />
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs.ListContainer>
      </Tabs>
    </nav>
  );
}
