import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@heroui/react';
import type { ToolInfo } from '@crewaid/shared';
import { ToolPalette } from '../src/renderer/components/composer/ToolPalette';

/**
 * The palette is a listbox the keyboard drives, but its markup is what an
 * operator reads first: the name they will mention, the badge that says
 * whether the tool will stop and ask them, and the hint row that says how to
 * choose. Rendered statically — the same discipline as the attachment card's
 * suite.
 */
function render(tools: ToolInfo[], selected = 0) {
  return renderToStaticMarkup(
    <I18nProvider>
      <ToolPalette
        tools={tools}
        selected={selected}
        onPick={() => undefined}
        onSelectedChanged={() => undefined}
      />
    </I18nProvider>,
  );
}

const TOOLS: ToolInfo[] = [
  {
    name: 'capture_screen',
    alias: 'screen',
    label: 'See the screen',
    summary: 'A picture of the whole screen, not just the page.',
    description: 'A picture of the whole screen. Use it before pointer work.',
    reach: 'contained',
    origin: 'builtin',
  },
  {
    name: 'shell',
    alias: 'run-command',
    label: 'Run a command',
    summary: 'Runs a shell command on the bot’s computer — always asks first.',
    description: 'Run a shell command. Always asks first.',
    reach: 'sensitive',
    origin: 'builtin',
  },
];

describe('ToolPalette', () => {
  it('is a listbox with one option per tool, highlighting the selected row', () => {
    const html = render(TOOLS);

    expect(html).toContain('role="listbox"');
    expect(html).toContain('data-tool-row="capture_screen"');
    expect(html).toContain('data-tool-row="shell"');
    // aria-selected rides the highlighted row, which the keyboard moves.
    expect(html).toMatch(
      /aria-selected="true"[^>]*data-tool-row="capture_screen"|data-tool-row="capture_screen"[^>]*aria-selected="true"/,
    );
  });

  it('sits on a white surface and highlights the selected row in gray', () => {
    const html = render(TOOLS);

    // White palette (surface--default → bg-surface), gray highlight pill on
    // the selected row — the scheme the reference palette uses. The old
    // scheme was exactly inverted (gray palette, bg-field-focus highlight,
    // which resolves to white) and read as a hole punched in the composer.
    expect(html).toContain('surface--default');
    expect(html).not.toContain('surface--secondary');
    expect(html).toContain('bg-surface-secondary');
    expect(html).not.toContain('bg-field-focus');
  });

  it('says which tools stop and ask, and which run directly', () => {
    const html = render(TOOLS);
    // The badge marks the exception only: the sensitive tool that will stop
    // and ask. Contained is the norm — repeating "Runs directly" on every
    // row said nothing past the first glance and drowned the warning.
    expect(html).toContain('Asks approval');
    expect(html).not.toContain('Runs directly');
  });

  it('renders the reading text in muted, reserving faint for the footer hints', () => {
    const html = render(TOOLS);
    // The description is the row's most useful sentence; at 11px faint it
    // was below AA contrast on white. Muted is the spec's own metadata tier
    // (UI-SPEC: ~11–12px muted), and faint keeps only the keyboard hints,
    // where legibility is decorative.
    expect(html).toContain('text-muted');
    expect(html.match(/text-foreground-faint/g)).toHaveLength(1);
  });

  it('shows the user-facing alias and label, never the internal name', () => {
    const html = render(TOOLS);
    expect(html).toContain('/screen');
    expect(html).toContain('See the screen');
    // The internal name stays in the data attribute for tests and tooling.
    expect(html).toContain('data-tool-row="capture_screen"');
    expect(html).not.toContain('/capture_screen');
    expect(html).not.toContain('browser_');
  });

  it('says when nothing matches instead of rendering an empty box', () => {
    const html = render([]);
    expect(html).toContain('No tool matches');
  });
});
