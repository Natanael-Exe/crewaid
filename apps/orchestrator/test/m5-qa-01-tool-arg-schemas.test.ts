import { describe, expect, it } from 'vitest';
import type { ToolDefinition as Tool } from '../src/agent/tool-contract.js';
import { z } from 'zod';
import { browserTools } from '../src/agent/browser-tools.js';
import { computerTools } from '../src/agent/computer-tools.js';
import { identityTools } from '../src/agent/identity-tools.js';
import { boardTools } from '../src/agent/board-tools.js';
import { memoryTools } from '../src/agent/memory-tools.js';
import type { MemoryService } from '../src/memory/memory.service.js';

/**
 * CC-31: the memory tools take a MemoryService at registration. This suite
 * only reads their NAMES and argument schemas — it never executes one — so a
 * stub is honest here. A test that calls a tool needs the real service and a
 * database (see memory-tools.integration.test.ts).
 */
const NO_MEMORY_SERVICE = {} as MemoryService;
import { skillTools } from '../src/agent/skill-tools.js';
import { sendMessageTool } from '../src/interbot/send-message.tool.js';
import type { RegisteredTool, ToolContext } from '../src/agent/tool-registry.js';
import { MACHINE_HOME, resolveWorkspacePath } from '../src/agent/workspace-paths.js';

/**
 * M5-QA-01 — what a tool will accept, and where it will let a bot go.
 *
 * The path half is the §6/M5 rejection list and is covered from two sides:
 * `workspace-paths.test.ts` pins the resolver, `computer-tools.test.ts` pins
 * what `fs_read`/`fs_write` tell the model. What nothing covered is the ARG
 * SCHEMAS — every built-in declares one, the SDK validates against it before
 * `execute` is ever reached, and no test had ever asked one of them a
 * question. A tool that accepted `{}` where §6/M5 names a parameter would
 * fail at the first real call instead of here.
 *
 * Every schema is asked BOTH questions. A schema that accepts everything
 * passes a rejection-only test by doing nothing, and one that accepts nothing
 * passes an acceptance-only test the same way.
 */

const BOT = 'clx1a2b3c4d5e6f7g8h9i0j1';

/** A context whose accessors would throw — nothing here calls `execute`. */
const CONTEXT = {
  userId: 'user-under-test',
  botId: BOT,
  messageId: 'message-under-test',
  trigger: { id: 'trigger-under-test', chainId: null, hopCount: 0 },
  browser: () => Promise.reject(new Error('a schema test must not reach the browser')),
  session: () => Promise.reject(new Error('a schema test must not reach the sandbox')),
} as unknown as ToolContext;

/** Every built-in §6/M5 registers, by name. */
function allTools(): RegisteredTool[] {
  return [
    ...browserTools(),
    // The dependency is a PORT, not a live machine: nothing in these two
    // sweeps executes a tool (see the comment on `session` above).
    ...computerTools({ machines: { ensureSeatFor: () => Promise.reject(new Error('unused')) } }),
    ...identityTools(),
    ...boardTools(),
    ...memoryTools(NO_MEMORY_SERVICE),
    ...skillTools({
      runSkill: () => Promise.reject(new Error('unused')),
      attachFile: () => Promise.reject(new Error('unused')),
    } as never),
    // M7-BE-01 moved `send_message` out of the skill tools and gave it a
    // body. Its schema is still §6/M5's and still belongs in this sweep —
    // nothing here calls `execute`, so the ports only have to exist.
    sendMessageTool({
      queue: { enqueue: () => Promise.reject(new Error('unused')) },
      directory: { peers: () => Promise.reject(new Error('unused')) },
    }),
  ];
}

function schemaOf(name: string): z.ZodType {
  const entry = allTools().find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`no tool named ${name} is registered`);
  const built = entry.build(CONTEXT) as Tool & { inputSchema: unknown };
  const schema = built.inputSchema;
  if (!(schema instanceof z.ZodType)) {
    throw new Error(`${name} does not declare a Zod input schema`);
  }
  return schema;
}

const accepts = (name: string, input: unknown) => schemaOf(name).safeParse(input).success;

describe('M5-QA-01 every built-in declares an arg schema', () => {
  it('declares one for each tool §6/M5 names, and none that accepts anything', () => {
    const names = allTools().map((tool) => tool.name);
    expect(names.length).toBeGreaterThan(0);

    for (const name of names) {
      const schema = schemaOf(name);
      // The failure this catches is a tool typed loosely enough to be no
      // schema at all: `z.any()`, or an object with a passthrough catch-all.
      // Either admits a string where an object belongs, which is what a
      // confused model actually sends.
      expect(schema.safeParse('a bare string').success, `${name} accepted a bare string`).toBe(
        false,
      );
      expect(schema.safeParse(42).success, `${name} accepted a number`).toBe(false);
      expect(schema.safeParse(null).success, `${name} accepted null`).toBe(false);
    }
  });
});

describe('M5-QA-01 the board tools', () => {
  it('requires the text it edits, and refuses the wrong types', () => {
    // `board_read` takes nothing, which is exactly why it is here: a no-arg
    // tool is the easiest one to declare as `z.any()` by accident.
    expect(accepts('board_read', {})).toBe(true);

    expect(accepts('board_add', { entry: '- [ ] Draft the copy' })).toBe(true);
    expect(accepts('board_add', {})).toBe(false);
    expect(accepts('board_add', { entry: 12 })).toBe(false);

    // Both halves required. A `board_update` that admitted a missing
    // `replace` would delete the entry the model meant to reword.
    expect(accepts('board_update', { find: 'a', replace: 'b' })).toBe(true);
    expect(accepts('board_update', { find: 'a' })).toBe(false);
    expect(accepts('board_update', { replace: 'b' })).toBe(false);
    expect(accepts('board_update', { find: 'a', replace: 12 })).toBe(false);
  });
});

describe('M5-QA-01 the memory tools', () => {
  it('requires the fact, and refuses the wrong types', () => {
    expect(accepts('memory_read', {})).toBe(true);

    const fact = 'Staging is crewaid-staging.example.com';
    expect(accepts('remember', { fact, kind: 'fact', scope: 'workspace' })).toBe(true);
    expect(accepts('remember', {})).toBe(false);
    expect(accepts('remember', { fact: 12, kind: 'fact', scope: 'workspace' })).toBe(false);

    expect(accepts('forget', { fact: 'Staging is old.example.com' })).toBe(true);
    expect(accepts('forget', {})).toBe(false);
  });

  it('gives `scope` no default, so the model has to choose (CC-31)', () => {
    // Not an oversight and not a strictness preference. A default `mine`
    // leaves the user-global memory permanently empty, which defeats the
    // whole point of a new bot starting with context; a default `workspace`
    // fills it with one bot's private notes. There is no safe default, so
    // there is no default.
    const fact = 'The client refuses em dashes';
    expect(accepts('remember', { fact, kind: 'convention' })).toBe(false);
    expect(accepts('remember', { fact, kind: 'convention', scope: 'workspace' })).toBe(true);
    expect(accepts('remember', { fact, kind: 'convention', scope: 'mine' })).toBe(true);
    expect(accepts('remember', { fact, kind: 'convention', scope: 'everyone' })).toBe(false);
  });

  it('accepts every kind it names, and nothing else', () => {
    const fact = 'A durable claim';
    for (const kind of ['preference', 'convention', 'fact', 'decision', 'task_state', 'resource']) {
      expect(accepts('remember', { fact, kind, scope: 'workspace' }), kind).toBe(true);
    }
    // `observed` is a SOURCE, not a kind: it is set by the code that read a
    // page, never chosen by a model describing its own claim (D-079).
    expect(accepts('remember', { fact, kind: 'observed', scope: 'workspace' })).toBe(false);
  });
});

describe('M5-QA-01 the browser tools', () => {
  it('requires the parameters §6/M5 names, and refuses the wrong types', () => {
    expect(accepts('browser_navigate', { url: 'https://example.com' })).toBe(true);
    expect(accepts('browser_navigate', {})).toBe(false);
    expect(accepts('browser_navigate', { url: 12 })).toBe(false);

    // `browser_read()` takes nothing — and must still refuse a non-object.
    expect(accepts('browser_read', {})).toBe(true);

    expect(accepts('browser_click', { reference: 'r123_e2' })).toBe(true);
    expect(accepts('browser_click', {})).toBe(false);
    expect(accepts('browser_click', { selector: '#go' })).toBe(false);

    expect(accepts('browser_type', { reference: 'r123_e3', text: 'hello' })).toBe(true);
    expect(accepts('browser_type', { reference: 'r123_e3' })).toBe(false);
    expect(accepts('browser_type', { text: 'hello' })).toBe(false);
  });
});

describe('M5-QA-01 the computer tools', () => {
  it('requires a command, a path, and a path with content', () => {
    expect(accepts('shell', { command: 'ls' })).toBe(true);
    expect(accepts('shell', {})).toBe(false);
    // An empty command is refused by the tool itself with a sentence the model
    // can read, which is `computer-tools.test.ts`'s case — the schema's job is
    // only that the field is there and is a string.
    expect(accepts('shell', { command: 42 })).toBe(false);

    expect(accepts('fs_read', { path: `${MACHINE_HOME}/agents/${BOT}/notes.md` })).toBe(true);
    expect(accepts('fs_read', {})).toBe(false);

    expect(accepts('fs_write', { path: 'notes.md', content: 'hello' })).toBe(true);
    expect(accepts('fs_write', { path: 'notes.md' })).toBe(false);
    expect(accepts('fs_write', { content: 'hello' })).toBe(false);
  });

  it('leaves WHERE a path may point to the resolver, not the schema', () => {
    // Deliberate, and worth stating: `/etc/shadow` is a perfectly good string,
    // so the schema admits it and the resolver refuses it. Putting the path
    // policy in the schema would make the refusal a validation error the model
    // cannot act on, instead of a sentence naming the directory to use.
    expect(accepts('fs_read', { path: '/etc/shadow' })).toBe(true);

    const verdict = resolveWorkspacePath(BOT, '/etc/shadow');
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain(`outside ${MACHINE_HOME}`);
  });
});

describe('M5-QA-01 the skill and identity tools', () => {
  it('requires a skill name, an attachment path, a recipient, and an identity', () => {
    expect(accepts('run_skill', { name: 'send-invoice' })).toBe(true);
    expect(accepts('run_skill', {})).toBe(false);

    expect(accepts('attach_file', { path: 'report.pdf' })).toBe(true);
    expect(accepts('attach_file', {})).toBe(false);

    expect(accepts('send_message', { toBot: 'Quill', content: 'ping' })).toBe(true);
    expect(accepts('send_message', { toBot: 'Quill' })).toBe(false);

    // `identity`, not `name` — the two skill tools above take `name`/`path`,
    // so the odd one out is exactly the parameter a caller guesses wrong.
    expect(accepts('use_identity', { identity: 'company-google' })).toBe(true);
    expect(accepts('use_identity', { name: 'company-google' })).toBe(false);
    expect(accepts('use_identity', {})).toBe(false);
  });
});

describe('M5-QA-01 the §6/M5 rejection list, through the tool arg it arrives as', () => {
  // `workspace-paths.test.ts` proves the resolver. These prove the two names
  // the task calls out reach it as the string a model would actually send,
  // including the relative spelling, which is the one a schema-only check
  // would wave through as "just a filename".
  const refused = (path: string) => {
    const verdict = resolveWorkspacePath(BOT, path);
    return verdict.ok === false ? verdict.reason : null;
  };

  it('rejects /etc/shadow however it is spelled', () => {
    expect(refused('/etc/shadow')).toContain(`outside ${MACHINE_HOME}`);
    expect(refused('../../../../etc/shadow')).toContain(`outside ${MACHINE_HOME}`);
    expect(refused(`${MACHINE_HOME}/agents/${BOT}/../../../etc/shadow`)).toContain(
      `outside ${MACHINE_HOME}`,
    );
    expect(refused(`${MACHINE_HOME}/../etc/shadow`)).toContain(`outside ${MACHINE_HOME}`);
  });

  it('rejects any escape from the home, and admits the paths that stay inside', () => {
    expect(refused('/root/.ssh/id_rsa')).toContain(`outside ${MACHINE_HOME}`);
    expect(refused('/proc/self/environ')).toContain(`outside ${MACHINE_HOME}`);
    expect(refused('/home/botswana/secrets')).toContain(`outside ${MACHINE_HOME}`);

    // The other half, so this is a boundary rather than a wall: a bot's own
    // area and the team's still resolve.
    expect(resolveWorkspacePath(BOT, 'notes.md').ok).toBe(true);
    expect(resolveWorkspacePath(BOT, `${MACHINE_HOME}/shared/plan.md`).ok).toBe(true);
  });
});
