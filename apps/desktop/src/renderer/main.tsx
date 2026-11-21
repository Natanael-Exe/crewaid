import { StrictMode, useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@heroui/react';
import App from './App';
import { useLocale } from './i18n/i18n';
import { reportLocale } from './bridge';
import { initializeLocale } from './i18n/localePreference';
import { initializeTheme } from './styles/themePreference';
import './styles/app.css';

/**
 * Renderer entry. I18nProvider is HeroUI/React Aria's locale+direction root —
 * HeroUI v3 exposes it from @heroui/react (re-exported from RAC). It follows
 * the app's own language, so the components' built-in words, dates
 * and direction agree with the catalog.
 */
const container = document.getElementById('root');
if (!container) throw new Error('#root not found — check index.html');

function LocaleRoot({ children }: { children: ReactNode }) {
  const locale = useLocale();
  useEffect(() => {
    // The application menu is shared by all windows. Restore this window's
    // language when it becomes active after another window reported its own.
    const focused = () => reportLocale(locale);
    window.addEventListener('focus', focused);
    return () => window.removeEventListener('focus', focused);
  }, [locale]);
  return <I18nProvider locale={locale}>{children}</I18nProvider>;
}

initializeTheme();

// The catalog first, so the first frame is not English for a moment. A load
// that fails leaves English active, and the app still opens.
void initializeLocale().finally(() => {
  createRoot(container).render(
    <StrictMode>
      <LocaleRoot>
        <App />
      </LocaleRoot>
    </StrictMode>,
  );
});
