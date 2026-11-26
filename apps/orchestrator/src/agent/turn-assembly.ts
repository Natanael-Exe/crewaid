import type { Bot } from '@prisma/client';
import type { Locale } from '@crewaid/shared';
import { readEdition } from '../common/edition.config.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { StructuredLogger } from '../logging/structured-logger.js';
import type { AgentBrowserService } from './agent-browser.service.js';
import type { AgentSessionService } from './agent-session.service.js';
import type { IdentityService } from '../sandbox/identity.service.js';
import type { SeatService } from '../sandbox/seat.service.js';
import type { SandboxReadinessService } from '../sandbox/sandbox-readiness.service.js';
import type { SeatControlService } from '../screen/seat-control.service.js';
import type { ToolPolicyStateService } from './policy/state.service.js';
import type { ToolApprovalHub } from './policy/approval-hub.js';
import { createDispatchLedger } from './policy/dispatch-ledger.js';
import { createPolicyProposalStore } from './policy/proposal-store.js';
import {
  createPolicyRuntime,
  type PolicyRuntime,
  type ToolDispatchPort,
} from './policy/runtime.js';
import { SEAT_BUILTIN, type ResolvedTools, type ToolRegistry } from './tool-registry.js';
import { SEAT_TOOL_KINDS } from './seat-admission.js';
import { createTurnComputer, type TurnComputer } from './turn-computer.js';
import { createTurnBrowser, type TurnBrowser } from './turn-browser.js';
import {
  NO_CONNECTOR_TOOLS,
  type TurnConnectors,
  type TurnConnectorTools,
} from './turn-connectors.js';
import { NO_PLUGIN_TOOLS, type BotPluginTools, type TurnPlugins } from './turn-plugins.js';
import { MACHINE_HOME } from './workspace-paths.js';
import type { AgentInstructionsInput } from './agent-instructions.js';
import {
  languageName,
  USER_PREFERENCES_SELECT,
  userPreferences,
  type UserPreferencesRow,
} from '../providers/user-preferences.js';

/** The row a run reads before assembling anything. Selected once, reused whole. */
export const TURN_BOT_SELECT = {
  id: true,
  kind: true,
  name: true,
  role: true,
  modelId: true,
  codingModelId: true,
  systemPrompt: true,
  autoReviewRules: true,
  approvalMode: true,
  sandboxId: true,
  group: { select: { id: true, name: true, instructions: true } },
  conversation: { select: { id: true } },
  // The person's language, zone, and optional account coding model ride on
  // the bot's own read, so the turn learns them without a query of its own.
  user: {
    select: {
      settings: { select: { ...USER_PREFERENCES_SELECT, codingModelId: true } },
    },
  },
} as const;

export type TurnBot = Pick<
  Bot,
  'id' | 'name' | 'role' | 'modelId' | 'systemPrompt' | 'autoReviewRules' | 'approvalMode'
> & {
  readonly kind?: string;
  readonly codingModelId?: string | null;
  readonly sandboxId: string | null;
  readonly group: { id: string; name: string; instructions: string } | null;
  readonly user?: {
    readonly settings: (UserPreferencesRow & { readonly codingModelId?: string | null }) | null;
  };
};

export type TurnAssemblyServices = {
  readonly prisma: PrismaService;
  readonly tools: ToolRegistry;
  readonly plugins: TurnPlugins;
  readonly connectors?: TurnConnectors | undefined;
  readonly computers: SandboxReadinessService;
  readonly browsers: AgentBrowserService;
  readonly sessions: AgentSessionService;
  readonly identities: IdentityService;
  readonly seats: SeatService;
  readonly policyState: ToolPolicyStateService;
  readonly approvalHub: ToolApprovalHub;
  readonly seatControl?: SeatControlService | undefined;
};

export type TurnAssemblyInput = {
  readonly userId: string;
  readonly bot: TurnBot;
  readonly threadId: string;
  /** The run the policy proposals belong to: its AgentTurn row. */
  readonly runId: string;
  readonly trigger: {
    readonly id: string;
    readonly chainId: string | null;
    readonly hopCount: number;
  };
  /** Resolves the canonical tool-result message ID an attachment claims. */
  readonly attachmentHost: (toolCallId: string) => Promise<string>;
  /** Already selected and budgeted by the caller; absent when the read failed. */
  readonly memory?: string | undefined;
  readonly logger: StructuredLogger;
  readonly signal: AbortSignal;
  /** How plugin tools reach the model: the two-door bridge or deferred tools. */
  readonly pluginSurface?: 'bridge' | 'deferred';
  /** The run's lease, when it has one: it fences the dispatch ledger. */
  readonly lease?: { readonly workerId: string; readonly epoch: number };
};

export type AssembledTurn = {
  readonly instructions: AgentInstructionsInput;
  /** The account's language, for the words the server writes for the person. */
  readonly language: Locale | null;
  readonly resolvedTools: ResolvedTools;
  readonly policy: PolicyRuntime;
  readonly computer: TurnComputer;
  readonly browser: TurnBrowser;
  readonly pluginTools: BotPluginTools;
  /** Tools withheld from this turn, for the log: a name this build cannot use, a spent budget. */
  readonly withheld: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
  /** Releases the browser and the computer, in that order. Safe to call once per assembly. */
  readonly dispose: () => Promise<void>;
};

/**
 * One turn, assembled in one place.
 *
 * What a bot is told and what it may do must have one answer, whichever
 * trigger started the run. So the roster, the group block, the plugin tools,
 * the registry resolution, the policy runtime and the lazy computer and
 * browser live here, and the backend keeps only what is genuinely its own —
 * its lease, durable log and library persistence.
 *
 * Assembling starts nothing. Every handle below defers its work to the first
 * tool call that needs it, which is what lets a text-only turn resolve four
 * browser tools and still wake no desktop.
 */
export async function assembleTurn(
  services: TurnAssemblyServices,
  input: TurnAssemblyInput,
): Promise<AssembledTurn> {
  // Bound to a local named `prisma` deliberately: R7's allowlist test keys
  // call sites on a receiver spelled `prisma` or `tx`, so a query reached
  // through a deps object (`services.prisma.bot.…`) would be invisible to the
  // audit that is supposed to prove every call is scoped.
  const { userId, bot, logger } = input;
  const prisma = services.prisma;
  // The roster the team block names, ordered the way
  // `send_message`'s refusals order it, so the team reads the same in the
  // prompt and in a failed send. `sandboxId` rides along because the block
  // says different things about a file depending on whether the teammate
  // shares this machine.
  const teammates = (
    await prisma.bot.findMany({
      where: { userId, id: { not: bot.id } },
      select: { id: true, name: true, role: true, sandboxId: true, groupId: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    })
  ).map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role,
    onThisMachine: bot.sandboxId !== null && row.sandboxId === bot.sandboxId,
    groupId: row.groupId,
  }));
  const botGroup = bot.group ?? null;
  const group =
    botGroup === null
      ? undefined
      : {
          name: botGroup.name,
          instructions: botGroup.instructions,
          folder: `${MACHINE_HOME}/groups/${botGroup.id}`,
          members: teammates
            .filter((mate) => mate.groupId === botGroup.id)
            .map(({ id, name, role, onThisMachine }) => ({ id, name, role, onThisMachine })),
        };

  // M6-BE-07, non-fatal for the reason §6/M6 states first: one broken plugin
  // must never fail a turn, and a database this cannot reach is a worse
  // version of the same event. Spread over the empty value so a source that
  // answers with fewer fields than this build reads cannot take the turn down.
  let pluginTools: BotPluginTools = NO_PLUGIN_TOOLS;
  try {
    pluginTools = { ...NO_PLUGIN_TOOLS, ...(await services.plugins.toolsForBot(userId, bot.id)) };
  } catch (error) {
    logger.warn('turn.plugins.unavailable', {
      detail: error instanceof Error ? error.message : 'unknown',
    });
  }

  let connectorTools: TurnConnectorTools = NO_CONNECTOR_TOOLS;
  if (services.connectors !== undefined) {
    try {
      connectorTools = {
        ...NO_CONNECTOR_TOOLS,
        ...(await services.connectors.toolsForTurn(userId, bot.id, bot.name)),
      };
    } catch (error) {
      logger.warn('turn.connectors.unavailable', {
        detail: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  // Created here and disposed by `dispose`, so completion,
  // cancellation, a refusal and a failure all release the same way.
  const computer = createTurnComputer({
    readiness: services.computers,
    userId,
    botId: bot.id,
    logger,
  });
  const browser = createTurnBrowser({
    computer,
    connect: () => services.browsers.connect(bot.id),
  });

  const scope = { userId, botId: bot.id, conversationId: input.threadId, runId: input.runId };
  const dispatch: ToolDispatchPort = {
    execute: (...args) => policy.execute(...args),
    skillPermit: (id) => policy.skillPermit(id),
  };
  let identitySelected = false;
  const preferences = userPreferences(bot.user?.settings);
  const resolvedTools = services.tools.resolveFor(
    {
      userId,
      language: preferences.language,
      policy: dispatch,
      seat: services.seatControl?.portFor(bot.id),
      botId: bot.id,
      runId: input.runId,
      botModelId: bot.modelId,
      codingModelId: bot.codingModelId ?? bot.user?.settings?.codingModelId ?? null,
      botName: bot.name,
      sandboxId: bot.sandboxId,
      groupId: botGroup?.id ?? null,
      attachmentHost: input.attachmentHost,
      trigger: input.trigger,
      browser: () => browser.page(),
      // Lazy, and it WAKES the computer first: `attachSession` reattaches
      // without starting anything, so a session taken straight from it would
      // exec against a container that is not running. `ensure` is memoised,
      // so this costs nothing after the first call.
      session: async () => {
        await computer.ensure();
        return services.sessions.restrictedFor(bot.id);
      },
      // M5-BE-27. The order is the whole thing: the grant is written first, so
      // a crash between the steps leaves a bot that will open on the identity
      // next time rather than one that lost its window for nothing; the seat
      // goes second, because a seat's profile is fixed at creation and the
      // machine refuses to hand back a window on the wrong one; the turn's
      // page goes last, because it is attached to the target the release just
      // closed and every later browser_* call would act on it.
      useIdentity: async (name: string) => {
        identitySelected = false;
        const granted = await services.identities.grant(userId, bot.id, name);
        try {
          await services.seats.releaseSeatForBot(bot.id);
        } finally {
          // Even a failed closer cannot keep a memoized client authorized for
          // the profile selection that was just superseded.
          await browser.reset();
        }
        identitySelected = true;
        return granted;
      },
    },
    [
      ...(input.pluginSurface === 'deferred' ? pluginTools.deferred : pluginTools.tools),
      ...connectorTools.tools,
    ],
  );
  const policy = createPolicyRuntime({
    project: (name, args) => resolvedTools.projectCall(name, args),
    onProposal: (id) => services.approvalHub.register(scope, id, policy.answer, policy.cancel),
    store: createPolicyProposalStore(prisma, scope),
    dispatches: createDispatchLedger(
      prisma,
      { userId, conversationId: input.threadId, runId: input.runId },
      input.lease,
    ),
    read: async (call, prepare) => {
      if (prepare && call.behavior?.effect === 'seat') await computer.ensure();
      return services.policyState.read(userId, bot.id, call, prepare);
    },
    preflight: async (name) => {
      const kind = name === 'run_skill' ? 'targeted' : SEAT_TOOL_KINDS[name];
      if (kind === undefined || kind === 'observation') return null;
      const admitted = await services.seatControl?.portFor(bot.id).admit(kind, input.signal);
      if (admitted === undefined) return null;
      if (!admitted.ok) return `${admitted.refusal.code}: ${admitted.refusal.message}`;
      admitted.release();
      return null;
    },
    afterIdentity: async () => {
      if (!identitySelected) return null;
      await computer.ensure();
      await browser.page();
      return services.policyState.read(
        userId,
        bot.id,
        { name: 'browser_click', args: {}, behavior: SEAT_BUILTIN },
        false,
      );
    },
  });

  let released = false;
  return {
    language: preferences.language,
    instructions: {
      identity: { name: bot.name, role: bot.role },
      mainAssistant: bot.kind === 'MAIN',
      ...(bot.kind === 'MAIN' && { edition: readEdition(process.env) }),
      // A solo bot gets no team block: a roster about nobody would be a
      // promise of people who are not there.
      ...(teammates.length > 0 && {
        team: teammates.map(({ id, name, role, onThisMachine }) => ({
          id,
          name,
          role,
          onThisMachine,
        })),
      }),
      ...(group !== undefined && { group }),
      // The plugins this turn RESOLVED, not the ones enabled. A bot
      // told it has a server it cannot reach is told something false.
      ...(pluginTools.servers.length > 0 && {
        plugins: pluginTools.servers,
        pluginSurface: input.pluginSurface ?? 'bridge',
      }),
      ...(connectorTools.hasConnectors && { hasLocalConnectors: true }),
      workspace: { home: `${MACHINE_HOME}/agents/${bot.id}` },
      person: {
        ...(preferences.language !== null && { languageName: languageName(preferences.language) }),
        ...(preferences.timezone !== null && { timezone: preferences.timezone }),
      },
      botPrompt: bot.systemPrompt,
      ...(input.memory !== undefined && { memory: input.memory }),
    },
    resolvedTools,
    policy,
    computer,
    browser,
    pluginTools,
    withheld: [...pluginTools.refusals, ...resolvedTools.refusals],
    dispose: async () => {
      if (released) return;
      released = true;
      // The browser first: it sits on top of the computer, so dropping the
      // socket while the container is still up is a clean close.
      try {
        await browser.dispose();
      } finally {
        await computer.dispose();
      }
    },
  };
}
