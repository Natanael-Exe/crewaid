import { describe, expect, it } from 'vitest';
import { WELCOME_COPY_EN, isWelcomeLine, welcomeCopy, welcomeLines } from './welcome.js';

const french = {
  ...WELCOME_COPY_EN,
  greeting: { named: 'Bonjour {firstName}, je suis Crewaid.', unnamed: 'Bonjour.', lines: [] },
  taskQuestion: 'Quelle tâche voulez-vous me confier ?',
  guide: ['Voici la version courte.'],
};
const copies = { en: WELCOME_COPY_EN, fr: french };

describe('D-235 — the welcome in the account’s language', () => {
  it('reads the language asked for, and English for one that has not shipped', () => {
    expect(welcomeCopy('fr', copies).taskQuestion).toBe(french.taskQuestion);
    expect(welcomeCopy('de', copies).taskQuestion).toBe(WELCOME_COPY_EN.taskQuestion);
    expect(welcomeCopy(null, copies).taskQuestion).toBe(WELCOME_COPY_EN.taskQuestion);
  });

  it('greets by first name when there is one', () => {
    expect(welcomeCopy('fr', copies).greeting('Ada')).toEqual(['Bonjour Ada, je suis Crewaid.']);
    expect(welcomeCopy('en').greeting(null)[0]).toBe('Hi, I’m Crewaid.');
    expect(welcomeCopy('en').greeting('Ada')).toHaveLength(3);
    expect(welcomeCopy('en').greeting('$&')[0]).toBe('Hi $&, I’m Crewaid.');
    expect(welcomeCopy('fr', copies).greeting('$$')[0]).toBe('Bonjour $$, je suis Crewaid.');
  });

  it('stores the guide as one message, its lines joined', () => {
    expect(welcomeCopy('en').guide.split('\n')).toEqual(WELCOME_COPY_EN.guide);
  });

  it('recognises a stored line in any language, so a language change strands nothing', () => {
    expect(welcomeLines('taskQuestion', copies)).toHaveLength(2);
    expect(isWelcomeLine('taskQuestion', french.taskQuestion, copies)).toBe(true);
    expect(isWelcomeLine('guide', 'Voici la version courte.', copies)).toBe(true);
    expect(isWelcomeLine('taskQuestion', 'Voici la version courte.', copies)).toBe(false);
    expect(isWelcomeLine('guide', WELCOME_COPY_EN.taskQuestion, copies)).toBe(false);
  });
});
