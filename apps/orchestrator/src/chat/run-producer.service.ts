import { Inject, Injectable, Optional } from '@nestjs/common';
import { FIND_PLUGIN_TOOLS } from '@crewaid/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import type { StructuredLogger } from '../logging/structured-logger.js';
import { ModelResolutionService } from '../models/model-resolution.service.js';
import { AttachmentsService } from '../attachments/attachments.service.js';
import { MemoryService } from '../memory/memory.service.js';
import { ToolRegistry } from '../agent/tool-registry.js';
import { TurnPlugins, type UnavailableServer } from '../agent/turn-plugins.js';
import { AgentBrowserService } from '../agent/agent-browser.service.js';
import { AgentSessionService } from '../agent/agent-session.service.js';
import { SandboxReadinessService } from '../sandbox/sandbox-readiness.service.js';
import { IdentityService } from '../sandbox/identity.service.js';
import { SeatService } from '../sandbox/seat.service.js';
import { SeatControlService } from '../screen/seat-control.service.js';
import { ToolApprovalHub } from '../agent/policy/approval-hub.js';
import { ToolPolicyStateService } from '../agent/policy/state.service.js';
import { assembleTurn, type TurnBot } from '../agent/turn-assembly.js';
import { buildMemoryBlock } from '../agent/turn-memory.js';
import { readMemoryBudgetChars } from '../agent/agent-loop.config.js';
import { REMOVED_BOT_NAME } from '../agent/trigger-content.js';
import { TanStackExecutionBackend } from '../agent/execution/tanstack-execution-backend.js';
import {
  claimedAttachmentLoader,
  type TeammateNameLoader,
} from '../agent/execution/provider-context.js';
import type {
  ExecutionOutcome,
  ExecutionPorts,
  ExecutionRequest,
} from '../agent/execution/execution-backend.port.js';
import { executeOwned } from '../agent/persistence/owned-tanstack-persistence.js';
import { RunLeaseService, type RunLease } from '../agent/persistence/run-lease.js';
import { toolResultMessageId } from '../agent/persistence/transcript.js';
import { AI_TELEMETRY, type AiTelemetrySink } from '../telemetry/ai-telemetry.js';
import { RunEventWakeupsService } from './run-event-wakeups.service.js';
import type { ProducedTrigger, StatusWriter, SystemMessagePoster } from './chat-run.types.js';

export type ProducerHooks = {
  readonly writeStatus: StatusWriter;
  readonly postSystemMessage: SystemMessagePoster;
};

/**
 * Assembles memory, plugins, tools, and sandbox seats for a leased run, then
 * drives `executeOwned` and disposes run-scoped resources in a `finally` block.
 */
@Injectable()
export class RunProducerService {
  private readonly memoryBudgetChars = readMemoryBudgetChars(
    process.env['AGENT_MEMORY_BUDGET_CHARS'],
  );
  private readonly leases: RunLeaseService;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ModelResolutionService) private readonly models: ModelResolutionService,
    @Inject(AttachmentsService) private readonly attachments: AttachmentsService,
    @Inject(MemoryService) private readonly memories: MemoryService,
    @Inject(RunEventWakeupsService) private readonly wakeups: RunEventWakeupsService,
    @Inject(ToolRegistry) private readonly tools: ToolRegistry,
    @Inject(TurnPlugins) private readonly plugins: TurnPlugins,
    @Inject(SandboxReadinessService) private readonly computers: SandboxReadinessService,
    @Inject(AgentBrowserService) private readonly browsers: AgentBrowserService,
    @Inject(AgentSessionService) private readonly sessions: AgentSessionService,
    @Inject(IdentityService) private readonly identities: IdentityService,
    @Inject(SeatService) private readonly seats: SeatService,
    @Inject(ToolPolicyStateService) private readonly policyState: ToolPolicyStateService,
    @Inject(ToolApprovalHub) private readonly approvalHub: ToolApprovalHub,
    @Inject(AI_TELEMETRY) private readonly telemetry: AiTelemetrySink,
    @Optional() @Inject(SeatControlService) private readonly seatControl?: SeatControlService,
  ) {
    this.leases = new RunLeaseService(prisma);
  }

  async execute(
    lease: RunLease,
    bot: TurnBot,
    trigger: ProducedTrigger,
    controller: AbortController,
    logger: StructuredLogger,
    hooks: ProducerHooks,
  ): Promise<ExecutionOutcome> {
    // A bot that cannot reach memory still answers rather than failing the turn.
    let memory: string | undefined;
    try {
      memory = await buildMemoryBlock(this.memories, this.memoryBudgetChars, {
        userId: lease.userId,
        botId: bot.id,
        triggerContent: trigger.triggerContent,
      });
    } catch (error) {
      logger.warn('turn.memory.unavailable', {
        detail: error instanceof Error ? error.message : 'unknown',
      });
    }
    const assembled = await assembleTurn(
      {
        prisma: this.prisma,
        tools: this.tools,
        plugins: this.plugins,
        computers: this.computers,
        browsers: this.browsers,
        sessions: this.sessions,
        identities: this.identities,
        seats: this.seats,
        policyState: this.policyState,
        approvalHub: this.approvalHub,
        seatControl: this.seatControl,
      },
      {
        userId: lease.userId,
        bot,
        threadId: lease.threadId,
        runId: lease.runId,
        trigger: {
          id: trigger.triggerMessageId,
          chainId: trigger.chainId,
          hopCount: trigger.hopCount,
        },
        // Tool attachments claim the tool-result row reserved when the call started.
        attachmentHost: (toolCallId) =>
          this.attachmentHostFor(lease, trigger.parentRunId, toolCallId),
        ...(memory !== undefined && { memory }),
        logger,
        signal: controller.signal,
        pluginSurface: 'deferred',
        lease,
      },
    );
    await this.notePluginsUnavailable(
      bot.id,
      assembled.pluginTools.unavailable,
      logger,
      hooks.postSystemMessage,
    );
    const toolSet = assembled.resolvedTools.toolSet;
    const deferredNames = assembled.pluginTools.deferred
      .map((entry) => entry.name)
      .filter((name) => name !== FIND_PLUGIN_TOOLS && name in toolSet);
    const request: ExecutionRequest = {
      model: { userId: lease.userId, modelRef: bot.modelId },
      botId: bot.id,
      threadId: lease.threadId,
      runId: lease.runId,
      triggerMessageId: trigger.triggerMessageId,
      chain: { chainId: trigger.chainId, hopCount: trigger.hopCount },
      instructions: assembled.instructions,
      tools: toolSet,
      observationTools: Object.keys(toolSet).filter(
        (name) => assembled.resolvedTools.behaviorOf(name)?.effect === 'read',
      ),
      policy: assembled.policy,
      ...(deferredNames.length > 0 && {
        deferredTools: { discovery: FIND_PLUGIN_TOOLS, names: deferredNames },
      }),
      ...(trigger.resume === undefined ? {} : { resume: trigger.resume }),
      ...(trigger.parentRunId === undefined ? {} : { parentRunId: trigger.parentRunId }),
      ...(trigger.continuation === undefined ? {} : { continuation: trigger.continuation }),
      language: assembled.language,
    };
    const ports: ExecutionPorts = {
      signal: controller.signal,
      // `executeOwned` wraps this with the fenced durable event log.
      appendEvent: () => Promise.resolve(),
      checkpoint: () => Promise.resolve(),
      releaseForApproval: async () => {
        // Release browser before computer because the browser runs on top of it.
        await assembled.browser.reset();
        await assembled.computer.release();
      },
      persistUsage: () => Promise.resolve(),
      status: (status) => hooks.writeStatus(bot.id, status),
    };
    const withheld = assembled.withheld;
    if (withheld.length > 0) {
      logger.warn('turn.plugins.withheld', {
        count: withheld.length,
        tools: withheld.map((refusal) => refusal.name),
        reason: withheld[0]?.reason ?? '',
      });
    }
    let outcome: ExecutionOutcome | undefined;
    try {
      outcome = await executeOwned({
        prisma: this.prisma,
        leases: this.leases,
        wakeups: this.wakeups,
        lease,
        backend: (persistence) =>
          new TanStackExecutionBackend({
            logger,
            resolveModel: (model) => this.models.resolveText(model.userId, model.modelRef),
            openPersistence: () => Promise.resolve(persistence),
            loadAttachments: claimedAttachmentLoader(this.attachments),
            loadSenders: this.senderNameLoader(lease.threadId),
            telemetry: this.telemetry,
          }),
        request,
        ports,
      });
      logger.info('turn.complete', { stopReason: outcome.finishReason ?? outcome.status });
      return outcome;
    } finally {
      try {
        // Leave pending interrupts open when parked for approval; Stop settles them on cancel.
        if (outcome?.status === 'interrupted')
          this.approvalHub.forgetRun(lease.userId, lease.runId);
        else await this.approvalHub.finishRun(lease.userId, lease.runId);
      } finally {
        await assembled.dispose();
      }
    }
  }

  /** Reports unreachable plugins once in the transcript without failing the run. */
  private async notePluginsUnavailable(
    botId: string,
    unavailable: readonly UnavailableServer[],
    logger: StructuredLogger,
    postSystemMessage: SystemMessagePoster,
  ): Promise<void> {
    if (unavailable.length === 0) return;
    const named = unavailable.map((server) => `${server.name} ${server.reason}`);
    const list =
      named.length === 1
        ? named[0]
        : `${named.slice(0, -1).join(', ')} and ${String(named.at(-1))}`;
    const content =
      `${String(list)}, so this reply was written without ${
        unavailable.length === 1 ? 'it' : 'them'
      }. ` + 'Reconnect from the plugin list to bring the tools back.';
    try {
      await postSystemMessage(botId, content);
    } catch (error) {
      logger.warn('turn.plugins.note.failed', {
        detail: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  /** Resolves current display names of teammate senders scoped to this thread and owner. */
  private senderNameLoader(threadId: string): TeammateNameLoader {
    return async (request, messageIds) => {
      if (messageIds.length === 0) return new Map();
      const rows = await this.prisma.message.findMany({
        where: {
          id: { in: [...messageIds] },
          conversationId: threadId,
          author: 'BOT',
          fromBotId: { not: null },
          NOT: { fromBotId: request.botId },
          conversation: { bot: { id: request.botId, userId: request.model.userId } },
        },
        select: { id: true, fromBotId: true },
      });
      if (rows.length === 0) return new Map();
      const senderIds = [...new Set(rows.flatMap((row) => (row.fromBotId ? [row.fromBotId] : [])))];
      const senders = await this.prisma.bot.findMany({
        where: { id: { in: senderIds }, userId: request.model.userId },
        select: { id: true, name: true },
      });
      const names = new Map(senders.map((sender) => [sender.id, sender.name]));
      return new Map(
        rows.map((row) => [row.id, names.get(row.fromBotId ?? '') ?? REMOVED_BOT_NAME]),
      );
    };
  }

  /**
   * Resolves which tool-result message row a tool attachment claims: the
   * resumed parent call's reserved row if it exists, otherwise this run's row.
   */
  private async attachmentHostFor(
    lease: RunLease,
    parentRunId: string | undefined,
    toolCallId: string,
  ): Promise<string> {
    const own = toolResultMessageId(lease.threadId, lease.runId, toolCallId);
    if (parentRunId === undefined) return own;
    const parent = toolResultMessageId(lease.threadId, parentRunId, toolCallId);
    const stored = await this.prisma.message.findFirst({
      where: { conversationId: lease.threadId, id: { in: [parent, own] } },
      select: { id: true },
    });
    return stored?.id ?? own;
  }
}
