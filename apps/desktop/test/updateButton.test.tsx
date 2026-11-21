import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@heroui/react';
import { UpdateButtonView, updateOffer } from '../src/renderer/components/UpdateButton';
import type { UpdateState } from '../src/preload';

/** M9-FE-01 — the sidebar's update button appears only when there is something to do. */

function render(state: UpdateState) {
  return renderToStaticMarkup(
    <I18nProvider>
      <UpdateButtonView state={state} onPress={() => undefined} />
    </I18nProvider>,
  );
}

describe('the update button', () => {
  it('offers a restart once an update is downloaded', () => {
    const html = render({ status: 'ready', version: '0.0.4' });
    expect(html).toContain('aria-label="Restart to update to v0.0.4"');
  });

  it('offers the download page where the build cannot install updates itself', () => {
    const html = render({ status: 'available', version: '0.0.4' });
    expect(html).toContain('aria-label="Download Crewaid v0.0.4"');
  });

  it('stays out of the way while nothing needs the person', () => {
    // A check, a download under way, a failure: none is something to press.
    expect(render({ status: 'idle' })).toBe('');
    expect(render({ status: 'downloading', version: '0.0.4', percent: 40 })).toBe('');
    expect(updateOffer({ status: 'downloading', version: '0.0.4', percent: 99 })).toBeNull();
  });
});
