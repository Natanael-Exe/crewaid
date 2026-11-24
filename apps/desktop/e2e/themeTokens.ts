import type { Page } from '@playwright/test';

/**
 * The colour a theme token resolves to, serialized exactly as the browser
 * reports a computed `color` / `background-color`.
 *
 * Specs assert which role a surface wears ("a hovered row uses
 * `--crew-hover`") rather than a literal like `rgba(255, 255, 255, 0.5)`.
 * The literal restates the theme file, so it fails on every palette tweak
 * while a wrong role — the regression worth catching — can still match it by
 * accident. A probe resolves the token in the same document, under the same
 * `data-theme`, so the comparison is like for like.
 *
 * `scope` places the probe inside an element whose own custom properties
 * matter, e.g. `.crewaid-bot-context` for a token a bot's accent overrides.
 */
export async function tokenColor(
  page: Page,
  token: `--${string}`,
  property: 'color' | 'background-color' = 'background-color',
  scope?: string,
): Promise<string> {
  return page.evaluate(
    ([name, prop, within]) => {
      const host = (within === undefined ? null : document.querySelector(within)) ?? document.body;
      const probe = document.createElement('div');
      probe.style.setProperty(prop, `var(${name})`);
      host.append(probe);
      const value = getComputedStyle(probe).getPropertyValue(prop);
      probe.remove();
      return value;
    },
    [token, property, scope] as const,
  );
}
