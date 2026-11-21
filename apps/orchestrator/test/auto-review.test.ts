import { describe, expect, it } from 'vitest';
import {
  AutoReviewDecisionSchema,
  AutoReviewRulesSchema,
  DEFAULT_AUTO_REVIEW_RULES,
  type ApprovalMode,
  type AutoReviewRule,
} from '@crewaid/shared';

import { decideAutoReview, type AutoReviewOutcome } from '../src/agent/auto-review.js';
import { ToolRegistry, type ToolBehavior } from '../src/agent/tool-registry.js';
import { browserTools } from '../src/agent/browser-tools.js';
import { computerTools } from '../src/agent/computer-tools.js';
import { identityTools } from '../src/agent/identity-tools.js';
import { boardTools } from '../src/agent/board-tools.js';
import { memoryTools } from '../src/agent/memory-tools.js';
import { skillTools } from '../src/agent/skill-tools.js';
import { sendMessageTool } from '../src/interbot/send-message.tool.js';
import type { MemoryService } from '../src/memory/memory.service.js';

/**
 * CC-31: the memory tools take a MemoryService at registration. This suite
 * only reads their NAMES and argument schemas — it never executes one — so a
 * stub is honest here. A test that calls a tool needs the real service and a
 * database (see memory-tools.integration.test.ts).
 */
const NO_MEMORY_SERVICE = {} as MemoryService;

/**
 * M5-BE-08 — PRD §6/M5's "ordered fixtures for allow, ask, deny, and default
 * fallthrough", plus the branches that decide what happens when the inputs are
 * not the shape the happy path assumes.
 *
 * Those branches are the point. `Bot.autoReviewRules` is a Json column, the
 * tool name comes from a model, and the matcher runs inside a turn that §6
 * forbids it to fail — so "what does it do with a rules column holding a
 * string" is a specification question, not an edge case.
 */

/**
 * D-092 — the fallthrough now reads the tool's reach, so a descriptor is no
 * longer interchangeable. `SENSITIVE` is what the generic matcher cases below
 * are written against: they are about which RULE matched, and a tool whose
 * unmatched answer is `ask` keeps "nothing matched" visible in the assertion.
 */
const SENSITIVE: ToolBehavior = {
  origin: { kind: 'builtin' },
  failure: { kind: 'isolate' },

  effect: 'unknown',
  authority: false,
};
const CONTAINED: ToolBehavior = { ...SENSITIVE, effect: 'draft', authority: false };
const BUILTIN = SENSITIVE;

/**
 * Every outcome this suite produced, for the coverage guard at the bottom.
 *
 * Collected rather than declared: a list written by hand says what someone
 * believed was covered, while this says what the cases actually exercised.
 */
const observed: AutoReviewOutcome[] = [];

function record<T extends AutoReviewOutcome>(outcome: T): T {
  observed.push(outcome);
  return outcome;
}

function decide(
  rules: unknown,
  toolName: string,
  args: unknown = {},
  behavior: ToolBehavior = BUILTIN,
  mode?: ApprovalMode,
) {
  return record(decideAutoReview({ rules, toolName, args, behavior, mode }));
}

describe('the auto-review matcher (M5-BE-08)', () => {
  it('returns each of the three decisions a rule can carry', () => {
    const rules: AutoReviewRule[] = [
      { toolPattern: 'browser_read', decision: 'allow' },
      { toolPattern: 'browser_click', decision: 'ask' },
      { toolPattern: 'shell', decision: 'deny' },
    ];

    expect(decide(rules, 'browser_read').decision).toBe('allow');
    expect(decide(rules, 'browser_click').decision).toBe('ask');
    expect(decide(rules, 'shell').decision).toBe('deny');
  });

  it('falls through to the TOOL when nothing matches (D-092)', () => {
    const rules: AutoReviewRule[] = [{ toolPattern: 'browser_read', decision: 'allow' }];

    // A shell is unbounded, so an unmatched call still stops and asks…
    expect(decide(rules, 'shell', {}, SENSITIVE)).toEqual({
      decision: 'ask',
      source: { kind: 'default' },
    });
    // …while a tool that touches nothing but the bot's own computer runs.
    // This is the babysitting fix: before it, EVERY tool nobody had written a
    // rule about interrupted the turn, and a rule list only ever reached the
    // bots created after it was written.
    expect(decide(rules, 'attach_file', {}, CONTAINED)).toEqual({
      decision: 'allow',
      source: { kind: 'default' },
    });
  });

  it('asks about an unbounded tool when the bot has no rules at all', () => {
    // Reachable two ways an operator can produce: an explicit `[]` in
    // `POST /bots`, and every row written before D-064 seeded a list.
    expect(decide([], 'shell', {}, SENSITIVE)).toEqual({
      decision: 'ask',
      source: { kind: 'default' },
    });
  });

  it('takes the FIRST match, not the last and not the most specific', () => {
    // The whole contract is order. A matcher that kept scanning would let a
    // broad `deny` at the bottom of a list quietly override the narrow `allow`
    // an operator put at the top to carve an exception out of it.
    const rules: AutoReviewRule[] = [
      { toolPattern: 'browser_read', decision: 'allow' },
      { toolPattern: 'browser_*', decision: 'deny' },
      { toolPattern: '*', decision: 'deny' },
    ];

    const outcome = decide(rules, 'browser_read');

    expect(outcome.decision).toBe('allow');
    expect(outcome.source).toEqual({ kind: 'rule', index: 0, rule: rules[0] });
  });

  it('reports which rule decided, so a surprising decision is traceable', () => {
    const rules: AutoReviewRule[] = [
      { toolPattern: 'browser_read', decision: 'allow' },
      { toolPattern: 'shell', decision: 'deny' },
    ];

    expect(decide(rules, 'shell').source).toEqual({ kind: 'rule', index: 1, rule: rules[1] });
  });

  describe('toolPattern', () => {
    it('matches a trailing * as a prefix — the whole point of it (D-005)', () => {
      // `gmail__*` is how an operator says "every tool from this MCP server"
      // without listing tools the server has not told us about yet.
      const rules: AutoReviewRule[] = [{ toolPattern: 'gmail__*', decision: 'allow' }];

      expect(decide(rules, 'gmail__send').decision).toBe('allow');
      expect(decide(rules, 'gmail__').decision).toBe('allow');
      expect(decide(rules, 'gmail_send').decision).toBe('ask');
      expect(decide(rules, 'notgmail__send').decision).toBe('ask');
    });

    it('treats a bare * as every tool', () => {
      const rules: AutoReviewRule[] = [{ toolPattern: '*', decision: 'deny' }];

      expect(decide(rules, 'anything_at_all').decision).toBe('deny');
    });

    it('matches exactly when there is no wildcard', () => {
      const rules: AutoReviewRule[] = [{ toolPattern: 'shell', decision: 'allow' }];

      expect(decide(rules, 'shell').decision).toBe('allow');
      expect(decide(rules, 'shell_exec').decision).toBe('ask');
    });

    it('is case-sensitive, because tool names are', () => {
      // The registry admits `^[A-Za-z0-9_-]{1,64}$`, so `Shell` and `shell` are
      // two different tools and a rule about one is not a rule about the other.
      const rules: AutoReviewRule[] = [{ toolPattern: 'Shell', decision: 'allow' }];

      expect(decide(rules, 'shell').decision).toBe('ask');
    });

    it('matches nothing when the * is not trailing, and says so', () => {
      // No legal tool name contains `*`, so `*_send` is a dead rule. The
      // behaviour is right and invisible, which is why it is logged: an
      // operator who wrote it sees no error and no effect.
      const warnings: string[] = [];
      const logger = { warn: (event: string) => warnings.push(event) };

      const outcome = decideAutoReview({
        rules: [{ toolPattern: '*_send', decision: 'allow' }],
        toolName: 'gmail_send',
        args: {},
        behavior: BUILTIN,
        logger: logger as never,
      });

      expect(outcome.decision).toBe('ask');
      expect(warnings).toContain('agent.autoreview.rule.dead-wildcard');
    });
  });

  describe('argMatch', () => {
    it('narrows a rule to calls whose serialized arguments contain it', () => {
      const rules: AutoReviewRule[] = [
        { toolPattern: 'shell', argMatch: 'rm -rf', decision: 'deny' },
        { toolPattern: 'shell', decision: 'allow' },
      ];

      expect(decide(rules, 'shell', { command: 'rm -rf /' }).decision).toBe('deny');
      expect(decide(rules, 'shell', { command: 'ls -la' }).decision).toBe('allow');
    });

    it('falls through to the next rule when the arguments do not contain it', () => {
      // An argMatch that misses must not consume the match. If it did, a
      // narrow `deny` at the top would shadow every later rule for that tool.
      const rules: AutoReviewRule[] = [
        { toolPattern: 'browser_navigate', argMatch: 'admin', decision: 'ask' },
        { toolPattern: 'browser_navigate', decision: 'allow' },
      ];

      const outcome = decide(rules, 'browser_navigate', { url: 'https://example.com' });

      expect(outcome.decision).toBe('allow');
      expect(outcome.source).toEqual({ kind: 'rule', index: 1, rule: rules[1] });
    });

    it('tests the serialized form, so it can reach a key as well as a value', () => {
      const rules: AutoReviewRule[] = [
        { toolPattern: '*', argMatch: '"password"', decision: 'deny' },
      ];

      expect(decide(rules, 'http_post', { password: 'hunter2' }).decision).toBe('deny');
      expect(decide(rules, 'http_post', { username: 'alice' }).decision).toBe('ask');
    });

    it('does not fire on arguments that will not serialize, and never allows on them', () => {
      // Tool arguments have already been through the SDK's schema parse, so
      // this is defensive. It is here because the alternative to the defence is
      // an exception on the approval path, and the direction matters: a rule
      // that cannot evaluate its condition falls through toward `ask`, never
      // toward `allow`.
      const circular: Record<string, unknown> = {};
      circular['self'] = circular;
      const warnings: string[] = [];
      const logger = { warn: (event: string) => warnings.push(event) };

      const outcome = decideAutoReview({
        rules: [
          { toolPattern: 'shell', argMatch: 'rm', decision: 'allow' },
          { toolPattern: 'shell', decision: 'deny' },
        ],
        toolName: 'shell',
        args: circular,
        behavior: BUILTIN,
        logger: logger as never,
      });

      expect(outcome.decision).toBe('deny');
      expect(warnings).toContain('agent.autoreview.args.unserializable');
    });

    it('handles arguments that serialize to nothing at all', () => {
      // `JSON.stringify(undefined)` is `undefined`, not a string. A tool
      // declared with no parameters is called with exactly that.
      const rules: AutoReviewRule[] = [
        { toolPattern: 'screenshot', argMatch: 'x', decision: 'allow' },
        { toolPattern: 'screenshot', decision: 'deny' },
      ];

      expect(decide(rules, 'screenshot', undefined).decision).toBe('deny');
    });
  });

  describe('inputs that are not the shape the happy path assumes', () => {
    it('denies a tool the registry does not know', () => {
      // A name nothing is registered under cannot run — there is no execute to
      // call — so the only question is whether it fails as a tool result the
      // model can react to or as an exception inside the turn. §6 answers that.
      const outcome = decideAutoReview({
        rules: [{ toolPattern: '*', decision: 'allow' }],
        toolName: 'gmail__wire_transfer',
        args: {},
        behavior: undefined,
      });

      expect(record(outcome)).toEqual({ decision: 'deny', source: { kind: 'unregistered' } });
    });

    it('checks registration BEFORE the rules, so a prefix cannot admit a ghost', () => {
      // `gmail__*` → allow is an honest rule about a server's tools. It must
      // not become permission for a name that server never reported.
      const registry = new ToolRegistry();
      registry.register({
        name: 'gmail__send',
        build: () => ({}) as never,
        behavior: {
          origin: { kind: 'mcp', serverId: 'srv_1' },
          failure: { kind: 'isolate' },
          // §6/M6: an MCP tool that is not classified read-only asks.

          effect: 'unknown',
          authority: false,
        },
      });
      const rules: AutoReviewRule[] = [{ toolPattern: 'gmail__*', decision: 'allow' }];

      const real = decideAutoReview({
        rules,
        toolName: 'gmail__send',
        args: {},
        behavior: registry.tryBehaviorOf('gmail__send'),
      });
      const ghost = decideAutoReview({
        rules,
        toolName: 'gmail__wire_transfer',
        args: {},
        behavior: registry.tryBehaviorOf('gmail__wire_transfer'),
      });

      expect(real.decision).toBe('allow');
      expect(ghost.decision).toBe('deny');
    });

    it('sets aside a rules column that does not parse, rather than part of it', () => {
      // Keeping the entries that happen to parse deletes whichever rule is
      // malformed, and a deleted `deny` is a hole nobody can see. Setting the
      // list aside sends every call to `ask` — visible, and recoverable by the
      // operator who broke it.
      const warnings: string[] = [];
      const logger = { warn: (event: string) => warnings.push(event) };

      const outcome = decideAutoReview({
        rules: [
          { toolPattern: 'browser_read', decision: 'allow' },
          { toolPattern: 'shell', decision: 'obliterate' },
        ],
        toolName: 'browser_read',
        args: {},
        behavior: BUILTIN,
        logger: logger as never,
      });

      // The VALID `allow` above it does not survive either. That is the point:
      // a partly-readable list is not a policy.
      expect(record(outcome)).toEqual({ decision: 'ask', source: { kind: 'unreadable-rules' } });
      expect(warnings).toContain('agent.autoreview.rules.unreadable');
    });

    it('asks rather than throwing when the column is not a list', () => {
      // A Json column holds whatever was written to it. Each of these is a
      // decision, not an exception, because the caller is inside a turn.
      for (const rules of [null, undefined, 'ask', 42, { toolPattern: '*' }]) {
        expect(decide(rules, 'shell')).toEqual({
          decision: 'ask',
          source: { kind: 'unreadable-rules' },
        });
      }
    });

    it('never throws, whatever it is handed', () => {
      const hostile: unknown[] = [
        [{ toolPattern: '', decision: 'allow' }],
        [{ toolPattern: 'x'.repeat(500), decision: 'allow' }],
        [{ toolPattern: '*', decision: 'allow', argMatch: '' }],
        [{}],
        [[]],
        Symbol('nope'),
      ];

      for (const rules of hostile) {
        expect(() => decide(rules, 'shell')).not.toThrow();
      }
    });
  });
});

describe('the policy a bot actually runs under (D-064, rewritten by D-092)', () => {
  /**
   * The seeded list is only half the policy since D-092 — the other half is
   * the tool's own reach — so every case below decides with the REAL
   * descriptor the registry holds, exactly as a turn does. A classification
   * changed in `browser-tools.ts` and forgotten here is a failing test, not a
   * passing one about a fixture.
   */
  const registry = new ToolRegistry();
  for (const registered of [
    ...browserTools(),
    // The dependency is a PORT, not a live machine: nothing in these two
    // sweeps executes a tool (see the comment on `session` above).
    ...computerTools({ machines: { ensureSeatFor: () => Promise.reject(new Error('unused')) } }),
    ...identityTools(),
    ...boardTools(),
    ...memoryTools(NO_MEMORY_SERVICE),
    ...skillTools({} as never),
    sendMessageTool({} as never),
  ]) {
    registry.register(registered);
  }

  const shipped = (toolName: string, args: unknown = {}) =>
    decide(DEFAULT_AUTO_REVIEW_RULES, toolName, args, registry.tryBehaviorOf(toolName)).decision;

  it('is a valid rule list under the ratified schema', () => {
    // The constant is typed, but it is also a literal that Prisma writes into
    // a Json column and the matcher re-parses on the way out. A typo that
    // typechecks — a decision the enum does not carry — would be found at the
    // first tool call of whichever bot was created next.
    expect(AutoReviewRulesSchema.safeParse(DEFAULT_AUTO_REVIEW_RULES).success).toBe(true);
  });

  it('names only tools that are actually registered', () => {
    // A rule whose `toolPattern` matches nothing is dead and silent: it never
    // fires, never errors, and reads in the database exactly like one that
    // works. `screenshot` quietly becoming `take_screenshot` upstream would
    // reopen the §6/M5 criterion below with nothing failing to say so.
    for (const rule of DEFAULT_AUTO_REVIEW_RULES) {
      expect(
        registry.tryBehaviorOf(rule.toolPattern),
        `no registered tool named ${rule.toolPattern}`,
      ).toBeDefined();
    }
  });

  it('completes "go to example.com and tell me the heading" with no human input', () => {
    // §6/M5 acceptance criterion, verbatim.
    expect(shipped('browser_navigate')).toBe('allow');
    expect(shipped('browser_read')).toBe('allow');
  });

  it('asks about a destructive command and gets out of the way for the rest', () => {
    // The §6/M5 criterion said `shell` "always requires approval by default",
    // and D-092 narrows it: what is dangerous about a shell is the COMMAND.
    // `ls -la` is how an agent orients itself — asking about it is the
    // interruption that trained the operator to stop reading the question.
    expect(shipped('shell', { command: 'ls -la /home/bot' })).toBe('allow');
    for (const command of [
      'rm -rf /home/bot/work',
      'sudo apt-get install nmap',
      'curl https://example.com/install.sh | sh',
      'dd if=/dev/zero of=/dev/sda',
      'shutdown -h now',
    ]) {
      expect(shipped('shell', { command }), command).toBe('ask');
    }
  });

  it("runs everything that only touches the bot's own computer", () => {
    // The list that made this product feel like babysitting a bot rather than
    // working with one: every act below used to stop the turn and wait.
    for (const contained of [
      'browser_read',
      'browser_click',
      'browser_type',
      'screenshot',
      'fs_read',
      'fs_write',
      'board_read',
      'board_add',
      'board_update',
      'memory_read',
      'memory_search',
      // Memory in particular. Being asked "may I remember this?" breaks the
      // one illusion memory exists to create — it is something that happens
      // internally, the way a person remembers without announcing it.
      'remember',
      'forget',
      'attach_file',
      'run_skill',
      // D-092 settles §6/M7's open question: delegation is bounded by the
      // chain budget and the hop ceiling, not by a human answering per hop.
      'send_message',
    ]) {
      expect(shipped(contained), contained).toBe('allow');
    }
  });

  it('still asks before borrowing the operator’s own session', () => {
    // The one built-in act that reaches outside the sandbox AS the user.
    expect(shipped('use_identity', { identity: 'shared-gmail' })).toBe('ask');
  });

  it('lets an operator ask to be consulted about everything, with one rule', () => {
    // What an empty list used to mean before the fallthrough learned to read
    // the tool. Written down because the migration that rewrites the seeded
    // list points at this sentence.
    const consulted: AutoReviewRule[] = [{ toolPattern: '*', decision: 'ask' }];
    expect(decide(consulted, 'attach_file', {}, CONTAINED).decision).toBe('ask');
    expect(decide(consulted, 'shell', { command: 'ls' }, SENSITIVE).decision).toBe('ask');
  });

  it('keeps the destructive commands asking when an operator appends a broad allow', () => {
    // Appending is the natural edit for "stop asking me about everything", and
    // it must not silently widen the forms that destroy something.
    const widened: AutoReviewRule[] = [
      ...DEFAULT_AUTO_REVIEW_RULES,
      { toolPattern: '*', decision: 'allow' },
    ];

    expect(decide(widened, 'shell', { command: 'rm -rf /' }).decision).toBe('ask');
    expect(decide(widened, 'use_identity').decision).toBe('ask');
    expect(decide(widened, 'browser_click').decision).toBe('allow');
  });

  it('can still be overridden completely, because order is the contract', () => {
    // The escape hatch that makes the rule above cheap: an operator who really
    // wants unattended `rm -rf` prepends, and first-match-wins does the rest.
    const prepended: AutoReviewRule[] = [
      { toolPattern: 'shell', decision: 'allow' },
      ...DEFAULT_AUTO_REVIEW_RULES,
    ];

    expect(decide(prepended, 'shell', { command: 'rm -rf /' }).decision).toBe('allow');
  });
});

describe('approval modes (D-144)', () => {
  // The real descriptors, so a reader relabelled in its own file is what is
  // tested rather than a fixture that agrees with this one.
  const registry = new ToolRegistry();
  for (const registered of [
    ...browserTools(),
    ...computerTools({ machines: { ensureSeatFor: () => Promise.reject(new Error('unused')) } }),
    ...identityTools(),
    ...boardTools(),
    ...memoryTools(NO_MEMORY_SERVICE),
  ]) {
    registry.register(registered);
  }
  const under = (
    mode: ApprovalMode,
    toolName: string,
    args: unknown = {},
    rules: unknown = DEFAULT_AUTO_REVIEW_RULES,
  ) => decide(rules, toolName, args, registry.tryBehaviorOf(toolName), mode).decision;

  it('Approve for me is the behaviour every bot already had', () => {
    for (const [tool, args] of [
      ['fs_write', { path: '/tmp/a', content: 'x' }],
      ['browser_click', { selector: 'button' }],
      ['shell', { command: 'ls -la' }],
      ['shell', { command: 'rm -rf /' }],
      ['use_identity', {}],
    ] as const) {
      expect({ tool, auto: under('AUTO', tool, args) }).toEqual({
        tool,
        auto: decide(DEFAULT_AUTO_REVIEW_RULES, tool, args, registry.tryBehaviorOf(tool)).decision,
      });
    }
  });

  it('Ask for approval asks before every act, and never before a look', () => {
    for (const tool of [
      'fs_write',
      'browser_click',
      'browser_navigate',
      'board_add',
      'remember',
      'shell',
      'use_identity',
    ]) {
      expect({ tool, decision: under('ASK', tool, { command: 'ls' }) }).toEqual({
        tool,
        decision: 'ask',
      });
    }
    for (const tool of [
      'fs_read',
      'browser_read',
      'screenshot',
      'board_read',
      'memory_read',
      'memory_search',
    ]) {
      expect({ tool, decision: under('ASK', tool) }).toEqual({ tool, decision: 'allow' });
    }
    // A rule that allows an act does not outvote the mode the operator chose.
    expect(under('ASK', 'fs_write', {}, [{ toolPattern: 'fs_write', decision: 'allow' }])).toBe(
      'ask',
    );
  });

  it('Full access asks about nothing, the destructive shell and the borrowed session included', () => {
    for (const [tool, args] of [
      ['shell', { command: 'rm -rf /tmp/x' }],
      ['use_identity', {}],
      ['fs_write', { path: '/tmp/a', content: 'x' }],
    ] as const) {
      expect({ tool, decision: under('FULL', tool, args) }).toEqual({ tool, decision: 'allow' });
    }
  });

  it('keeps a deny in every mode, and refuses an unknown tool in every mode', () => {
    const deny = [{ toolPattern: 'fs_write', decision: 'deny' as const }];
    for (const mode of ['ASK', 'AUTO', 'FULL'] as const) {
      expect({ mode, decision: under(mode, 'fs_write', {}, deny) }).toEqual({
        mode,
        decision: 'deny',
      });
      // Straight to the matcher: the suite's helper fills in a default
      // descriptor, and an unknown tool is precisely one that has none.
      const unknown = record(
        decideAutoReview({
          rules: [],
          toolName: 'wire_money',
          args: {},
          behavior: undefined,
          mode,
        }),
      );
      expect({ mode, decision: unknown.decision }).toEqual({ mode, decision: 'deny' });
    }
  });

  it('names the mode as the reason, so a log line says why', () => {
    expect(
      decide(DEFAULT_AUTO_REVIEW_RULES, 'fs_write', {}, registry.tryBehaviorOf('fs_write'), 'ASK')
        .source,
    ).toEqual({
      kind: 'mode',
      mode: 'ASK',
    });
  });
});

describe('M5-QA-02 the fixture set is complete, and stays complete', () => {
  /**
   * The guard that makes the cases above a SPECIFICATION rather than a
   * sample.
   *
   * §6/M5 fixes three decisions and a fallthrough, and every one has a case.
   * What nothing enforced is that the NEXT member gets one too — M5-BE-15
   * added the `turn-approved` source to this union without any test being
   * obliged to notice, and the same would be true of a fourth decision. This
   * fails the build instead, in the file whose job it is to have the fixture.
   *
   * Written against the outcomes the suite actually PRODUCED rather than a
   * hand-kept list, so it cannot drift into agreeing with itself.
   */
  it('exercises every decision the vocabulary has', () => {
    const decisions = new Set(observed.map((outcome) => outcome.decision));
    expect([...decisions].sort()).toEqual([...AutoReviewDecisionSchema.options].sort());
  });

  it('exercises every source a decision can come from', () => {
    // `turn-approved` is the one the matcher never produces: it is synthesized
    // by the turn's approval policy (M5-BE-15), and `tool-approval.test.ts`
    // owns it. Named here rather than silently excluded, so removing it from
    // the union leaves a dangling name instead of a quietly smaller set.
    const matcherSources = new Set(observed.map((outcome) => outcome.source.kind));
    expect([...matcherSources].sort()).toEqual([
      'default',
      'mode',
      'rule',
      'unreadable-rules',
      'unregistered',
    ]);

    const everySource: AutoReviewOutcome['source']['kind'][] = [...matcherSources, 'turn-approved'];
    // Exhaustive by construction: a source added to the union with no home
    // here fails to typecheck the switch below.
    for (const kind of everySource) {
      switch (kind) {
        case 'rule':
        case 'default':
        case 'mode':
        case 'unregistered':
        case 'unreadable-rules':
        case 'turn-approved':
          break;
        default: {
          const unhandled: never = kind;
          throw new Error(`unhandled source ${String(unhandled)}`);
        }
      }
    }
  });
});

describe('ToolRegistry.tryBehaviorOf (M5-BE-08)', () => {
  it('answers undefined where behaviorOf throws', () => {
    // Two lookups for two different questions. `behaviorOf` is asked about a
    // tool the caller registered, where absence is a wiring bug; this is asked
    // once per tool call about a name a model produced, where absence is an
    // ordinary answer and a throw would fail the turn.
    const registry = new ToolRegistry();
    registry.register({ name: 'shell', build: () => ({}) as never, behavior: BUILTIN });

    expect(registry.tryBehaviorOf('shell')).toEqual(BUILTIN);
    expect(registry.tryBehaviorOf('nope')).toBeUndefined();
    expect(() => registry.behaviorOf('nope')).toThrow(/No tool named/);
  });

  it('does not default an unknown name to a classification', () => {
    // The third option the task note names, and the one that must not exist:
    // a defaulted builtin/isolate classifies a tool nobody classified.
    expect(new ToolRegistry().tryBehaviorOf('anything')).not.toEqual(BUILTIN);
  });
});
