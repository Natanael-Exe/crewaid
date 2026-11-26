import { describe, expect, it } from 'vitest';
import {
  MACHINE_HOME,
  MACHINE_OWNED,
  resolveWorkspacePath,
  resolveWorkspaceSearchPlan,
} from '../src/agent/workspace-paths.js';

/**
 * M5-BE-05 / M5-QA-01 — where a bot may read and write on a machine it shares.
 *
 * §6/M5 says these tools are "scoped to `/home/bot`", which was a boundary
 * when a container held one bot. Under D-046 `/home/bot` is the MACHINE's home
 * and every tenant shares it, so the question changed from "inside the home?"
 * to WORKSPACE §19's three-way split: the bot's own area, the team's, and the
 * machine's.
 *
 * What it is worth is stated in the module and repeated here because a test
 * suite reads like a claim of safety: this is a guardrail against a confused
 * model, never a boundary against a determined one. `shell()` runs as the same
 * uid and skips every check below. The boundary is the container.
 */

const BOT = 'clx1a2b3c4d5e6f7g8h9i0j1';
const OWN = `${MACHINE_HOME}/agents/${BOT}`;

const allowed = (path: string): string => {
  const verdict = resolveWorkspacePath(BOT, path);
  if (!verdict.ok) throw new Error(`expected ${path} to be allowed: ${verdict.reason}`);
  return verdict.path;
};
const refused = (path: string): string => {
  const verdict = resolveWorkspacePath(BOT, path);
  if (verdict.ok) throw new Error(`expected ${path} to be refused, got ${verdict.path}`);
  return verdict.reason;
};

describe('the paths a bot may use', () => {
  it('lets a bot into its own area', () => {
    expect(allowed(`${OWN}/notes.md`)).toBe(`${OWN}/notes.md`);
    expect(allowed(`${OWN}`)).toBe(OWN);
  });

  it('resolves a relative path against that area, not the process cwd', () => {
    // The model writes `notes.md`; it means its own notes, not the
    // orchestrator's working directory on some other machine entirely.
    expect(allowed('notes.md')).toBe(`${OWN}/notes.md`);
    expect(allowed('drafts/one.txt')).toBe(`${OWN}/drafts/one.txt`);
  });

  it('lets every bot into the team area', () => {
    // §19: `/home/bot/shared` is the project, the worktrees, the board and the
    // memory. Sharing it is the point of D-046, not a leak.
    expect(allowed(`${MACHINE_HOME}/shared/board.md`)).toBe(`${MACHINE_HOME}/shared/board.md`);
  });

  it('refuses the §6/M5 cases verbatim', () => {
    expect(refused('/etc/shadow')).toContain('outside /home/bot');
    expect(refused('/etc/passwd')).toContain('outside /home/bot');
  });

  it('refuses every way out of the home, not just the obvious one', () => {
    // Normalised before the prefix is checked, so a path is judged by where it
    // LANDS rather than by how it is spelled.
    expect(refused('../../../etc/shadow')).toContain('outside /home/bot');
    expect(refused(`${MACHINE_HOME}/../etc/shadow`)).toContain('outside /home/bot');
    expect(refused(`${OWN}/../../../../etc/shadow`)).toContain('outside /home/bot');
    // `/home/bot` is a prefix of this and it is still a different directory.
    expect(refused('/home/botswana/secrets')).toContain('outside /home/bot');
    // One that climbs and returns is fine, because it lands inside.
    expect(allowed(`${OWN}/drafts/../notes.md`)).toBe(`${OWN}/notes.md`);
    // And `..` at the root clamps, because `/..` IS `/` on Linux — refusing
    // it would be stricter than the kernel and would reject a real file.
    expect(allowed(`/../${MACHINE_HOME.slice(1)}/shared/x`)).toBe(`${MACHINE_HOME}/shared/x`);
  });

  it('refuses a null byte before it normalises anything', () => {
    // The syscall truncates at the NUL, so a path that passes a string check
    // can open something else entirely.
    expect(refused(`${OWN}/ok\0/../../../../etc/shadow`)).toContain('null byte');
  });

  it('keeps a bot out of the machine’s own state', () => {
    // `.chrome/Default` is the launch window's profile and nobody's; `.config`
    // and `.cache` are the machine's. A model tidying up its "cache" would
    // take the whole desktop's state with it. `.crewaid-deleted-profiles` is the
    // machine's too (M5-BE-26): a tombstone there retires a profile for good,
    // so a bot writing a sibling's would end that sibling's browser for good.
    for (const path of [
      '.chrome/Default/Cookies',
      '.config/anything',
      '.cache/x',
      '.crewaid-deleted-profiles/clx9z8y7x6w5v4u3t2s1r0q9',
    ]) {
      expect(refused(`${MACHINE_HOME}/${path}`)).toContain('belongs to the machine');
    }
  });

  it('lets a bot into its own browser profile, and no one else’s', () => {
    // M5-BE-26: one Chrome profile per bot, under a machine-owned directory.
    // Refusing a bot its own profile would stop it reading the cookies it is
    // itself logged in with; allowing a sibling's would undo the isolation
    // the profiles exist for.
    expect(allowed(`${MACHINE_HOME}/.chrome/${BOT}/Cookies`)).toBe(
      `${MACHINE_HOME}/.chrome/${BOT}/Cookies`,
    );
    expect(refused(`${MACHINE_HOME}/.chrome/clx9z8y7x6w5v4u3t2s1r0q9/Cookies`)).toContain(
      'belongs to the machine',
    );
    // And the refusal names the profile that IS theirs.
    expect(refused(`${MACHINE_HOME}/.chrome/Default/Cookies`)).toContain(
      `${MACHINE_HOME}/.chrome/${BOT}`,
    );
  });

  it('keeps a bot out of another bot’s area, and says where to go instead', () => {
    const reason = refused(`${MACHINE_HOME}/agents/someone-else/notes.md`);
    expect(reason).toContain("another bot's area");
    // A refusal a model can act on: it names the right place.
    expect(reason).toContain(OWN);
    expect(reason).toContain(`${MACHINE_HOME}/shared`);
  });

  it('lets a bot list the agents directory itself', () => {
    // Nothing secret about the directory; the refusal is about reaching INTO
    // a sibling, and being stricter here would stop a bot discovering who
    // else works on this machine.
    expect(allowed(`${MACHINE_HOME}/agents`)).toBe(`${MACHINE_HOME}/agents`);
  });

  it('refuses nothing at all rather than guessing what was meant', () => {
    expect(refused('')).toContain('required');
    expect(refused('   ')).toContain('required');
  });

  it('is decided by the bot it is asked about', () => {
    const other = 'clx9z8y7x6w5v4u3t2s1r0q9';
    expect(resolveWorkspacePath(other, `${MACHINE_HOME}/agents/${other}/n.md`).ok).toBe(true);
    expect(resolveWorkspacePath(other, `${OWN}/n.md`).ok).toBe(false);
  });
});

describe('D-131 group folders', () => {
  const GROUP = 'clx4m5n6o7p8q9r0s1t2u3v4';
  const OTHER_GROUP = 'clx7h8i9j0k1l2m3n4o5p6q7';

  it("lets a bot into its own group's folder", () => {
    const path = `${MACHINE_HOME}/groups/${GROUP}/brief.md`;
    const verdict = resolveWorkspacePath(BOT, path, GROUP);
    expect(verdict).toEqual({ ok: true, path });
  });

  it("refuses another group's folder, and names the right one", () => {
    const verdict = resolveWorkspacePath(BOT, `${MACHINE_HOME}/groups/${OTHER_GROUP}/x.md`, GROUP);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain(`${MACHINE_HOME}/groups/${GROUP}`);
  });

  it('refuses every group folder to a bot in no group', () => {
    expect(resolveWorkspacePath(BOT, `${MACHINE_HOME}/groups/${GROUP}/x.md`).ok).toBe(false);
    expect(resolveWorkspacePath(BOT, `${MACHINE_HOME}/groups/${GROUP}/x.md`, null).ok).toBe(false);
  });

  it('refuses a climb out of the group folder into another', () => {
    const climb = `${MACHINE_HOME}/groups/${GROUP}/../${OTHER_GROUP}/x.md`;
    expect(resolveWorkspacePath(BOT, climb, GROUP).ok).toBe(false);
  });

  it('still allows the groups directory itself, which names no group', () => {
    // Listing `groups/` tells a bot nothing it cannot learn from its prompt,
    // and refusing it would be stricter than the rule needs.
    expect(resolveWorkspacePath(BOT, `${MACHINE_HOME}/groups`, GROUP).ok).toBe(true);
  });
});

describe('resolveWorkspaceSearchPlan', () => {
  const GROUP = 'clx4m5n6o7p8q9r0s1t2u3v4';

  it('defaults omitted path to the bot’s own area', () => {
    expect(resolveWorkspaceSearchPlan(BOT, undefined, null)).toEqual({
      ok: true,
      mode: 'root',
      path: OWN,
      excludes: ['.git', 'node_modules'],
    });
  });

  it('returns machine-home mode skipping MACHINE_OWNED, agents, and groups when searching /home/bot', () => {
    const plan = resolveWorkspaceSearchPlan(BOT, MACHINE_HOME, GROUP);
    expect(plan).toMatchObject({
      ok: true,
      mode: 'machine-home',
      ownDir: OWN,
      groupDir: `${MACHINE_HOME}/groups/${GROUP}`,
    });
    if (plan.ok && plan.mode === 'machine-home') {
      for (const dir of MACHINE_OWNED) expect(plan.skipTopLevel).toContain(dir);
      expect(plan.skipTopLevel).toContain('agents');
      expect(plan.skipTopLevel).toContain('groups');
    }
  });

  it('narrows /home/bot/agents and /home/bot/groups so sibling folders are never scanned', () => {
    expect(resolveWorkspaceSearchPlan(BOT, `${MACHINE_HOME}/agents`, null)).toMatchObject({
      ok: true,
      mode: 'root',
      path: OWN,
    });
    expect(resolveWorkspaceSearchPlan(BOT, `${MACHINE_HOME}/groups`, null)).toEqual({
      ok: true,
      mode: 'empty',
    });
    expect(resolveWorkspaceSearchPlan(BOT, `${MACHINE_HOME}/groups`, GROUP)).toMatchObject({
      ok: true,
      mode: 'root',
      path: `${MACHINE_HOME}/groups/${GROUP}`,
    });
  });

  it('anchors relative paths and search roots against an explicit baseDir when valid', () => {
    const repo = `${OWN}/my-repo`;
    expect(resolveWorkspacePath(BOT, 'src/index.ts', null, repo)).toEqual({
      ok: true,
      path: `${repo}/src/index.ts`,
    });
    expect(resolveWorkspacePath(BOT, '.', null, repo)).toEqual({
      ok: true,
      path: repo,
    });
    expect(resolveWorkspaceSearchPlan(BOT, undefined, null, repo)).toEqual({
      ok: true,
      mode: 'root',
      path: repo,
      excludes: ['.git', 'node_modules'],
    });
    // Still refuses escapes out of /home/bot or into another bot's area.
    expect(resolveWorkspacePath(BOT, '../../../../etc/passwd', null, repo).ok).toBe(false);
    expect(resolveWorkspacePath(BOT, 'src/index.ts', null, '/etc').ok).toBe(false);
    expect(
      resolveWorkspacePath(BOT, 'src/index.ts', null, `${MACHINE_HOME}/agents/someone-else`).ok,
    ).toBe(false);
  });
});
