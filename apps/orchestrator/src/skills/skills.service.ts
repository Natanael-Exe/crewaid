import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import {
  JsonSchemaObjectSchema,
  SkillStepsSchema,
  type ListSkillsQuery,
  type UpdateSkillBody,
} from '@crewaid/shared';

import { PrismaService } from '../prisma/prisma.service.js';

/**
 * The review surface's read and edit routes.
 *
 * Why a skill is a row per version
 *
 * §3 keys skills `[botId, name, version]`, and M3's acceptance criteria say
 * "editing and saving a script bumps `version` and keeps the previous version
 * queryable" — a single row cannot satisfy both halves, which is exactly what
 * D-009's dropped `sourceRecordingId @unique` was for. So PATCH does not
 * mutate the row it was given: it writes the NEXT version as a new row and
 * leaves the old one untouched and fetchable by its own id. The response is
 * the new row, and the client switches to its id.
 *
 * Why an edit comes back draft
 *
 * Approval is per version, never inherited. An edit produces bytes nobody has
 * reviewed in that exact form — the rule the compile path already follows
 * ("nothing model-generated may run unreviewed", §7.3) — so the new version
 * starts DRAFT and must be approved again before it can run. The previous
 * version keeps whatever status it had: an approved v1 remains runnable by id
 * while its successor is being drafted.
 *
 * R7/D-010 discipline as `BotsService`: every query carries the caller's
 * `userId`, and a 404 deliberately does not distinguish "absent" from "not
 * yours". The `@OwnedResource('skill')` markers on the controller are a second
 * fence in front of this one, not a replacement for it.
 */
@Injectable()
export class SkillsService {
  // Explicit tokens: vitest/esbuild emits no design:paramtypes, so type-based
  // DI resolution silently fails in the integration suite.
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * The latest version of each skill name (M3-BE-09's list contract).
   *
   * `distinct` is the SQL-side dedupe: ordering by [botId, name, version desc]
   * and keeping the first row per [botId, name] is "the newest version of each
   * skill", which is the row a reviewer acts on. Older versions stay
   * queryable by id — they are just not what a list render should offer to
   * edit. The remaining sort is newest-first, so the thing someone just
   * recorded is at the top of the review queue.
   */
  async list(userId: string, query: ListSkillsQuery) {
    const rows = await this.prisma.skill.findMany({
      where: {
        bot: { userId },
        ...(query.botId === undefined ? {} : { botId: query.botId }),
      },
      orderBy: [{ botId: 'asc' }, { name: 'asc' }, { version: 'desc' }],
      distinct: ['botId', 'name'],
      select: {
        id: true,
        botId: true,
        name: true,
        description: true,
        paramsSchema: true,
        // The summary is list surface too — the one thing a reviewer
        // reads before deciding which version to open.
        steps: true,
        version: true,
        status: true,
        sourceRecordingId: true,
        createdAt: true,
      },
    });
    return rows.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  }

  /** One version, source included — REST "includes script source". */
  async get(userId: string, id: string) {
    const skill = await this.findOwned(userId, id);
    if (skill === null) throw new NotFoundException('Skill not found');
    return skill;
  }

  /**
   * Save an edit as the next version.
   *
   * The next version number is the next FREE one for `[botId, name]`, not
   * `current.version + 1`: editing an older version of a skill that already
   * has newer ones must not collide with a version that exists, and monotonic
   * numbering is what the compile path already takes ("the shape the
   * constraint describes"). `name` and `botId` are not editable — a PATCH is
   * an edit of this skill, not a rename into a different key.
   */
  async update(userId: string, id: string, body: UpdateSkillBody) {
    return await this.prisma.$transaction(async (tx) => {
      const current = await tx.skill.findFirst({ where: { id, bot: { userId } } });
      if (current === null) throw new NotFoundException('Skill not found');

      const latest = await tx.skill.findFirst({
        // `bot: { userId }` is redundant against the botId — and stays: the
        // fence belongs in the query, not in a reviewer remembering that the
        // read above resolved the row through the caller's ownership.
        where: { botId: current.botId, name: current.name, bot: { userId } },
        orderBy: { version: 'desc' },
        select: { version: true },
      });

      return await tx.skill.create({
        data: {
          botId: current.botId,
          name: current.name,
          description: body.description ?? current.description,
          paramsSchema: body.paramsSchema ?? carriedParamsSchema(current.paramsSchema),
          // The summary is carried forward like `paramsSchema` — it
          // describes what the skill was recorded doing, and a PATCH of the
          // script does not restate it. A revise is the edit that does.
          steps: carriedSteps(current.steps),
          script: body.script ?? current.script,
          version: (latest?.version ?? current.version) + 1,
          // See the class comment: approval is per version and an edit is
          // unreviewed bytes, so the successor starts DRAFT.
          status: 'DRAFT',
          sourceRecordingId: current.sourceRecordingId,
        },
      });
    });
  }

  /**
   * `DELETE /skills/:id` — throw a draft away.
   *
   * DRAFT only, and a 409 otherwise rather than a quieter fallback. A draft
   * was never runnable (§6: only an APPROVED skill can run), so no run
   * references the row and deleting it leaves nothing dangling — while an
   * APPROVED version's runs point at it, and M3-BE-09's versioning promise
   * ("the previous version stays queryable") is exactly what a delete must
   * not punch a hole in. The compare-and-set mirrors `approve`: `deleteMany`
   * counts, so a row that moved between the read and the write answers 409
   * with what it found instead of a 500 from a vanished row.
   */
  async remove(userId: string, id: string): Promise<void> {
    const skill = await this.findOwned(userId, id);
    if (skill === null) throw new NotFoundException('Skill not found');
    if (skill.status !== 'DRAFT') {
      throw new ConflictException(
        `skill "${skill.name}" is ${skill.status}, and only a DRAFT skill can be deleted`,
      );
    }

    const deleted = await this.prisma.skill.deleteMany({
      where: { id, status: 'DRAFT', bot: { userId } },
    });
    if (deleted.count === 0) {
      const now = await this.findOwned(userId, id);
      if (now === null) throw new NotFoundException('Skill not found');
      throw new ConflictException(
        `skill "${now.name}" is ${now.status}, and only a DRAFT skill can be deleted`,
      );
    }
  }

  /**
   * `DRAFT → APPROVED`.
   *
   * Idempotent when the row is already APPROVED — a double-clicked Approve
   * button gets the same row back rather than an error about a state the
   * client is looking at. ARCHIVED is refused: v1 has no un-archive route, so
   * approving one would resurrect it through the back door.
   *
   * The compare-and-set is pinned to DRAFT, so the one transition this route
   * owns cannot overwrite a decision that landed first; whatever it finds when
   * it loses that race decides the answer.
   */
  async approve(userId: string, id: string) {
    const skill = await this.findOwned(userId, id);
    if (skill === null) throw new NotFoundException('Skill not found');
    if (skill.status === 'APPROVED') return skill;
    if (skill.status === 'ARCHIVED') {
      throw new ConflictException(
        `skill "${skill.name}" is ARCHIVED, and an archived skill cannot be approved`,
      );
    }

    const flipped = await this.prisma.skill.updateMany({
      where: { id, status: 'DRAFT', bot: { userId } },
      data: { status: 'APPROVED' },
    });
    if (flipped.count === 0) {
      const now = await this.findOwned(userId, id);
      if (now === null) throw new NotFoundException('Skill not found');
      if (now.status === 'APPROVED') return now;
      throw new ConflictException(
        `skill "${now.name}" is ${now.status}, so there is nothing to approve`,
      );
    }

    const approved = await this.findOwned(userId, id);
    if (approved === null) throw new NotFoundException('Skill not found');
    return approved;
  }

  /**
   * `save_skill`'s write half — a skill the BOT authored, landing APPROVED.
   *
   * The row-per-version discipline is the same as PATCH's: an existing name
   * gets the next free version, and the previous versions stay queryable. The
   * difference is the STATUS. An edit through the review surface starts DRAFT
   * because nobody has seen those bytes; here the operator has — `save_skill`
   * is `sensitive`, and the approval prompt carried the whole script, so the
   * approval of the call is the review §7.3 demands. Writing DRAFT would
   * strand that review inside an args blob and block the reuse the tool is
   * for; the review surface's own flow is unchanged.
   *
   * The write is fenced by the bot row first: a bot id the model invented (or
   * a sibling's, guessed) resolves to nothing under the caller's ownership,
   * and the skill then cannot exist unowned — its `botId` points at a row the
   * caller demonstrably owns.
   */
  async saveBotSkill(input: {
    userId: string;
    botId: string;
    name: string;
    description: string;
    script: string;
    paramsSchema: Record<string, unknown>;
  }): Promise<{ id: string; name: string; version: number; created: boolean }> {
    // The same narrow `carriedParamsSchema` uses: Prisma's Json write input
    // does not admit the wide `Record<string, unknown>`, and re-validating
    // through the shared schema ESTABLISHES the shape rather than casting it.
    const paramsSchema = JsonSchemaObjectSchema.safeParse(input.paramsSchema);
    if (!paramsSchema.success) {
      throw new BadRequestException('paramsSchema is not a JSON Schema object');
    }
    return this.prisma.$transaction(async (tx) => {
      const bot = await tx.bot.findFirst({
        where: { id: input.botId, userId: input.userId },
        select: { id: true },
      });
      if (bot === null) throw new NotFoundException('Bot not found');

      const latest = await tx.skill.findFirst({
        where: { botId: input.botId, name: input.name, bot: { userId: input.userId } },
        orderBy: { version: 'desc' },
        select: { version: true },
      });

      const created = await tx.skill.create({
        data: {
          botId: input.botId,
          name: input.name,
          description: input.description,
          paramsSchema: paramsSchema.data,
          script: input.script,
          version: (latest?.version ?? 0) + 1,
          status: 'APPROVED',
        },
      });
      return {
        id: created.id,
        name: created.name,
        version: created.version,
        created: latest === undefined,
      };
    });
  }

  /** One owner-scoped lookup; every route on this service goes through it. */
  private findOwned(userId: string, id: string) {
    return this.prisma.skill.findFirst({ where: { id, bot: { userId } } });
  }
}

/**
 * §3's `paramsSchema` column, read back for the next version.
 *
 * Prisma types a Json READ as `JsonValue` (which admits null) and a Json WRITE
 * as `InputJsonValue` (which does not), so copying a column forward is not an
 * assignment the compiler accepts — and CLAUDE.md forbids the cast that would
 * only silence it. Re-validating through the shared schema is the narrow that
 * ESTABLISHES the shape; it cannot fail for a row this codebase wrote, since
 * both writers — the compiler's assembler and PATCH itself — produce exactly
 * what it accepts. A row that somehow fails it is reported rather than
 * repaired, because guessing at a skill's arguments is how a run gets the
 * wrong ones.
 */
function carriedParamsSchema(value: unknown) {
  const parsed = JsonSchemaObjectSchema.safeParse(value);
  if (!parsed.success) {
    throw new InternalServerErrorException(
      'this skill has an unreadable paramsSchema; it cannot be carried to a new version',
    );
  }
  // The inferred type is the parsed `Record<string, Json>` — an object type,
  // which is what makes it assignable to Prisma's write input where the raw
  // column type (which admits a top-level null) is not.
  return parsed.data;
}

/**
 * D-098's `steps` column, read back for the next version.
 *
 * The same narrow as `carriedParamsSchema` and for the same reason: Prisma
 * types a Json READ as `JsonValue` (which admits null) and a Json WRITE as
 * `InputJsonValue` (which does not), so copying the column forward is not an
 * assignment the compiler accepts. A row written before the column existed
 * carries `[]` from the migration's default. A row that fails the parse is
 * repaired to `[]` rather than reported: unlike `paramsSchema`, an unreadable
 * summary costs nothing but the summary, and refusing the edit would block the
 * one gesture that can replace it.
 */
function carriedSteps(value: unknown) {
  const parsed = SkillStepsSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}
