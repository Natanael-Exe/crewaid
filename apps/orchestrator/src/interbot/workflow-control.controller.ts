import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common';
import {
  WorkflowControlBodySchema,
  type ListWorkflowsResponse,
  type Principal,
  type StopWorkflowResponse,
  type WorkflowControlBody,
  type WrapUpWorkflowResponse,
} from '@crewaid/shared';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkflowControlService } from './workflow-control.service.js';

/**
 * Chain-scoped workflow control endpoints (`Stop workflow` vs `Wrap up`).
 * Ownership is resolved inside `WorkflowControlService` by `id` AND
 * `principal.userId` before any read or mutation (matching the bot route family).
 */
@Controller('bots')
export class WorkflowControlController {
  constructor(
    @Inject(WorkflowControlService) private readonly workflows: WorkflowControlService,
  ) {}

  @Get(':id/workflows')
  list(
    @Param('id') id: string,
    @CurrentUser() principal: Principal,
  ): Promise<ListWorkflowsResponse> {
    return this.workflows.listWorkflows(principal.userId, id);
  }

  @Post(':id/workflows/stop')
  @HttpCode(HttpStatus.OK)
  stop(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(WorkflowControlBodySchema)) body: WorkflowControlBody,
    @CurrentUser() principal: Principal,
  ): Promise<StopWorkflowResponse> {
    return this.workflows.stopWorkflow(principal.userId, id, body.chainId);
  }

  @Post(':id/workflows/wrap-up')
  @HttpCode(HttpStatus.OK)
  wrapUp(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(WorkflowControlBodySchema)) body: WorkflowControlBody,
    @CurrentUser() principal: Principal,
  ): Promise<WrapUpWorkflowResponse> {
    return this.workflows.wrapUpWorkflow(principal.userId, id, body.chainId);
  }
}
