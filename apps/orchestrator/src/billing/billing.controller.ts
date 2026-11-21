import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import {
  BillingCheckoutBodySchema,
  type BillingCheckoutBody,
  type BillingRedirectResponse,
  type BillingResponse,
  type Principal,
} from '@crewaid/shared';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { BillingService } from './billing.service.js';

/**
 * REST billing routes. No path ids: every route is about the caller's
 * own account, so the ownership is the `principal.userId` each one passes.
 */
@Controller('billing')
export class BillingController {
  constructor(@Inject(BillingService) private readonly billing: BillingService) {}

  @Get()
  status(@CurrentUser() principal: Principal): Promise<BillingResponse> {
    return this.billing.status(principal.userId);
  }

  @Post('checkout')
  @HttpCode(200)
  checkout(
    @Body(new ZodValidationPipe(BillingCheckoutBodySchema)) body: BillingCheckoutBody,
    @CurrentUser() principal: Principal,
  ): Promise<BillingRedirectResponse> {
    return this.billing.checkout(principal.userId, body.plan);
  }

  @Post('portal')
  @HttpCode(200)
  portal(@CurrentUser() principal: Principal): Promise<BillingRedirectResponse> {
    return this.billing.portal(principal.userId);
  }
}
