import { describe, expect, it } from 'vitest';
import {
  activeBotQuery,
  applyBotMention,
  completedBotMention,
  filterBots,
  isAfterCompletedBotMention,
  mentionSegments,
  type MentionBot,
} from '../src/renderer/components/composer/botMention';

const BOTS: MentionBot[] = [
  { id: 'nathan', name: 'Nathan Bot', role: 'Frontend engineer', avatarColor: '#16a3b6' },
  { id: 'quill', name: 'Quill', role: 'Researcher', avatarColor: '#d85b42' },
];

describe('bot mention mechanics', () => {
  it('opens on @ at the caret and supports multi-word names', () => {
    expect(activeBotQuery('ask @Nathan B', 13)).toEqual({ query: 'Nathan B', start: 4 });
    expect(activeBotQuery('mail@example.com', 9)).toBeNull();
  });

  it('filters by name or role and inserts the selected display name', () => {
    expect(filterBots(BOTS, 'front').map((bot) => bot.id)).toEqual(['nathan']);
    expect(filterBots(BOTS, 'qui').map((bot) => bot.id)).toEqual(['quill']);
    expect(applyBotMention('ask @nat tomorrow', 8, 'Nathan Bot')).toEqual({
      draft: 'ask @Nathan Bot  tomorrow',
      caret: 16,
    });
  });

  it('keeps a selected mention closed while ordinary message text continues', () => {
    const selected = applyBotMention('@Jo', 3, 'John');
    const completed = completedBotMention('John', selected.caret);
    const continued = `${selected.draft}please review this`;

    expect(
      isAfterCompletedBotMention(
        continued,
        continued.length,
        activeBotQuery(continued, continued.length),
        completed,
      ),
    ).toBe(true);
  });

  it('allows the picker to reopen when the selected mention is edited', () => {
    const edited = '@Joh';
    expect(
      isAfterCompletedBotMention(
        edited,
        edited.length,
        activeBotQuery(edited, edited.length),
        completedBotMention('John', 6),
      ),
    ).toBe(false);
  });

  it('finds full roster names without turning email addresses into mentions', () => {
    const segments = mentionSegments('Email me, then ask @Nathan Bot.', BOTS);
    expect(segments.filter((segment) => segment.kind === 'mention')).toEqual([
      { kind: 'mention', value: '@Nathan Bot', bot: BOTS[0] },
    ]);
    expect(mentionSegments('mail@nathan bot.example', BOTS)).toEqual([
      { kind: 'text', value: 'mail@nathan bot.example' },
    ]);
  });

  it('does not link an ambiguous duplicate name', () => {
    const duplicate = { ...BOTS[0]!, id: 'nathan-2' };
    expect(mentionSegments('@Nathan Bot', [...BOTS, duplicate])).toEqual([
      { kind: 'text', value: '@Nathan Bot' },
    ]);
  });
});
