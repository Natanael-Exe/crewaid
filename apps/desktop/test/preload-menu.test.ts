import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  on: vi.fn(),
  expose: vi.fn(),
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: { on: mocks.on },
}));

describe('New Bot before the app is ready', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('preserves the menu request until the app subscribes, then consumes it once', async () => {
    await import('../src/preload.js');
    const receive = mocks.on.mock.calls.find(([channel]) => channel === 'crewaid:menu:new-bot')![1];
    const api = mocks.expose.mock.calls[0]![1];
    receive();
    const open = vi.fn();
    const unsubscribe = api.menu.onNewBot(open);
    expect(open).toHaveBeenCalledTimes(1);
    receive();
    expect(open).toHaveBeenCalledTimes(2);
    unsubscribe();
    receive();
    expect(open).toHaveBeenCalledTimes(2);
    const remounted = vi.fn();
    api.menu.onNewBot(remounted);
    expect(remounted).toHaveBeenCalledTimes(1);
  });
});
