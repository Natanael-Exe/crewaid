import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StreamingMarkdown } from '../src/renderer/components/markdown/StreamingMarkdown';
import { describe, expect, it } from 'vitest';
import { RIGHT_TO_LEFT } from '../../../tools/i18n/languages.mjs';
import { shippedLocales } from '../../../tools/i18n/sources.mjs';
import {
  catalogCompletenessIssues,
  catalogIntegrityIssues,
  messageIssues,
} from '../../../tools/i18n/validate.mjs';
import { activateLocale, AVAILABLE_LOCALES, t } from '../src/renderer/i18n/i18n';

/**
 * Shipped translations must stay structurally valid on every PR without
 * requiring an OpenRouter key. Missing or stale keys fall back to English at
 * runtime; full completeness is checked before release via `pnpm i18n:check`
 * (or `CREWAID_STRICT_I18N=1`).
 */
describe('shipped locale catalogs', () => {
  it('keep every translated entry structurally valid (placeholders, tags, plurals, no dangling keys)', () => {
    expect(catalogIntegrityIssues()).toEqual([]);
  });

  it.skipIf(process.env['CREWAID_STRICT_I18N'] !== '1')(
    'hold every string translated from today’s English when strict i18n checking is enabled',
    () => {
      expect(catalogCompletenessIssues()).toEqual([]);
    },
  );

  it('falls back cleanly to English when an unavailable locale is requested', async () => {
    await activateLocale('fr');
    try {
      expect(t('markdown.controls.copyCode')).not.toBe('Copy Code');
    } finally {
      await activateLocale('en');
    }
    expect(t('markdown.controls.copyCode')).toBe('Copy Code');
  });

  it('offers exactly the languages that ship', () => {
    expect([...AVAILABLE_LOCALES].sort()).toEqual(['en', ...shippedLocales()].sort());
  });

  it('ships the right-to-left languages, now the layout reads right to left (CC-85)', () => {
    expect(shippedLocales().filter((locale) => RIGHT_TO_LEFT.has(locale))).toEqual([
      'ar',
      'he',
      'ur',
    ]);
  });
});

describe('D-234 — what a translation must keep', () => {
  it('rejects malformed model answers without crashing the retry or coverage check', () => {
    for (const invalid of [null, 42, false, [], { bad: true }]) {
      expect(messageIssues('Open {name}', invalid, 'fr').length).toBeGreaterThan(0);
    }
    expect(messageIssues({ other: '{count} rows' }, { other: 42 }, 'ja').length).toBeGreaterThan(0);
  });

  it('keeps commands, URLs, model ids, keyboard keys and product names unchanged', () => {
    for (const token of [
      'npx crewaid-selfhost update',
      'https://mcp.example.com/mcp',
      '/newbot',
      '@BotFather',
      'gpt-5.1',
      'ElevenLabs',
      'CSV',
    ]) {
      const english = token.startsWith('npx') ? `Run <code>${token}</code>` : `Use ${token}.`;
      expect(messageIssues(english, english.replace(token, 'traduit'), 'fr')).toContain(
        `"${token}" was translated`,
      );
    }
    expect(
      messageIssues('Run <code>{command}</code>', 'Lancez <code>{command}</code>', 'fr'),
    ).toEqual([]);
    expect(messageIssues('<code>run</code>', '</code>run<code>', 'fr')).toContain(
      'markup tags are unbalanced',
    );
  });

  it('keeps identifying placeholders in every plural form', () => {
    expect(
      messageIssues(
        { one: '{count} file in {folder}', other: '{count} files in {folder}' },
        {
          one: 'un fichier',
          many: '{count} de fichiers dans {folder}',
          other: '{count} fichiers dans {folder}',
        },
        'fr',
      ),
    ).toContain('one: missing placeholder {folder}');
  });

  it('keeps every placeholder, and adds none', () => {
    expect(messageIssues('Open {name}', 'Ouvrir {name}', 'fr')).toEqual([]);
    expect(messageIssues('Open {name}', 'Ouvrir', 'fr')).toEqual(['missing placeholder {name}']);
    expect(messageIssues('Open', 'Ouvrir {nom}', 'fr')).toEqual(['unknown placeholder {nom}']);
  });

  it('keeps markup, bold markers and the product’s name', () => {
    expect(messageIssues('Send — Enter', 'Envoyer — Entrée', 'fr')).toContain(
      '"Enter" was translated',
    );
    expect(messageIssues('Enter a name', 'Saisissez un nom', 'fr')).toEqual([]);
    expect(messageIssues('Run <code>{command}</code>', 'Lancez {command}', 'fr')).toContain(
      'markup tags differ',
    );
    expect(messageIssues('**Start** here', 'Commencez ici', 'fr')).toContain('bold markers differ');
    expect(messageIssues('Welcome to Crewaid', 'Bienvenue sur Équipage', 'fr')).toContain(
      '"Crewaid" was translated',
    );
  });

  it('answers a plural with exactly the forms the language uses', () => {
    const files = { one: '{count} file', other: '{count} files' };
    expect(
      messageIssues(
        files,
        { one: '{count} fichier', many: '{count} de fichiers', other: '{count} fichiers' },
        'fr',
      ),
    ).toEqual([]);
    expect(
      messageIssues(files, { one: '{count} fichier', other: '{count} fichiers' }, 'fr')[0],
    ).toMatch(/plural categories/);
    expect(messageIssues(files, { other: '{count}個のファイル' }, 'ja')).toEqual([]);
    expect(messageIssues(files, { other: 'ファイル' }, 'ja')).toEqual([
      'other: missing placeholder {count}',
    ]);
    expect(messageIssues('Save', { other: 'Enregistrer' }, 'fr')).toEqual([
      'plural object for a plain message',
    ]);
  });
});

describe('D-234 — third-party Markdown controls', () => {
  it('renders code and table controls in the chosen language, keeping their content verbatim', async () => {
    await activateLocale('fr');
    try {
      const code = 'const greeting = "Hello";';
      const output = renderToStaticMarkup(
        createElement(StreamingMarkdown, {
          source: '```js\n' + code + '\n```\n\n| Name | Value |\n| --- | --- |\n| Sample | 42 |',
        }),
      );
      expect(t('markdown.controls.copyCode')).not.toBe('Copy Code');
      const attribute = renderToStaticMarkup(
        createElement('button', { 'aria-label': t('markdown.controls.copyCode') }),
      ).match(/aria-label="[^"]*"/)?.[0];
      expect(attribute).toBeDefined();
      expect(output).toContain(attribute);
      expect(output).toContain(t('markdown.controls.copyTable'));
      expect(output).toContain('const greeting = &quot;Hello&quot;;');
      expect(output).toContain('Sample');
    } finally {
      await activateLocale('en');
    }
  });
});
