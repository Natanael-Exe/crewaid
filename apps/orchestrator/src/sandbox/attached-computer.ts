import type { Prisma } from '@prisma/client';

/**
 * "Which machine does this bot work on?", asked in one place.
 *
 * Before D-046 this question did not exist: a bot's machine was the `Sandbox`
 * row keyed on its id, and six services wrote `where: { botId }` because that
 * was the whole of it. A machine is now shared by the bots attached to it, so
 * the lookup goes through `Bot.sandboxId` — and six copies of a two-step
 * traversal is six places for it to be written slightly differently.
 *
 * One query, not two: filtering the machine by its tenants reads the edge from
 * the side that has the index, and leaves the R7 audit one call site to check
 * instead of twelve (`test/prisma-allowlist.test.ts` keys on the call site, so
 * fewer of them is a smaller surface, not just tidier code).
 *
 * **Not an ownership check.** Every caller reaches this with a bot id that a
 * scoped query already resolved — a recording's own row, a skill run's bot, a
 * §4.3 socket that authenticated first. A caller holding an unvalidated bot id
 * must scope it before asking, exactly as it had to before.
 */
export function computerOfBot<Select extends Prisma.SandboxSelect>(
  prisma: Prisma.TransactionClient,
  botId: string,
  select: Select,
): Promise<Prisma.SandboxGetPayload<{ select: Select }> | null> {
  return prisma.sandbox.findFirst({
    where: { bots: { some: { id: botId } } },
    select,
  });
}

/**
 * The narrow slice of the provider this module needs, so the helper stays
 * importable from `bots.service.ts` without dragging the whole port in.
 */
export interface WorkspaceProvisioner {
  readonly workspaceOnFirstStart?: boolean;
  provisionWorkspace(options: { botId: string }): Promise<unknown>;
}

/**
 * Attach a bot to its user's computer, creating that computer the first time
 * (D-046 §19).
 *
 * **One machine per user by default, not per bot.** A second bot joins the
 * first one's machine, which is the entire point: it can read what the first
 * one wrote and it is already logged into the same accounts. A user who wants
 * a second boundary creates a second computer — the cardinality is theirs, not
 * the schema's, which is why this picks the oldest existing machine rather
 * than asserting there is exactly one.
 *
 * Storage is shared by every bot on the machine. Providers whose workspace
 * is the machine itself defer allocation to the first admitted start.
 *
 * `provisionWorkspace` takes `botId` because the provider's parameter is still
 * spelled that way; the value is the COMPUTER's id, and the volume it creates
 * is `crewaid-workspace-<computerId>`. Renaming the provider's parameter would
 * mean relabelling every operator's existing volume to gain nothing this
 * comment does not say — M5-BE-18 carries that rename if it is ever worth it.
 */
export async function attachToComputer(
  tx: Prisma.TransactionClient,
  userId: string,
  botId: string,
  provider: WorkspaceProvisioner,
  preferredComputerId?: string | null,
): Promise<string> {
  await tx.$executeRaw`SELECT id FROM "User" WHERE id = ${userId} FOR NO KEY UPDATE`;
  const existing = await tx.sandbox.findFirst({
    where: { userId, ...(preferredComputerId ? { id: preferredComputerId } : {}) },
    orderBy: { id: 'asc' },
    select: { id: true },
  });
  if (existing !== null) {
    await tx.$executeRaw`SELECT id FROM "Sandbox" WHERE id = ${existing.id} FOR UPDATE`;
    await tx.bot.update({ where: { id: botId }, data: { sandboxId: existing.id } });
    return existing.id;
  }

  const created = await tx.sandbox.create({
    data: { userId, workspacePending: provider.workspaceOnFirstStart === true },
    select: { id: true },
  });
  await tx.bot.update({ where: { id: botId }, data: { sandboxId: created.id } });
  if (!provider.workspaceOnFirstStart) await provider.provisionWorkspace({ botId: created.id });
  return created.id;
}

/**
 * Every browser profile that belongs to this computer now: each attached
 * bot's own, and each named identity's (D-057). A machine brought back from a
 * snapshot keeps these and retires the rest (D-237), so a bot deleted since the
 * snapshot does not get its logins back.
 *
 * Not an ownership check: the computer id comes from a row already scoped to
 * its user.
 */
export async function profilesOfComputer(
  prisma: Prisma.TransactionClient,
  computerId: string,
): Promise<string[]> {
  const [bots, identities] = await Promise.all([
    prisma.bot.findMany({ where: { sandboxId: computerId }, select: { id: true } }),
    prisma.identity.findMany({ where: { sandboxId: computerId }, select: { name: true } }),
  ]);
  return [...bots.map((bot) => bot.id), ...identities.map((identity) => identity.name)];
}
