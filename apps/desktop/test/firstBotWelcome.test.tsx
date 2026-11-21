import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@heroui/react';
import { FirstBotWelcome, WELCOME_POINTS } from '../src/renderer/bots/FirstBotWelcome';

function render() {
  return renderToStaticMarkup(
    <I18nProvider>
      <FirstBotWelcome onCreateBot={() => undefined} />
    </I18nProvider>,
  );
}

describe('FirstBotWelcome', () => {
  it('introduces bots and offers the one action beside it', () => {
    const html = render();
    expect(html).toContain('Create your first bot');
    expect(html).toMatch(/<button[^>]*>[\s\S]*Create a bot[\s\S]*<\/button>/);
  });

  it('renders every point it lists', () => {
    const html = render();
    expect(WELCOME_POINTS.length).toBeGreaterThan(0);
    for (const point of WELCOME_POINTS) {
      expect(html).toContain(point.title);
      expect(html).toContain(point.body);
    }
  });

  it('keeps the illustration out of the accessibility tree', () => {
    // Three mascots are decoration; read aloud they would be three unnamed
    // images before the heading.
    const html = render();
    const beforeHeading = html.slice(0, html.indexOf('<h1'));
    expect(beforeHeading).toContain('<svg');
    for (const svg of beforeHeading.match(/<svg[^>]*>/g) ?? []) {
      expect(svg).toContain('aria-hidden');
    }
  });
});
