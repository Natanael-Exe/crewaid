import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ServerVersionNote } from '../src/renderer/settings/GeneralPane';
import { fetchServerVersion, serverIsOlder } from '../src/renderer/settings/serverVersion';

/** D-155 — a self-hosted app notices when its server is an older release. */

describe('serverIsOlder', () => {
  it('compares releases numerically, not as text', () => {
    expect(serverIsOlder('0.0.3', '0.0.4')).toBe(true);
    expect(serverIsOlder('0.9.0', '0.10.0')).toBe(true);
    expect(serverIsOlder('0.10.0', '0.9.0')).toBe(false);
    expect(serverIsOlder('0.1.0', '0.1.0')).toBe(false);
  });

  it('never claims "older" about something that is not a plain release', () => {
    expect(serverIsOlder('dev', '0.1.0')).toBe(false);
    expect(serverIsOlder('0.1.0', 'dev')).toBe(false);
    expect(serverIsOlder('0.1.0-rc.1', '0.1.0')).toBe(false);
  });
});

describe('ServerVersionNote', () => {
  it('shows the version, and how to update when the server is behind', () => {
    const behind = renderToStaticMarkup(<ServerVersionNote server="0.0.3" app="0.0.5" />);
    expect(behind).toContain('Server version 0.0.3');
    expect(behind).toContain('npx crewaid-selfhost update');
  });

  it('stays quiet when the server is current, or the app version is unknown', () => {
    // Asserted against the version line, so the absence cannot pass by
    // rendering nothing.
    const current = renderToStaticMarkup(<ServerVersionNote server="0.0.5" app="0.0.5" />);
    expect(current).toContain('Server version 0.0.5');
    expect(current).not.toContain('crewaid-selfhost update');
    expect(renderToStaticMarkup(<ServerVersionNote server="0.0.3" app={null} />)).not.toContain(
      'crewaid-selfhost update',
    );
  });
});

describe('fetchServerVersion', () => {
  afterEach(() => vi.unstubAllGlobals());

  const health = {
    status: 'ok',
    version: '0.0.4',
    edition: 'selfhosted',
    db: true,
    redis: true,
    docker: true,
    sandboxes: [],
  };

  it('reads the version from GET /health', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(health)));
    vi.stubGlobal('fetch', fetch);
    await expect(fetchServerVersion('http://localhost:3000/')).resolves.toBe('0.0.4');
    expect(fetch).toHaveBeenCalledWith('http://localhost:3000/health');
  });

  it('answers null for an older server, an error, or no answer at all', async () => {
    const { version: _version, ...withoutVersion } = health;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(withoutVersion))));
    await expect(fetchServerVersion('http://x')).resolves.toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
    await expect(fetchServerVersion('http://x')).resolves.toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(fetchServerVersion('http://x')).resolves.toBeNull();
  });
});
