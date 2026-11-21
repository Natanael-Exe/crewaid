import { validateSkillArguments } from './skill-arguments.js';
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Skill } from '@prisma/client';
import { JsonSchema } from '@crewaid/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SandboxReadinessService } from '../../sandbox/sandbox-readiness.service.js';
import { SeatControlService } from '../../screen/seat-control.service.js';
import { TurnEventBus } from '../turn-event.bus.js';
import { SEAT_BUILTIN } from '../tool-registry.js';
import { createPolicyRuntime } from './runtime.js';
import { createPolicyProposalStore } from './proposal-store.js';
import { ToolPolicyStateService } from './state.service.js';
import { ToolApprovalHub } from './approval-hub.js';

/** Direct operator requests approve this exact skill; schedules receive no implicit approval. */
@Injectable()
export class SkillExecutionPolicy {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ToolPolicyStateService) private readonly state: ToolPolicyStateService,
    @Inject(ToolApprovalHub) private readonly hub: ToolApprovalHub,
    @Inject(SandboxReadinessService) private readonly computers: SandboxReadinessService,
    @Inject(SeatControlService) private readonly control: SeatControlService,
    @Inject(TurnEventBus) private readonly events: TurnEventBus,
  ) {}

  async prepare(
    userId: string,
    botId: string,
    skill: Skill,
    params: unknown,
    operator: boolean,
    signal?: AbortSignal,
  ) {
    const args = JsonSchema.parse({ name: skill.name, params });
    const conversation = await this.prisma.conversation.findFirst({
      where: { botId, bot: { userId } },
      select: { id: true },
    });
    if (conversation === null)
      throw new Error('GRANT_REVOKED: this bot has no owned conversation.');
    const run = await this.prisma.agentTurn.create({
      data: {
        bot: { connect: { id: botId, userId } },
        conversation: { connect: { id: conversation.id, bot: { userId } } },
        activeKey: botId,
        triggerMessageId: randomUUID(),
        status: 'running',
      },
    });
    const scope = { userId, botId, conversationId: conversation.id, runId: run.id };
    const store = createPolicyProposalStore(this.prisma, scope);
    const callId = randomUUID();
    const policy = createPolicyRuntime({
      project: (name, input) => ({
        name,
        args: input,
        behavior: SEAT_BUILTIN,
        skillId: skill.id,
        validate: validateSkillArguments,
      }),
      onProposal: (id) => this.hub.register(scope, id, policy.answer, policy.cancel),
      read: async (call, prepare) => {
        if (prepare)
          await this.computers.withComputer(userId, botId, 'skill', () =>
            Promise.resolve(undefined),
          );
        return this.state.read(userId, botId, call, prepare);
      },
      store,
      preflight: async () => {
        const admitted = await this.control.seats.admit(botId, 'targeted', signal);
        if (!admitted.ok) return `${admitted.refusal.code}: ${admitted.refusal.message}`;
        admitted.release();
        return null;
      },
    });
    let finished: Promise<void> | undefined;
    const finish = (status: 'completed' | 'failed') =>
      (finished ??= (async () => {
        await this.hub.finishRun(userId, run.id);
        await this.prisma.$transaction(async (tx) => {
          const terminal = await tx.agentTurn.updateMany({
            where: {
              id: run.id,
              botId,
              bot: { userId },
              status: { in: ['running', 'interrupted'] },
            },
            data: { status, endedAt: new Date(), activeKey: null },
          });
          if (terminal.count === 1)
            await tx.bot.updateMany({ where: { id: botId, userId }, data: { status: 'IDLE' } });
        });
        this.events.emitBotStatus(botId, 'IDLE');
      })());
    try {
      const decision = await policy.decide({
        toolCall: { toolName: 'run_skill', input: args, toolCallId: callId },
      });
      if (typeof decision === 'object') throw new Error(decision.reason);
      if (decision === 'user-approval') {
        const prompt = policy.prompt({
          approvalId: callId,
          toolCallId: callId,
          toolName: 'run_skill',
          args,
        });
        let answer;
        if (operator) {
          await this.hub.respond(userId, prompt.toolCallId, { approved: true });
          answer = await this.hub.wait(scope, prompt, policy.answer, policy.cancel, signal);
        } else {
          await this.prisma.agentTurn.updateMany({
            where: { id: run.id, botId, bot: { userId }, status: 'running' },
            data: { status: 'interrupted' },
          });
          await this.prisma.bot.updateMany({
            where: { id: botId, userId },
            data: { status: 'AWAITING_APPROVAL' },
          });
          this.events.emitBotStatus(botId, 'AWAITING_APPROVAL');
          answer = await this.hub.wait(scope, prompt, policy.answer, policy.cancel, signal);
          await this.prisma.agentTurn.updateMany({
            where: { id: run.id, botId, bot: { userId }, status: 'interrupted' },
            data: { status: 'running' },
          });
        }
        if (!answer?.approved)
          throw new Error(answer?.reason ?? 'POLICY_DENIED: this skill was declined.');
      }
      await this.prisma.bot.updateMany({
        where: { id: botId, userId },
        data: { status: 'ACTING' },
      });
      this.events.emitBotStatus(botId, 'ACTING');
      return { policy, args, callId, finish };
    } catch (error) {
      await finish('failed');
      throw error;
    }
  }
}
