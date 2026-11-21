import { EventEmitter } from 'node:events';
import type { Browser } from 'playwright-core';

/** Policy/identity fixtures mock the library port; live Chrome suites test the driver. */
export function fakePlaywrightBrowser(onNavigate: (url: string) => void): Browser {
  let url = 'about:blank';
  let connected = true;
  const browser = new EventEmitter();
  const page = Object.assign(new EventEmitter(), {
    isClosed: () => false,
    url: () => url,
    goto: async (target: string) => {
      url = target;
      onNavigate(target);
      page.emit('framenavigated');
      return null;
    },
    ariaSnapshot: async () => '- heading "Fixture" [ref=e1]',
  });
  const context = Object.assign(new EventEmitter(), {
    pages: () => [page],
    newCDPSession: async () => ({ send: async () => ({}), detach: async () => undefined }),
  });
  return Object.assign(browser, {
    contexts: () => [context],
    isConnected: () => connected,
    close: async () => {
      connected = false;
      browser.emit('disconnected');
    },
  }) as unknown as Browser;
}
