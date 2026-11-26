import { useEffect, useState } from 'react';
import { Button, Popover } from '@heroui/react';
import { IconCheck, IconChevronDown } from '@tabler/icons-react';
import type { ModelOption } from '@crewaid/shared';
import { fetchModelCatalog, useApiClient } from '../api';
import { useT } from '../i18n/i18n';
import { useAccountSettings } from '../settings/accountSettings';
import { toolCapableCodingModels } from '../settings/codingModelChoices';
import { FIELD_LABEL } from '../work/Fields';

/**
 * Optional per-bot coding model override for delegated `code_task` runs.
 *
 * Null inherits the account-wide coding model (if set in Settings → General →
 * Bots) and otherwise falls back to the bot's own model.
 */
export function BotCodingModelField({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (codingModelId: string | null) => void;
}) {
  const t = useT();
  const client = useApiClient();
  const settings = useAccountSettings();
  const [models, setModels] = useState<readonly ModelOption[] | 'loading' | 'unavailable'>(
    'loading',
  );
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let active = true;
    fetchModelCatalog(client).then(
      (response) => {
        if (active) setModels(response.models);
      },
      () => {
        if (active) setModels('unavailable');
      },
    );
    return () => {
      active = false;
    };
  }, [client]);

  const allModels = typeof models === 'string' ? [] : models;
  const eligible = toolCapableCodingModels(allModels, value);
  const selected = allModels.find((model) => model.id === value);
  const accountCodingModelId = settings?.codingModelId ?? null;
  const accountCodingModel =
    accountCodingModelId === null
      ? undefined
      : allModels.find((model) => model.id === accountCodingModelId);

  const defaultDetail =
    accountCodingModel !== undefined
      ? t('bots.botCodingModelField.accountDefault', { name: accountCodingModel.label })
      : t('bots.botCodingModelField.sameAsBot');

  const triggerLabel =
    models === 'loading'
      ? t('bots.botCodingModelField.loading')
      : value === null
        ? t('bots.botCodingModelField.default')
        : (selected?.label ?? t('bots.botCodingModelField.current'));

  function choose(id: string | null) {
    onChange(id);
    setOpen(false);
  }

  return (
    <div data-bot-coding-model-field>
      <span className={FIELD_LABEL}>{t('bots.botCodingModelField.label')}</span>
      <Popover isOpen={open} onOpenChange={setOpen}>
        <Button
          variant="secondary"
          aria-label={t('bots.botCodingModelField.ariaLabel', { name: triggerLabel })}
          isDisabled={models === 'loading'}
          className="flex min-h-10 w-full items-center justify-between gap-2 rounded-[10px] border border-border bg-background-secondary px-3 py-2 text-footnote text-foreground outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus/40"
        >
          <span className="min-w-0 truncate">{triggerLabel}</span>
          <IconChevronDown aria-hidden className="size-4 shrink-0 text-muted" stroke={1.8} />
        </Button>
        <Popover.Content
          placement="bottom end"
          className="w-[380px] max-w-[calc(100vw-32px)] rounded-xl"
        >
          <Popover.Dialog
            aria-label={t('bots.botCodingModelField.chooseTitle')}
            className="p-2"
          >
            <Popover.Heading className="px-2 pt-1 pb-2 text-caption font-medium text-muted">
              {t('bots.botCodingModelField.heading')}
            </Popover.Heading>
            <div className="max-h-[min(50vh,340px)] overflow-y-auto overscroll-contain">
              <button
                type="button"
                aria-label={t('bots.botCodingModelField.chooseDefault')}
                aria-pressed={value === null}
                onClick={() => choose(null)}
                className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2 py-2 text-start outline-none hover:bg-background-secondary focus-visible:ring-2 focus-visible:ring-focus/40"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-footnote">
                    {t('bots.botCodingModelField.default')}
                  </span>
                  <span className="block truncate text-micro text-muted">{defaultDetail}</span>
                </span>
                {value === null ? <IconCheck aria-hidden className="size-4 shrink-0" /> : null}
              </button>
              {eligible.map((model) => (
                <button
                  key={model.id}
                  type="button"
                  aria-label={t('bots.botCodingModelField.choose', { name: model.label })}
                  aria-pressed={value === model.id}
                  onClick={() => choose(model.id)}
                  className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2 py-2 text-start text-footnote outline-none hover:bg-background-secondary focus-visible:ring-2 focus-visible:ring-focus/40"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{model.label}</span>
                    <span className="mt-0.5 block truncate text-micro text-muted">
                      {model.available
                        ? model.connectionName
                        : `${model.connectionName} · ${t('bots.botCodingModelField.unavailable')}`}
                    </span>
                  </span>
                  {value === model.id ? (
                    <IconCheck aria-hidden className="size-4 shrink-0" />
                  ) : null}
                </button>
              ))}
              {eligible.length === 0 ? (
                <p className="px-2 py-2 text-caption text-muted">
                  {t('bots.botCodingModelField.empty')}
                </p>
              ) : null}
            </div>
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
      <p className="mt-1.5 text-caption text-muted">{t('bots.botCodingModelField.hint')}</p>
    </div>
  );
}
