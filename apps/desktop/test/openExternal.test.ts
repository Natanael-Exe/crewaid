import { describe, expect, it, vi } from 'vitest';

import { OPEN_EXTERNAL_CHANNEL, openableUrl, registerOpenExternalIpc } from '../src/openExternal';

/**
 * M6-FE-02 — the widest capability in this app, and the fence around it.
 *
 * `shell.openExternal` hands a string to the operating system, which decides
 * what to run. The string reaching it is a THIRD PARTY'S — an MCP server's own
 * OAuth discovery document, by way of the orchestrator (D-101) — so it is
 * exactly the class of input that must not be trusted, and the check has to be
 * on the side of the boundary that holds the capability.
 */

type Handler = (event: unknown, value: unknown) => Promise<unknown>;

function registered(options: { trusted?: boolean; open?: (url: string) => Promise<void> }): {
  invoke: (value: unknown) => Promise<unknown>;
  opened: string[];
} {
  const opened: string[] = [];
  const handlers = new Map<string, Handler>();
  registerOpenExternalIpc({
    ipcMain: {
      handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    } as never,
    isTrustedSender: () => options.trusted ?? true,
    open:
      options.open ??
      (async (url) => {
        opened.push(url);
      }),
  });
  const handler = handlers.get(OPEN_EXTERNAL_CHANNEL);
  if (handler === undefined) throw new Error('the channel was never registered');
  return { invoke: (value) => handler({}, value), opened };
}

describe('M6-FE-02 what this app will hand to the operating system', () => {
  it('opens an https URL, unchanged', () => {
    expect(openableUrl('https://auth.example.com/authorize?state=abc')).toBe(
      'https://auth.example.com/authorize?state=abc',
    );
  });

  it('refuses every scheme that is not https', () => {
    // Each of these is a capability nobody asked for: `file:` opens a file
    // manager, and a registered custom scheme can launch a program.
    for (const value of [
      'http://auth.example.com/authorize',
      'file:///etc/passwd',
      'vbscript:msgbox(1)',
      'javascript:alert(1)',
      'smb://host/share',
      'crewaid://callback',
    ]) {
      expect(openableUrl(value), value).toBeNull();
    }
  });

  it('hands over the URL it judged, not the string it was given', () => {
    // A predicate would leave the caller opening the string it was GIVEN while
    // having checked the string as PARSED, and those differ: the parser trims
    // whitespace, folds the scheme's case, and rewrites `https:/\\host`.
    // Validating one value and handing over another is the shape of every
    // bypass this check exists to prevent.
    expect(openableUrl('  https://ok.test/authorize  ')).toBe('https://ok.test/authorize');
    expect(openableUrl('HTTPS://ok.test/authorize')).toBe('https://ok.test/authorize');
    expect(openableUrl('https:/\\evil.test')).toBe('https://evil.test/');
  });

  it('refuses credentials in the authority, rather than stripping them', () => {
    // A phishing shape — the eye reads `accounts.google.com` and the browser
    // goes to `evil.test` — and no authorize URL has them. Rewriting a URL
    // somebody is about to be sent to is worse than declining to send them.
    expect(openableUrl('https://accounts.google.com@evil.test/')).toBeNull();
    expect(openableUrl('https://user:pw@evil.test/')).toBeNull();
  });

  it('refuses anything that is not a string', () => {
    for (const value of [undefined, null, 42, {}, ['https://ok.test']]) {
      expect(openableUrl(value)).toBeNull();
    }
  });
});

describe('M6-FE-02 the channel', () => {
  it('opens a URL it admits, and says so', async () => {
    const { invoke, opened } = registered({});

    await expect(invoke('  https://auth.example.com/authorize  ')).resolves.toEqual({
      status: 'opened',
    });
    // The NORMALIZED url reached the OS — the one the check judged.
    expect(opened).toEqual(['https://auth.example.com/authorize']);
  });

  it('refuses a URL without asking the operating system', async () => {
    const { invoke, opened } = registered({});

    await expect(invoke('file:///etc/passwd')).resolves.toEqual({ status: 'refused' });
    // The assertion that matters: nothing was handed over, so the refusal is
    // a decision rather than a label on something that already happened.
    expect(opened).toEqual([]);
  });

  it('answers an untrusted sender the same way it answers a failure', async () => {
    // Deliberately indistinguishable. The second is something an operator can
    // act on (open it by hand); the first must not be tellable from it by
    // anything probing this channel.
    const untrusted = registered({ trusted: false });
    await expect(untrusted.invoke('https://auth.example.com/authorize')).resolves.toEqual({
      status: 'failed',
    });
    expect(untrusted.opened).toEqual([]);

    const broken = registered({
      open: () => Promise.reject(new Error('no browser on this machine')),
    });
    await expect(broken.invoke('https://auth.example.com/authorize')).resolves.toEqual({
      status: 'failed',
    });
  });

  it('never lets a platform error cross the preload boundary', async () => {
    // `guardedIpc`'s rule, asserted here because this channel's handler is the
    // first one that can throw for a reason the renderer might be tempted to
    // render.
    const thrown = vi.fn(() => {
      throw new Error('EPERM: the sandbox said no');
    });
    const { invoke } = registered({ open: thrown as never });

    const result = await invoke('https://auth.example.com/authorize');

    expect(result).toEqual({ status: 'failed' });
    expect(JSON.stringify(result)).not.toContain('EPERM');
  });
});
