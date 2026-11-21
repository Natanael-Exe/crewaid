import { Inject, Injectable } from '@nestjs/common';
import { SANDBOX_INFRA_SURFACE, type ToolSandboxSession } from '@crewaid/sandbox-core';

import { PrismaService } from '../prisma/prisma.service.js';
import { SANDBOX_PROVIDER, type SandboxProvider } from '../sandbox/sandbox.provider.js';
import { computerOfBot } from '../sandbox/attached-computer.js';

/**
 * The bot's computer, reduced, for the tools that touch files.
 *
 * "Tools receive `session.restricted()`, never the full network session.
 * A tool must not be able to call `destroy()`, `setNetworkPolicy()`, or
 * `setPorts()`." `restricted()` is called HERE, once, so no tool is ever
 * handed the object those methods live on — a tool cannot narrow a session it
 * was given wide, and the reduction has to happen on the way in.
 *
 * The bot id comes from the turn's own row, never from a request, and the
 * computer is resolved through `computerOfBot` so D-046's per-user machine is
 * found the same way every other caller finds it.
 */
@Injectable()
export class AgentSessionService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SANDBOX_PROVIDER) private readonly provider: SandboxProvider,
  ) {}

  async restrictedFor(botId: string): Promise<ToolSandboxSession> {
    const computer = await computerOfBot(this.prisma, botId, { sessionId: true });
    if (computer === null) throw new Error(`bot ${botId} has no computer`);
    const session = await this.provider.attachSession({ sessionId: computer.sessionId ?? botId });
    if (session === null) {
      throw new Error(`no container is attached to session ${computer.sessionId ?? botId}`);
    }
    return assertReduced(session.restricted(), botId);
  }
}

/**
 * M5-BE-07 — the runtime half of R4.
 *
 * `ToolSandboxSession` fences the wiring above at compile time, but it is a
 * type: erased before anything runs, and describing an object that arrives from
 * an injected provider TypeScript never saw. The implementation that would
 * break R4 is the obvious one — `restricted: () => this`, which every
 * hand-written fake reaches for and which upstream's own doc comment ("a
 * narrower surface over the same resource") reads as permission for. Under that
 * provider the type says nothing, the wiring still compiles, and every tool
 * gets `destroy()`.
 *
 * So the object is checked, not trusted. `in` rather than `Object.hasOwn`
 * deliberately: a class instance carries its methods on the prototype, and that
 * is exactly the shape `restricted: () => this` produces.
 *
 * Throwing is the right failure. The alternative — stripping the members and
 * carrying on — hides a provider bug behind a session that silently is not the
 * one its own contract describes, and R4 is a security boundary, not a
 * preference.
 */
function assertReduced(session: ToolSandboxSession, botId: string): ToolSandboxSession {
  const reachable = SANDBOX_INFRA_SURFACE.filter((member) => member in session);
  if (reachable.length > 0) {
    throw new Error(
      `R4: restricted() for bot ${botId} returned a session still carrying ` +
        `${reachable.join(', ')}. Tools must not be able to stop the sandbox, ` +
        'change its network policy, or resolve a port and reach it out of band.',
    );
  }
  return session;
}
