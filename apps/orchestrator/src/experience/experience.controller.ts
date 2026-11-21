import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import {
  OnboardingBootstrapBodySchema,
  TemplateInstallBodySchema,
  UpdateOnboardingBodySchema,
  type OnboardingBootstrapBody,
  type Principal,
  type TemplateInstallBody,
  type UpdateOnboardingBody,
} from '@crewaid/shared';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { OnboardingService } from './onboarding.service.js';
import { TemplateService } from './template.service.js';

@Controller('onboarding')
export class OnboardingController {
  constructor(@Inject(OnboardingService) private readonly onboarding: OnboardingService) {}
  @Post('bootstrap')
  @HttpCode(200)
  bootstrap(
    @CurrentUser() principal: Principal,
    // Optional: a client that sends nothing is greeted in what the account knows.
    @Body(new ZodValidationPipe(OnboardingBootstrapBodySchema.optional()))
    body: OnboardingBootstrapBody | undefined,
  ) {
    return this.onboarding.bootstrap(principal.userId, body ?? {});
  }
  @Get() read(@CurrentUser() principal: Principal) {
    return this.onboarding.read(principal.userId);
  }
  @Patch() update(
    @CurrentUser() principal: Principal,
    @Body(new ZodValidationPipe(UpdateOnboardingBodySchema)) body: UpdateOnboardingBody,
  ) {
    return this.onboarding.update(principal.userId, body);
  }
}
@Controller('templates')
export class TemplatesController {
  constructor(@Inject(TemplateService) private readonly templates: TemplateService) {}
  @Get() async list(@CurrentUser() principal: Principal, @Query('q') query?: string) {
    return this.templates.list(query ?? '', await this.templates.languageOf(principal.userId));
  }
  @Get(':id') async read(@CurrentUser() principal: Principal, @Param('id') id: string) {
    const language = await this.templates.languageOf(principal.userId);
    return this.templates.readForUser(principal.userId, id, language);
  }
}
@Controller('template-installations')
export class TemplateInstallationsController {
  constructor(@Inject(TemplateService) private readonly templates: TemplateService) {}
  @Post() async install(
    @CurrentUser() principal: Principal,
    @Body(new ZodValidationPipe(TemplateInstallBodySchema)) body: TemplateInstallBody,
  ) {
    const language = await this.templates.languageOf(principal.userId);
    return this.templates.install(principal.userId, body, language);
  }
}
