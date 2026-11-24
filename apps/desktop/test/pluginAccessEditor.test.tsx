import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@heroui/react';
import type { PluginAccess } from '@crewaid/shared';
import { PluginAccessEditor, accessSummary } from '../src/renderer/settings/PluginAccessEditor';
import { ApiClient } from '../src/renderer/api/apiClient';
import { setPluginAccess } from '../src/renderer/api/plugins';

const bots = [
  { id: 'bot-a', name: 'Quill' },
  { id: 'bot-b', name: 'Scout' },
];
function render(access: PluginAccess, busy = false) {
  return renderToStaticMarkup(
    <I18nProvider locale="en-US">
      <PluginAccessEditor
        name="Gmail"
        access={access}
        bots={bots}
        backend="COMPOSIO"
        busy={busy}
        problem=""
        onCancel={() => undefined}
        onSave={() => undefined}
      />
    </I18nProvider>,
  );
}
describe('Installation bot access', () => {
  it('explains ALL inheritance and labels checked bots as exceptions', () => {
    const markup = render({ mode: 'ALL', excludedBotIds: ['bot-b'] });
    expect(markup).toContain('Current and future bots');
    expect(markup).toContain('Except these bots');
    expect(markup).toContain('Checked bots cannot use this connection.');
    expect(markup).toMatch(
      /<label[^>]*data-selected="true"[^>]*>[\s\S]*?checked=""[\s\S]*?<span[^>]*>Scout<\/span><\/label>/,
    );
    expect(markup).toContain('Reconnect after those permissions change.');
  });
  it('makes selected-only access and an empty selection explicit', () => {
    expect(render({ mode: 'SELECTED', selectedBotIds: [] })).toContain(
      'New bots start without access.',
    );
    expect(accessSummary({ mode: 'SELECTED', selectedBotIds: [] })).toBe('No bots have access');
    expect(accessSummary({ mode: 'ALL', excludedBotIds: [] })).toBe(
      'All bots · including future bots',
    );
  });
  it('disables editing and save while access is being persisted', () => {
    const markup = render({ mode: 'SELECTED', selectedBotIds: ['bot-a'] }, true);
    expect(markup).toContain('<fieldset disabled=""');
    expect(markup).toContain('Saving…');
    expect(markup).toContain('aria-busy="true"');
  });
  it('writes the shared authenticated route and validates the response', async () => {
    const access: PluginAccess = { mode: 'ALL', excludedBotIds: ['bot-b'] };
    let seen: { url: string; init: RequestInit | undefined } | undefined;
    const client = new ApiClient({
      credentialsProvider: async () => ({
        orchestratorBaseUrl: 'https://orch.test',
        orchestratorToken: 'owner-token',
      }),
      fetchFn: async (url, init) => {
        seen = { url: String(url), init };
        return new Response(JSON.stringify(access), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    expect(await setPluginAccess(client, 'server-a', access)).toEqual(access);
    expect(seen?.url).toBe('https://orch.test/api/v1/mcp/servers/server-a/access');
    expect(seen?.init?.method).toBe('PUT');
    expect(JSON.parse(String(seen?.init?.body))).toEqual(access);
    expect(new Headers(seen?.init?.headers).get('Authorization')).toBe('Bearer owner-token');
  });
});
