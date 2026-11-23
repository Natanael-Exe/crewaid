import { Alert, Button, Checkbox, Radio, RadioGroup } from '@heroui/react';
import { useState } from 'react';
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
  const [mode, setMode] = useState(access.mode);
  const [selected, setSelected] = useState(access.mode === 'SELECTED' ? access.selectedBotIds : []);
  const [excluded, setExcluded] = useState(access.mode === 'ALL' ? access.excludedBotIds : []);
  const ids = mode === 'ALL' ? excluded : selected;
  const draft: PluginAccess =
    mode === 'ALL' ? { mode, excludedBotIds: excluded } : { mode, selectedBotIds: selected };
  return (
    <div className="space-y-5" aria-busy={busy}>
      <div className="border-b border-separator pb-4">
        <Button
          size="sm"
          variant="ghost"
          isDisabled={busy}
          onPress={onCancel}
          className="mb-2 -ms-2 h-7 px-2 text-caption text-muted"
        >
          {t('plugins.back')}
        </Button>
        <p className="mb-1 text-caption text-muted">{t('plugins.access.breadcrumb')}</p>
        <h2 className="text-heading font-semibold text-foreground">
          {t('plugins.access.heading', { name })}
        </h2>
        <p className="mt-1 text-footnote text-muted">{t('plugins.access.intro')}</p>
      </div>
      <fieldset disabled={busy} className="space-y-2">
        <legend className="mb-2 text-caption font-medium text-muted">
          {t('plugins.access.legend')}
        </legend>
        <RadioGroup
          aria-label={t('plugins.access.legend')}
          value={mode}
          isDisabled={busy}
          onChange={(value) => {
            if (value === 'ALL' || value === 'SELECTED') setMode(value);
          }}
          className="flex flex-col gap-2"
        >
          {(['SELECTED', 'ALL'] as const).map((choice) => (
            <Radio
              key={choice}
              value={choice}
              className={`rounded-card border p-4 transition-colors ${mode === choice ? 'border-accent bg-surface-secondary' : 'border-separator'}`}
            >
              <Radio.Content className="flex w-full cursor-pointer items-start gap-3">
                <Radio.Control className="mt-0.5 shrink-0">
                  <Radio.Indicator />
                </Radio.Control>
                <span className="min-w-0 flex-1">
                  <span className="block text-footnote font-medium text-foreground">
                    {choice === 'ALL'
                      ? t('plugins.access.mode.all')
                      : t('plugins.access.mode.selected')}
                  </span>
                  <span className="mt-0.5 block text-caption text-muted">
                    {choice === 'ALL'
                      ? t('plugins.access.mode.all.hint')
                      : t('plugins.access.mode.selected.hint')}
                  </span>
                </span>
              </Radio.Content>
            </Radio>
          ))}
        </RadioGroup>
      </fieldset>
      <fieldset disabled={busy}>
        <legend className="mb-2 text-footnote font-medium text-foreground">
          {mode === 'ALL' ? t('plugins.access.except') : t('plugins.access.choose')}
        </legend>
        <p className="mb-3 text-caption text-muted">
          {mode === 'ALL' ? t('plugins.access.except.hint') : t('plugins.access.choose.hint')}
        </p>
        {bots.length === 0 ? (
          <p className="py-3 text-footnote text-muted">
            {t('plugins.access.noBots')}{' '}
            {mode === 'ALL' ? t('plugins.access.noBots.all') : t('plugins.access.noBots.selected')}
          </p>
        ) : (
          <div className="max-h-64 overflow-y-auto rounded-card border border-separator">
            {bots.map((bot) => (
              <Checkbox
                key={bot.id}
                isDisabled={busy}
                isSelected={ids.includes(bot.id)}
                onChange={(checked) => {
                  const next = checked ? [...ids, bot.id] : ids.filter((id) => id !== bot.id);
                  if (mode === 'ALL') setExcluded(next);
                  else setSelected(next);
                }}
                className="w-full border-b border-separator last:border-b-0"
              >
                <Checkbox.Content className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 hover:bg-surface-secondary">
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  <span className="truncate text-footnote text-foreground">{bot.name}</span>
                </Checkbox.Content>
              </Checkbox>
            ))}
          </div>
        )}
      </fieldset>
      {backend === 'COMPOSIO' ? (
        <p className="rounded-card bg-surface-secondary p-3 text-caption leading-relaxed text-muted">
          {t('plugins.access.composio')}
        </p>
      ) : null}
      {problem === '' ? null : (
        <Alert status="danger" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{problem}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-separator pt-4">
        <p className="text-caption text-muted" aria-live="polite">
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
