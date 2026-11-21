import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { OnboardingBootstrap, UpdateOnboardingBody } from '@crewaid/shared';
import { useApiClient } from '../api';
import { bootstrapExperience, updateOnboarding } from '../api/experience';
import { currentLocale } from '../i18n/i18n';
import type { SetupPrefill } from './templateView';

/** Where the Templates library opens: browsing, one template, or that template's setup. */
export type TemplatesTarget = {
  readonly id: string | null;
  readonly setup: boolean;
  /** A brief Crewaid drafted in chat, offered as the setup's starting point. */
  readonly prefill?: SetupPrefill | undefined;
};

export type Experience = {
  /** The account's main assistant and onboarding progress; null if the server could not say. */
  readonly assistant: OnboardingBootstrap | null;
  readonly templates: TemplatesTarget | null;
  readonly openTemplates: (id?: string | null, setup?: boolean, prefill?: SetupPrefill) => void;
  readonly closeTemplates: () => void;
  readonly progress: (body: UpdateOnboardingBody) => Promise<void>;
};
const Context = createContext<Experience | null>(null);

const BOOTSTRAP_WAIT_MS = 4000;

/** Null only outside the gate, which is how renderer tests mount components. */
export const useExperience = () => useContext(Context);

/**
 * Makes sure the account has its main assistant before the shell
 * picks a bot, so a new user lands on Crewaid rather than an empty room.
 *
 * It fails open. A server that cannot answer — an older one without these
 * routes, or one having a bad minute — leaves the app as it was before
 * Crewaid existed, rather than holding every bot behind a retry screen.
 * Templates do not depend on it at all.
 */
export function ExperienceGate({ children }: { children: ReactNode }) {
  const client = useApiClient();
  const [assistant, setAssistant] = useState<OnboardingBootstrap | null>(null);
  const [settled, setSettled] = useState(false);
  const [templates, setTemplates] = useState<TemplatesTarget | null>(null);
  useEffect(() => {
    let live = true;
    // A slow answer is treated like none: the shell opens, and the assistant
    // joins the moment the server replies.
    const giveUp = setTimeout(() => live && setSettled(true), BOOTSTRAP_WAIT_MS);
    // A new account is greeted before this window reports its
    // computer, so the greeting is told the language this window shows.
    bootstrapExperience(client, { language: currentLocale() })
      .then((value) => live && setAssistant(value))
      .catch(() => undefined)
      .finally(() => live && setSettled(true));
    return () => {
      live = false;
      clearTimeout(giveUp);
    };
  }, [client]);
  const progress = useCallback(
    async (body: UpdateOnboardingBody) => {
      const onboarding = await updateOnboarding(client, body);
      setAssistant((current) => (current === null ? current : { ...current, onboarding }));
    },
    [client],
  );
  const openTemplates = useCallback(
    (id: string | null = null, setup = false, prefill?: SetupPrefill) =>
      setTemplates({ id, setup, prefill }),
    [],
  );
  const closeTemplates = useCallback(() => setTemplates(null), []);
  const value = useMemo(
    () => ({ assistant, templates, openTemplates, closeTemplates, progress }),
    [assistant, templates, openTemplates, closeTemplates, progress],
  );
  // A short wait keeps a new account from flashing an empty room before its
  // assistant arrives; after that the shell renders either way.
  if (!settled) return <div className="crewaid-gate h-full" aria-busy />;
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
