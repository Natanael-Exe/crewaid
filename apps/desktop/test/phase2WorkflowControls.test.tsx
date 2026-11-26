import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { WorkflowChainSummary } from '@crewaid/shared';
import { WorkflowControls } from '../src/renderer/components/transcript/WorkflowControls';

const botNames = new Map<string, string>([
  ['clx1a2b3c4d5e6f7g8h9i0j1', 'Gideon'],
  ['clx9z8y7x6w5v4u3t2s1r0q9', 'Diana'],
  ['clx4m5n6o7p8q9r0s1t2u3v4', 'Julian'],
]);

function chain(overrides?: Partial<WorkflowChainSummary>): WorkflowChainSummary {
  return {
    chainId: 'chain_launch_1',
    status: 'ACTIVE',
    rootBotId: 'clx1a2b3c4d5e6f7g8h9i0j1',
    groupId: null,
    participantBotIds: ['clx1a2b3c4d5e6f7g8h9i0j1', 'clx9z8y7x6w5v4u3t2s1r0q9'],
    activeBotIds: ['clx9z8y7x6w5v4u3t2s1r0q9'],
    expectedOwners: [],
    respondedOwners: [],
    deadlineAt: null,
    startedAt: '2026-11-25T11:30:00.000Z',
    ...overrides,
  };
}

describe('Phase 2 — WorkflowControls', () => {
  it('renders direct Wrap up and Stop workflow actions for a single active chain', () => {
    const html = renderToStaticMarkup(
      <WorkflowControls
        chains={[chain()]}
        botNameById={botNames}
        onWrapUp={vi.fn()}
        onStopWorkflow={vi.fn()}
      />,
    );

    expect(html).toContain('data-workflow-controls');
    expect(html).toContain('data-wrap-up-workflow');
    expect(html).toContain('Wrap up');
    expect(html).toContain('data-stop-workflow');
    expect(html).toContain('Stop workflow');
  });

  it('shows wrapping-up progress badge while keeping Stop workflow available', () => {
    const html = renderToStaticMarkup(
      <WorkflowControls
        chains={[
          chain({
            status: 'WRAPPING_UP',
            expectedOwners: ['clx9z8y7x6w5v4u3t2s1r0q9', 'clx4m5n6o7p8q9r0s1t2u3v4'],
            respondedOwners: ['clx9z8y7x6w5v4u3t2s1r0q9'],
          }),
        ]}
        botNameById={botNames}
        onWrapUp={vi.fn()}
        onStopWorkflow={vi.fn()}
      />,
    );

    expect(html).not.toContain('data-wrap-up-workflow');
    expect(html).toContain('data-workflow-wrapping-badge');
    expect(html).toContain('Wrapping up (1/2)');
    expect(html).toContain('data-stop-workflow');
  });

  it('renders a chooser trigger when multiple workflows are active', () => {
    const html = renderToStaticMarkup(
      <WorkflowControls
        chains={[chain({ chainId: 'chain_1' }), chain({ chainId: 'chain_2' })]}
        botNameById={botNames}
        onWrapUp={vi.fn()}
        onStopWorkflow={vi.fn()}
      />,
    );

    expect(html).toContain('data-workflow-chooser');
    expect(html).toContain('Workflows (2)');
  });
});
