import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ChatToolGroup,
  EmptyState,
  IconButtonTooltip,
  Kanban,
  Segment,
} from '../src/renderer/components/ui';

/**
 * The shared primitives in `components/ui`. Each screen leans on these for its
 * accessible names and states, so the contract is pinned here once instead of
 * re-asserted per screen.
 */

describe('IconButtonTooltip', () => {
  const html = renderToStaticMarkup(
    <IconButtonTooltip label="Close settings" onPress={() => undefined}>
      <svg aria-hidden="true" />
    </IconButtonTooltip>,
  );

  it('is ONE focusable button carrying the action name', () => {
    // A Tooltip.Trigger wrapper renders its own focusable `role="button"`
    // div, so every icon button became two tab stops announced twice.
    expect(html.match(/<button\b/g)).toHaveLength(1);
    expect(html).not.toContain('role="button"');
    expect(html).not.toContain('tooltip__trigger');
    expect(html.match(/tabindex="0"/g) ?? []).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*aria-label="Close settings"/);
  });

  it('keeps the tooltip out of the markup until it is asked for', () => {
    expect(html.match(/Close settings/g)).toHaveLength(1);
  });
});

describe('Segment', () => {
  const html = renderToStaticMarkup(
    <Segment aria-label="Appearance" selectedKey="dark">
      <Segment.Item id="light">Light</Segment.Item>
      <Segment.Item id="dark">Night</Segment.Item>
    </Segment>,
  );

  it('is a labelled group with exactly one pressed item', () => {
    expect(html).toMatch(/data-slot="segment"[^>]*/);
    expect(html).toContain('aria-label="Appearance"');
    expect(html.match(/aria-pressed="true"|aria-checked="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-(pressed|checked)="true"[^>]*>(?:(?!<\/button>).)*Night/s);
  });
});

describe('EmptyState', () => {
  it('renders its title and description in their slots', () => {
    const html = renderToStaticMarkup(
      <EmptyState>
        <EmptyState.Header>
          <EmptyState.Title>No bots yet</EmptyState.Title>
          <EmptyState.Description>Create one to get started.</EmptyState.Description>
        </EmptyState.Header>
      </EmptyState>,
    );
    expect(html).toMatch(/data-slot="empty-state-title"[^>]*>No bots yet</);
    expect(html).toMatch(/data-slot="empty-state-description"[^>]*>Create one to get started\.</);
  });
});

describe('Kanban', () => {
  it('names each column so a screen reader can tell them apart', () => {
    const html = renderToStaticMarkup(
      <Kanban>
        <Kanban.Column aria-label="To do">
          <Kanban.ColumnHeader>
            <Kanban.ColumnTitle>To do</Kanban.ColumnTitle>
            <Kanban.ColumnCount>2</Kanban.ColumnCount>
          </Kanban.ColumnHeader>
        </Kanban.Column>
      </Kanban>,
    );
    expect(html).toMatch(
      /data-slot="kanban-column"[^>]*aria-label="To do"|aria-label="To do"[^>]*data-slot="kanban-column"/,
    );
    expect(html).toMatch(/data-slot="kanban-column-count"[^>]*>2</);
  });
});

describe('ChatToolGroup', () => {
  function render(active: boolean, defaultExpanded = false): string {
    return renderToStaticMarkup(
      <ChatToolGroup active={active} defaultExpanded={defaultExpanded}>
        <ChatToolGroup.Trigger>Ran 3 actions</ChatToolGroup.Trigger>
        <ChatToolGroup.Content>
          <p>details</p>
        </ChatToolGroup.Content>
      </ChatToolGroup>,
    );
  }

  it('is a disclosure that starts collapsed', () => {
    const html = render(false);
    expect(html).toMatch(/data-slot="chat-tool-group-trigger"[^>]*aria-expanded="false"/);
    expect(html).not.toContain('data-active');
  });

  it('marks a running group so it never reads as finished', () => {
    const html = render(true, true);
    expect(html).toContain('data-active="true"');
    expect(html).toMatch(/data-slot="chat-tool-group-trigger"[^>]*aria-expanded="true"/);
  });
});
