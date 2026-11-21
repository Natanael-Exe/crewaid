import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BotStatus } from '@crewaid/shared';
import { BotAvatar, MascotFace, mascotActivity } from '../src/renderer/components/BotAvatar';

/**
 * CC-43 — the mascot wears what the bot is doing.
 *
 * `bot.status` has carried THINKING and ACTING since CC-25 and reached the
 * operator as a 6px dot, so a turn that spent four minutes in tool calls
 * looked exactly like a bot doing nothing.
 */

const BOT = { name: 'Nathan Bot', avatarColor: '#e0447c' };

function avatar(status: BotStatus | undefined, size?: 'xs' | 'sm' | 'md' | 'lg'): string {
  return renderToStaticMarkup(
    <BotAvatar bot={BOT} {...(size === undefined ? {} : { size })} status={status} />,
  );
}

describe('mascotActivity', () => {
  it('answers one question — is anything happening right now', () => {
    expect(mascotActivity('THINKING')).toBe('thinking');
    expect(mascotActivity('ACTING')).toBe('acting');
    // A bot waiting on an answer, an idle one and a broken one are all "not
    // working". The dot beside the name tells those three apart in colour;
    // giving the face five answers would make the two that matter harder to
    // see.
    for (const still of ['IDLE', 'AWAITING_APPROVAL', 'ERROR'] as const) {
      expect(mascotActivity(still), still).toBe('idle');
    }
    // A form draft has no status at all.
    expect(mascotActivity(undefined)).toBe('idle');
    expect(mascotActivity(null)).toBe('idle');
  });
});

describe('the mascot at work', () => {
  it('keeps the stored shape and tints only the clay body, leaving the neutral face and features', () => {
    const shapes = [
      'circle',
      'square',
      'polygon',
      'egg',
      'bulb',
      'cloud',
      'shield',
      'splat',
    ] as const;
    shapes.forEach((shape, index) => {
      const markup = renderToStaticMarkup(
        <MascotFace name="A custom bot" shape={shape} color="#123ABC" />,
      );
      expect(markup).toContain(`data-mascot-shape="${shapes[index]}"`);
      expect(markup.match(/<image /g)).toHaveLength(4);
      expect(markup.match(/ filter=/g)).toHaveLength(1);
      expect(markup).toContain('tableValues="0 0.07058823529411765 1"');
      expect(markup).not.toContain('var(--message-user-foreground)');
    });
  });

  it('marks the body and the eyes with what it is doing', () => {
    const acting = avatar('ACTING');
    expect(acting).toContain('class="crewaid-mascot-body" data-activity="acting"');
    expect(acting).toContain('data-activity="acting"');
    expect(avatar('THINKING')).toContain('data-activity="thinking"');
  });

  it('leaves a bot that is not working unmarked, so the CSS cannot animate it', () => {
    // The attribute is ABSENT rather than `idle`: the selectors key on it, and
    // an idle bot that still matched would breathe with a work animation.
    const idle = avatar('IDLE');
    expect(idle).not.toContain('data-activity');
    // It still blinks and breathes — those are on the class, not the state.
    expect(idle).toContain('crewaid-mascot-blink');
    expect(idle).toContain('crewaid-mascot-body');
  });

  it('gives every size the eyes, and only the large ones the ring and the dots', () => {
    // At 24px a thought dot is under two pixels: present in the markup,
    // illegible on screen, and close enough to the next row to read as dirt.
    for (const small of ['xs', 'sm'] as const) {
      expect(avatar('ACTING', small), small).not.toContain('crewaid-mascot-ring');
      expect(avatar('THINKING', small), small).not.toContain('crewaid-mascot-dot');
      expect(avatar('ACTING', small), small).toContain('data-activity="acting"');
    }
    expect(avatar('ACTING', 'md')).toContain('crewaid-mascot-ring');
    expect(avatar('THINKING', 'md')).toContain('crewaid-mascot-dot');
    // One kind of ornament at a time: a thinking bot has no work ring.
    expect(avatar('THINKING', 'md')).not.toContain('crewaid-mascot-ring');
    expect(avatar('ACTING', 'md')).not.toContain('crewaid-mascot-dot');
  });

  it('gives two bots with the same shape different blink phases', () => {
    // Every mascot blinking on the same frame reads as a rendering artifact.
    // The phase is hashed from the NAME, because a stored shape collapses to
    // one of eight values and would put those bots back in lockstep.
    const phaseOf = (name: string) =>
      /--crewaid-mascot-phase:([^;"]*)/.exec(
        renderToStaticMarkup(
          <MascotFace name={name} color="#e0447c" shape="circle" activity="idle" />,
        ),
      )?.[1];
    expect(phaseOf('Quill')).not.toBe(phaseOf('Warden'));
    // And it is stable across renders, so it does not re-roll on every frame.
    expect(phaseOf('Quill')).toBe(phaseOf('Quill'));
  });
});
