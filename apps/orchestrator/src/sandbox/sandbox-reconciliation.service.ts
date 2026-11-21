import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Prisma, Sandbox, SandboxState } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import { TurnEventBus } from '../agent/turn-event.bus.js';
import {
  SANDBOX_PROVIDER,
  type SandboxProvider,
  type SandboxRuntimeObservation,
} from './sandbox.provider.js';
import { SANDBOX_LOCK_LEASE_MS } from './sandbox.service.js';
import { lifecycleLeaseFresh } from './lifecycle-lease.js';

/**
 * Repairs disagreement between durable rows and provider observations.
 *
 * Reconciliation observes first and mutates second. It never creates a runtime
 * or a workspace: a missing container is evidence for an operator-visible
 * recoverable state, not permission to produce an empty desktop. The only
 * deletion here is a provider-owned container. Workspace deletion belongs only
 * to the separate, grace-period retention path, never runtime reconciliation.
 */
@Injectable()
export class SandboxReconciliationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SandboxReconciliationService.name);
  private readonly reconcileOnBoot: boolean;
  private sweeping = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SANDBOX_PROVIDER) private readonly provider: SandboxProvider,
    @Inject(TurnEventBus) private readonly events: TurnEventBus,
  ) {
    this.reconcileOnBoot = process.env['SANDBOX_RECONCILE_ON_BOOT'] !== 'false';
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.reconcileOnBoot) {
      this.logger.log('sandbox startup reconciliation disabled');
      return;
    }
    await this.sweep();
  }

  /** One idempotent reconciliation pass. Public so recovery tests can drive it. */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const [runtimes, rows] = await Promise.all([
        this.provider.listManagedSessions(),
        this.prisma.sandbox.findMany(),
      ]);
      // The runtime's identity label holds the COMPUTER's id, because
      // that is what the lifecycle passes as `identity` and what names the
      // workspace volume. Matching it against bot ids — which is what this did
      // when the two were the same string — would treat every machine created
      // after the migration as an orphan and destroy live containers. Matching
      // against known machines is the same question the old code was asking,
      // asked of the thing that now answers it.
      const rowsByMachine = new Map(rows.map((row) => [row.id, row]));
      const runtimesByMachine = new Map<string, SandboxRuntimeObservation[]>();

      for (const runtime of runtimes) {
        if (
          runtime.botId === null ||
          runtime.sessionId === null ||
          !rowsByMachine.has(runtime.botId)
        ) {
          // A container the database has no machine for cannot be attributed
          // to a user, and an unowned machine is unreachable through every
          // R7-scoped query. Before D-046 this branch could create the missing
          // row because the label named a live bot, and a bot carries its
          // owner; a computer id carries nothing. The container goes; the
          // VOLUME is never touched here.
          await this.removeOrphan(runtime, 'no live computer or incomplete identity labels');
          continue;
        }
        const group = runtimesByMachine.get(runtime.botId) ?? [];
        group.push(runtime);
        runtimesByMachine.set(runtime.botId, group);
      }

      const observedMachines = new Set<string>();
      for (const [machineId, candidates] of runtimesByMachine) {
        observedMachines.add(machineId);
        const row = rowsByMachine.get(machineId) ?? null;
        const preferred = chooseRuntime(candidates, row);
        let duplicatesRemoved = true;
        for (const duplicate of candidates) {
          if (duplicate.containerId === preferred.containerId) continue;
          duplicatesRemoved =
            (await this.removeOrphan(duplicate, `duplicate runtime for computer ${machineId}`)) &&
            duplicatesRemoved;
        }
        if (!duplicatesRemoved) {
          await this.markUnhealthy(
            row,
            machineId,
            'Reconciliation could not remove every duplicate runtime; refusing to attach while another writable container may exist.',
          );
          continue;
        }

        if (preferred.workspace?.ok !== true) {
          const reason =
            preferred.workspace === null
              ? 'runtime has no durable workspace identity'
              : preferred.workspace.reason;
          const removed = await this.removeOrphan(preferred, `inconsistent runtime: ${reason}`);
          await this.markUnhealthy(
            row,
            machineId,
            `Runtime ${preferred.containerId} is inconsistent: ${reason}. No workspace was deleted.`,
            removed,
          );
          continue;
        }

        await this.adopt(row, preferred);
      }

      for (const row of rows) {
        if (row.workspacePending || row.pausePending) continue;
        if (observedMachines.has(row.id) || row.state === 'ERROR') {
          continue;
        }
        if (isFreshStart(row)) continue;
        const workspace = await this.provider.inspectWorkspace({ botId: row.id });
        if (
          row.state === 'STOPPED' &&
          row.sessionId === null &&
          row.containerId === null &&
          row.lastStartedAt === null &&
          workspace.exists &&
          workspace.ok
        ) {
          const history = await this.provider.inspectWorkspaceHistory({ botId: row.id });
          if (!history.referenced && history.runtimeCreatedAt === null) continue;
        }
        const detail = !workspace.exists
          ? 'no durable workspace volume was observed'
          : workspace.ok
            ? `workspace ${workspace.volumeName} was preserved`
            : `the workspace exists but is inconsistent: ${workspace.reason}`;
        await this.markUnhealthy(
          row,
          row.id,
          `Runtime ${row.sessionId ?? row.id} is missing; ${detail}. Replacement requires an explicit start/recovery action.`,
          true,
        );
      }
    } catch (error: unknown) {
      // Boot recovery is best effort. A Docker outage must not prevent the API
      // from coming up, and a later explicit pass can retry the same idempotent work.
      this.logger.error(`sandbox reconciliation failed: ${messageOf(error)}`);
    } finally {
      this.sweeping = false;
    }
  }

  private async adopt(row: Sandbox | null, runtime: SandboxRuntimeObservation): Promise<void> {
    const machineId = runtime.botId;
    const sessionId = runtime.sessionId;
    if (machineId === null || sessionId === null) return;
    // The sweep only groups runtimes whose identity matches a known
    // machine, so a null row here is unreachable. It stays typed as nullable
    // because `chooseRuntime` and the diagnostics below still take one, and a
    // silent return is a better answer than creating a machine with no owner.
    if (row === null || row.pausePending) return;
    if (row.state === 'STARTING' && isFreshStart(row)) return;

    const lease = nextLease(row.lastStartedAt);
    const claimed = await this.claim(row, sessionId, runtime.containerId, lease);
    if (!claimed) return;

    try {
      if (row.state === 'ERROR' && runtime.running && this.provider.workspaceOnFirstStart) {
        // Early Runtime deployments could leave running machines in ERROR.
        await this.settle(machineId, lease, {
          state: 'UNHEALTHY',
          pausePending: true,
          containerId: runtime.containerId,
          lastError: row.lastError,
        });
        return;
      }

      // A stopped, unrecorded runtime is adopted as stopped. Starting it here
      // would bypass host admission because no durable row occupied a slot
      // before this pass. The next explicit start goes through SandboxService
      // and resumes this exact container under the normal capacity fence.
      if (row.state === 'STOPPED' || !runtime.running) {
        const session = await this.provider.attachSession({ sessionId });
        if (session !== null && runtime.running) await session.stop();
        await this.settle(machineId, lease, {
          state: 'STOPPED',
          sessionId,
          containerId: runtime.containerId,
          vncPort: null,
          cdpPort: null,
          bridgePort: null,
          lastError: null,
          keepRunningUntil: null,
        });
        return;
      }

      const session = await this.provider.resumeSession({ sessionId });
      const [rfb, cdp, bridge] = await Promise.all([
        session.getPortEndpoint({ port: 5900 }),
        session.getPortEndpoint({ port: 9222 }),
        session.getPortEndpoint({ port: 7070 }),
      ]);
      await this.settle(machineId, lease, {
        state: 'RUNNING',
        workspacePending: false,
        sessionId: session.id,
        containerId: session.containerId,
        widthPx: session.screen.widthPx,
        heightPx: session.screen.heightPx,
        vncPort: portOf(rfb.url),
        cdpPort: portOf(cdp.url),
        bridgePort: portOf(bridge.url),
        lastActiveAt: row?.lastActiveAt ?? new Date(),
        lastError: null,
      });
    } catch (error: unknown) {
      await this.settle(machineId, lease, {
        state: 'UNHEALTHY',
        lastError: `Reconciliation could not recover runtime ${runtime.containerId}: ${messageOf(error)}`,
      });
    }
  }

  private async claim(
    row: Sandbox,
    sessionId: string,
    containerId: string,
    lease: Date,
  ): Promise<boolean> {
    void sessionId;
    void containerId;
    const claimed = await this.prisma.sandbox.updateMany({
      where: {
        id: row.id,
        state: row.state,
        lastStartedAt: row.lastStartedAt,
      },
      data: { state: 'STARTING', lastStartedAt: lease, lastError: null },
    });
    return claimed.count === 1;
  }

  private async settle(
    machineId: string,
    lease: Date,
    data: Prisma.SandboxUpdateManyMutationInput,
  ): Promise<void> {
    const updated = await this.prisma.sandbox.updateManyAndReturn({
      where: { id: machineId, state: 'STARTING', lastStartedAt: lease },
      data,
    });
    const row = updated[0];
    if (row === undefined) return;
    await this.announceToTenants(machineId, row.state, row.widthPx, row.heightPx);
  }

  /**
   * §4.2 frames are addressed to a bot, and a machine has several.
   *
   * Every tenant's client is looking at this machine, so every tenant is told.
   * Announcing under one arbitrary tenant would leave the others showing a
   * desktop that is no longer there — silently, and only for the bots nobody
   * was looking at.
   */
  private async announceToTenants(
    machineId: string,
    state: SandboxState,
    widthPx: number,
    heightPx: number,
  ): Promise<void> {
    const tenants = await this.prisma.bot.findMany({
      where: { sandboxId: machineId },
      select: { id: true },
    });
    for (const tenant of tenants) {
      this.events.emitSandboxState(tenant.id, state, widthPx, heightPx);
    }
  }

  private async markUnhealthy(
    row: Sandbox | null,
    machineId: string,
    reason: string,
    clearContainer = false,
  ): Promise<void> {
    // A diagnosis needs a machine to write it on, and one that does not
    // exist cannot be created here — reconciliation sees a container's
    // identity label, never a user, and a machine with no owner is unreachable
    // through every R7-scoped query. The container was already removed as an
    // orphan by the caller; the workspace is untouched.
    if (row === null) {
      this.logger.warn(`computer ${machineId} has no row to record a diagnosis on: ${reason}`);
      return;
    }

    const updated = await this.prisma.sandbox.updateManyAndReturn({
      where: { id: row.id, state: row.state, lastStartedAt: row.lastStartedAt },
      data: {
        state: 'UNHEALTHY',
        ...(clearContainer ? { containerId: null } : {}),
        vncPort: null,
        cdpPort: null,
        bridgePort: null,
        lastError: reason,
      },
    });
    const changed = updated[0];
    if (changed !== undefined) {
      await this.announceToTenants(machineId, changed.state, changed.widthPx, changed.heightPx);
    }
  }

  private async removeOrphan(runtime: SandboxRuntimeObservation, reason: string): Promise<boolean> {
    try {
      await this.provider.removeManagedSession({ containerId: runtime.containerId });
      this.logger.warn(`removed container ${runtime.containerId}: ${reason}; workspace preserved`);
      return true;
    } catch (error: unknown) {
      this.logger.error(
        `could not remove container ${runtime.containerId} (${reason}): ${messageOf(error)}`,
      );
      return false;
    }
  }
}

function chooseRuntime(
  candidates: readonly SandboxRuntimeObservation[],
  row: Sandbox | null,
): SandboxRuntimeObservation {
  return (
    candidates.find((candidate) => candidate.containerId === row?.containerId) ??
    candidates.find((candidate) => candidate.sessionId === (row?.sessionId ?? row?.id)) ??
    candidates.find((candidate) => candidate.workspace?.ok === true && candidate.running) ??
    candidates.find((candidate) => candidate.workspace?.ok === true) ??
    candidates[0]!
  );
}

function isFreshStart(row: Sandbox): boolean {
  return row.state === 'STARTING' && lifecycleLeaseFresh(row, Date.now(), SANDBOX_LOCK_LEASE_MS);
}

function nextLease(previous: Date | null): Date {
  return new Date(Math.max(Date.now(), (previous?.getTime() ?? 0) + 1));
}

function portOf(url: string): number {
  const port = Number(new URL(url).port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Sandbox endpoint did not contain a valid port: ${url}`);
  }
  return port;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
