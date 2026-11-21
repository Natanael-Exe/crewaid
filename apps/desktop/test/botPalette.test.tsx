import { I18nProvider } from '@heroui/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BotPalette } from '../src/renderer/components/composer/BotPalette';

describe('BotPalette', () => {
  it('renders a keyboard-selectable roster with names and roles', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <BotPalette
          bots={[
            {
              id: 'bot-nathan',
              name: 'Nathan',
              role: 'Frontend engineer',
              avatarColor: '#16a3b6',
            },
          ]}
          selected={0}
          onPick={() => undefined}
          onSelectedChanged={() => undefined}
        />
      </I18nProvider>,
    );

    expect(html).toContain('role="listbox"');
    expect(html).toContain('data-bot-row="bot-nathan"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('@Nathan');
    expect(html).toContain('Frontend engineer');
  });
});
