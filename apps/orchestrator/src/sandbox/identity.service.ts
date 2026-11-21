import { Inject, Injectable } from '@nestjs/common';
import { IdentityNameSchema } from '@crewaid/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Prisma } from '@prisma/client';

/**
 * Named shared identities, and which bots may use one.
 *
 * D-056 gave every bot its own Chrome profile, which is the right default and
 * gives up the one thing WORKSPACE §20's shared profile was good at: a session
 * somebody has already signed into. An identity is that session back, named —
 * `company-google` is a profile directory like a bot's own, and a bot granted
 * it opens its seat with its own `--user-data-dir` for that named identity.
 *
 * Nothing is copied, and that is the argument
 *
 * The obvious alternative is to move the session: read the cookies out of one
 * profile and write them into another. Measured, that does not work and its
 * failures are quiet. Chrome refuses a named profile's context id in the
 * browser-level `Storage` domain ("Failed to find browser context for id"), so
 * it has to go through the page's `Network.getCookies`/`setCookies`, which is
 * origin-scoped and misses `localStorage` tokens entirely. Sites that bind a
 * session to the device defeat it outright, and a login that appears on a
 * second device trips exactly the anomaly heuristics the operator does not
 * want tripped. Sharing the directory has none of those properties because
 * there is no second copy to be wrong.
 *
 * What a grant is and is not
 *
 * A grant is a PRODUCT control, not a security boundary, and it is worth being
 * as plain about that here as D-055 is about the path checks: `shell` runs as
 * the same uid and `/home/bot/.chrome` is the machine's, so a determined bot
 * on this computer can read any profile on it. The boundary is the container
 * (WORKSPACE §22). What the grant buys is that a bot does not SILENTLY end up
 * inside someone's Google session — it has to ask, and the operator's answer
 * is recorded.
 *
 * MCP is not this and must not become it: R10 keeps MCP credentials in the
 * orchestrator and out of every sandbox. An MCP server gives an agent access
 * to a service; it is not a way to hand a browser someone's cookies.
 */

/** A bot's identity after a grant, as the tool reports it back to the model. */
export interface IdentityGrant {
  /** The identity's name, which is also its Chrome profile directory. */
  readonly name: string;
  /** True when this call created the identity rather than joining one. */
  readonly created: boolean;
  /** True when permission already existed; selection may still have changed. */
  readonly alreadyGranted: boolean;
}

/** A grant that cannot be made. The tool turns this into a result, not a throw. */
export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityError';
  }
}

/**
 * The profile the machine's own launch window uses, which is therefore not
 * anybody's identity. The bridge refuses it too; refusing here is what turns
 * "the seat would not open" into a sentence naming the reason.
 */
const MACHINE_PROFILE = 'Default';

@Injectable()
export class IdentityService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Read the desired selection and its permission together; no running lease is claimed. */
  async selectionFor(botId: string): Promise<{ profile: string | null; revision: number }> {
    const bot = await this.prisma.bot.findUnique({
      where: { id: botId },
      select: {
        userId: true,
        sandboxId: true,
        identityRevision: true,
        activeIdentity: {
          select: {
            name: true,
            sandboxId: true,
            sandbox: { select: { userId: true } },
            bots: { where: { botId }, select: { botId: true } },
          },
        },
      },
    });
    if (bot === null) throw new IdentityError('This bot no longer exists.');
    const identity = bot.activeIdentity;
    const profile =
      identity !== null &&
      identity.sandboxId === bot.sandboxId &&
      identity.sandbox.userId === bot.userId &&
      identity.bots.length === 1
        ? identity.name
        : null;
    return { profile, revision: bot.identityRevision };
  }

  async profileFor(botId: string): Promise<string | null> {
    return (await this.selectionFor(botId)).profile;
  }

  /** A bridge hint can name only a peer on this owned computer. */
  async holderNameFor(botId: string, holderBotId: string): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<Array<{ name: string }>>`
      SELECT h.name FROM "Bot" b JOIN "Sandbox" s ON s.id = b."sandboxId"
      JOIN "Bot" h ON h."sandboxId" = s.id AND h."userId" = b."userId"
      WHERE b.id = ${botId} AND h.id = ${holderBotId} AND s."userId" = b."userId"`;
    return typeof rows[0]?.name === 'string' ? rows[0].name : null;
  }

  /** Permission and explicit selection commit as one fact, including reselecting an older grant. */
  async grant(userId: string, botId: string, requested: string): Promise<IdentityGrant> {
    const name = this.validateName(requested);
    return this.prisma.$transaction(async (tx) => {
      const sandboxId = await this.lockComputer(tx, userId, botId);
      // Bot ids remain reserved across computers, so moving a bot cannot turn its private directory shared.
      const collision = await tx.bot.findUnique({ where: { id: name }, select: { id: true } });
      if (collision !== null) {
        throw new IdentityError(
          `${name} is a bot's own profile, not a shared identity; pick another name`,
        );
      }
      const found = await tx.identity.findUnique({
        where: { sandboxId_name: { sandboxId, name } },
        select: { id: true },
      });
      const identity =
        found ?? (await tx.identity.create({ data: { sandboxId, name }, select: { id: true } }));
      const held = await tx.botIdentity.findUnique({
        where: { botId_identityId: { botId, identityId: identity.id } },
        select: { botId: true },
      });
      if (held === null) await tx.botIdentity.create({ data: { botId, identityId: identity.id } });
      await tx.bot.update({
        where: { id: botId, userId },
        data: { activeIdentityId: identity.id, identityRevision: { increment: 1 } },
      });
      return { name, created: found === null, alreadyGranted: held !== null };
    });
  }

  /** Revocation is durable before close; a crashed closer cannot restore permission. */
  async release(userId: string, botId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockComputer(tx, userId, botId);
      const bot = await tx.bot.findUniqueOrThrow({
        where: { id: botId, userId },
        select: { activeIdentityId: true },
      });
      if (bot.activeIdentityId === null) return;
      if (bot.activeIdentityId !== null) {
        await tx.botIdentity.deleteMany({
          where: { botId, identityId: bot.activeIdentityId, bot: { userId } },
        });
      }
      await tx.bot.update({
        where: { id: botId, userId },
        data: { activeIdentityId: null, identityRevision: { increment: 1 } },
      });
    });
  }

  private async lockComputer(
    tx: Prisma.TransactionClient,
    userId: string,
    botId: string,
  ): Promise<string> {
    const computers = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT s.id FROM "Sandbox" s JOIN "Bot" b ON b."sandboxId" = s.id
      WHERE b.id = ${botId} AND b."userId" = ${userId} AND s."userId" = ${userId}
      FOR UPDATE OF s, b`;
    const computer = computers[0];
    if (computer === undefined) throw new IdentityError('This bot has no computer owned by you.');
    const recording = await tx.recording.count({
      where: { botId, state: 'RECORDING', bot: { userId } },
    });
    if (recording > 0)
      throw new IdentityError('Stop teaching before changing or releasing a shared login.');
    return computer.id;
  }

  /**
   * The name as a Chrome profile directory, or a refusal a model can act on.
   *
   * `safeParse` rather than a throwing parse: this is reached from inside a
   * turn, and the shape of a bad name is something the model chose and can
   * choose again — so it gets a sentence, never a ZodError stack.
   */
  private validateName(requested: string): string {
    const parsed = IdentityNameSchema.safeParse(requested);
    if (!parsed.success) {
      throw new IdentityError(
        `${JSON.stringify(requested)} cannot name an identity; ` +
          `use letters, digits, underscore or hyphen, e.g. "company-google"`,
      );
    }
    if (parsed.data === MACHINE_PROFILE) {
      throw new IdentityError(
        `${MACHINE_PROFILE} is the machine's own browser profile, not a shared identity`,
      );
    }
    return parsed.data;
  }
}
