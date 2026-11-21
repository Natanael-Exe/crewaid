import { SkillExecutionPolicy } from '../agent/policy/skill-policy.js';
import { resolvedSkillRevision } from '../agent/policy/resource-revision.js';
import type { Skill } from '@prisma/client';
import { JsonSchema } from '@crewaid/shared';
import { SeatControlService } from '../screen/seat-control.service.js';
import type { SeatAdmission } from '../screen/seat-control.js';
import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SANDBOX_PORTS } from '@crewaid/sandbox-core';
import type { RunSkillBody, RunSkillResponse } from '@crewaid/shared';
import type { RunStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import { SandboxReadinessService } from '../sandbox/sandbox-readiness.service.js';
import { SANDBOX_PROVIDER, type SandboxProvider } from '../sandbox/sandbox.provider.js';
import { SeatService } from '../sandbox/seat.service.js';
import { computerOfBot } from '../sandbox/attached-computer.js';

/**
 * Running an APPROVED skill.
 *
 * Why the route answers before the run finishes
 *
 * §6/M3's bound on a single run is the runner's own 600 s, so a synchronous
 * `POST /skills/:id/run` would hold an HTTP request open across an outage of
 * that length. The route creates the `SkillRun` row and answers with its id;
 * the client follows `GET /skills/:id/runs/:runId`, which is what that route
 * is for.
 *
 * Why the run holds a lease
 *
 * A `SkillRun` is not one of the two rows §8's idle sweep counts as work
 * (`AgentTurn`, `Recording`), so the container would be stoppable mid-run
 * unless someone protects it. It is exactly the case D-041 §17 built the
 * keep-running lease for — a managed operation with no §8-recognized row —
 * so the execution holds `withComputer(..., 'skill', ...)` for its whole life
 * and the lease service renews on its own timer.
 *
 * Where the script runs
 *
 * Never in this process. The orchestrator resolves the bot's bridge
 * endpoint and asks `POST /skill/run`; the executor lives in the sandbox
 * image. This service carries no script-evaluating import
 * and must not grow one — CC-06's lint rules guard the same door.
 */
/**
 * The fence on a run's own writes, decided from the RESOLVED skill.
 *
 * A bot-owned skill is scoped by its owner, which is R7 as everywhere else. A
 * GLOBAL skill has no owner to scope by — that is what global means — so
 * ownership cannot be its fence and the run id is: the row was created by the
 * call that resolved the skill under a scoped query, and a cuid is not
 * guessable.
 *
 * Taken as an argument rather than as an `OR` in the where-clause on purpose.
 * A widened clause would let ANY future caller of `execute` settle a global
 * skill's run from an id it never validated; this way the caller that
 * resolved the skill says which fence applies, and a caller that did not
 * resolve one cannot ask for the weaker one by accident.
 *
 * Without either branch a global skill's run is created PENDING and stays
 * PENDING forever: `markRunning` claims nothing, `settle` writes nothing, and
 * the caller waits for a row nobody will settle. Found by
 * `skill-tools-scope.integration.test.ts`, which is the only place a global
 * skill exists — v1 has no way to create one through the API yet.
 */
function runFence(userId: string, ownerScoped: boolean): Record<string, unknown> {
  return ownerScoped ? { skill: { bot: { userId } } } : { skill: { botId: null } };
}

@Injectable()
export class SkillRunService {
  private readonly logger = new Logger(SkillRunService.name);

  /**
   * How long one bridge call may take.
   *
   * The sandbox bounds a run at 600 s itself (`SKILL_TIMEOUT_S`) and answers a
   * structured `SKILL_TIMEOUT` when it fires. Aborting exactly on that bound
   * would race the bridge's own answer — and lose the returned logs when the
   * race is lost — so this sits just above it: a bridge that is wedged
   * entirely is still cut off, and one that answers in time has its outcome
   * reported verbatim.
   */
  static readonly BRIDGE_TIMEOUT_MS = 620_000;

  // Explicit tokens: vitest/esbuild emits no design:paramtypes, so type-based
  // DI resolution silently fails in the integration suite.
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SandboxReadinessService) private readonly computers: SandboxReadinessService,
    @Inject(SANDBOX_PROVIDER) private readonly provider: SandboxProvider,
    @Inject(SeatService) private readonly seats: SeatService,
    @Inject(SeatControlService) private readonly seatControl?: SeatControlService,
    @Inject(SkillExecutionPolicy) private readonly skillPolicy?: SkillExecutionPolicy,
  ) {}

  /** Accept a run: gate it, create its row, and start it in the background. */
  async start(
    userId: string,
    skillId: string,
    params: RunSkillBody['params'],
  ): Promise<RunSkillResponse> {
    const { botId, skill, runId } = await this.accept(userId, skillId, params);

    // Fire-and-forget by design: `execute` settles every outcome on the row
    // and must never reject (a rejection here would be a bug, and it is
    // logged rather than left unhandled).
    void this.execute(userId, botId, skill, runId, params, undefined, undefined, true).catch(
      (error: unknown) => {
        this.logger.error(`skill run ${runId} crashed: ${messageOf(error)}`);
      },
    );

    return { runId };
  }

  /**
   * §6/M8 — a routine that runs a skill.
   *
   * `start` by id, with the same gate, but AWAITED: a routine's firing is the
   * unit of work the scheduler waits on, so it has to last as long as the run
   * does, and the routine's `lastStatus` is this run's outcome rather than
   * "accepted". Not `runForBot`, which resolves by NAME and so would run
   * whichever version is newest rather than the one the operator scheduled.
   */
  async runToCompletion(
    userId: string,
    skillId: string,
    params: RunSkillBody['params'],
  ): Promise<{ runId: string; status: RunStatus }> {
    const { botId, skill, runId } = await this.accept(userId, skillId, params);
    await this.execute(userId, botId, skill, runId, params);
    const settled = await this.prisma.skillRun.findFirst({
      where: { id: runId, skill: { bot: { userId } } },
      select: { status: true },
    });
    return { runId, status: settled?.status ?? 'FAILED' };
  }

  /**
   * M5-BE-06 — `run_skill(name, params)` for the agent loop.
   *
   * Three things make this a sibling of `start` rather than a caller of it.
   *
   * IT RESOLVES A NAME, not an id. §6/M5 gives the model a name because that
   * is what a skill is called in the transcript it can see; an id is not
   * something a model can know. `@@unique([botId, name, version])` means a
   * name can have several rows, so the newest APPROVED version wins and a
   * bot's own skill beats a global one of the same name — the specific
   * beating the general, which is the order the operator would expect when
   * they wrote a bot-local override.
   *
   * IT ALLOWS A GLOBAL SKILL. §6/M5: "only APPROVED skills belonging to that
   * bot or global". `start` refuses `botId === null` because §4.1's route
   * names no bot to borrow a computer from; a turn always has one, so the
   * refusal does not apply here.
   *
   * IT AWAITS THE OUTCOME. `start` is fire-and-forget because its HTTP caller
   * polls. A tool call IS the poll: the model asked in order to use the
   * answer, and handing it a run id to chase would spend the turn's steps on
   * bookkeeping. `execute` already settles every outcome on the row, so the
   * row is still the record; this just waits for it.
   */
  async runForBot(
    userId: string,
    botId: string,
    name: string,
    params: RunSkillBody['params'],
    signal?: AbortSignal,
    permit?: (revision: string, params: unknown) => Promise<void>,
  ): Promise<{ status: string; logs: string | null; error: string | null }> {
    const skill = await this.prisma.skill.findFirst({
      // Scoped by the principal AND by reachability: this bot's own skills,
      // or the global ones. Another bot's skill is not found rather than
      // refused — it is not a thing this bot can name.
      where: {
        name,
        status: 'APPROVED',
        OR: [{ botId, bot: { userId } }, { botId: null }],
      },
      // A bot-owned row first, then the newest version of whatever matched.
      orderBy: [{ botId: { sort: 'desc', nulls: 'last' } }, { version: 'desc' }],
    });
    if (skill === null) {
      throw new NotFoundException(`no APPROVED skill named "${name}" is available to this bot`);
    }

    const run = await this.prisma.skillRun.create({
      data: { skillId: skill.id, params, status: 'PENDING' },
    });
    await this.execute(userId, botId, skill, run.id, params, signal, permit);

    const settled = await this.prisma.skillRun.findFirst({ where: { id: run.id } });
    return {
      status: settled?.status ?? 'FAILED',
      logs: settled?.logs ?? null,
      error: settled?.error ?? null,
    };
  }

  /**
   * One run's current state (§4.1's trailing route).
   *
   * `skillId` is part of the lookup, not a decoration: the ownership guard
   * fences the RUN by its own id (D-026), and this is the check that the run
   * it found is a run OF the skill the path names — otherwise a run id from
   * any of the caller's skills would be readable through any other.
   */
  async status(userId: string, skillId: string, runId: string) {
    const run = await this.prisma.skillRun.findFirst({
      where: { id: runId, skill: { id: skillId, bot: { userId } } },
    });
    if (run === null) throw new NotFoundException('Run not found');
    return run;
  }

  /**
   * Settle runs a previous process left behind.
   *
   * A `PENDING`/`RUNNING` row is claimed in memory and executed by this
   * process alone, so at boot one can only mean the process that owned it is
   * gone — and nothing else ever revisits it, because no sweep counts run
   * rows as work. `FAILED` with the sentence, same shape as the recording
   * recoveries: a row that says why beats a row that says `RUNNING` forever.
   *
   * Driven from `main.ts` exactly as `recoverInterruptedRecordings` is, and
   * for the same reason: suites boot `AppModule` many times against one
   * shared database, and a hook would make every boot settle every other
   * suite's rows.
   */
  async recoverInterruptedRuns(): Promise<number> {
    const settled = await this.prisma.skillRun.updateMany({
      where: { status: { in: ['PENDING', 'RUNNING'] } },
      data: {
        status: 'FAILED',
        error: 'the run did not survive an orchestrator restart',
        endedAt: new Date(),
      },
    });
    if (settled.count > 0) {
      this.logger.warn(`settled ${settled.count} interrupted skill run(s) FAILED`);
    }
    return settled.count;
  }

  /**
   * The gate every run by id passes, and the row it creates.
   *
   * PRD §6/M3: "A `DRAFT` skill cannot be run. Only `APPROVED`." That is the
   * gate, and it is a conflict rather than a validation error: the request is
   * well-formed and the state of the resource is the reason it fails, which
   * is also the sentence the client shows.
   */
  private async accept(userId: string, skillId: string, params: RunSkillBody['params']) {
    const skill = await this.prisma.skill.findFirst({
      where: { id: skillId, bot: { userId } },
    });
    if (skill === null) throw new NotFoundException('Skill not found');

    if (skill.status !== 'APPROVED') {
      throw new ConflictException(
        `skill "${skill.name}" is ${skill.status} — only an APPROVED skill can be run`,
      );
    }
    if (skill.botId === null) {
      // A global skill has no computer to run on, and §4.1's run route names
      // no bot to borrow. v1 has no way to create one; this refusal is for
      // the day one exists.
      throw new ConflictException(
        `skill "${skill.name}" is not attached to a bot, so there is no computer to run it on`,
      );
    }
    const botId = skill.botId;

    const run = await this.prisma.skillRun.create({
      data: { skillId: skill.id, params, status: 'PENDING' },
    });

    return { botId, skill, runId: run.id };
  }

  /**
   * The background half of `start`, from `PENDING` to a terminal state.
   *
   * Never rejects: every path here — the wake refusing for capacity, a bridge
   * that is gone, a script that throws — is an outcome the row must carry,
   * because the HTTP caller is long answered and the polling client is the
   * only reader.
   */
  private async execute(
    userId: string,
    botId: string,
    skill: Skill,
    runId: string,
    params: RunSkillBody['params'],
    signal?: AbortSignal,
    permit?: (revision: string, params: unknown) => Promise<void>,
    operator = false,
  ): Promise<void> {
    let standalone: Awaited<ReturnType<SkillExecutionPolicy['prepare']>> | undefined;
    let admission: SeatAdmission | undefined;
    try {
      if (permit === undefined) {
        if (this.skillPolicy === undefined)
          throw new Error('POLICY_UNAVAILABLE: no skill execution policy is wired.');
        standalone = await this.skillPolicy.prepare(userId, botId, skill, params, operator, signal);
      }
      // HTTP, routine and model callers share this boundary; counting the
      // complete replay prevents a human grant halfway through its steps.
      admission = await this.seatControl?.seats.admit(botId, 'targeted', signal);
      if (admission !== undefined && !admission.ok) {
        await standalone?.finish('failed');
        await this.settleFailed(
          userId,
          runId,
          `${admission.refusal.message} (${admission.refusal.code})`,
          skill.botId !== null,
        );
        return;
      }
      // The resolved skill decides the fence: owner-scoped unless it is global.
      const ownerScoped = skill.botId !== null;
      if (!(await this.markRunning(userId, runId, ownerScoped)))
        throw new Error('APPROVAL_STALE: this skill run is no longer pending.');
      const outcome = await this.computers.withComputer(userId, botId, 'skill', async () => {
        const bridge = await this.bridgeOf(botId);
        const current = await this.prisma.skill.findFirst({
          where: {
            id: skill.id,
            status: 'APPROVED',
            OR: [{ botId, bot: { userId } }, { botId: null }],
          },
        });
        if (current === null) throw new Error('GRANT_REVOKED: this approved skill is unavailable.');
        if (permit !== undefined) {
          await permit(resolvedSkillRevision(current), params);
          return this.runOnBridge(bridge, current.script, params, botId);
        }
        if (standalone === undefined) throw new Error('POLICY_UNAVAILABLE');
        let result: BridgeRunOutcome | undefined;
        const response = await standalone.policy.execute(
          'run_skill',
          standalone.args,
          standalone.callId,
          async (finalArgs) => {
            const parsed = JsonSchema.parse(finalArgs);
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
              throw new Error('INVALID_ARGUMENTS');
            const finalParams = parsed['params'] ?? {};
            await standalone!.policy.skillPermit(standalone!.callId)(
              resolvedSkillRevision(current),
              finalParams,
            );
            if (
              finalParams === null ||
              typeof finalParams !== 'object' ||
              Array.isArray(finalParams)
            )
              throw new Error('INVALID_ARGUMENTS');
            await this.prisma.skillRun.updateMany({
              where: { id: runId, status: 'RUNNING', ...runFence(userId, ownerScoped) },
              data: { params: finalParams },
            });
            result = await this.runOnBridge(bridge, current.script, finalParams, botId);
            return result;
          },
        );
        if (result === undefined)
          throw new Error(typeof response === 'string' ? response : 'APPROVAL_STALE');
        return result;
      });
      await standalone?.finish(outcome.error === null ? 'completed' : 'failed');
      await this.settle(userId, runId, outcome, ownerScoped);
      this.logger.log(
        `skill run ${runId} (${skill.name}) settled ${outcome.error === null ? 'SUCCEEDED' : 'FAILED'}`,
      );
    } catch (error: unknown) {
      try {
        await standalone?.finish('failed');
      } finally {
        await this.settleFailed(userId, runId, messageOf(error), skill.botId !== null);
      }
    } finally {
      if (admission?.ok) admission.release();
    }
  }

  private async markRunning(userId: string, runId: string, ownerScoped: boolean): Promise<boolean> {
    const claimed = await this.prisma.skillRun.updateMany({
      where: { id: runId, status: 'PENDING', ...runFence(userId, ownerScoped) },
      data: { status: 'RUNNING', startedAt: new Date() },
    });
    if (claimed.count === 0) {
      // Only this process claims a run, and only once — a zero here means a
      // boot recovery settled a row this process somehow resurrected, which
      // is worth a line rather than a silent continue.
      this.logger.warn(`skill run ${runId} was not PENDING when it started`);
    }
    return claimed.count === 1;
  }

  private async settle(
    userId: string,
    runId: string,
    outcome: BridgeRunOutcome,
    ownerScoped: boolean,
  ): Promise<void> {
    // The terminal write is fenced the same way the compile's is: pinned to
    // the non-terminal states this process owns, so a row boot recovery
    // settled is not written over by a late answer.
    await this.prisma.skillRun.updateMany({
      where: {
        id: runId,
        status: { in: ['PENDING', 'RUNNING'] },
        ...runFence(userId, ownerScoped),
      },
      data:
        outcome.error === null
          ? { status: 'SUCCEEDED', logs: outcome.logs, error: null, endedAt: new Date() }
          : { status: 'FAILED', logs: outcome.logs, error: outcome.error, endedAt: new Date() },
    });
  }

  private async settleFailed(
    userId: string,
    runId: string,
    reason: string,
    ownerScoped: boolean,
  ): Promise<void> {
    try {
      await this.settle(userId, runId, { logs: null, error: reason }, ownerScoped);
      this.logger.error(`skill run ${runId} failed: ${reason}`);
    } catch (error: unknown) {
      // The database is the only place this could be reported, so there is
      // nowhere left to put it but the log.
      this.logger.error(
        `skill run ${runId} failed (${reason}) and the failure could not be recorded: ` +
          messageOf(error),
      );
    }
  }

  /** The bot's bridge, resolved per run — a wake can move the published port. */
  private async bridgeOf(botId: string): Promise<BridgeEndpoint> {
    const sandbox = await computerOfBot(this.prisma, botId, {
      sessionId: true,
      widthPx: true,
      heightPx: true,
    });
    if (sandbox === null) throw new Error(`bot ${botId} has no sandbox to run in`);
    // Falls back to botId exactly as the lifecycle does: a container created
    // before its session id was persisted still answers to that key.
    const sessionId = sandbox.sessionId ?? botId;
    const session = await this.provider.attachSession({ sessionId });
    if (session === null) throw new Error(`no container is attached to session ${sessionId}`);
    await this.seats.ensureSeat(sessionId, botId, {
      widthPx: sandbox.widthPx,
      heightPx: sandbox.heightPx,
    });
    const endpoint = await session.getPortEndpoint({ port: SANDBOX_PORTS.bridge });
    // D-012: a provider may require headers on its endpoints; this is plain
    // HTTP, so they are simply sent.
    return { url: endpoint.url, headers: endpoint.headers ?? {} };
  }

  /**
   * One `POST /skill/run` to the bridge (D-040's transport, M3-PK-01's
   * executor) and its outcome, reduced to what the row stores.
   */
  private async runOnBridge(
    bridge: BridgeEndpoint,
    script: string,
    params: RunSkillBody['params'],
    botId: string,
  ): Promise<BridgeRunOutcome> {
    const response = await fetch(`${bridge.url}/skill/run?botId=${encodeURIComponent(botId)}`, {
      method: 'POST',
      headers: { ...bridge.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ script, params }),
      signal: AbortSignal.timeout(SkillRunService.BRIDGE_TIMEOUT_MS),
    });

    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      // The bridge's own refusal — a runner that could not start, a run past
      // its timeout, a request it did not accept. It is infrastructure, so
      // the sentence names the status and the bridge's code rather than
      // pretending the script failed.
      const code = stringField(body, 'code');
      const detail = stringField(body, 'detail');
      throw new Error(
        `the sandbox could not run the skill (HTTP ${response.status}` +
          `${code === null ? '' : `, ${code}`}${detail === null ? '' : `: ${detail}`})`,
      );
    }
    return parseOutcome(body);
  }
}

/** The bridge's answer, after the success/failure split. */
interface BridgeRunOutcome {
  /** The script's log lines joined for the `logs` column; null when empty. */
  readonly logs: string | null;
  /** The failure reason, or null for a run that finished. */
  readonly error: string | null;
}

interface BridgeEndpoint {
  readonly url: string;
  readonly headers: Record<string, string>;
}

/**
 * One string field of a parsed JSON body, or null.
 *
 * The bridge's refusal bodies are `{code, detail}` for infrastructure errors,
 * and this reads them without asserting a shape onto something a wedged
 * process might have written.
 */
function stringField(body: unknown, key: 'code' | 'detail'): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Read the bridge's outcome (M3-PK-01's response contract).
 *
 * The two shapes are `{ok: true, result, logs, durationMs}` and
 * `{ok: false, code, detail, logs, durationMs}`. `result` is deliberately not
 * carried onto the row — §3's `SkillRun` has no column for it, and the run's
 * value is for its caller, not for a later status read.
 */
function parseOutcome(body: unknown): BridgeRunOutcome {
  if (
    typeof body !== 'object' ||
    body === null ||
    typeof (body as { ok?: unknown }).ok !== 'boolean'
  ) {
    throw new Error('the bridge answered with an unreadable outcome');
  }
  const record = body as { ok: boolean; detail?: unknown; logs?: unknown };
  const lines = Array.isArray(record.logs) ? record.logs.map((line) => String(line)) : [];
  const logs = lines.length === 0 ? null : lines.join('\n');
  if (record.ok) return { logs, error: null };
  return {
    logs,
    error: typeof record.detail === 'string' ? record.detail : 'the skill run failed',
  };
}

/**
 * One sentence for the row.
 *
 * A transport timeout is reported as the bound that fired — an `AbortSignal`
 * abort surfaces as "This operation was aborted", which names neither the
 * operation nor the duration — and everything else keeps its message, which
 * is this codebase's own (the bridge's codes, the capacity refusal), never a
 * vendor's.
 */
function messageOf(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return `the skill did not finish within ${Math.round(SkillRunService.BRIDGE_TIMEOUT_MS / 1000)} seconds`;
    }
    return error.message;
  }
  return String(error);
}
