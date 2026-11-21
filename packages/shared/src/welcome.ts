import type { Locale } from './locale.js';
import { WELCOME_TRANSLATIONS } from './welcome-translations.js';

/**
 * Crewaid's welcome, as the conversation it is. The server stores these
 * as Crewaid's messages and the person's replies; the renderer reads the same
 * words to know which replies are still open. One copy, so the two cannot
 * drift apart.
 *
 * One copy per language, written in the account's language. Plain data
 * (no functions), because every translation is generated from this shape.
 */
export type WelcomeCopyData = {
  readonly greeting: {
    /** The first line when the account has a name: `{firstName}` is the person's. */
    readonly named: string;
    readonly unnamed: string;
    /** The lines after it. */
    readonly lines: readonly string[];
  };
  readonly replies: { readonly TASK: string; readonly CREW: string; readonly TOUR: string };
  /** What Crewaid asks when the person brings a task of their own. */
  readonly taskQuestion: string;
  /** The tour, one line per entry; stored as one message. */
  readonly guide: readonly string[];
  readonly afterGuide: string;
  /** Crewaid's role, written when Crewaid is created. */
  readonly assistantRole: string;
};

export const WELCOME_COPY_EN: WelcomeCopyData = {
  greeting: {
    named: 'Hi {firstName}, I’m Crewaid.',
    unnamed: 'Hi, I’m Crewaid.',
    lines: [
      'Tell me what you’d like to get done. I can help directly, or bring in the right specialists.',
      'New here? I can show you around first.',
    ],
  },
  replies: {
    TASK: 'I have a task',
    CREW: 'Help me find the right crew',
    TOUR: 'Show me around',
  },
  taskQuestion: 'What task would you like me to help you with?',
  guide: [
    'Here’s the quick version.',
    '',
    '1. **Start here with a task.** I can help directly and keep the pieces together.',
    '2. **Bring in specialists when they help.** I brief them, collect their replies and bring the result back here.',
    '3. **Each bot has its own screen.** Watch it work, take over, or show it once how you do something.',
    '4. **Connect tools when they’re useful.** You choose which accounts and which bots get access.',
    '5. **Keep tasks and outputs together in Work.** Routines repeat only after you choose a schedule.',
  ],
  afterGuide: 'Want to try something now?',
  assistantRole: 'Main assistant',
};

/** Every language the welcome ships in. A language missing here reads English. */
export const WELCOME_COPIES: Readonly<Partial<Record<Locale, WelcomeCopyData>>> = {
  en: WELCOME_COPY_EN,
  ...WELCOME_TRANSLATIONS,
};

export type WelcomeCopy = {
  readonly greeting: (firstName: string | null) => readonly string[];
  readonly replies: WelcomeCopyData['replies'];
  readonly taskQuestion: string;
  readonly guide: string;
  readonly afterGuide: string;
  readonly assistantRole: string;
};

function welcomeOf(data: WelcomeCopyData): WelcomeCopy {
  return {
    greeting: (firstName) => [
      firstName
        ? data.greeting.named.replaceAll('{firstName}', () => firstName)
        : data.greeting.unnamed,
      ...data.greeting.lines,
    ],
    replies: data.replies,
    taskQuestion: data.taskQuestion,
    guide: data.guide.join('\n'),
    afterGuide: data.afterGuide,
    assistantRole: data.assistantRole,
  };
}

/** The welcome in `locale`, or in English when that language has not shipped. */
export function welcomeCopy(
  locale: Locale | null,
  copies: Readonly<Partial<Record<Locale, WelcomeCopyData>>> = WELCOME_COPIES,
): WelcomeCopy {
  return welcomeOf((locale === null ? undefined : copies[locale]) ?? WELCOME_COPY_EN);
}

/**
 * Every language's wording of one welcome line. A stored line keeps the
 * language it was written in, so what is still open is read against all of
 * them: a person who changes language mid-welcome keeps their replies.
 */
export function welcomeLines(
  line: 'guide' | 'taskQuestion',
  copies: Readonly<Partial<Record<Locale, WelcomeCopyData>>> = WELCOME_COPIES,
): readonly string[] {
  return Object.values(copies)
    .filter((data): data is WelcomeCopyData => data !== undefined)
    .map((data) => welcomeOf(data)[line]);
}

export function isWelcomeLine(
  line: 'guide' | 'taskQuestion',
  text: string,
  copies: Readonly<Partial<Record<Locale, WelcomeCopyData>>> = WELCOME_COPIES,
): boolean {
  return welcomeLines(line, copies).includes(text);
}
