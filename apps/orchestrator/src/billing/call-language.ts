import type { Locale } from '@crewaid/shared';

/**
 * A call in the person's language: the agent's language code and the
 * greeting the voice opens with.
 *
 * The greeting is spoken verbatim before the model says anything, so it
 * cannot be left to the "Speak …" line in the prompt the way every later turn
 * is. Each one avoids a gendered verb form, because a bot's name says nothing
 * about which form would be right.
 */
const GREETINGS: Record<Locale, (name: string) => string> = {
  af: (name) => `Hallo, dis ${name}.`,
  ar: (name) => `مرحبًا، أنا ${name}.`,
  bn: (name) => `হ্যালো, আমি ${name}।`,
  cs: (name) => `Ahoj, tady ${name}.`,
  da: (name) => `Hej, det er ${name}.`,
  de: (name) => `Hallo, hier ist ${name}.`,
  el: (name) => `Γεια σας, εδώ ${name}.`,
  en: (name) => `Hi, it's ${name}.`,
  es: (name) => `Hola, soy ${name}.`,
  fi: (name) => `Hei, täällä ${name}.`,
  fr: (name) => `Bonjour, c'est ${name}.`,
  ha: (name) => `Sannu, ${name} ne.`,
  he: (name) => `שלום, כאן ${name}.`,
  hi: (name) => `नमस्ते, यह ${name} है।`,
  hu: (name) => `Szia, itt ${name}.`,
  id: (name) => `Halo, ini ${name}.`,
  it: (name) => `Ciao, sono ${name}.`,
  ja: (name) => `こんにちは、${name}です。`,
  ko: (name) => `안녕하세요, ${name}입니다.`,
  mr: (name) => `नमस्कार, मी ${name}.`,
  nb: (name) => `Hei, det er ${name}.`,
  nl: (name) => `Hoi, met ${name}.`,
  pl: (name) => `Cześć, tu ${name}.`,
  pt: (name) => `Oi, aqui é ${name}.`,
  ru: (name) => `Привет, это ${name}.`,
  sv: (name) => `Hej, det är ${name}.`,
  sw: (name) => `Habari, ni ${name}.`,
  ta: (name) => `வணக்கம், நான் ${name}.`,
  te: (name) => `నమస్కారం, నేను ${name}.`,
  th: (name) => `สวัสดี นี่คือ ${name}`,
  tr: (name) => `Merhaba, ben ${name}.`,
  uk: (name) => `Привіт, це ${name}.`,
  ur: (name) => `ہیلو، میں ${name} ہوں۔`,
  vi: (name) => `Xin chào, mình là ${name}.`,
  'zh-Hans': (name) => `你好，我是${name}。`,
  'zh-Hant': (name) => `你好，我是${name}。`,
};

/**
 * ElevenLabs' code for each language, where it differs from Crewaid's. The
 * agent's language sets its speech recognition too, so a French call with an
 * English agent would mishear every word the person says.
 */
const AGENT_CODES: Partial<Record<Locale, string>> = {
  nb: 'no',
  pt: 'pt-br',
  'zh-Hans': 'zh',
  'zh-Hant': 'zh',
};

export function callGreeting(language: Locale | null, botName: string): string {
  return GREETINGS[language ?? 'en'](botName);
}

/** The agent's language code, or undefined for English — the agent's own default. */
export function callAgentLanguage(language: Locale | null): string | undefined {
  if (language === null || language === 'en') return undefined;
  return AGENT_CODES[language] ?? language;
}
