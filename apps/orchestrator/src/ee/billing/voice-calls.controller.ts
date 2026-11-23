import { Body, Controller, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import {
  UpdateCallBodySchema,
  type CallAllowanceResponse,
  type Principal,
  type StartCallResponse,
  type UpdateCallBody,
  type VoiceCallResponse,
} from '@crewaid/shared';
import { CurrentUser } from '../../auth/current-user.decorator.js';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { OwnedResource } from '../../ownership/owned-resource.decorator.js';
import { VoiceCallsService } from './voice-calls.service.js';

/**
 * Calls with a bot. Registered with `BillingModule`, and only when the
 * voice agent is configured, so a self-hosted server has none of these routes.
 */
@Controller()
export class VoiceCallsController {
  constructor(@Inject(VoiceCallsService) private readonly calls: VoiceCallsService) {}

  @Post('bots/:id/calls')
  @OwnedResource('bot', 'id')
  start(
    @Param('id') botId: string,
    @CurrentUser() principal: Principal,
  ): Promise<StartCallResponse> {
    return this.calls.start(principal.userId, botId);
  }

  @Patch('calls/:callId')
  @OwnedResource('voiceCall', 'callId')
  async update(
    @Param('callId') callId: string,
    @Body(new ZodValidationPipe(UpdateCallBodySchema)) body: UpdateCallBody,
    @CurrentUser() principal: Principal,
  ): Promise<VoiceCallResponse> {
    return { call: await this.calls.update(principal.userId, callId, body) };
  }

  @Get('calls/allowance')
  allowance(@CurrentUser() principal: Principal): Promise<CallAllowanceResponse> {
    return this.calls.allowance(principal.userId);
  }
}
