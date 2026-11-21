import { describe, expect, it } from 'vitest';
import { isRendererUrl, rendererEntryUrl } from '../src/rendererLocation';

const INDEX = '/Applications/Crewaid.app/Contents/Resources/app.asar/dist/renderer/index.html';

describe('rendererEntryUrl', () => {
  it('ignores ELECTRON_START_URL in a packaged build', () => {
    expect(
      rendererEntryUrl({ packaged: true, startUrl: 'https://attacker.example/', indexPath: INDEX }),
    ).toBe(`file://${INDEX}`);
  });

  it('uses the dev server only when unpackaged and set', () => {
    expect(
      rendererEntryUrl({ packaged: false, startUrl: 'http://localhost:5173', indexPath: INDEX }),
    ).toBe('http://localhost:5173');
    expect(rendererEntryUrl({ packaged: false, startUrl: '', indexPath: INDEX })).toBe(
      `file://${INDEX}`,
    );
    expect(rendererEntryUrl({ packaged: false, startUrl: undefined, indexPath: INDEX })).toBe(
      `file://${INDEX}`,
    );
  });
});

describe('isRendererUrl', () => {
  const entry = `file://${INDEX}`;

  it('admits the renderer file whatever its hash or query', () => {
    expect(isRendererUrl(entry, entry)).toBe(true);
    expect(isRendererUrl(`${entry}#/bots/1`, entry)).toBe(true);
    expect(isRendererUrl(`${entry}?x=1`, entry)).toBe(true);
  });

  it('refuses any other document', () => {
    expect(isRendererUrl('file:///etc/passwd', entry)).toBe(false);
    expect(isRendererUrl(`file://evil.example${INDEX}`, entry)).toBe(false);
    expect(isRendererUrl('https://attacker.example/', entry)).toBe(false);
    expect(isRendererUrl('about:blank', entry)).toBe(false);
    expect(isRendererUrl('not a url', entry)).toBe(false);
    expect(isRendererUrl(undefined, entry)).toBe(false);
  });

  it('admits a dev server by origin only', () => {
    const dev = 'http://localhost:5173';
    expect(isRendererUrl('http://localhost:5173/', dev)).toBe(true);
    expect(isRendererUrl('http://localhost:5173/src/x.ts', dev)).toBe(true);
    expect(isRendererUrl('http://localhost:5174/', dev)).toBe(false);
    expect(isRendererUrl('https://localhost:5173/', dev)).toBe(false);
  });
});
