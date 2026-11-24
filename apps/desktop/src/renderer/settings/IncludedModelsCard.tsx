import { Chip } from '@heroui/react';
import type { ProviderConnectionWithModels } from '@crewaid/shared';
import { capabilityLabels, contextWindowLabel } from './modelSettings';
import { useT } from '../i18n/i18n';

/**
 * The models a hosted plan includes, shown read-only.
 *
 * The server makes this connection and refuses every change to it, so the
 * full connection card — rename, key, switch, remove, add a model — would be a
 * row of controls that each answer 409. What a person needs here is which
 * models they have and what using them costs them.
 */
export function IncludedModelsCard({ connection }: { connection: ProviderConnectionWithModels }) {
  const t = useT();
  return (
    <section className="crewaid-connection-card mb-4 overflow-hidden rounded-card border border-separator bg-surface">
      <div className="flex items-center gap-2 px-4 py-3">
        <span className="text-footnote font-medium text-foreground">{connection.name}</span>
        <Chip size="sm" variant="soft" color="accent">
          <Chip.Label>{t('settings.included.chip')}</Chip.Label>
        </Chip>
      </div>
      <p className="border-t border-separator px-4 py-2.5 text-caption leading-[17px] text-muted">
        {t('settings.included.body')}
      </p>
      {connection.models.map((model) => (
        <div
          key={model.id}
          className="flex items-center gap-3 border-t border-separator px-4 py-2.5"
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-footnote text-foreground">{model.label}</span>
              {capabilityLabels(model.capabilities).map((capability) => (
                <Chip key={capability} size="sm" variant="soft" color="accent">
                  <Chip.Label>{capability}</Chip.Label>
                </Chip>
              ))}
            </div>
          </div>
          <span className="shrink-0 text-micro text-foreground-faint tabular-nums">
            {contextWindowLabel(model.contextWindow)}
          </span>
        </div>
      ))}
    </section>
  );
}
