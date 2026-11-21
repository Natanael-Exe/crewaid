import { describe, expect, it } from 'vitest';
import { previewTools } from '../src/agent/preview-tools.js';
import { OBSERVING_BUILTIN } from '../src/agent/tool-registry.js';

describe('email preview without external execution', () => {
  it('can present a validated draft without acquiring any turn resources', async () => {
    const entry = previewTools()[0]!;
    expect(entry.behavior).toBe(OBSERVING_BUILTIN);
    // The builder has no dependency on a mailbox, machine, database or turn context.
    const definition = entry.build({} as Parameters<typeof entry.build>[0]);
    expect(
      await definition.execute!(
        { to: 'alex@example.test', subject: 'Update', body: 'Hello Alex' },
        { toolCallId: 'p1', messages: [] },
      ),
    ).toBe('Email preview shown in chat. Not saved or sent.');
    await expect(
      definition.execute!(
        { to: 'alex', subject: 'Update', body: '' },
        { toolCallId: 'p2', messages: [] },
      ),
    ).rejects.toThrow();
  });
});
