import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ToolContext } from './tool-registry.js';
import { MACHINE_HOME } from './workspace-paths.js';

/** Canonical path where the durable board is projected for sandbox tools & humans. */
export const MANAGED_BOARD_PATH = `${MACHINE_HOME}/shared/BOARD.md`;
const MANAGED_BOARD_MARKER = '<!-- crewaid-managed-board -->';
const MAX_BOARD_CHARS = 32_000;

export type ManagedBoardReadResult =
  | {
      readonly kind: 'read';
      readonly text: string;
      readonly restored?: boolean;
      /** The file held edits made outside the board tools; they were saved to history first. */
      readonly displaced?: boolean;
    }
  | { readonly kind: 'absent' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'failed'; readonly detail: string };

export type ManagedBoardWriteResult =
  | { readonly kind: 'written'; readonly entryId: string; readonly text: string }
  | { readonly kind: 'removed'; readonly entryId: string; readonly text: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'ambiguous' }
  | { readonly kind: 'not-owner'; readonly ownerName: string }
  | { readonly kind: 'too-large'; readonly would: number; readonly limit: number }
  | { readonly kind: 'failed'; readonly detail: string };

/** What a read of the projected file found: its text (null when absent), or that it could not be read. */
type DiskRead = { readonly ok: true; readonly text: string | null } | { readonly ok: false };

export interface ManagedBoardRow {
  readonly id: string;
  readonly ownerBotId: string | null;
  readonly ownerName: string;
  readonly content: string;
  readonly version: number;
}

/**
 * Deterministic scope key matching `/home/bot/shared/BOARD.md`: shared across
 * all bots on the same sandbox machine, falling back to the user scope when a
 * bot has no sandbox attached yet.
 */
export function boardScopeKey(context: Pick<ToolContext, 'userId' | 'sandboxId'>): string {
  return context.sandboxId !== undefined && context.sandboxId !== null && context.sandboxId !== ''
    ? `sandbox:${context.sandboxId}`
    : `user:${context.userId}`;
}

/**
 * Renders active durable board entries into clean, human-readable Markdown
 * with a header marker so external shell overwrites can be detected reliably.
 */
export function renderManagedBoard(entries: readonly ManagedBoardRow[]): string {
  if (entries.length === 0) return '';
  const lines: string[] = ['# Team Board', MANAGED_BOARD_MARKER, ''];
  for (const entry of entries) {
    const content = entry.content.trim();
    if (content === '') continue;
    const ownerTag = entry.ownerName.trim() || 'Shared';
    const contentLines = content.split(/\r?\n/);
    const first = contentLines[0] ?? '';
    const rest = contentLines.slice(1);
    const bullet = /^[-*+]\s/.test(first) ? first : `- ${first}`;
    lines.push(`${bullet}  *(owner: ${ownerTag})*`);
    for (const extra of rest) {
      lines.push(`  ${extra}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function parseLegacyEntries(raw: string): string[] {
  const cleaned = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line !== '' &&
        line !== '# Team Board' &&
        line !== MANAGED_BOARD_MARKER &&
        !/^<!--.*-->$/.test(line),
    );
  return cleaned;
}

/**
 * Durable per-owner board storage backing `board_read`, `board_add`, and
 * `board_update`, projecting a readable Markdown file to
 * `/home/bot/shared/BOARD.md`.
 *
 * Guarantees:
 * 1. First adoption snapshots any pre-existing `BOARD.md` into `BoardRevision`
 *    (`INIT_SNAPSHOT`) before managing entries.
 * 2. Every mutation runs inside a serialised transaction scoped by `(userId,
 *    scopeKey)` and refuses cross-bot overwrites — one bot can never wipe
 *    another bot's entries.
 * 3. Every change appends a `BoardRevision` snapshot; if a shell command wipes
 *    or overwrites `BOARD.md`, managed entries remain intact in Postgres and
 *    are restored cleanly.
 * 4. The projection never overwrites text it did not write without saving it
 *    first: whatever an outside edit left in the file is kept as an
 *    `EXTERNAL_EDIT` revision before the managed board replaces it.
 */
@Injectable()
export class BoardStoreService {
  /** Per-scope async serialization queue so concurrent bot writes never race on init or disk projection. */
  private readonly scopeLocks = new Map<string, Promise<void>>();

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private withScopeLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.scopeLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.scopeLocks.set(key, tail);
    return previous
      .then(() => fn())
      .finally(() => {
        release();
        if (this.scopeLocks.get(key) === tail) {
          this.scopeLocks.delete(key);
        }
      });
  }

  async read(
    context: ToolContext,
    options?: { readonly restore?: boolean },
  ): Promise<ManagedBoardReadResult> {
    const scopeKey = boardScopeKey(context);
    return this.withScopeLock(`${context.userId}:${scopeKey}`, async () => {
      try {
        await this.ensureInitialized(context, scopeKey);
        const entries = await this.listActive(this.prisma, context.userId, scopeKey);
        const disk = await this.readDisk(context);
        if (entries.length === 0) {
          if (!disk.ok) return { kind: 'failed', detail: `could not read ${MANAGED_BOARD_PATH}` };
          if (disk.text === null) return { kind: 'absent' };
          return disk.text.trim() === '' ? { kind: 'empty' } : { kind: 'read', text: disk.text };
        }

        const rendered = renderManagedBoard(entries);
        // A file that cannot be read cannot be compared, so it is left alone.
        if (!disk.ok) return { kind: 'read', text: rendered };
        const differs = disk.text === null || disk.text.trim() !== rendered.trim();
        if (options?.restore !== true && !differs) return { kind: 'read', text: rendered };

        const displaced = await this.saveOutsideEdits(context, scopeKey, rendered, disk);
        await this.tryWriteDisk(context, rendered);
        if (
          options?.restore === true ||
          displaced ||
          (disk.text !== null && !disk.text.includes(MANAGED_BOARD_MARKER))
        ) {
          await this.prisma.boardRevision.create({
            data: {
              userId: context.userId,
              scopeKey,
              ownerBotId: context.botId,
              kind: 'RESTORE',
              snapshot: rendered,
            },
          });
          return {
            kind: 'read',
            text: rendered,
            restored: true,
            ...(displaced ? { displaced: true } : {}),
          };
        }

        return { kind: 'read', text: rendered };
      } catch (error) {
        return { kind: 'failed', detail: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  async add(context: ToolContext, rawEntry: string): Promise<ManagedBoardWriteResult> {
    const text = rawEntry.trim();
    const scopeKey = boardScopeKey(context);
    return this.withScopeLock(`${context.userId}:${scopeKey}`, async () => {
      try {
        await this.ensureInitialized(context, scopeKey);
        const ownerName = await this.resolveOwnerName(context);

        const { outcome, before } = await this.prisma.$transaction(async (tx): Promise<{
          outcome: ManagedBoardWriteResult;
          before: string;
        }> => {
          const existing = await this.listActive(tx, context.userId, scopeKey);
          const before = renderManagedBoard(existing);
          const prospective = renderManagedBoard([
            ...existing,
            { id: 'pending', ownerBotId: context.botId, ownerName, content: text, version: 1 },
          ]);
          if (prospective.length > MAX_BOARD_CHARS) {
            return {
              outcome: { kind: 'too-large', would: prospective.length, limit: MAX_BOARD_CHARS },
              before,
            };
          }
          const created = await tx.boardEntry.create({
            data: {
              userId: context.userId,
              scopeKey,
              ownerBotId: context.botId,
              ownerName,
              content: text,
              version: 1,
            },
            select: { id: true, ownerBotId: true, ownerName: true, content: true, version: true },
          });
          const rendered = renderManagedBoard([...existing, created]);
          await tx.boardRevision.create({
            data: {
              userId: context.userId,
              scopeKey,
              entryId: created.id,
              ownerBotId: context.botId,
              kind: 'ADD',
              snapshot: rendered,
            },
          });
          return { outcome: { kind: 'written', entryId: created.id, text: rendered }, before };
        });

        if (outcome.kind === 'written') {
          await this.project(context, scopeKey, before, outcome.text);
        }
        return outcome;
      } catch (error) {
        return { kind: 'failed', detail: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  async update(
    context: ToolContext,
    find: string,
    replace: string,
  ): Promise<ManagedBoardWriteResult> {
    const scopeKey = boardScopeKey(context);
    return this.withScopeLock(`${context.userId}:${scopeKey}`, async () => {
      try {
        await this.ensureInitialized(context, scopeKey);
        const { outcome, before } = await this.prisma.$transaction(async (tx): Promise<{
          outcome: ManagedBoardWriteResult;
          before: string;
        }> => {
          const entries = await this.listActive(tx, context.userId, scopeKey);
          const before = renderManagedBoard(entries);
          const done = (result: ManagedBoardWriteResult) => ({ outcome: result, before });
          if (entries.length === 0) return done({ kind: 'absent' });

          const needle = find.trim();
          const matches = entries.filter(
            (entry) =>
              entry.content.includes(find) ||
              (needle !== '' && entry.content.includes(needle)),
          );
          if (matches.length === 0) return done({ kind: 'not-found' });
          if (matches.length > 1) {
            // If only one matched entry belongs to this bot, target it; otherwise ambiguous.
            const ownMatches = matches.filter((entry) => entry.ownerBotId === context.botId);
            if (ownMatches.length !== 1) {
              return done({ kind: 'ambiguous' });
            }
            matches.splice(0, matches.length, ownMatches[0]!);
          }

          const target = matches[0]!;
          if (target.ownerBotId !== null && target.ownerBotId !== context.botId) {
            return done({ kind: 'not-owner', ownerName: target.ownerName });
          }

          const matchedToken = target.content.includes(find) ? find : needle;
          const first = target.content.indexOf(matchedToken);
          if (first === -1) return done({ kind: 'not-found' });
          if (target.content.indexOf(matchedToken, first + matchedToken.length) !== -1) {
            return done({ kind: 'ambiguous' });
          }

          const nextContent = `${target.content.slice(0, first)}${replace}${target.content.slice(first + matchedToken.length)}`.trim();
          const removing = nextContent === '';

          const updatedEntries = removing
            ? entries.filter((entry) => entry.id !== target.id)
            : entries.map((entry) =>
                entry.id === target.id
                  ? { ...entry, content: nextContent, version: entry.version + 1 }
                  : entry,
              );
          const rendered = renderManagedBoard(updatedEntries);
          if (rendered.length > MAX_BOARD_CHARS) {
            return done({ kind: 'too-large', would: rendered.length, limit: MAX_BOARD_CHARS });
          }

          await tx.boardEntry.updateMany({
            where: { id: target.id, userId: context.userId, scopeKey, version: target.version },
            data: removing
              ? { deleted: true, version: { increment: 1 } }
              : { content: nextContent, version: { increment: 1 } },
          });
          await tx.boardRevision.create({
            data: {
              userId: context.userId,
              scopeKey,
              entryId: target.id,
              ownerBotId: context.botId,
              kind: removing ? 'DELETE' : 'UPDATE',
              snapshot: rendered,
            },
          });
          return done(
            removing
              ? { kind: 'removed', entryId: target.id, text: rendered }
              : { kind: 'written', entryId: target.id, text: rendered },
          );
        });

        if (outcome.kind === 'written' || outcome.kind === 'removed') {
          await this.project(context, scopeKey, before, outcome.text);
        }
        return outcome;
      } catch (error) {
        return { kind: 'failed', detail: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  /**
   * Explicitly restores the board projection on disk (and records a `RESTORE`
   * revision), optionally returning a specific historical revision snapshot.
   */
  async restore(
    context: ToolContext,
    revisionId?: string,
  ): Promise<{ readonly restored: boolean; readonly text: string }> {
    const scopeKey = boardScopeKey(context);
    return this.withScopeLock(`${context.userId}:${scopeKey}`, async () => {
      const current = renderManagedBoard(
        await this.listActive(this.prisma, context.userId, scopeKey),
      );
      let snapshot: string;
      if (revisionId !== undefined) {
        const rev = await this.prisma.boardRevision.findFirst({
          where: { id: revisionId, userId: context.userId, scopeKey },
          select: { snapshot: true },
        });
        if (rev === null) return { restored: false, text: '' };
        snapshot = rev.snapshot;
      } else {
        snapshot = current;
      }
      await this.project(context, scopeKey, current, snapshot);
      await this.prisma.boardRevision.create({
        data: {
          userId: context.userId,
          scopeKey,
          ownerBotId: context.botId,
          kind: 'RESTORE',
          snapshot,
        },
      });
      return { restored: true, text: snapshot };
    });
  }

  private async ensureInitialized(context: ToolContext, scopeKey: string): Promise<void> {
    const existingRevision = await this.prisma.boardRevision.findFirst({
      where: { userId: context.userId, scopeKey },
      select: { id: true },
    });
    if (existingRevision !== null) return;

    // Adoption happens once: the first revision marks the scope initialized.
    // A read that FAILED is not an empty board — carrying on would write that
    // first revision and the next projection would overwrite the legacy file
    // without it ever having been imported.
    const disk = await this.readDisk(context);
    if (!disk.ok) {
      throw new Error(
        `could not read ${MANAGED_BOARD_PATH} to adopt it; try again once this computer is reachable`,
      );
    }
    const rawDisk = disk.text;
    if (rawDisk === null || rawDisk.trim() === '') return;

    const legacyLines = parseLegacyEntries(rawDisk);
    await this.prisma.$transaction(async (tx) => {
      const doubleCheck = await tx.boardRevision.findFirst({
        where: { userId: context.userId, scopeKey },
        select: { id: true },
      });
      if (doubleCheck !== null) return;
      await tx.boardRevision.create({
        data: {
          userId: context.userId,
          scopeKey,
          ownerBotId: null,
          kind: 'INIT_SNAPSHOT',
          snapshot: rawDisk,
        },
      });
      for (const line of legacyLines) {
        await tx.boardEntry.create({
          data: {
            userId: context.userId,
            scopeKey,
            ownerBotId: null,
            ownerName: 'Shared',
            content: line,
            version: 1,
          },
        });
      }
    });
  }

  private async listActive(
    tx: PrismaService | Prisma.TransactionClient,
    userId: string,
    scopeKey: string,
  ): Promise<ManagedBoardRow[]> {
    return tx.boardEntry.findMany({
      where: { userId, scopeKey, deleted: false },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, ownerBotId: true, ownerName: true, content: true, version: true },
    });
  }

  private async resolveOwnerName(context: ToolContext): Promise<string> {
    if (context.botName !== undefined && context.botName.trim() !== '') {
      return context.botName.trim();
    }
    const row = await this.prisma.bot.findFirst({
      where: { id: context.botId, userId: context.userId },
      select: { name: true },
    });
    return row?.name.trim() || context.botId;
  }

  private async readDisk(context: ToolContext): Promise<DiskRead> {
    try {
      const session = await context.session();
      return { ok: true, text: await session.readTextFile({ path: MANAGED_BOARD_PATH }) };
    } catch {
      return { ok: false };
    }
  }

  /**
   * Keeps whatever an outside edit left in the file as an `EXTERNAL_EDIT`
   * revision. `expected` is what the projection last wrote; anything else
   * non-empty on disk was written by someone else. True when it saved one.
   */
  private async saveOutsideEdits(
    context: ToolContext,
    scopeKey: string,
    expected: string,
    disk: DiskRead,
  ): Promise<boolean> {
    if (!disk.ok || disk.text === null) return false;
    const onDisk = disk.text.trim();
    if (onDisk === '' || onDisk === expected.trim()) return false;
    await this.prisma.boardRevision.create({
      data: {
        userId: context.userId,
        scopeKey,
        ownerBotId: null,
        kind: 'EXTERNAL_EDIT',
        snapshot: disk.text,
      },
    });
    return true;
  }

  /** Writes the managed board to disk, saving any outside edits it would replace. */
  private async project(
    context: ToolContext,
    scopeKey: string,
    before: string,
    next: string,
  ): Promise<void> {
    await this.saveOutsideEdits(context, scopeKey, before, await this.readDisk(context));
    await this.tryWriteDisk(context, next);
  }

  private async tryWriteDisk(context: ToolContext, content: string): Promise<void> {
    try {
      const session = await context.session();
      await session.writeTextFile({ path: MANAGED_BOARD_PATH, content });
    } catch {
      // Durable Postgres state is authoritative; sandbox write is best-effort projection.
    }
  }
}
