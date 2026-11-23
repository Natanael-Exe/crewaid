import type { ClipboardEvent } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  IconFileCode,
  IconFileSpreadsheet,
  IconFileTypePdf,
  IconFileZip,
  IconPhoto,
} from '@tabler/icons-react';
import {
  ChainOfThought,
  ChatAttachment,
  ChatAttachmentGroup,
  ChatToolGroup,
  clipboardImageFiles,
  Command,
  ContextMenu,
  EmptyState,
  IconButtonTooltip,
  InlineSelect,
  ItemCard,
  ItemCardGroup,
  Kanban,
  PromptSuggestion,
  Segment,
  Stepper,
  Timeline,
} from '../src/renderer/components/ui';
import { attachmentIcon } from '../src/renderer/components/ui/ChatAttachment';

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

  it('forwards React Aria render-prop classNames on root and items', () => {
    const dynamic = renderToStaticMarkup(
      <Segment
        aria-label="View"
        selectedKey="board"
        className={({ isDisabled }) => (isDisabled ? 'is-off' : 'custom-root')}
      >
        <Segment.Item
          id="board"
          className={({ isSelected }) => (isSelected ? 'custom-selected' : 'custom-idle')}
        >
          Board
        </Segment.Item>
      </Segment>,
    );
    expect(dynamic).toContain('custom-root');
    expect(dynamic).toContain('custom-selected');
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

describe('Stepper', () => {
  it('renders plain non-button headers when read-only and marks the active step', () => {
    const html = renderToStaticMarkup(
      <Stepper currentStep={1}>
        <Stepper.Step>
          <Stepper.Indicator />
          <Stepper.Title>Choose</Stepper.Title>
          <Stepper.Separator />
        </Stepper.Step>
        <Stepper.Step>
          <Stepper.Indicator />
          <Stepper.Title>Review</Stepper.Title>
          <Stepper.Separator />
        </Stepper.Step>
      </Stepper>,
    );
    expect(html).not.toContain('<button');
    expect(html).toContain('data-status="complete"');
    expect(html).toMatch(/data-slot="stepper-step-header"[^>]*aria-current="step"/);
    expect(html.match(/data-slot="stepper-separator"/g)).toHaveLength(1);
  });

  it('renders interactive step buttons when onStepChange is provided', () => {
    const html = renderToStaticMarkup(
      <Stepper currentStep={0} onStepChange={() => undefined}>
        <Stepper.Step>
          <Stepper.Indicator />
          <Stepper.Title>Choose</Stepper.Title>
        </Stepper.Step>
        <Stepper.Step>
          <Stepper.Indicator />
          <Stepper.Title>Install</Stepper.Title>
        </Stepper.Step>
      </Stepper>,
    );
    expect(html.match(/data-slot="stepper-step-button"/g)).toHaveLength(2);
    expect(html).toMatch(/data-slot="stepper-step-button"[^>]*aria-current="step"/);
  });
});

describe('Timeline', () => {
  it('marks the current item and renders default rail marker and connector', () => {
    const html = renderToStaticMarkup(
      <Timeline>
        <Timeline.Item status="complete">
          <Timeline.Rail />
          <Timeline.Content>Done</Timeline.Content>
        </Timeline.Item>
        <Timeline.Item status="current">
          <Timeline.Rail />
          <Timeline.Content>Now</Timeline.Content>
        </Timeline.Item>
      </Timeline>,
    );
    expect(html).toContain('data-slot="timeline"');
    expect(html.match(/data-slot="timeline-marker"/g)).toHaveLength(2);
    expect(html.match(/data-slot="timeline-connector"/g)).toHaveLength(2);
    expect(html).toMatch(/data-status="current"[^>]*aria-current="true"/);
  });
});

describe('ChainOfThought', () => {
  it('shimmers while streaming and settles once finished', () => {
    const live = renderToStaticMarkup(
      <ChainOfThought isStreaming>
        <ChainOfThought.Trigger>Thinking</ChainOfThought.Trigger>
        <ChainOfThought.Content>Steps</ChainOfThought.Content>
      </ChainOfThought>,
    );
    expect(live).toContain('data-streaming="true"');
    expect(live).toContain('crewaid-shimmer');
    expect(live).toMatch(/data-slot="chain-of-thought-trigger"[^>]*aria-expanded="false"/);

    const settled = renderToStaticMarkup(
      <ChainOfThought isStreaming={false}>
        <ChainOfThought.Trigger>Thought for 2s</ChainOfThought.Trigger>
        <ChainOfThought.Content>Steps</ChainOfThought.Content>
      </ChainOfThought>,
    );
    expect(settled).not.toContain('data-streaming');
    expect(settled).not.toContain('crewaid-shimmer');
  });
});

describe('ChatAttachment', () => {
  it('renders file metadata, status, and render-prop remove classes', () => {
    const html = renderToStaticMarkup(
      <ChatAttachmentGroup>
        <ChatAttachment mimeType="application/pdf" name="spec.pdf" status="warning">
          <ChatAttachment.Icon />
          <ChatAttachment.Info>
            <ChatAttachment.Name />
            <ChatAttachment.Size>12 KB</ChatAttachment.Size>
          </ChatAttachment.Info>
          <ChatAttachment.Remove
            aria-label="Remove spec.pdf"
            className={({ isPressed }) => (isPressed ? 'pressed' : 'custom-remove')}
          />
        </ChatAttachment>
      </ChatAttachmentGroup>,
    );
    expect(html).toContain('data-status="warning"');
    expect(html).toContain('spec.pdf');
    expect(html).toContain('custom-remove');
  });

  it('chooses file icons by MIME family first and extension second', () => {
    expect(attachmentIcon('image/png', 'x.bin')).toBe(IconPhoto);
    expect(attachmentIcon('application/pdf', 'x')).toBe(IconFileTypePdf);
    expect(attachmentIcon(undefined, 'archive.zip')).toBe(IconFileZip);
    expect(attachmentIcon(undefined, 'metrics.csv')).toBe(IconFileSpreadsheet);
    expect(attachmentIcon(undefined, 'main.ts')).toBe(IconFileCode);
  });

  it('extracts images from clipboard items first, falls back to files, and names unnamed pastes', () => {
    const unnamed = new File(['png'], '', { type: 'image/png', lastModified: 1_700_000_000_000 });
    const text = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    const fromItems = clipboardImageFiles({
      clipboardData: {
        items: [
          { kind: 'string', type: 'text/plain', getAsFile: () => null },
          { kind: 'file', type: 'image/png', getAsFile: () => unnamed },
        ],
        files: [text],
      },
    } as unknown as ClipboardEvent);
    expect(fromItems).toHaveLength(1);
    expect(fromItems[0]?.name).toBe('pasted-image-1.png');
    expect(fromItems[0]?.lastModified).toBe(1_700_000_000_000);

    const svg = new File(['<svg/>'], '', { type: 'image/svg+xml' });
    const fromFiles = clipboardImageFiles({
      clipboardData: { items: [], files: [text, svg] },
    } as unknown as ClipboardEvent);
    expect(fromFiles).toHaveLength(1);
    expect(fromFiles[0]?.name).toBe('pasted-image-1.svg');
  });
});

describe('PromptSuggestion, ItemCard, InlineSelect, ContextMenu and Command', () => {
  it('supports render-prop className and optional chevron on PromptSuggestion', () => {
    const html = renderToStaticMarkup(
      <PromptSuggestion>
        <PromptSuggestion.Items>
          <PromptSuggestion.Item
            showEndIcon={false}
            className={({ isDisabled }) => (isDisabled ? 'off' : 'custom-suggestion')}
          >
            Draft an update
          </PromptSuggestion.Item>
        </PromptSuggestion.Items>
      </PromptSuggestion>,
    );
    expect(html).toContain('custom-suggestion');
    expect(html).not.toContain('<svg');
  });

  it('renders ItemCardGroup grid layout and ItemCard slots', () => {
    const html = renderToStaticMarkup(
      <ItemCardGroup layout="grid" columns={3} variant="transparent">
        <ItemCard variant="outline">
          <ItemCard.Content>
            <ItemCard.Title>Crew</ItemCard.Title>
            <ItemCard.Description>Ready to work</ItemCard.Description>
          </ItemCard.Content>
        </ItemCard>
      </ItemCardGroup>,
    );
    expect(html).toContain('grid-template-columns:repeat(3, minmax(0, 1fr))');
    expect(html).toContain('data-variant="outline"');
  });

  it('renders InlineSelect trigger without throwing', () => {
    const html = renderToStaticMarkup(
      <InlineSelect aria-label="Status" placeholder="Pick one">
        <InlineSelect.Trigger>
          <InlineSelect.Value />
          <InlineSelect.Indicator />
        </InlineSelect.Trigger>
      </InlineSelect>,
    );
    expect(html).toContain('data-slot="inline-select"');
    expect(html).toContain('data-slot="inline-select-trigger"');
  });

  it('renders ContextMenu safely without a DOM document', () => {
    const html = renderToStaticMarkup(
      <ContextMenu open anchorPoint={{ x: 24, y: 48 }} onOpenChange={() => undefined}>
        <ContextMenu.Popover>
          <ContextMenu.Menu aria-label="Row actions">
            <ContextMenu.Item id="pin">Pin</ContextMenu.Item>
          </ContextMenu.Menu>
        </ContextMenu.Popover>
      </ContextMenu>,
    );
    expect(typeof html).toBe('string');
  });

  it('passes localized clear aria-label through Command.InputGroupClearButton', () => {
    const html = renderToStaticMarkup(
      <Command>
        <Command.InputGroup aria-label="Search">
          <Command.InputGroupInput aria-label="Search" />
          <Command.InputGroupClearButton aria-label="Clear search" />
        </Command.InputGroup>
      </Command>,
    );
    expect(html).toContain('aria-label="Clear search"');
  });
});
