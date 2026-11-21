import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@heroui/react';
import type { ComputerSnapshotStatusResponse } from '@crewaid/shared';
import { ComputerView } from '../src/renderer/settings/ComputerPane';
import { settingsPane } from '../src/renderer/settings/settingsPanes';

/** D-237 — every snapshot state, rendered without a server. */
function render(status: ComputerSnapshotStatusResponse | null, problem: string | null = null) {
  return renderToStaticMarkup(
    <I18nProvider>
      <ComputerView
        status={status}
        problem={problem}
        busy={false}
        onSave={() => undefined}
        onRestore={() => undefined}
      />
    </I18nProvider>,
  );
}

const SAVED: ComputerSnapshotStatusResponse = {
  supported: true,
  snapshot: { takenAt: '2026-11-19T10:00:00.000Z', sizeBytes: 3 * 1024 ** 3, expiresAt: null },
  activity: null,
  lastError: null,
};

describe('Computer pane (D-237)', () => {
  it('is a live pane now, not a promise', () => {
    expect(settingsPane('computer').status).toBe('ready');
  });

  it('offers a first save, and nothing to restore, before any snapshot exists', () => {
    const html = render({ ...SAVED, snapshot: null });
    expect(html).toContain('No snapshot yet');
    expect(html).toContain('Save snapshot');
    expect(html).not.toContain('Restore…');
  });

  it('says when the snapshot was taken and how large it is, and offers both actions', () => {
    const html = render(SAVED);
    expect(html).toContain('Snapshot saved');
    expect(html).toMatch(/Taken .*3 GB/);
    expect(html).toContain('Save snapshot');
    expect(html).toContain('Restore…');
  });

  it('shows the work in flight instead of the buttons', () => {
    const saving = render({ ...SAVED, activity: 'SAVING' });
    expect(saving).toContain('Saving…');
    expect(saving).not.toContain('Save snapshot');
    expect(render({ ...SAVED, activity: 'RESTORING' })).toContain('Restoring…');
  });

  it('words a failure itself rather than showing the server’s', () => {
    expect(render({ ...SAVED, lastError: 'SAVE_FAILED' })).toContain(
      'The last snapshot could not be saved.',
    );
    expect(render({ ...SAVED, lastError: 'RESTORE_FAILED' })).toContain(
      'The snapshot could not be restored.',
    );
  });

  it('says plainly when this server cannot snapshot its computers', () => {
    const html = render({ supported: false, snapshot: null, activity: null, lastError: null });
    expect(html).toContain('Snapshots are not available');
    expect(html).not.toContain('Save snapshot');
  });

  it('shows a load failure in place of the section', () => {
    expect(render(null, 'Nothing answered.')).toContain('Nothing answered.');
    expect(render(null)).toContain('aria-busy="true"');
  });
});
