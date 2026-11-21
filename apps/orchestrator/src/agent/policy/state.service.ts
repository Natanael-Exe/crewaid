import { enabledPluginWhere } from '../../mcp/plugin-access.js';
import { Inject, Injectable } from '@nestjs/common';
import { JsonSchema } from '@crewaid/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SeatService } from '../../sandbox/seat.service.js';
import { SandboxReadinessService } from '../../sandbox/sandbox-readiness.service.js';
import { policyHash } from './policy.js';
import { resolvedSkillRevision, pluginRevision } from './resource-revision.js';
import { pluginArgumentValidator } from './validate-arguments.js';
import type { PolicyCall, PolicyState } from './runtime.js';

/** Only a server state reader can supply current grants and resource revisions. */
@Injectable()
export class ToolPolicyStateService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SeatService) private readonly seats: SeatService,
    @Inject(SandboxReadinessService) private readonly computers: SandboxReadinessService,
  ) {}

  async read(
    userId: string,
    botId: string,
    call: PolicyCall,
    prepare: boolean,
  ): Promise<PolicyState> {
    const bot = await this.prisma.bot.findFirst({
      where: { id: botId, userId },
      select: {
        approvalMode: true,
        autoReviewRules: true,
        identityRevision: true,
        pluginGrantRevision: true,
        activeIdentityId: true,
        sandbox: {
          select: { id: true, userId: true, sessionId: true, widthPx: true, heightPx: true },
        },
        identities: { select: { identityId: true, identity: { select: { name: true } } } },
        activeIdentity: {
          select: { id: true, name: true, sandboxId: true, sandbox: { select: { userId: true } } },
        },
      },
    });
    if (bot === null) throw new Error('GRANT_REVOKED: this bot is not owned by the caller.');
    const plugins = await this.prisma.mcpServer.findMany({
      where: { userId, ...enabledPluginWhere(botId) },
      select: {
        id: true,
        accessRevision: true,
        status: true,
        credential: { select: { id: true, revision: true } },
        composioConnection: {
          select: { accountId: true, sessionId: true, revision: true, removing: true },
        },
      },
    });
    const identity = bot.activeIdentity;
    let grantValid =
      bot.activeIdentityId === null ||
      (identity !== null &&
        bot.sandbox !== null &&
        identity.sandboxId === bot.sandbox.id &&
        identity.sandbox.userId === userId &&
        bot.identities.some((grant) => grant.identityId === identity.id));
    if (
      call.requiredIdentity !== undefined &&
      !bot.identities.some((grant) => grant.identity.name === call.requiredIdentity)
    )
      throw new Error('GRANT_REVOKED: the approved login permission was revoked.');
    const grants = {
      identityRevision: bot.identityRevision,
      selectedIdentity: bot.activeIdentityId,
      identities: bot.identities.map((grant) => grant.identityId).sort(),
      pluginRevision: bot.pluginGrantRevision,
      plugins: plugins
        .map((grant) => ({
          id: grant.id,
          accessRevision: grant.accessRevision,
          credential: grant.credential,
          composio: grant.composioConnection,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    };
    let resourceRevision: string | null = null;
    let validate = call.validate;
    let skillRevision: string | undefined;
    if (call.behavior?.origin.kind === 'mcp') {
      const serverId = call.behavior.origin.serverId;
      grantValid &&= plugins.some(
        (grant) =>
          grant.id === serverId &&
          (grant.composioConnection === null ||
            (grant.status === 'CONNECTED' && !grant.composioConnection.removing)),
      );
      const resource = call.resource;
      if (resource === undefined) grantValid = false;
      else {
        const tool = await this.prisma.mcpTool.findFirst({
          where: { serverId, name: resource.toolName, server: { userId } },
          select: { name: true, inputSchema: true, readOnly: true, source: true },
        });
        grantValid &&= tool !== null;
        if (tool !== null) {
          resourceRevision = pluginRevision(serverId, tool);
          if (resourceRevision !== resource.revision)
            throw new Error('APPROVAL_STALE: refresh the plugin definition before calling it.');
          validate = pluginArgumentValidator(tool.inputSchema);
        }
      }
    }
    if (call.name === 'run_skill') {
      const args = JsonSchema.parse(call.args);
      const name =
        args !== null && typeof args === 'object' && !Array.isArray(args)
          ? args['name']
          : undefined;
      if (typeof name !== 'string') throw new Error('INVALID_ARGUMENTS: a skill name is required.');
      const skill = await this.prisma.skill.findFirst({
        where: {
          ...(call.skillId === undefined ? { name } : { id: call.skillId }),
          status: 'APPROVED',
          OR: [{ botId, bot: { userId } }, { botId: null }],
        },
        orderBy: [{ botId: { sort: 'desc', nulls: 'last' } }, { version: 'desc' }],
      });
      if (skill === null) throw new Error('GRANT_REVOKED: that approved skill is unavailable.');
      if (skill.name !== name)
        throw new Error('INVALID_ARGUMENTS: the requested skill name changed.');
      skillRevision = resolvedSkillRevision(skill);
      resourceRevision = skillRevision;
      const parameters = pluginArgumentValidator(skill.paramsSchema);
      validate = async (input) => {
        const base = await call.validate?.(input);
        if (base?.ok === false) return base;
        const parsed = JsonSchema.parse(input);
        const params =
          parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed['params'] ?? {})
            : null;
        const result = await parameters(params);
        return result.ok ? { ok: true, value: parsed } : result;
      };
    }
    let seat: PolicyState['snapshot']['seat'] = null;
    if (call.behavior?.effect === 'seat') {
      const computer = bot.sandbox;
      if (computer === null || computer.userId !== userId)
        throw new Error('GRANT_REVOKED: this bot has no owned computer.');
      const sessionId = computer.sessionId ?? computer.id;
      if (prepare) {
        await this.computers.withComputer(userId, botId, 'agent-tool', async () => {
          await this.seats.ensureSeat(sessionId, botId, {
            widthPx: computer.widthPx,
            heightPx: computer.heightPx,
          });
          // A named login window is bound to a real Chrome launch, never a desired selection.
          if (identity !== null || call.name.startsWith('browser_'))
            await this.seats.ensureBrowser(sessionId, botId);
        });
      }
      const live = await this.seats.seatFor(sessionId, botId);
      if (live === null) throw new Error('APPROVAL_STALE: the approved seat is no longer running.');
      if (
        live.profile !== (identity?.name ?? botId) ||
        live.identityRevision !== bot.identityRevision
      ) {
        throw new Error('APPROVAL_STALE: the seat login selection changed.');
      }
      seat = { identity: identity?.name ?? null, browserGeneration: live.browserGeneration };
      resourceRevision = policyHash({ resource: resourceRevision, seatId: live.seatId });
    }
    return {
      snapshot: {
        mode: bot.approvalMode,
        rules: bot.autoReviewRules,
        grantRevision: policyHash(grants),
        grantValid,
        seat,
        resourceRevision,
      },
      ...(validate !== undefined && { validate }),
      ...(skillRevision !== undefined && { skillRevision }),
    };
  }
}
