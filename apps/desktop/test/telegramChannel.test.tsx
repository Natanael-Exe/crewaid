import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@heroui/react';
import { TelegramChannelView } from '../src/renderer/settings/ChannelsPane';
import { panesFor } from '../src/renderer/settings/settingsPanes';

type Props = Parameters<typeof TelegramChannelView>[0];
const noop = () => undefined;
const status = (overrides: Partial<NonNullable<Props['status']>> = {}): Props['status'] => ({
  configured: true,
  canCreateBots: true,
  connection: null,
  pending: null,
  ...overrides,
});
const inTenMinutes = () => new Date(Date.now() + 600_000);
const render = (props: Partial<Props>) =>
  renderToStaticMarkup(
    <I18nProvider>
      <TelegramChannelView
        status={status()}
        link={null}
        registered={null}
        tokenForm={false}
        busy={false}
        problem={null}
        onConnect={noop}
        onNewCode={noop}
        onShowTokenForm={noop}
        onSubmitToken={noop}
        onOpen={noop}
        onConfirm={noop}
        onCancel={noop}
        onDisconnect={noop}
        {...props}
      />
    </I18nProvider>,
  );

describe('Telegram account controls', () => {
  it('offers Channels in both editions', () => {
    for (const edition of ['cloud', 'selfhosted'] as const)
      expect(panesFor(edition).some((pane) => pane.id === 'channels')).toBe(true);
  });
  it('explains server setup and disables linking while unavailable', () => {
    const html = render({ status: status({ configured: false, canCreateBots: false }) });
    expect(html).toContain('administrator');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[^<]*Connect Telegram/);
  });
  it('offers to connect when nothing is linked', () => {
    const html = render({});
    expect(html).toContain('Connect Telegram');
    expect(html).not.toContain('<svg role="img"');
  });
  it('shows a QR code that creates the bot, the code to send, and the token fallback', () => {
    const html = render({
      link: {
        code: 'K7M2Q9XF',
        expiresAt: inTenMinutes(),
        createUrl: 'https://t.me/newbot/CrewaidBot/ana_crew_ab12_bot?name=Ana%E2%80%99s%20Crew',
      },
    });
    expect(html).toContain('aria-label="QR code that creates your Telegram bot"');
    expect(html).toMatch(/<path d="M\d+ \d+h1v1h-1z/);
    expect(html).toContain('K7M2-Q9XF');
    expect(html).toContain('Use a bot you already have');
    expect(html).toContain('Open on this computer');
    expect(html).not.toContain('Connect Telegram');
  });
  it('asks for a BotFather token in a field that never shows it', () => {
    const html = render({ status: status({ canCreateBots: false }), tokenForm: true });
    expect(html).toContain('@BotFather');
    expect(html).toMatch(/<input[^>]*id="telegram-bot-token"[^>]*type="password"/);
    expect(html).toMatch(/autoComplete="off"|autocomplete="off"/);
    expect(html).not.toContain('QR code');
  });
  it('sends a pasted bot’s person to open it with the code', () => {
    const expiresAt = inTenMinutes();
    const html = render({
      status: status({
        pending: { botUsername: 'ana_crew_bot', telegramName: null, expiresAt },
      }),
      registered: {
        botUsername: 'ana_crew_bot',
        code: 'K7M2Q9XF',
        expiresAt,
        openUrl: 'https://t.me/ana_crew_bot?start=K7M2Q9XF',
      },
    });
    expect(html).toContain('Send your code to @ana_crew_bot');
    expect(html).toContain('Open @ana_crew_bot');
    expect(html).toContain('K7M2-Q9XF');
    expect(html).toContain('Cancel');
  });
  it('offers a new code for a waiting bot whose code this window never saw', () => {
    const html = render({
      status: status({
        pending: { botUsername: 'ana_crew_bot', telegramName: null, expiresAt: inTenMinutes() },
      }),
    });
    expect(html).toContain('New code');
    expect(html).not.toContain('Open @ana_crew_bot');
  });
  it('makes nothing live until the person confirms who sent the code', () => {
    const html = render({
      status: status({
        pending: { botUsername: 'ana_crew_bot', telegramName: 'Ana', expiresAt: inTenMinutes() },
      }),
      link: { code: 'K7M2Q9XF', expiresAt: inTenMinutes(), createUrl: null },
    });
    expect(html).toContain('Telegram user Ana wants to connect through @ana_crew_bot');
    expect(html).toContain('Confirm');
    expect(html).toContain('Cancel');
    expect(html).not.toContain('Disconnect');
    expect(html).not.toContain('K7M2-Q9XF');
  });
  it('gives a connected account its bot, a disconnect control and the crew commands', () => {
    const html = render({
      status: status({
        connection: {
          botUsername: 'ana_crew_bot',
          displayName: 'Natanael',
          selectedBotId: null,
          connectedAt: new Date(),
        },
      }),
    });
    expect(html).toContain('Connected to @ana_crew_bot');
    expect(html).toContain('Natanael');
    expect(html).toContain('Disconnect');
    expect(html).toContain('/emma');
    expect(html).toContain('/approvals');
    expect(html).not.toContain('Connect Telegram');
  });
  it('shows a problem as an alert', () => {
    expect(render({ problem: 'Your code expired.' })).toMatch(
      /role="alert"[^>]*>Your code expired\./,
    );
  });
});
