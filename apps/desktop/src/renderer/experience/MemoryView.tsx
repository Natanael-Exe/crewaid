import { Button } from '@heroui/react';
import { IconLock } from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import type { MemoryRow } from '@crewaid/shared';
import { useApiClient } from '../api';
import { editMemory, forgetMemory, listMemories } from '../api/experience';
import { SETTINGS_INPUT_CLASS } from '../settings/SettingsLayout';
import { currentLocale, useT, t } from '../i18n/i18n';

export function provenance(row: MemoryRow, botName: string): string {
  const when = new Intl.DateTimeFormat(currentLocale(), { month: 'short', day: 'numeric' }).format(
    new Date(row.createdAt),
  );
  if (row.status === 'CANDIDATE') return t('experience.memoryView.tentative', { when });
  return row.source === 'TOLD'
    ? t('experience.memoryView.youTold', { botName, when })
    : t('experience.memoryView.learnedInConversation', { when });
}

/**
 * What a bot remembers about the person, opened from its settings.
 * Shared rows are what every bot is shown; private ones are this bot's alone.
 * A correction supersedes the old row and a forget suppresses it, both on the
 * server, so the bot cannot quietly learn the old claim back.
 */
export function MemoryView({ botId, botName }: { botId: string; botName: string }) {
  const t = useT();
  const client = useApiClient();
  const [rows, setRows] = useState<MemoryRow[] | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setError('');
    try {
      setRows((await listMemories(client, botId)).rows);
    } catch {
      setError(t('experience.memoryView.couldNotLoad'));
    }
  }, [client, botId]);
  useEffect(() => {
    void load();
  }, [load]);
  async function change(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
      setEditing(null);
      await load();
    } catch {
      setError(t('experience.memoryView.notSaved'));
    } finally {
      setBusy(false);
    }
  }
  const shared = rows?.filter((row) => row.botId === null) ?? [];
  const own = rows?.filter((row) => row.botId === botId) ?? [];

  const list = (items: MemoryRow[], empty: string) =>
    items.length === 0 ? (
      <p className="py-2 text-[13px] text-muted">{empty}</p>
    ) : (
      <ul className="flex flex-col">
        {items.map((row) => (
          <li key={row.id} className="border-b border-separator py-3">
            {editing === row.id ? (
              <div className="crewaid-memory-edit flex flex-col gap-2 rounded-card p-3">
                <span className="text-[12px] text-muted">
                  {t('experience.memoryView.editingAMemory')}
                </span>
                <input
                  aria-label={t('experience.memoryView.correctThisMemory')}
                  maxLength={300}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  className={SETTINGS_INPUT_CLASS}
                />
                <span className="text-[12px] text-muted">{provenance(row, botName)}</span>
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onPress={() => setEditing(null)}>
                    {t('experience.memoryView.cancel')}
                  </Button>
                  <Button
                    size="sm"
                    isDisabled={busy || text.trim() === ''}
                    onPress={() => void change(() => editMemory(client, row.id, text.trim()))}
                  >
                    {t('experience.memoryView.saveCorrection')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-3">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p className="text-[14px] leading-5">{row.text}</p>
                  <span className="text-[12px] text-muted">{provenance(row, botName)}</span>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    isDisabled={busy}
                    onPress={() => {
                      setEditing(row.id);
                      setText(row.text);
                    }}
                  >
                    {t('experience.memoryView.edit')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    isDisabled={busy}
                    onPress={() => void change(() => forgetMemory(client, row.id))}
                  >
                    {t('experience.memoryView.forget')}
                  </Button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-4 pt-2">
      <div className="flex flex-col gap-2">
        <h2 className="crewaid-pane-title">
          {t('experience.memoryView.whatBotKnows', { botName })}
        </h2>
        <p className="text-[13px] leading-5 text-muted">
          {t('experience.memoryView.aLittleContextMakesThe')}
        </p>
      </div>
      {rows === null ? (
        error ? null : (
          <p className="text-[13px] text-muted">{t('experience.memoryView.loading')}</p>
        )
      ) : (
        <>
          <section className="flex flex-col gap-1">
            <h3 className="text-[14px] font-semibold">
              {t('experience.memoryView.sharedWithYourCrew')}
            </h3>
            {list(shared, t('experience.memoryView.nothingSharedYet'))}
          </section>
          <section className="flex flex-col gap-1">
            <h3 className="flex items-center gap-1.5 text-[14px] font-semibold">
              <IconLock className="size-3.5" aria-hidden />
              {t('experience.memoryView.privateTo', { botName })}
            </h3>
            {list(own, t('experience.memoryView.nothingPrivateYet'))}
          </section>
          <p className="text-[12px] text-muted">
            {t('experience.memoryView.everyBotSeesShared', { botName })}
          </p>
        </>
      )}
      {error ? (
        <div role="alert" className="flex items-center gap-2 text-[13px] text-danger">
          {error}
          <Button size="sm" variant="ghost" onPress={() => void load()}>
            {t('experience.memoryView.retry')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
