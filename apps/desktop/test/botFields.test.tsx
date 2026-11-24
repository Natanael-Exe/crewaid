import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@heroui/react';
import { BotFields } from '../src/renderer/bots/BotFields';
import { BOT_MENU_ITEMS, BotRowMenu } from '../src/renderer/bots/BotRowMenu';
import { AVATAR_COLORS, AVATAR_SHAPES, type BotDraft } from '../src/renderer/bots/botProfileForm';

/**
 * The fields are asserted here rather than through the dialog or the rail
 * pane: React Aria mounts an overlay into a portal that
 * `renderToStaticMarkup` has nowhere to put, so a test driven through either
 * container would assert against an empty string and pass regardless.
 */
const draft: BotDraft = {
  name: 'Quill',
  role: 'Outbound Writer',
  systemPrompt: 'You are an outbound writer.',
  avatarColor: '#8d6e4e',
  avatarShape: null,
};

function render(idPrefix = 'test-bot') {
  return renderToStaticMarkup(
    <I18nProvider>
      <BotFields draft={draft} onChange={() => undefined} idPrefix={idPrefix} />
    </I18nProvider>,
  );
}

describe('BotFields', () => {
  it('renders the three editable columns with their stored values', () => {
    const html = render();
    expect(html).toContain('value="Quill"');
    expect(html).toContain('value="Outbound Writer"');
    expect(html).toContain('You are an outbound writer.');
  });

  it('labels every field, so each input is reachable by name', () => {
    const html = render();
    for (const id of ['test-bot-name', 'test-bot-role', 'test-bot-prompt']) {
      expect(html).toContain(`for="${id}"`);
      expect(html).toContain(`id="${id}"`);
    }
  });

  /**
   * The rail's pane stays mounted behind the create dialog, so both field sets
   * exist in one document. Without distinct ids their labels would both point
   * at whichever input the document reaches first.
   */
  it('namespaces its ids so two mounted forms cannot collide', () => {
    expect(render('a')).toContain('id="a-name"');
    expect(render('b')).toContain('id="b-name"');
  });

  it('offers every mascot shape as its own radio', () => {
    const html = render();
    for (const shape of AVATAR_SHAPES) {
      expect(html).toContain(`Avatar shape ${shape}`);
    }
  });

  /**
   * A draft with no chosen shape must leave the shape group empty rather than
   * marking one — the avatar is derived from the name until an operator picks,
   * and pre-selecting one would claim a choice nobody made.
   */
  it('checks no shape until one is chosen, then exactly that one', () => {
    expect(render()).not.toContain('Avatar shape circle" aria-checked="true"');
    const chosen = renderToStaticMarkup(
      <I18nProvider>
        <BotFields
          draft={{ ...draft, avatarShape: 'cloud' }}
          onChange={() => undefined}
          idPrefix="t"
        />
      </I18nProvider>,
    );
    // Shapes are radios; colours are the swatch picker's options, so the
    // chosen shape is the only checked radio in the document.
    expect(chosen.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(chosen).toMatch(/aria-checked="true" aria-label="Avatar shape cloud"/);
  });

  it('offers every palette colour in a swatch picker, with the draft one selected', () => {
    const html = render();
    expect(html).toContain('data-slot="color-swatch-picker"');
    for (const color of AVATAR_COLORS) {
      expect(html).toContain(`Avatar colour ${color}`);
    }
    const selected = [...html.matchAll(/role="option" aria-selected="true" aria-label="([^"]+)"/g)];
    expect(selected.map((match) => match[1])).toEqual([`Avatar colour ${draft.avatarColor}`]);
  });

  /**
   * The look is folded behind "Customize appearance" where it is an
   * occasional edit (the profile pane) and laid out where it is part of
   * making the bot (the create dialog). Folded, the controls still render —
   * hidden — so their state is not lost.
   */
  it('lays the look out by default and folds it when asked', () => {
    const open = render();
    expect(open).toContain('Customize appearance');
    expect(open).toMatch(/aria-expanded="true"/);
    const folded = renderToStaticMarkup(
      <I18nProvider>
        <BotFields draft={draft} onChange={() => undefined} idPrefix="f" defaultLookOpen={false} />
      </I18nProvider>,
    );
    expect(folded).toMatch(/aria-expanded="false"/);
  });
});

describe('BotRowMenu', () => {
  function renderMenu(pinned: boolean) {
    return renderToStaticMarkup(
      <I18nProvider>
        <BotRowMenu
          bot={{ id: 'bot_1', name: 'Quill', pinned, groupId: null }}
          onEditProfile={() => undefined}
          onTogglePin={() => undefined}
          onHide={() => undefined}
          onDuplicate={() => undefined}
          onClearChat={() => undefined}
          onDelete={() => undefined}
          groups={[]}
          onMoveToGroup={() => undefined}
          onNewGroup={() => undefined}
          onMarkUnread={() => undefined}
        />
      </I18nProvider>,
    );
  }

  it('does not render a hover trigger; actions are opened from the row context menu', () => {
    expect(renderMenu(false)).not.toContain('Actions for Quill');
  });

  /**
   * Every id here is routed by the menu's onAction. An entry added to the list
   * without a branch there is a silent click, which is the failure this pairing
   * is meant to make visible.
   */
  it('offers exactly the actions the orchestrator can back', () => {
    // D-131 added two: "Move to" writes `Bot.groupId`, and "Mark as unread"
    // moves `Conversation.lastReadAt`. D-147 added "Clear chat", which is
    // `DELETE /bots/:id/messages`.
    expect(BOT_MENU_ITEMS.map((item) => item.id)).toEqual([
      'pin',
      'move',
      'unread',
      'edit',
      'duplicate',
      'hide',
      'clear',
      'delete',
    ]);
  });

  it('does not advertise the reference app entries with no column behind them', () => {
    const labels = BOT_MENU_ITEMS.map((item) => item.label);
    expect(labels).not.toContain('Copy conversation ID');
  });
});
