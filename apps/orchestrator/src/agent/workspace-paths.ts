/**
 * Where a bot may read and write on a machine it shares (WORKSPACE §19).
 *
 * D-046 moved what "scoped" means. §6/M5 says `fs_read`/`fs_write` are
 * "scoped to `/home/bot`", which was a boundary when a container held one
 * bot; now `/home/bot` is the MACHINE's home and every tenant shares it, so
 * the layout decides which paths are a bot's own, which are the team's, and
 * which are neither:
 *
 * | Path | Who |
 * |---|---|
 * | `/home/bot/agents/<botId>/` | that one bot |
 * | `/home/bot/shared/` | every bot on the machine |
 * | `/home/bot/groups/<groupId>/` | the bots in that group |
 * | `/home/bot/.chrome/<botId>/` | that one bot's browser profile |
 * | `/home/bot/.chrome` itself, `.config`, `.cache` | the machine |
 *
 * What this is, and what it is not
 *
 * A guardrail against a confused model, never a boundary against a determined
 * one. §22 is explicit: `shell` executes as the same uid and can read
 * anything that uid can, so a path check here is worth exactly as much as the
 * model's willingness to use the tool that has one. The boundary is the
 * container, and it is per user.
 *
 * That is the reason to be strict anyway rather than the reason not to
 * bother. The rejection cases are about a model reaching somewhere it did
 * not mean to — `/etc/shadow`, an escape upward — and those are exactly the
 * mistakes a check catches.
 */

/** The machine's home, and the `WORKDIR` of every sandbox. */
export const MACHINE_HOME = '/home/bot';

/**
 * The machine's own state. Not a bot's to read or write (WORKSPACE §19).
 *
 * `.crewaid-deleted-profiles` is here for a sharper reason than the rest: a
 * tombstone there retires a profile for good (D-056 keeps it so a delayed
 * allocation cannot recreate a deleted bot). A bot that wrote one for a
 * sibling would take that sibling's browser away permanently, which is not a
 * mistake it can undo and not one an operator should have to notice.
 *
 * `.seats` is here for the same reason squared. Each seat's Chrome
 * runs on its own `--user-data-dir` under it, so that directory holds every
 * cookie and every logged-in session on this machine — a bot's own, its
 * siblings', and every shared identity an operator signed into. `shell` can
 * still reach it, because `shell` runs as the same uid and the boundary is the
 * container; what this closes is the path where a confused model reads a
 * sibling's session through the one tool that is supposed to be scoped.
 */
export const MACHINE_OWNED: readonly string[] = [
  '.chrome',
  '.seats',
  '.config',
  '.cache',
  '.local',
  '.crewaid-deleted-profiles',
];

/** Directories skipped by default in recursive code searches (`fs_grep`, `fs_glob`). */
export const DEFAULT_SEARCH_EXCLUDES: readonly string[] = ['.git', 'node_modules'];

export type WorkspaceSearchPlan =
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly mode: 'empty' }
  | {
      readonly ok: true;
      readonly mode: 'root';
      readonly path: string;
      readonly excludes: readonly string[];
    }
  | {
      readonly ok: true;
      readonly mode: 'machine-home';
      readonly ownDir: string;
      readonly groupDir: string | null;
      readonly skipTopLevel: readonly string[];
      readonly excludes: readonly string[];
    };

/**
 * Resolve a recursive search root (`fs_grep` / `fs_glob`) and compute pre-search
 * exclusions so sibling bots' folders and machine state are never scanned or
 * allowed to consume result limits before post-filtering runs.
 */
export function resolveWorkspaceSearchPlan(
  botId: string,
  requested: string | undefined,
  groupId: string | null = null,
  baseDir?: string,
): WorkspaceSearchPlan {
  const ownDir = `${MACHINE_HOME}/agents/${botId}`;
  const groupDir = groupId === null ? null : `${MACHINE_HOME}/groups/${groupId}`;
  let defaultRoot = ownDir;
  if (baseDir !== undefined && baseDir.trim() !== '') {
    const baseVerdict = resolveWorkspacePath(botId, baseDir, groupId);
    if (!baseVerdict.ok) return baseVerdict;
    defaultRoot = baseVerdict.path;
  }
  const target = requested === undefined || requested.trim() === '' ? defaultRoot : requested;
  const verdict = resolveWorkspacePath(botId, target, groupId, defaultRoot);
  if (!verdict.ok) return verdict;

  if (verdict.path === MACHINE_HOME) {
    return {
      ok: true,
      mode: 'machine-home',
      ownDir,
      groupDir,
      skipTopLevel: [...MACHINE_OWNED, ...DEFAULT_SEARCH_EXCLUDES, 'agents', 'groups'],
      excludes: DEFAULT_SEARCH_EXCLUDES,
    };
  }
  if (verdict.path === `${MACHINE_HOME}/agents`) {
    return { ok: true, mode: 'root', path: ownDir, excludes: DEFAULT_SEARCH_EXCLUDES };
  }
  if (verdict.path === `${MACHINE_HOME}/groups`) {
    if (groupDir === null) return { ok: true, mode: 'empty' };
    return { ok: true, mode: 'root', path: groupDir, excludes: DEFAULT_SEARCH_EXCLUDES };
  }
  return { ok: true, mode: 'root', path: verdict.path, excludes: DEFAULT_SEARCH_EXCLUDES };
}

/**
 * Chrome's user-data directory, which since M5-BE-26 holds one profile per bot.
 *
 * The directory itself is still the machine's — `Local State` names every
 * profile on it, and the launch window's `Default` is nobody's — but a bot's
 * OWN profile inside it is that bot's, and refusing it would stop a bot
 * reading the cookies it is itself logged in with.
 */
const CHROME_DIR = '.chrome';

export type PathVerdict =
  { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string };

/**
 * Resolve a path the model asked for, or say why not — in a sentence the
 * model can act on.
 *
 * Refusals are text rather than exceptions for the reason: a tool result
 * the model can react to beats one shaped for a developer reading a stack. A
 * model told "that is another bot's area, yours is /home/bot/agents/<id>" can
 * retry correctly; one handed a stack trace re-runs the same call.
 */
export function resolveWorkspacePath(
  botId: string,
  requested: string,
  groupId: string | null = null,
  baseDir?: string,
): PathVerdict {
  if (typeof requested !== 'string' || requested.trim() === '') {
    return { ok: false, reason: 'a path is required' };
  }
  // A NUL byte truncates the path at the syscall boundary, so
  // `"/home/bot/agents/x/ok\0/../../../etc/shadow"` can pass a string check
  // and open something else entirely. Refused before anything is normalized.
  if (requested.includes('\0')) {
    return { ok: false, reason: 'a path may not contain a null byte' };
  }

  const own = `${MACHINE_HOME}/agents/${botId}`;
  let anchor = own;
  if (!requested.startsWith('/') && baseDir !== undefined && baseDir.trim() !== '') {
    const baseVerdict = resolveWorkspacePath(botId, baseDir, groupId);
    if (!baseVerdict.ok) return baseVerdict;
    anchor = baseVerdict.path;
  }
  const absolute = requested.startsWith('/') ? requested : `${anchor}/${requested}`;
  const normalized = normalizePosix(absolute);

  if (normalized !== MACHINE_HOME && !normalized.startsWith(`${MACHINE_HOME}/`)) {
    return {
      ok: false,
      reason:
        `${requested} is outside ${MACHINE_HOME}. This bot's own area is ${own}, ` +
        `and ${MACHINE_HOME}/shared is the team's.`,
    };
  }

  const relative = normalized.slice(MACHINE_HOME.length + 1);
  const [first, second] = relative.split('/');

  // A bot's own browser profile, which lives under a machine-owned directory.
  // Checked before the machine rule below, because it is the exception to it.
  if (first === CHROME_DIR && second === botId) {
    return { ok: true, path: normalized };
  }
  if (first !== undefined && MACHINE_OWNED.includes(first)) {
    return {
      ok: false,
      reason:
        `${normalized} belongs to the machine, not to a bot — it is the browser's own ` +
        `state and the config every bot here shares. Your browser profile is ` +
        `${MACHINE_HOME}/${CHROME_DIR}/${botId}.`,
    };
  }
  // Another tenant's area. Readable in fact (§22: isolation is per computer),
  // and refused anyway, because a model reaching into `agents/<someone-else>`
  // has mistaken whose notes these are rather than decided to share.
  if (first === 'agents' && second !== undefined && second !== '' && second !== botId) {
    return {
      ok: false,
      reason:
        `${normalized} is another bot's area. Yours is ${own}; use ` +
        `${MACHINE_HOME}/shared for work the team should see.`,
    };
  }

  // Another group's folder. Refused for the same reason as another
  // bot's area: a model writing into a group it is not in has confused whose
  // folder this is, and the members of that group would find its files there.
  if (first === 'groups' && second !== undefined && second !== '' && second !== groupId) {
    return {
      ok: false,
      reason:
        groupId === null
          ? `${normalized} belongs to a group this bot is not in. Yours is ${own}; use ` +
            `${MACHINE_HOME}/shared for work the team should see.`
          : `${normalized} belongs to another group. Your group's folder is ` +
            `${MACHINE_HOME}/groups/${groupId}.`,
    };
  }

  return { ok: true, path: normalized };
}

/**
 * POSIX-normalize without touching the host filesystem.
 *
 * `node:path` would be the obvious tool and is the wrong one: this resolves a
 * path INSIDE a Linux container from an orchestrator that may be running on
 * Windows, where `path.resolve` would introduce a drive letter and treat `\`
 * as a separator. The rules here are the container's.
 *
 * `..` at the root clamps, because that is what the kernel does: `/..` IS `/`
 * on Linux, so refusing it would be stricter than the filesystem and would
 * reject `/../home/bot/shared/x`, which names a real and legitimate file.
 * Nothing rests on the clamp — a path that climbs out lands outside
 * `/home/bot` and the prefix check below is what refuses it.
 */
function normalizePosix(absolute: string): string {
  const segments: string[] = [];
  for (const segment of absolute.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment !== '..') {
      segments.push(segment);
      continue;
    }
    segments.pop();
  }
  return `/${segments.join('/')}`;
}
