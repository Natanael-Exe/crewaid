import { Button } from '@heroui/react';
import { useId, useState } from 'react';
import type { Bot, PluginAccess } from '@crewaid/shared';
import { t, useT } from '../i18n/i18n';

export function accessSummary(access: PluginAccess): string {
  if (access.mode === 'ALL')
    return access.excludedBotIds.length === 0
      ? t('plugins.access.all')
      : t('plugins.access.allExcept', { count: access.excludedBotIds.length });
  const count = access.selectedBotIds.length;
  return count === 0 ? t('plugins.access.none') : t('plugins.access.some', { count });
}

/** Account permissions and bot grants are different decisions, visible in one place. */
export function PluginAccessEditor({
  name,
  access,
  bots,
  backend,
  busy,
  problem,
  onCancel,
  onSave,
}: {
  readonly name: string;
  readonly access: PluginAccess;
  readonly bots: readonly Pick<Bot, 'id' | 'name'>[];
  readonly backend: 'DIRECT' | 'COMPOSIO';
  readonly busy: boolean;
  readonly problem: string;
  readonly onCancel: () => void;
  readonly onSave: (access: PluginAccess) => void;
}) {
  const t = useT();
  const group = useId();
  const [mode, setMode] = useState(access.mode);
  const [selected, setSelected] = useState(access.mode === 'SELECTED' ? access.selectedBotIds : []);
  const [excluded, setExcluded] = useState(access.mode === 'ALL' ? access.excludedBotIds : []);
  const ids = mode === 'ALL' ? excluded : selected;
  const draft: PluginAccess =
    mode === 'ALL' ? { mode, excludedBotIds: excluded } : { mode, selectedBotIds: selected };
  return (
    <div className="space-y-5" aria-busy={busy}>
      <div className="border-b border-separator pb-4">
        <p className="mb-1 text-[12px] text-muted">{t('plugins.access.breadcrumb')}</p>
        <h2 className="text-[19px] font-semibold text-foreground">
          {t('plugins.access.heading', { name })}
        </h2>
        <p className="mt-1 text-[13px] text-muted">{t('plugins.access.intro')}</p>
      </div>
      <fieldset disabled={busy} className="space-y-2">
        <legend className="mb-2 text-[12px] font-medium text-muted">
          {t('plugins.access.legend')}
        </legend>
        {(['SELECTED', 'ALL'] as const).map((choice) => (
          <label
            key={choice}
            className={`flex cursor-pointer items-start gap-3 rounded-card border p-4 ${mode === choice ? 'border-accent bg-surface-secondary' : 'border-separator'}`}
          >
            <input
              type="radio"
              name={group}
              value={choice}
              checked={mode === choice}
              onChange={() => setMode(choice)}
              className="mt-1 size-4 accent-accent"
            />
            <span>
              <span className="block text-[13px] font-medium text-foreground">
                {choice === 'ALL'
                  ? t('plugins.access.mode.all')
                  : t('plugins.access.mode.selected')}
              </span>
              <span className="mt-0.5 block text-[12px] text-muted">
                {choice === 'ALL'
                  ? t('plugins.access.mode.all.hint')
                  : t('plugins.access.mode.selected.hint')}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset disabled={busy}>
        <legend className="mb-2 text-[13px] font-medium text-foreground">
          {mode === 'ALL' ? t('plugins.access.except') : t('plugins.access.choose')}
        </legend>
        <p className="mb-3 text-[12px] text-muted">
          {mode === 'ALL' ? t('plugins.access.except.hint') : t('plugins.access.choose.hint')}
        </p>
        {bots.length === 0 ? (
          <p className="py-3 text-[13px] text-muted">
            {t('plugins.access.noBots')}{' '}
            {mode === 'ALL' ? t('plugins.access.noBots.all') : t('plugins.access.noBots.selected')}
          </p>
        ) : (
          <div className="max-h-64 overflow-y-auto rounded-card border border-separator">
            {bots.map((bot) => (
              <label
                key={bot.id}
                className="flex cursor-pointer items-center gap-3 border-b border-separator px-4 py-3 last:border-b-0 hover:bg-surface-secondary"
              >
                <input
                  type="checkbox"
                  checked={ids.includes(bot.id)}
                  onChange={(event) => {
                    const next = event.target.checked
                      ? [...ids, bot.id]
                      : ids.filter((id) => id !== bot.id);
                    if (mode === 'ALL') setExcluded(next);
                    else setSelected(next);
                  }}
                  className="size-4 shrink-0 accent-accent"
                />
                <span className="truncate text-[13px] text-foreground">{bot.name}</span>
              </label>
            ))}
          </div>
        )}
      </fieldset>
      {backend === 'COMPOSIO' ? (
        <p className="rounded-card bg-surface-secondary p-3 text-[12px] leading-relaxed text-muted">
          {t('plugins.access.composio')}
        </p>
      ) : null}
      {problem === '' ? null : (
        <p role="alert" className="text-[13px] text-warning">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-separator pt-4">
        <p className="text-[12px] text-muted" aria-live="polite">
          {accessSummary(draft)}
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" isDisabled={busy} onPress={onCancel}>
            {t('settings.cancel')}
          </Button>
          <Button size="sm" variant="primary" isDisabled={busy} onPress={() => onSave(draft)}>
            {busy ? t('plugins.access.saving') : t('plugins.access.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
