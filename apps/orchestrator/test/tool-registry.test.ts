import { describe, expect, it } from 'vitest';
import { tool } from '../src/agent/tool-contract.js';
import { z } from 'zod';
import {
  ToolRegistry,
  type RegisteredTool,
  type ToolBehavior,
} from '../src/agent/tool-registry.js';

/**
 * M5-BE-03 — the tool registry.
 *
 * The registry owes two things, and they are easy to confuse because one is a
 * subset of the other. It owes the model a `ToolSet` — the definitions, and
 * only the definitions — and it owes the orchestrator the behavior descriptor
 * that is deliberately NOT on those definitions. A test that only checked the
 * first would pass against a registry that had quietly merged provenance into
 * the tool object, and that merge is the thing `AutoReviewRuleSchema` and
 * §0 rule 2 forbid; a test that only checked the second would pass against a
 * registry nothing ever read.
 */

/** One definition, shared by the cases that only care about identity. */
function ping(): ReturnType<typeof tool> {
  return tool({
    description: 'answers pong',
    inputSchema: z.object({ n: z.number() }),
    execute: async ({ n }: { n: number }) => `pong ${n}`,
  });
}

function registered(
  name: string,
  behavior: RegisteredTool['behavior'],
  definition = ping(),
): RegisteredTool {
  return { name, build: () => definition, behavior };
}

/** No tool under test needs anything from the turn. */
const noContext = {
  browser: async () => {
    throw new Error('not used');
  },
} as never;

const builtin = {
  origin: { kind: 'builtin' },
  failure: { kind: 'isolate' },

  effect: 'draft',
  authority: false,
} as const;

describe('M5-BE-03 registering tools', () => {
  it('keeps the names it was given, in registration order', () => {
    const registry = new ToolRegistry();
    registry.register(registered('ping', builtin));
    registry.register(registered('shell', builtin));

    expect(registry.names()).toEqual(['ping', 'shell']);
    expect(registry.has('ping')).toBe(true);
    expect(registry.has('fetch')).toBe(false);
  });

  it('refuses a duplicate instead of overwriting it', () => {
    // Overwriting would make the winner depend on registration order, which is
    // the kind of bug that shows up as "works until M6 registers two servers
    // with the same slug". The failure has to be at registration, where the
    // stack names the colliding caller.
    const registry = new ToolRegistry();
    registry.register(registered('ping', builtin));

    expect(() => registry.register(registered('ping', builtin))).toThrow(/already registered/);
    expect(registry.names()).toEqual(['ping']);
  });

  it('rejects names the model providers would reject', () => {
    const registry = new ToolRegistry();

    for (const bad of ['foo.bar', 'foo bar', 'foo/bar', '', 'a'.repeat(65)]) {
      expect(() => registry.register(registered(bad, builtin))).toThrow(/model providers accept/);
    }
    // M6-BE-06's `<serverSlug>__<toolName>` has to survive this pattern, so a
    // double underscore is the one that must NOT be rejected.
    registry.register(registered('foo__bar', builtin));
    registry.register(registered('a'.repeat(64), builtin));
    expect(registry.names()).toEqual(['foo__bar', 'a'.repeat(64)]);
  });

  it('leaves nothing behind when a registration throws', () => {
    const registry = new ToolRegistry();

    expect(() => registry.register(registered('bad.name', builtin))).toThrow();

    expect(registry.names()).toEqual([]);
    expect(registry.has('bad.name')).toBe(false);
  });

  it('requires an MCP tool to name its server', () => {
    // Without the server id, M6-BE-06 cannot round-trip a call back to the
    // server that offered the tool and M6-BE-10 cannot key strike state off
    // it. An empty string satisfies the type and defeats both.
    const registry = new ToolRegistry();

    expect(() =>
      registry.register(
        registered('fetch', {
          origin: { kind: 'mcp', serverId: ' ' },
          failure: { kind: 'isolate' },

          effect: 'draft',
          authority: false,
        }),
      ),
    ).toThrow(/serverId/);
    expect(registry.names()).toEqual([]);
  });

  it('requires an approved skill to name itself', () => {
    const registry = new ToolRegistry();

    expect(() =>
      registry.register(
        registered('run_skill', {
          origin: { kind: 'skill', skillId: '' },
          failure: { kind: 'isolate' },

          effect: 'draft',
          authority: false,
        }),
      ),
    ).toThrow(/skillId/);
    expect(registry.names()).toEqual([]);
  });

  it('refuses a tool that does not say whether it only looks (D-144)', () => {
    // Ask for approval branches on it; a value it does not know, or none,
    // must fail registration rather than decide approvals by accident.
    const registry = new ToolRegistry();
    for (const effect of [undefined, 'maybe']) {
      expect(() =>
        registry.register(registered('probe', { ...builtin, effect } as never)),
      ).toThrow();
    }
    expect(registry.names()).toEqual([]);
    registry.register(registered('probe', { ...builtin, effect: 'read', authority: false }));
    expect(registry.names()).toEqual(['probe']);
  });
});

describe('M5-BE-03 the model-facing projection', () => {
  it('hands back the definition unchanged, with no descriptor merged in', () => {
    // This asserted object IDENTITY until M5-BE-12, on the reasoning that
    // "whatever object comes out of here is the object the provider
    // serializes". The reasoning is right and identity was the wrong way to
    // hold it: §6/M5's 100 KB ceiling has to reach every tool, including the
    // MCP tools and compiled skills whose authors never read the registry, so
    // `toolSetFor` now composes a `toModelOutput` onto each definition.
    //
    // What the provider sees is unchanged, and that is what this checks
    // instead. `toModelOutput` is a server-side callback the SDK invokes when
    // it builds the next step's messages — it is not part of the tool schema
    // that is serialized into the request — so the additive member is the one
    // difference allowed here, and the assertions below say exactly that.
    const registry = new ToolRegistry();
    const definition = ping();
    registry.register(registered('ping', builtin, definition));

    const set = registry.toolSetFor(noContext);

    expect(Object.keys(set)).toEqual(['ping']);
    // Every member the definition declared survives by reference.
    for (const [key, value] of Object.entries(definition)) {
      expect(set['ping']?.[key as keyof typeof definition]).toBe(value);
    }
    // And exactly one member was added, named.
    const added = Object.keys(set['ping'] ?? {}).filter((key) => !(key in definition));
    expect(added).toEqual(['toModelOutput']);
    // The descriptor's own words, asserted absent. A registry that spread
    // `behavior` onto the definition would fail here.
    expect(Object.keys(set['ping'] ?? {})).not.toContain('behavior');
    expect(Object.keys(set['ping'] ?? {})).not.toContain('origin');
    expect(Object.keys(set['ping'] ?? {})).not.toContain('failure');
  });

  it('is empty until something registers', () => {
    expect(new ToolRegistry().toolSetFor(noContext)).toEqual({});
  });
});

describe('M6-BE-10 the remote failure policy', () => {
  const remote = (over: Partial<{ callTimeoutMs: number; strikeLimit: number }> = {}) =>
    ({
      origin: { kind: 'mcp', serverId: 'srv-1' },
      failure: { kind: 'isolate-remote', callTimeoutMs: 30_000, strikeLimit: 3, ...over },

      effect: 'unknown',
      authority: false,
    }) as const;

  it('registers a tool whose failure carries a deadline and a strike limit', () => {
    const registry = new ToolRegistry();
    registry.register(registered('gmail__send', remote()));

    expect(registry.behaviorOf('gmail__send').failure).toEqual({
      kind: 'isolate-remote',
      callTimeoutMs: 30_000,
      strikeLimit: 3,
    });
  });

  it('refuses a bound that can never be met', () => {
    // A zero timeout and a zero strike limit both READ as policy and are not:
    // the first fails every call, the second disables a server on its first
    // blip. Policy that is silently off is worse than policy that is missing,
    // and registration is where it can still be a stack trace.
    const registry = new ToolRegistry();

    expect(() => registry.register(registered('a__b', remote({ callTimeoutMs: 0 })))).toThrow(
      /call timeout/,
    );
    expect(() => registry.register(registered('a__b', remote({ strikeLimit: 0 })))).toThrow(
      /strike limit/,
    );
    expect(() => registry.register(registered('a__b', remote({ strikeLimit: -1 })))).toThrow(
      /strike limit/,
    );
    expect(registry.names()).toEqual([]);
  });

  it('keeps the policy off the definition the provider sees', () => {
    const registry = new ToolRegistry();
    registry.register(registered('gmail__send', remote()));

    const keys = Object.keys(registry.toolSetFor(noContext)['gmail__send'] ?? {});
    expect(keys).not.toContain('failure');
    expect(keys).not.toContain('callTimeoutMs');
    expect(keys).not.toContain('strikeLimit');
  });
});

describe('M6-BE-12 one resolution, for one turn', () => {
  const mcp = {
    origin: { kind: 'mcp', serverId: 'srv-1' },
    failure: { kind: 'isolate' },

    effect: 'unknown',
    authority: false,
  } as const;

  it('offers the registered tools and the turn’s extras together', () => {
    // An MCP tool is not registered and never will be (D-104): it belongs to
    // one user's server and changes when that server is re-listed. This is
    // the seam that lets it reach a turn anyway.
    const registry = new ToolRegistry();
    registry.register(registered('shell', builtin));

    const resolved = registry.resolveFor(noContext, [registered('gmail__send', mcp)]);

    expect(resolved.names).toEqual(['shell', 'gmail__send']);
    expect(Object.keys(resolved.toolSet)).toEqual(['shell', 'gmail__send']);
    expect(resolved.refusals).toEqual([]);
  });

  it('answers the descriptor for an extra, over the same map', () => {
    // The whole point of the method. A `toolSet` on its own would leave the
    // caller holding a definition the approval matcher cannot classify, and
    // `decideAutoReview` answers an unclassifiable call with `deny` — so an
    // MCP tool the model was offered would be denied every time it was used.
    const registry = new ToolRegistry();
    registry.register(registered('shell', builtin));

    const resolved = registry.resolveFor(noContext, [registered('gmail__send', mcp)]);

    expect(resolved.behaviorOf('gmail__send')).toEqual(mcp);
    expect(resolved.behaviorOf('shell')).toEqual(builtin);
    expect(resolved.behaviorOf('nothing')).toBeUndefined();
    // …and the registry itself is unchanged: an extra belongs to one turn.
    expect(registry.names()).toEqual(['shell']);
    expect(registry.tryBehaviorOf('gmail__send')).toBeUndefined();
  });

  it('keeps the descriptor off the definitions it hands the provider', () => {
    const registry = new ToolRegistry();
    const resolved = registry.resolveFor(noContext, [registered('gmail__send', mcp)]);

    const keys = Object.keys(resolved.toolSet['gmail__send'] ?? {});
    expect(keys).not.toContain('behavior');
    expect(keys).not.toContain('origin');
    expect(keys).not.toContain('reach');
    // M5-BE-12's cap reaches an extra too — that is the whole reason MCP
    // tools pass through here rather than being merged in by the caller.
    expect(keys).toContain('toModelOutput');
  });

  it('drops an extra instead of failing the turn it is part of', () => {
    // §6/M6: "One broken plugin must never fail a turn." `register` throws,
    // which is right at boot where the stack names the caller and nothing has
    // started; here the caller is a turn in flight and the material is a
    // third party's.
    const registry = new ToolRegistry();
    registry.register(registered('shell', builtin));

    const resolved = registry.resolveFor(noContext, [
      registered('bad.name', mcp),
      registered('gmail__send', mcp),
      registered('no_server', { ...mcp, origin: { kind: 'mcp', serverId: '' } }),
    ]);

    expect(resolved.names).toEqual(['shell', 'gmail__send']);
    expect(resolved.refusals.map((refusal) => refusal.name)).toEqual(['bad.name', 'no_server']);
    expect(resolved.refusals[0]?.reason).toMatch(/tool name/);
    expect(resolved.refusals[1]?.reason).toMatch(/serverId/);
  });

  it('refuses an extra that would shadow a registered tool, keeping this build’s own', () => {
    // The second fence under M6-BE-06's install-time slug check. A plugin
    // quietly replacing `shell` is the exact shape that check exists to stop,
    // and the winner must not depend on which side resolved last.
    const registry = new ToolRegistry();
    const ours = ping();
    registry.register(registered('shell', builtin, ours));

    const theirs = ping();
    const resolved = registry.resolveFor(noContext, [registered('shell', mcp, theirs)]);

    expect(resolved.names).toEqual(['shell']);
    expect(resolved.behaviorOf('shell')).toEqual(builtin);
    expect(resolved.refusals).toEqual([
      { name: 'shell', reason: 'a tool named "shell" is already offered this turn' },
    ]);
    // Identity, because "the registered one won" is the claim: every member
    // of OUR definition is the one in the set.
    for (const [key, value] of Object.entries(ours)) {
      expect(resolved.toolSet['shell']?.[key as keyof typeof ours]).toBe(value);
    }
  });

  it('refuses a second extra under a name an earlier extra took', () => {
    // Two servers can only reach one namespace by way of a bug — M6-BE-06
    // makes `<slug>__<tool>` unique per user — so this is the fence under
    // that, and the first one still wins rather than the last.
    const registry = new ToolRegistry();
    const first = ping();
    const resolved = registry.resolveFor(noContext, [
      registered('gmail__send', mcp, first),
      registered('gmail__send', { ...mcp, origin: { kind: 'mcp', serverId: 'srv-2' } }),
    ]);

    expect(resolved.names).toEqual(['gmail__send']);
    expect(resolved.behaviorOf('gmail__send')?.origin).toEqual({ kind: 'mcp', serverId: 'srv-1' });
    expect(resolved.refusals).toHaveLength(1);
  });

  it('resolves to exactly what the registry holds when there are no extras', () => {
    const registry = new ToolRegistry();
    registry.register(registered('shell', builtin));

    const resolved = registry.resolveFor(noContext);

    expect(resolved.names).toEqual(registry.names());
    expect(Object.keys(resolved.toolSet)).toEqual(Object.keys(registry.toolSetFor(noContext)));
    expect(resolved.refusals).toEqual([]);
  });
});

describe('M5-BE-03 the behavior descriptor', () => {
  it('round-trips every origin kind, payload included', () => {
    const registry = new ToolRegistry();
    const mcpBehavior = {
      origin: { kind: 'mcp', serverId: 'server-a' },
      failure: { kind: 'isolate' },

      effect: 'draft',
      authority: false,
    } as const;
    const skillBehavior = {
      origin: { kind: 'skill', skillId: 'skill-7' },
      failure: { kind: 'isolate' },

      effect: 'draft',
      authority: false,
    } as const;
    registry.register(registered('ping', builtin));
    registry.register(registered('server_a__fetch', mcpBehavior));
    registry.register(registered('run_skill', skillBehavior));

    expect(registry.behaviorOf('ping')).toEqual({
      origin: { kind: 'builtin' },
      failure: { kind: 'isolate' },

      effect: 'draft',
      authority: false,
    });
    expect(registry.behaviorOf('server_a__fetch')).toEqual(mcpBehavior);
    expect(registry.behaviorOf('run_skill')).toEqual(skillBehavior);
  });

  it('throws on an unknown name rather than defaulting', () => {
    // A defaulted `builtin`/`isolate` is the silent-allow M6-BE-08 warns
    // about: it would classify a tool nobody classified, and the caller —
    // the approval matcher or the read-only classifier — could not tell.
    const registry = new ToolRegistry();

    expect(() => registry.behaviorOf('nobody')).toThrow(/No tool named/);
  });
});
