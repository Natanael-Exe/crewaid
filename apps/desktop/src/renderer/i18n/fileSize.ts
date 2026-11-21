import { currentLocale, t } from './i18n';

/**
 * "12 KB", "1.5 MB" — in the language's own decimal mark and unit.
 * One place, because three cards wrote the same three lines each.
 */
export function formatFileSize(bytes: number): string {
  const number = (value: number, digits: number) =>
    new Intl.NumberFormat(currentLocale(), {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  if (bytes < 1024) return t('units.bytes', { value: number(bytes, 0) });
  if (bytes < 1024 * 1024) return t('units.kilobytes', { value: number(bytes / 1024, 0) });
  return t('units.megabytes', { value: number(bytes / (1024 * 1024), 1) });
}
