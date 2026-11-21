import { expect, it } from 'vitest';
import { ToolApprovalAnswerSchema } from '@crewaid/shared';
it('keeps approval answers strict without any frontend tool execution definitions', () => {
  expect(
    ToolApprovalAnswerSchema.safeParse({ approved: true, editedArgs: { command: 'pwd' } }).success,
  ).toBe(true);
  expect(
    ToolApprovalAnswerSchema.safeParse({ approved: true, grantRevision: 'forged' }).success,
  ).toBe(false);
});
