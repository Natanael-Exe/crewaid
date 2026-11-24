import { useEffect, useState } from 'react';
import { appInfo, tokenStore } from '../bridge';
import { ExternalLink } from '../components/ExternalLink';
import { useT } from '../i18n/i18n';
import { useAppEdition } from '../state/useAppEdition';
import { SettingsRow, SettingsSection } from './SettingsLayout';
import { fetchServerVersion } from './serverVersion';

const WEBSITE = 'https://crewaid.io';
const SOURCE = 'https://github.com/Natanael-Exe/crewaid';
const LICENSE = 'https://github.com/Natanael-Exe/crewaid/blob/main/LICENSE';
/** Names, not prose: a domain, a site and a licence identifier read the same in every language. */
const WEBSITE_NAME = 'crewaid.io';
const SOURCE_NAME = 'GitHub';
const LICENSE_NAME = 'AGPL-3.0';

/**
 * What is running and where it comes from. The server's release is asked of
 * the self-hosted orchestrator only: a hosted build's server is the service,
 * and its version is not the operator's to match.
 */
export function AboutPane({
  readAppVersion = appInfo.version,
  readServerVersion,
}: {
  /** Seams for tests; production asks the bridge and the saved server. */
  readonly readAppVersion?: () => Promise<string | null>;
  readonly readServerVersion?: () => Promise<string | null>;
} = {}) {
  const t = useT();
  const edition = useAppEdition();
  const [app, setApp] = useState<string | null>(null);
  const [server, setServer] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void readAppVersion().then((version) => {
      if (live) setApp(version);
    });
    return () => {
      live = false;
    };
  }, [readAppVersion]);

  useEffect(() => {
    if (edition !== 'selfhosted') return;
    let live = true;
    const read =
      readServerVersion ??
      (async () => {
        const baseUrl = (await tokenStore.get()).orchestratorBaseUrl?.trim() ?? '';
        return baseUrl === '' ? null : fetchServerVersion(baseUrl);
      });
    void read().then((version) => {
      if (live) setServer(version);
    });
    return () => {
      live = false;
    };
  }, [edition, readServerVersion]);

  const unknown = t('settings.about.unknown');
  return (
    <div className="crewaid-settings-preferences">
      <SettingsSection title={t('settings.about.versions')}>
        <SettingsRow
          label={t('settings.about.app')}
          control={<span className="text-footnote tabular-nums text-muted">{app ?? unknown}</span>}
        />
        {edition !== 'selfhosted' ? null : (
          <SettingsRow
            label={t('settings.about.server')}
            control={
              <span className="text-footnote tabular-nums text-muted">{server ?? unknown}</span>
            }
          />
        )}
      </SettingsSection>
      <SettingsSection title={t('settings.about.links')}>
        <SettingsRow
          label={t('settings.about.website')}
          control={
            <ExternalLink href={WEBSITE} className="text-footnote text-link underline">
              {WEBSITE_NAME}
            </ExternalLink>
          }
        />
        <SettingsRow
          label={t('settings.about.source')}
          control={
            <ExternalLink href={SOURCE} className="text-footnote text-link underline">
              {SOURCE_NAME}
            </ExternalLink>
          }
        />
        <SettingsRow
          label={t('settings.about.license')}
          control={
            <ExternalLink href={LICENSE} className="text-footnote text-link underline">
              {LICENSE_NAME}
            </ExternalLink>
          }
        />
      </SettingsSection>
    </div>
  );
}
