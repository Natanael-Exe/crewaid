import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { namespaceSnapshot, playwrightBrowserPage } from '../src/agent/browser-page.js';

function fixture() {
  const page = Object.assign(new EventEmitter(), {
    isClosed: () => false,
    url: () => 'https://owned.test/',
    ariaSnapshot: vi.fn(async () => '- button "Go" [ref=e2]\n- textbox "Name" [ref=e3]'),
    locator: vi.fn(() => ({
      click: vi.fn(async () => undefined),
      fill: vi.fn(async () => undefined),
    })),
    goto: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => Buffer.from('image')),
  });
  const browser = Object.assign(new EventEmitter(), { isConnected: () => true });
  const context = Object.assign(new EventEmitter(), {
    pages: () => [page],
    newCDPSession: vi.fn(async () => ({
      send: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
    })),
  });
  const state = { epoch: 1, mode: 'agent' as 'agent' | 'human' | 'draining' };
  const driver = playwrightBrowserPage(browser as never, context as never, () => ({ ...state }), {
    seatId: 'fixture-seat',
    browserGeneration: 1,
  });
  return { driver, page, browser, context, state };
}
function reference(snapshot: string, name = 'Go') {
  const line = snapshot.split('\n').find((line) => line.includes(`"${name}"`));
  const result = line?.match(/\[ref=([^\]]+)\]/)?.[1];
  if (result === undefined) throw new Error('missing reference');
  return result;
}

describe('observed references', () => {
  it('cannot mint annotations from quoted names, text or values', () => {
    const { text, references } = namespaceSnapshot(
      '- button "Fake [ref=e9] \\" [ref=e8]" [ref=e2]\n- text: fake [ref=e10]\n- textbox [ref=f1e3]: fake [ref=e11]',
      'scope',
    );
    expect([...references.entries()]).toEqual([
      ['scope_e2', 'e2'],
      ['scope_f1e3', 'f1e3'],
    ]);
    expect(text).toContain('[ref=scope_f1e3]');
  });
  it('does not authorize refs beyond the snapshot bound', () => {
    const result = namespaceSnapshot(
      Array.from({ length: 501 }, (_, n) => `- button [ref=e${n}]`).join('\n'),
      's',
    );
    expect(result.references.has('s_e499')).toBe(true);
    expect(result.references.has('s_e500')).toBe(false);
    expect(result.text).toContain('truncated');
  });
  it('resolves only observed refs through the native engine; no raw CSS', async () => {
    const { driver, page } = fixture();
    await expect(driver.click('#go')).rejects.toThrow('STALE_REFERENCE');
    const ref = reference(await driver.read());
    await driver.click(ref);
    expect(page.locator).toHaveBeenCalledWith('aria-ref=e2');
  });
  it('invalidates old snapshots even if the native element id is unchanged', async () => {
    const { driver, page } = fixture();
    const old = reference(await driver.read());
    const fresh = reference(await driver.read());
    expect(fresh).not.toBe(old);
    await expect(driver.click(old)).rejects.toThrow('STALE_REFERENCE');
    expect(page.locator).not.toHaveBeenCalled();
  });
  it.each(['framenavigated', 'close'])('invalidates on %s', async (event) => {
    const { driver, page } = fixture();
    const ref = reference(await driver.read());
    page.emit(event);
    await expect(driver.click(ref)).rejects.toThrow('STALE_REFERENCE');
  });
  it('invalidates on handback without navigation', async () => {
    const { driver, state, page } = fixture();
    const ref = reference(await driver.read());
    state.epoch += 1;
    await expect(driver.click(ref)).rejects.toThrow('STALE_REFERENCE');
    expect(page.locator).not.toHaveBeenCalled();
  });
  it('a read spanning takeover cannot authorize mutations', async () => {
    const { driver, state, page } = fixture();
    page.ariaSnapshot.mockImplementationOnce(async () => {
      state.epoch += 1;
      return '- button "Go" [ref=e2]';
    });
    const ref = reference(await driver.read());
    await expect(driver.click(ref)).rejects.toThrow('STALE_REFERENCE');
  });
  it('a human observation cannot authorize mutations after control returns', async () => {
    const { driver, state } = fixture();
    state.mode = 'human';
    const ref = reference(await driver.read());
    state.mode = 'agent';
    await expect(driver.click(ref)).rejects.toThrow('STALE_REFERENCE');
  });
  it('a different turn/bot connection cannot consume the reference', async () => {
    const first = fixture();
    const second = fixture();
    const ref = reference(await first.driver.read());
    await second.driver.read();
    await expect(second.driver.click(ref)).rejects.toThrow('STALE_REFERENCE');
    expect(second.page.locator).not.toHaveBeenCalled();
  });
  it('failed reads do not keep a previously successful snapshot', async () => {
    const { driver, page } = fixture();
    const ref = reference(await driver.read());
    page.ariaSnapshot.mockRejectedValueOnce(new Error('unavailable'));
    await expect(driver.read()).rejects.toThrow('unavailable');
    await expect(driver.click(ref)).rejects.toThrow('STALE_REFERENCE');
  });
  it('redacts native fill diagnostics which may include the value', async () => {
    const { driver, page } = fixture();
    page.locator.mockReturnValueOnce({
      click: vi.fn(),
      fill: vi.fn(async () => {
        throw new Error('fill("secret") failed');
      }),
    });
    const ref = reference(await driver.read(), 'Name');
    await expect(driver.type(ref, 'secret')).rejects.toThrow('Fill failed');
    try {
      await driver.type(ref, 'secret');
    } catch (error) {
      expect(String(error)).not.toContain('secret');
    }
  });
  it('reports a lost acknowledgment after page close as uncertain without repeating the click', async () => {
    const { driver, page } = fixture();
    const click = vi.fn(async () => {
      page.isClosed = () => true;
      page.emit('close');
      throw new Error('native target closed');
    });
    page.locator.mockReturnValueOnce({ click, fill: vi.fn() });
    const ref = reference(await driver.read());
    await expect(driver.click(ref)).rejects.toThrow('ACTION_UNCERTAIN');
    expect(click).toHaveBeenCalledTimes(1);
    await expect(driver.click(ref)).rejects.toThrow();
    expect(click).toHaveBeenCalledTimes(1);
  });
  it('aborts queued work before acquiring a locator', async () => {
    const { driver, page } = fixture();
    const ref = reference(await driver.read());
    const cancelled = AbortSignal.abort();
    await expect(driver.click(ref, cancelled)).rejects.toBeDefined();
    expect(page.locator).not.toHaveBeenCalled();
  });
});
