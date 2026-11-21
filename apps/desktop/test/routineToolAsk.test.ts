import { describe, expect, it } from 'vitest';

import { describeToolAsk } from '../src/renderer/components/tools/toolPhrase.js';

/**
 * M8-BE-08 — the approval card for a bot scheduling itself.
 *
 * `schedule_routine` is the one routine act that asks (D-125), so the card is
 * where an operator decides whether to be committed to runs they will not be
 * watching. It must say what, when, and what the bot will be told — not
 * "Can I use my schedule routine tool?".
 */
describe('describeToolAsk for the routine tools', () => {
  it('names the routine and its schedule, with the prompt as the detail', () => {
    expect(
      describeToolAsk('schedule_routine', {
        name: 'Invoice check',
        cron: '0 9 * * *',
        prompt: 'Check whether the invoice was paid.',
      }),
    ).toEqual({
      question: 'Can I schedule "Invoice check" to run on my own (0 9 * * *)?',
      detail: 'Check whether the invoice was paid.',
      detailIsCode: false,
    });
  });

  it('still reads as a sentence when the arguments are missing', () => {
    expect(describeToolAsk('schedule_routine', {}).question).toBe(
      'Can I schedule a routine to run on my own later?',
    );
    expect(describeToolAsk('cancel_routine', {}).question).toBe('Can I cancel one of my routines?');
  });

  it('names what cancel_routine would cancel', () => {
    expect(describeToolAsk('cancel_routine', { routine: 'Invoice check' }).question).toBe(
      'Can I cancel Invoice check?',
    );
  });
});
