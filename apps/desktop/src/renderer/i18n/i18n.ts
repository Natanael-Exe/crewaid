import { useSyncExternalStore } from 'react';
import { DEFAULT_LOCALE, isRtlLocale, SUPPORTED_LOCALES, type Locale } from '@crewaid/shared';
import { en } from './messages/en';
import { formatMessage, type Message, type PluralMessage } from './format';
import { reportLocale } from '../bridge';

/**
 * The app's language at runtime. One active catalog for the window,
 * read by `t()` anywhere — a component, or a plain `.ts` helper that writes
 * copy — and a re-render wherever `useT()` or `useLocale()` is read when it
 * changes.
 *
 * Changing the language re-renders in place rather than remounting the app,
 * so the Settings modal the person changed it from stays open.
 */

export type MessageKey = keyof typeof en;
export type Catalog = Readonly<Partial<Record<MessageKey, Message>>>;

type Placeholders<S> = S extends `${string}{${infer Name}}${infer Rest}`
  ? Name | Placeholders<Rest>
  : never;
type TextOf<M> = M extends string ? M : M extends PluralMessage ? M[keyof M] : never;
type ParamsOf<K extends MessageKey> = (typeof en)[K] extends string
  ? Record<Placeholders<(typeof en)[K]>, string | number>
  : { readonly count: number } & Record<
      Exclude<Placeholders<TextOf<(typeof en)[K]>>, 'count'>,
      string | number
    >;
type ArgsFor<K extends MessageKey> = keyof ParamsOf<K> extends never ? [] : [params: ParamsOf<K>];

/** A key whose message takes no parameters — what a lookup table of labels holds. */
export type PlainKey = {
  [K in MessageKey]: keyof ParamsOf<K> extends never ? K : never;
}[MessageKey];

/**
 * Every other language is a JSON catalog beside this file, split into its own
 * chunk and fetched only when chosen. A language is available when its file
 * exists; the coverage test is what makes "exists" mean "complete".
 */
const LOADERS = import.meta.glob<Catalog>('./locales/*.json', { import: 'default' });

function loaderFor(locale: Locale): (() => Promise<Catalog>) | undefined {
  return LOADERS[`./locales/${locale}.json`];
}

/** The languages the picker offers: English, and every one whose catalog ships. */
export const AVAILABLE_LOCALES: readonly Locale[] = SUPPORTED_LOCALES.filter(
  (locale) => locale === DEFAULT_LOCALE || loaderFor(locale) !== undefined,
);

let active: { readonly locale: Locale; readonly catalog: Catalog } = {
  locale: DEFAULT_LOCALE,
  catalog: en,
};
let requested = 0;
const listeners = new Set<() => void>();

export function currentLocale(): Locale {
  return active.locale;
}

/**
 * A message in the active language. A key the active catalog lacks reads in
 * English rather than as a key name; the catalog check keeps that from
 * shipping, so this only covers a catalog that failed to load.
 */
export function t<K extends MessageKey>(key: K, ...args: ArgsFor<K>): string {
  const message: Message | undefined = active.catalog[key] ?? en[key];
  // Unreachable through the types; a key computed at runtime that misses
  // shows itself rather than taking the screen down.
  if (message === undefined) return String(key);
  return formatMessage(message, args[0], active.locale);
}

/**
 * Switch the window's language. An unavailable language reads as English,
 * and a load that fails leaves the current language in place. When two
 * switches race, the later request wins even if its catalog arrives first.
 */
export async function activateLocale(locale: Locale): Promise<void> {
  const ticket = ++requested;
  const loader = locale === DEFAULT_LOCALE ? undefined : loaderFor(locale);
  let next: { readonly locale: Locale; readonly catalog: Catalog };
  if (loader === undefined) {
    next = { locale: DEFAULT_LOCALE, catalog: en };
  } else {
    try {
      next = { locale, catalog: await loader() };
    } catch {
      return;
    }
  }
  if (ticket !== requested) return;
  active = next;
  applyDocumentLocale(next.locale);
  for (const listener of listeners) listener();
}

/** `lang` for fonts, hyphenation and screen readers; `dir` for the layout. */
function applyDocumentLocale(locale: Locale): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = locale;
  document.documentElement.dir = isRtlLocale(locale) ? 'rtl' : 'ltr';
  reportLocale(locale);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The active language, and a re-render when it changes. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, currentLocale, currentLocale);
}

/** `t`, in a component that should re-render when the language changes. */
export function useT(): typeof t {
  useLocale();
  return t;
}
