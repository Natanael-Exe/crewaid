import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import {
  ModelResolutionService,
  type ResolvedTextModel,
} from '../models/model-resolution.service.js';
import { answerInstructions } from '../models/structured-answer.js';
import { askModelText } from '../models/text-call.js';

/** What a revision asks: the run engine's adapter for the bot's model. */
type TextModel = Pick<ResolvedTextModel, 'adapter'>;
import { correctedTask, refuseModelFailure, withDeadline } from './skill-model-call.js';
import {
  CompiledSkillSchema,
  SKILL_CONTEXT_SOURCE,
  TIMING_RULE,
} from './skill-compile.contract.js';
import { validateCompiled, type ValidatedSkill, type Verdict } from './skill-validator.js';

/** Compile a plain-language edit into a new, unapproved skill version. */
@Injectable()
export class SkillReviseService {
  private readonly logger = new Logger(SkillReviseService.name);

  /**
   * The same bound as a compile attempt, for the same reason — a wedged
   * provider must not hold a request open forever. The dialog waits on it.
   */
  static readonly DEADLINE_MS = 180_000;

  // Explicit tokens: vitest/esbuild emits no design:paramtypes, so type-based
  // DI resolution silently fails in the integration suite.
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ModelResolutionService) private readonly models: ModelResolutionService,
  ) {}

  /** Compile one sentence of change into the skill's next version. */
  async revise(userId: string, skillId: string, instruction: string) {
    const skill = await this.prisma.skill.findFirst({
      where: { id: skillId, bot: { userId } },
      select: {
        id: true,
        botId: true,
        name: true,
        description: true,
        paramsSchema: true,
        steps: true,
        script: true,
      },
    });
    if (skill === null || skill.botId === null) throw new NotFoundException('Skill not found');

    const model = await this.resolveModel(userId, skill.botId);
    const task = describeSkill(skill) + `\n\nWhat to change: ${instruction}`;

    const first = await this.ask(model, task, skill.name);
    let revised = first;
    if (!revised.ok) {
      // The same single corrective retry the compile gives (§6/M3): the
      // defects are sentences addressed to the model, and the change is still
      // in front of it.
      this.logger.warn(
        `skill ${skill.id}: the revision was rejected (${revised.defects.join('; ')}); ` +
          'retrying once with the defects named',
      );
      revised = await this.ask(model, correctedTask(task, revised.defects), skill.name);
    }
    if (!revised.ok) {
      // The operator is waiting, so the refusal is the response — a readable
      // sentence about their change rather than a stalled dialog.
      throw new BadRequestException(
        `the compiler could not apply that change: ${revised.defects.join('; ')}`,
      );
    }

    return await this.persist(userId, skill.id, revised.skill);
  }

  /** Resolve the model from the same owner-scoped bot that owns the skill. */
  private async resolveModel(userId: string, botId: string): Promise<TextModel> {
    const bot = await this.prisma.bot.findFirst({
      where: { id: botId, userId },
      select: { modelId: true },
    });
    if (bot === null) throw new NotFoundException('Skill not found');
    return this.models.resolveText(userId, bot.modelId);
  }

  /**
   * One bounded attempt, judged by the compile's own validator plus the name
   * lock this route adds.
   */
  private async ask(model: TextModel, task: string, lockedName: string): Promise<Verdict> {
    let reply: string;
    try {
      // R3: a resolved model, never an endpoint.
      reply = await withDeadline(SkillReviseService.DEADLINE_MS, (signal) =>
        askModelText(model, {
          system: `${REVISE_SYSTEM_PROMPT}

${answerInstructions(CompiledSkillSchema)}`,
          prompt: task,
          signal,
        }),
      );
    } catch (error: unknown) {
      // The deadline's sentence is written for an operator; a provider's is
      // converted here, where it is still known that a model was involved.
      // 503, not 400: the model or the network failed, and saying "your change
      // was bad" about a provider outage is the same wrong-system sentence
      // D-044's normalizer exists to avoid.
      const refused = refuseModelFailure(error, 'revise', this.logger);
      throw new ServiceUnavailableException(refused.message);
    }

    const verdict = validateCompiled(reply);
    if (!verdict.ok) return verdict;
    if (verdict.skill.name !== lockedName) {
      return {
        ok: false,
        defects: [
          `the name must stay "${lockedName}" — a revision changes the skill, it does not rename it`,
        ],
      };
    }
    return verdict;
  }

  /** Allocate the next version, retrying transaction/write conflicts. */
  private async persist(userId: string, skillId: string, revised: ValidatedSkill) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            const current = await tx.skill.findFirst({
              where: { id: skillId, bot: { userId } },
            });
            if (current === null) throw new NotFoundException('Skill not found');

            const latest = await tx.skill.findFirst({
              where: { botId: current.botId, name: current.name, bot: { userId } },
              orderBy: { version: 'desc' },
              select: { version: true },
            });

            return await tx.skill.create({
              data: {
                botId: current.botId,
                name: current.name,
                description: revised.description,
                paramsSchema: revised.paramsSchema,
                steps: [...revised.steps],
                script: revised.script,
                version: (latest?.version ?? current.version) + 1,
                status: 'DRAFT',
                sourceRecordingId: current.sourceRecordingId,
              },
            });
          },
          { isolationLevel: 'Serializable' },
        );
      } catch (error: unknown) {
        if (attempt === 3 || !isVersionWriteConflict(error)) throw error;
      }
    }
    throw new Error('unreachable');
  }
}

function isVersionWriteConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'P2002' || code === 'P2034';
}

/**
 * The revise prompt: the skill as it stands, then the change, then the rules
 * that make the answer an EDIT rather than a fresh composition.
 *
 * `SKILL_CONTEXT_SOURCE` is the same source the compiler writes scripts
 * against, sent for the same reason (D-097's account of asking with what we
 * judge by): a paraphrase of the interface is how a revision emits a method
 * the runtime does not have.
 */
const REVISE_SYSTEM_PROMPT = `You revise an existing recorded skill: a TypeScript module that reproduces a task on a
Linux desktop. The person who recorded the task has said what should change, in their own
words; you return the whole skill again, with that change made.

The module default-exports \`async function run(ctx, params)\`, where \`ctx\` is:

${SKILL_CONTEXT_SOURCE}

Rules:
  - Use only the methods above. There is no other API, no imports, and no
    filesystem or network access.
  - The name is fixed: return exactly the name you were given.
  - This is an edit, not a re-recording. Keep everything the change does not
    ask to touch — the same steps in the same order, the same selectors, the
    same coordinates, the same parameters. Rewrite only what the change makes
    wrong.
  - Update \`description\` and \`steps\` where the change makes the old wording
    untrue, and only there. \`steps\` stays one short sentence per meaningful
    action, in order, in plain language — no coordinates, selectors, variable
    names, or code.
  - Coordinates are absolute, in the screen resolution the skill was recorded
    at; a change never re-measures them.
  - ${TIMING_RULE}
  - \`ctx.log\` each meaningful step, so a failed run says where it stopped.`;

/**
 * The user turn: what the skill is now, machine halves included.
 *
 * The script goes over as source rather than as a description of itself —
 * the revision has to preserve code it cannot see — and `steps` goes with it
 * because the summary is the half the model is asked to keep true.
 */
function describeSkill(skill: {
  readonly name: string;
  readonly description: string;
  readonly paramsSchema: unknown;
  readonly steps: unknown;
  readonly script: string;
}): string {
  const steps = Array.isArray(skill.steps)
    ? skill.steps.filter((step): step is string => typeof step === 'string')
    : [];
  const summary =
    steps.length === 0
      ? '(the person never saw a summary for this skill)'
      : steps.map((step, index) => `  ${index + 1}. ${step}`).join('\n');

  return `The skill as it stands:

name: ${skill.name}
description: ${skill.description}
steps:
${summary}

The parameters it takes (JSON Schema):
${JSON.stringify(skill.paramsSchema, null, 2)}

Its script:

\`\`\`ts
${skill.script}
\`\`\``;
}
