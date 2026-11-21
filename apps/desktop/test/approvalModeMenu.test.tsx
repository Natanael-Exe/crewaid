import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  APPROVAL_MODES,
  ApprovalModeMenu,
  approvalModeOption,
} from '../src/renderer/components/composer/ApprovalModeMenu';

/** D-144 — the composer's approval control: one icon, three modes. */

describe('the approval control', () => {
  it('offers the three modes, least trusting first', () => {
    expect(APPROVAL_MODES.map((mode) => [mode.id, mode.label])).toEqual([
      ['ASK', 'Ask for approval'],
      ['AUTO', 'Approve for me'],
      ['FULL', 'Full access'],
    ]);
  });

  it('is an icon that names the current mode, and warns for Full access', () => {
    const auto = renderToStaticMarkup(<ApprovalModeMenu botId="b1" mode="AUTO" />);
    expect(auto).toContain('aria-label="Approvals: Approve for me"');
    expect(auto).toContain('data-approval-mode="AUTO"');
    expect(auto).not.toContain('text-warning');

    const full = renderToStaticMarkup(<ApprovalModeMenu botId="b1" mode="FULL" />);
    expect(full).toContain('aria-label="Approvals: Full access"');
    expect(full).toContain('text-warning');
  });

  it('reads an unknown mode from an older server as Approve for me', () => {
    expect(approvalModeOption('SOMETHING' as never).id).toBe('AUTO');
  });
});
