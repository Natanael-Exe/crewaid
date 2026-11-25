import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BotStatus } from '@crewaid/shared';

import { StatusDot } from '../src/renderer/components/Chips';

/** The sidebar's status dot: five states a person has to tell apart. */

const STATUSES: BotStatus[] = ['IDLE', 'THINKING', 'ACTING', 'AWAITING_APPROVAL', 'ERROR'];

function classOf(status: BotStatus): string {
  const html = renderToStaticMarkup(<StatusDot status={status} />);
  return /class="([^"]*)"/.exec(html)?.[1] ?? '';
}

describe('the status dot', () => {
  it('draws every status differently', () => {
    // AWAITING_APPROVAL and ERROR used to be the same solid red dot, so a bot
    // waiting on the operator read as a bot that had failed.
    const styles = STATUSES.map(classOf);
    expect(new Set(styles).size).toBe(STATUSES.length);
    expect(classOf('AWAITING_APPROVAL')).toContain('border-danger');
    expect(classOf('ERROR')).toContain('bg-danger');
  });

  it('is announced, not only seen', () => {
    // An aria-label on a role-less span is ignored by screen readers.
    const html = renderToStaticMarkup(<StatusDot status="AWAITING_APPROVAL" />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Awaiting approval"');
  });

  it('pulses only while working, and only when motion is welcome', () => {
    expect(classOf('THINKING')).toContain('motion-safe:animate-pulse');
    expect(classOf('ACTING')).toContain('motion-safe:animate-pulse');
    expect(classOf('AWAITING_APPROVAL')).not.toContain('animate-pulse');
    for (const status of STATUSES) {
      expect(classOf(status)).not.toMatch(/(^|\s)animate-pulse/);
    }
  });

  it('merges unread state into one dot without stacking a second indicator', () => {
    const idleUnread = renderToStaticMarkup(<StatusDot status="IDLE" unread={3} />);
    expect(idleUnread).toContain('bg-accent');
    expect(idleUnread).not.toContain('animate-pulse');
    expect(idleUnread).toContain('aria-label="3 unread"');
    expect(idleUnread).toContain('data-unread="true"');

    const errorUnread = renderToStaticMarkup(<StatusDot status="ERROR" unread={2} />);
    expect(errorUnread).toContain('bg-danger');
    expect(errorUnread).toContain('aria-label="Error · 2 unread"');
    expect(errorUnread.match(/role="img"/g)).toHaveLength(1);
  });
});
