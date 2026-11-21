import { defineInterrupt } from '@tanstack/ai';
import { ToolApprovalRequestSchema, ToolApprovalAnswerSchema } from '@crewaid/shared';

export const toolApproval = defineInterrupt({
  id: 'crewaid.tool-approval',
  payloadSchema: ToolApprovalRequestSchema,
  responseSchema: ToolApprovalAnswerSchema,
});
