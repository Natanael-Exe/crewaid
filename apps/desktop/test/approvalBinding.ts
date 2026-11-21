import type { ApprovalBinding } from '@crewaid/shared';
export const approvalBinding = (toolName = 'shell'): ApprovalBinding => ({
  toolName,
  effect: 'unknown',
  scope: 'call',
  argsHash: 'a'.repeat(64),
  grantRevision: 'b'.repeat(64),
  resourceRevision: null,
  seat: null,
  commit: null,
});
