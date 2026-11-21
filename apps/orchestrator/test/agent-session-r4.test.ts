import { describe, expect, it } from 'vitest';
import { SANDBOX_INFRA_SURFACE } from '@crewaid/sandbox-core';

import { AgentSessionService } from '../src/agent/agent-session.service.js';

/**
 * R4 at the one place it is decided.
 *
 * PRD §6/M5's required test is "assert the object handed to tools has no
 * `destroy`, `setNetworkPolicy`, or `setPorts`". `sandbox-session.test.ts`
 * covers the SHAPE of `restricted()`; this covers the LINK — that the object a
 * turn's tools receive is the one `restricted()` returned, and not the session
 * it was reduced from — and, since M5-BE-07, the fence that holds when the
 * provider does not keep its side of the bargain.
 *
 * The compile-time half lives in `packages/sandbox-docker/src/types.test.ts`:
 * `ToolSandboxSession` makes the wide session unassignable, so the wiring slip
 * cannot reach here in our own code. What it cannot fence is the object a
 * provider actually returns, and that is what these cases are about.
 */

function serviceOver(session: unknown): AgentSessionService {
  const prisma = { sandbox: { findFirst: async () => ({ id: 'c1', sessionId: 's1' }) } };
  const provider = { attachSession: async () => session };
  return new AgentSessionService(prisma as never, provider as never);
}

describe('R4 the session a tool receives is the reduced one', () => {
  it('hands tools restricted(), not the session it came from', async () => {
    const reduced = { readBinaryFile: async () => null };
    const service = serviceOver({
      destroy: () => undefined,
      setNetworkPolicy: () => undefined,
      setPorts: () => undefined,
      restricted: () => reduced,
    });

    const handed = (await service.restrictedFor('bot_1')) as Record<string, unknown>;

    expect(handed).toBe(reduced);
    // The three §6/M5 names, absent by construction rather than by promise.
    expect(handed['destroy']).toBeUndefined();
    expect(handed['setNetworkPolicy']).toBeUndefined();
    expect(handed['setPorts']).toBeUndefined();
  });

  it('refuses a provider whose restricted() hands back the session itself', async () => {
    // `restricted: () => this` is the implementation a provider slides into —
    // upstream's own words are "a narrower surface over the same resource", and
    // returning the resource is one keystroke from that. Every type in the
    // path still checks out, because the type describes what we DECLARE and
    // this is what arrives. Nothing else in the system would notice.
    const full = {
      readBinaryFile: async () => null,
      destroy: () => undefined,
      setNetworkPolicy: () => undefined,
      setPorts: () => undefined,
      restricted(): unknown {
        return this;
      },
    };

    await expect(serviceOver(full).restrictedFor('bot_1')).rejects.toThrow(
      /R4: restricted\(\) for bot bot_1 returned a session still carrying/,
    );
  });

  it('names the members that leaked, so the provider bug is readable', async () => {
    const leaky = {
      readBinaryFile: async () => null,
      destroy: () => undefined,
      setPorts: () => undefined,
    };
    const service = serviceOver({ restricted: () => leaky });

    // The failure has to say WHICH members came through: "a session still
    // carrying something" sends the reader back to the provider to diff two
    // object literals by eye.
    await expect(service.restrictedFor('bot_1')).rejects.toThrow(/destroy, setPorts/);
  });

  it('looks through the prototype, not only own properties', async () => {
    // A provider written as a class carries `destroy` on the prototype, so
    // `Object.hasOwn` answers false for the exact shape that matters most —
    // and `restricted: () => this` on a class is how it arrives.
    class NetworkSession {
      readBinaryFile = async (): Promise<null> => null;
      destroy(): void {}
      restricted(): unknown {
        return this;
      }
    }

    await expect(serviceOver(new NetworkSession()).restrictedFor('bot_1')).rejects.toThrow(
      /still carrying .*destroy/,
    );
  });

  it('passes the shape restricted() is contracted to return', async () => {
    // The fence must not fire on the production object, or the next person
    // deletes it. This is the full base session — every member
    // `ContainerSandboxSession.restricted()` builds — and none of the infra ones.
    const reduced = {
      description: 'bot computer',
      readFile: async () => null,
      readBinaryFile: async () => null,
      readTextFile: async () => null,
      writeFile: async () => undefined,
      writeBinaryFile: async () => undefined,
      writeTextFile: async () => undefined,
      spawn: async () => ({}),
      run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };

    await expect(serviceOver({ restricted: () => reduced }).restrictedFor('bot_1')).resolves.toBe(
      reduced,
    );
  });

  it('bans the three members §6/M5 names, whatever the list is built from', async () => {
    // M5-QA-03. Every other case here is driven off SANDBOX_INFRA_SURFACE,
    // which is the right way round — it is the exact difference between the
    // two interfaces and `types.test.ts` pins it to that difference. But it
    // means the PRD's own sentence is nowhere in the assertions: a refactor
    // that replaced the list mechanism could drop these three and every test
    // would still pass, because each one would go on checking whatever the
    // new list happened to say.
    //
    // So the sentence gets a line of its own. It is deliberately redundant
    // with the loop below, and the redundancy is the point.
    for (const member of ['destroy', 'setNetworkPolicy', 'setPorts'] as const) {
      expect(SANDBOX_INFRA_SURFACE).toContain(member);

      const leaky = { readBinaryFile: async () => null, [member]: () => undefined };
      await expect(serviceOver({ restricted: () => leaky }).restrictedFor('bot_1')).rejects.toThrow(
        new RegExp(`still carrying .*\\b${member}\\b`),
      );
    }
  });

  it('checks every member the type bans, not a shortlist', async () => {
    // One case per infra member, driven off the list itself: adding a member
    // to SANDBOX_INFRA_SURFACE extends this test for free, and a member the
    // runtime check forgot fails here rather than shipping as a capability a
    // tool can reach.
    for (const member of SANDBOX_INFRA_SURFACE) {
      const leaky = { readBinaryFile: async () => null, [member]: () => undefined };

      await expect(serviceOver({ restricted: () => leaky }).restrictedFor('bot_1')).rejects.toThrow(
        new RegExp(`still carrying .*\\b${member}\\b`),
      );
    }
  });
});
