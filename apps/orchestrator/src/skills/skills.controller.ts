import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ListSkillsQuerySchema,
  ReviseSkillBodySchema,
  RunSkillBodySchema,
  UpdateSkillBodySchema,
  type ListSkillsQuery,
  type Principal,
  type ReviseSkillBody,
  type RunSkillBody,
  type UpdateSkillBody,
} from '@crewaid/shared';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { OwnedResource } from '../ownership/owned-resource.decorator.js';
import { SkillReviseService } from './skill-revise.service.js';
import { SkillRunService } from './skill-run.service.js';
import { SkillsService } from './skills.service.js';

/**
 * REST skills routes — the wire the review surface reads, edits and
 * approves against.
 *
 * Every direct-by-id route is fenced by `@OwnedResource`: `skill` for
 * the skill-shaped ones, and `skillRun` on the run route, whose ownership
 * rides the run's skill. Each service scopes its own lookups by `userId` as
 * well — the guard closes the route, R7 closes the query, and neither is
 * load-bearing on the other.
 *
 * What the codes say
 *
 * - `PATCH` and `approve` answer 200 with the row the caller should now be
 * holding: for PATCH that is the NEW version row (a new id — the client
 * switches to it), for approve the same row, APPROVED.
 * - `run` answers 201, like `POST /bots/:id/recordings` and for the same
 * reason: the response carries the id of a `SkillRun` row that exists.
 * The execution is asynchronous — the client polls the run route.
 * - A `DRAFT` skill's run is a 409: the POST is well-formed and the state
 * is the reason it cannot proceed, and the message is the sentence §6
 * asks for ("only an APPROVED skill can be run").
 */
@Controller('skills')
export class SkillsController {
  constructor(
    @Inject(SkillsService) private readonly skills: SkillsService,
    @Inject(SkillReviseService) private readonly revise: SkillReviseService,
    @Inject(SkillRunService) private readonly runs: SkillRunService,
  ) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(ListSkillsQuerySchema)) query: ListSkillsQuery,
    @CurrentUser() principal: Principal,
  ) {
    return this.skills.list(principal.userId, query);
  }

  @Get(':id')
  @OwnedResource('skill')
  get(@Param('id') id: string, @CurrentUser() principal: Principal) {
    return this.skills.get(principal.userId, id);
  }

  @Patch(':id')
  @OwnedResource('skill')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateSkillBodySchema)) body: UpdateSkillBody,
    @CurrentUser() principal: Principal,
  ) {
    return this.skills.update(principal.userId, id, body);
  }

  /**
   * `DELETE /skills/:id` — discard a DRAFT.
   *
   * 204, like `DELETE /bots/:id`: there is nothing left to describe, and the
   * client already holds the only fact worth returning (the id it sent). A
   * 409 for anything that is not a draft — an approved version's runs point at
   * the row, and the version history is what M3-BE-09 promises to keep.
   */
  @Delete(':id')
  @OwnedResource('skill')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @CurrentUser() principal: Principal): Promise<void> {
    await this.skills.remove(principal.userId, id);
  }

  /**
   * `POST /skills/:id/revise` — a plain-language edit, compiled.
   *
   * Answers 200 with the NEW version row, exactly like `PATCH`: the request
   * changed one skill and the response is what the client should hold now.
   * The body of the request is a sentence, never a script — the script is the
   * compiler's to write, and this route is the one that keeps a person out of
   * it.
   */
  @Post(':id/revise')
  @OwnedResource('skill')
  @HttpCode(HttpStatus.OK)
  reviseSkill(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ReviseSkillBodySchema)) body: ReviseSkillBody,
    @CurrentUser() principal: Principal,
  ) {
    return this.revise.revise(principal.userId, id, body.instruction);
  }

  @Post(':id/approve')
  @OwnedResource('skill')
  @HttpCode(HttpStatus.OK)
  approve(@Param('id') id: string, @CurrentUser() principal: Principal) {
    return this.skills.approve(principal.userId, id);
  }

  @Post(':id/run')
  @OwnedResource('skill')
  @HttpCode(HttpStatus.CREATED)
  run(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RunSkillBodySchema)) body: RunSkillBody,
    @CurrentUser() principal: Principal,
  ) {
    return this.runs.start(principal.userId, id, body.params);
  }

  @Get(':id/runs/:runId')
  @OwnedResource('skillRun', 'runId')
  runStatus(
    @Param('id') id: string,
    @Param('runId') runId: string,
    @CurrentUser() principal: Principal,
  ) {
    return this.runs.status(principal.userId, id, runId);
  }
}
