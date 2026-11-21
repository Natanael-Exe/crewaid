import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { RecordingWarning } from '@crewaid/shared';

import { PrismaService } from '../prisma/prisma.service.js';
import { TurnEventBus } from '../agent/turn-event.bus.js';
import { ARTIFACT_STORE, type ArtifactStore } from '../attachments/artifact-store.js';
import { DiskArtifactStore } from '../attachments/disk-artifact-store.js';
import {
  ModelResolutionService,
  type ResolvedTextModel,
} from '../models/model-resolution.service.js';
import { askModelText } from '../models/text-call.js';
import { answerInstructions, parseJsonAnswer } from '../models/structured-answer.js';
import { correctedTask, refuseModelFailure, withDeadline } from './skill-model-call.js';
import {
  CompilabilitySchema,
  CompiledSkillSchema,
  CompileRefused,
  SKILL_CONTEXT_SOURCE,
  TIMING_RULE,
  TRACE_LEGEND,
  type CompilabilityDecision,
} from './skill-compile.contract.js';
import { validateCompiled, type ValidatedSkill } from './skill-validator.js';
import {
  constrainToResolver,
  cropCandidatesOf,
  foldCorrelated,
  renderTrace,
  selectCrops,
  type CropCandidate,
  type ScreenSize,
  type TraceRow,
} from './compile-input.js';
import { computerOfBot } from '../sandbox/attached-computer.js';

/** What a compile asks: the run engine's adapter for the bot's model. */
type TextModel = Pick<ResolvedTextModel, 'adapter'>;
/**
 * The `skill.compile` job.
 *
 * WHY THIS IS A JOB AND NOT PART OF `stop`
 *
 * REST calls the route "stop and enqueue compilation", and the split is the
 * point: stopping is a keystroke's worth of work and compiling is a model call
 * that §6 gives a bounded model-call budget. A stop that waited would hold an HTTP request
 * open across a provider outage, and the operator has nothing to do with the
 * answer anyway — WebSocket tells them when it lands.
 *
 * Why the job holds no lock
 *
 * `RecordingsService` serialises its transitions per recording, and this
 * deliberately stays outside that chain: holding it across a model call would
 * block every read of the row for the duration. Instead the row's own state IS
 * the claim. Capture already moved it to `COMPILING`, and every write here is
 * a compare-and-set pinned to that state, so a job that runs twice — BullMQ
 * retries, two workers, a redelivery after a crash — settles once and the
 * loser writes nothing. It is the same fencing `SandboxHealthService` uses on
 * `Sandbox.state`, for the same reason.
 */
@Injectable()
export class SkillCompileService {
  private readonly logger = new Logger(SkillCompileService.name);

  /** A bounded attempt, including reasoning and structured code generation.
   * A six-minute demonstration already exceeded the former 60-second cap.
   * Capture is durably stopped before this worker runs; it holds no desktop.
   */
  static readonly DEADLINE_MS = 180_000;

  // Explicit tokens: vitest/esbuild emits no design:paramtypes, so type-based
  // DI resolution silently fails in the integration suite.
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TurnEventBus) private readonly events: TurnEventBus,
    @Inject(ModelResolutionService) private readonly models: ModelResolutionService,
    @Optional()
    @Inject(ARTIFACT_STORE)
    private readonly artifacts: ArtifactStore = new DiskArtifactStore(),
  ) {}

  /**
   * Compile one recording into a `DRAFT` skill.
   *
   * Never throws: a job gets a single attempt — BullMQ's default — so a
   * rejection is the job's last word. A failure is written to the row
   * instead, where §6 asks for it ("a FAILED recording with a readable
   * error", D-044), and the operator can see it. That includes the read this
   * job starts with: a transient database error on it settles the row with a
   * reason rather than rejecting with nothing written — the queue does not
   * retry, so nothing else would revisit it.
   */
  async run(recordingId: string): Promise<void> {
    try {
      const recording = await this.loadRecording(recordingId);
      if (recording === null) {
        // The recording was deleted with its bot while the job sat in the queue.
        this.logger.warn(`skill.compile for ${recordingId}: the recording no longer exists`);
        return;
      }
      if (recording.state !== 'COMPILING') {
        // Someone already settled it, or this is a redelivery of a job that
        // finished. Either way the row is not ours to move.
        this.logger.log(
          `skill.compile for ${recordingId}: already ${recording.state}, nothing to compile`,
        );
        return;
      }

      const compiled = await this.compile(recordingId, recording.botId, recording.intent, {
        // V1-10 in miniature: the owner is read from the ROW, not from a live
        // connection. A compile is authorized when the recording is stopped
        // and runs on a worker that may have no one connected to it.
        userId: recording.bot.userId,
        modelId: recording.bot.modelId,
        warning: recording.warning,
      });
      await this.persist(recording.id, recording.botId, compiled);
    } catch (error: unknown) {
      await this.fail(recordingId, readableError(error));
    }
  }

  /**
   * The row this job was queued for.
   *
   * The read is inside the job's error handling on purpose: it is the one
   * error that could otherwise reject with NO row write — a transient
   * database error, not a verdict on the recording — and a rejection with
   * nothing written leaves the row `COMPILING` for good. Turning it into a
   * `CompileRefused` is what puts an operator sentence on the row instead.
   */
  private async loadRecording(recordingId: string) {
    try {
      return await this.prisma.recording.findUnique({
        where: { id: recordingId },
        // V1-06: `userId` too. A model reference means nothing without an
        // owner now — which connection serves it, and whose key pays for
        // it, are properties of the bot's user (D-086).
        include: { bot: { select: { modelId: true, userId: true } } },
      });
    } catch (error: unknown) {
      this.logger.error(
        `skill.compile for ${recordingId}: reading the recording failed: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      throw new CompileRefused('the compile could not read this recording from the database');
    }
  }

  /** Everything between a settled trace and a model's answer. */
  private async compile(
    recordingId: string,
    botId: string,
    intent: string | null,
    options: { userId: string; modelId: string; warning: RecordingWarning | null },
  ): Promise<ValidatedSkill> {
    const [screen, rows] = await Promise.all([
      this.screenOf(botId),
      this.prisma.recordingEvent.findMany({
        where: { recordingId },
        orderBy: { tsOffsetMs: 'asc' },
        // `id`/`correlatedWithId` are M4-BE-06's inputs: the fold pairs the
        // rows the correlator proved are one action by their mutual
        // references, and reads each row's own `type` (`pointer` press vs
        // `click` report) to tell the two apart — none of that may be
        // guessed from timestamps here — a guess is how both layers get
        // emitted.
        select: {
          id: true,
          tsOffsetMs: true,
          type: true,
          payload: true,
          screenshotKey: true,
          correlatedWithId: true,
        },
      }),
    ]);

    if (rows.length === 0) {
      // Nothing was demonstrated. A model handed an empty trace will invent a
      // plausible script, which is the worst possible output: it looks like a
      // skill and reproduces nothing that happened.
      throw new CompileRefused('the recording captured no events, so there is nothing to compile');
    }

    // §6/M4's "the compiler must not emit both": every correlated X11+CDP
    // pair becomes ONE row before anything else reads the trace — the crops,
    // the model's prompt and the truncation judgement all see the folded
    // form, so "one action, one step" is a property of the input rather than
    // a rule the model is trusted to obey.
    //
    // Then the resolver-compatibility fence (M4-BE-06 fix wave): every
    // candidate the model reads is one the shipped `ctx.page` can execute,
    // and a click left without such a candidate falls back to its recorded
    // coordinates — see `constrainToResolver`.
    const folded = constrainToResolver(foldCorrelated(rows));

    const resolved = await this.models.resolveText(options.userId, options.modelId);
    const model = resolved;
    // D-042: a trace a hard limit cut off is decided, never silently compiled.
    if (options.warning !== null) {
      await this.judgeTruncated(recordingId, model, intent, screen, folded, options.warning);
    }

    const crops = resolved.capabilities.vision
      ? await this.readCrops(selectCrops(cropCandidatesOf(folded), screen))
      : [];
    // §6: "screenshots referenced by index" — the index is the position of an
    // image this request actually attaches, so a crop whose file could not be
    // read renumbers the rest instead of leaving a reference that points at
    // the wrong picture (or past the end of what was sent).
    const trace = renderTrace(
      folded,
      crops.map((crop) => crop.candidate),
    );
    const images = crops.map((crop) => crop.image);
    const task = describeTask(intent, screen, trace, images.length, options.warning);

    const first = validateCompiled(await this.askModel({ model, task, images }));
    if (first.ok) return first.skill;

    // §6's acceptance criteria: "Enforced by a validator that retries once
    // with a corrective message before failing" (M3-BE-08). The retry is a
    // fresh request — a model has no memory of the rejected answer — so the
    // message names every defect and restates the shape it must return.
    this.logger.warn(
      `recording ${recordingId}: the model's answer was rejected (${first.defects.join('; ')}); ` +
        'retrying once with the defects named',
    );
    const second = validateCompiled(
      await this.askModel({ model, task, images, defects: first.defects }),
    );
    if (second.ok) return second.skill;

    // One repair, then the operator hears exactly what was wrong — the
    // sentence lands on `Recording.error` through the caller.
    throw new CompileRefused(
      `the compiler's answer was still unusable after a corrective retry: ${second.defects.join('; ')}`,
    );
  }

  /**
   * One model call, held to the deadline.
   *
   * Both attempts go through here so the retry carries the same schema, the
   * same system prompt, the same trace and the same images as the first call
   * — only the correction is new. Anything else would make the second attempt
   * a different question, and §6's rule is about making the model answer the
   * SAME question correctly.
   *
   * Each attempt gets its own deadline rather than sharing one across the
   * pair: the deadline bounds a wedged provider, and a retry that only gets
   * whatever is left of a shared budget after a slow first response would be
   * disarmed exactly when the provider is slow (the case it exists for).
   *
   * The reply is returned RAW: whether it is a usable skill is the
   * validator's verdict, and a reply that is not parseable is a retryable
   * defect rather than a transport failure.
   */
  private async askModel(input: {
    readonly model: TextModel;
    readonly task: string;
    readonly images: readonly Buffer[];
    readonly defects?: readonly string[];
  }): Promise<string> {
    const text =
      input.defects === undefined ? input.task : correctedTask(input.task, input.defects);
    try {
      return await this.generate(input, text);
    } catch (error: unknown) {
      // The deadline already speaks in the right vocabulary; everything else
      // reaching here came out of the provider, so it is converted HERE rather
      // than in the catch-all that settles the row — which cannot tell a
      // provider failure from a Prisma one and used to label both as the
      // provider's. Same shape as `judgeTruncated`.
      throw refuseModelFailure(error, 'compiling', this.logger);
    }
  }

  /** The model call itself, held to the deadline: plain text, schema in the prompt. */
  private async generate(
    input: {
      readonly model: TextModel;
      readonly images: readonly Buffer[];
    },
    text: string,
  ): Promise<string> {
    // R3: a resolved model, never an endpoint. `Bot.modelId` may be the
    // "default" alias, which resolves against the OWNER's chosen default
    // (D-086) — not a process-wide environment variable.
    const reply = await withDeadline(SkillCompileService.DEADLINE_MS, (signal) =>
      askModelText(input.model, {
        system: `${SYSTEM_PROMPT}

${answerInstructions(CompiledSkillSchema)}`,
        prompt: text,
        images: input.images.map((image) => ({ data: image, mimeType: 'image/png' })),
        signal,
      }),
    );
    return reply;
  }

  /**
   * The D-042 judgement: does a truncated trace still contain a complete task?
   *
   * `Recording.warning` says a hard limit cut the capture; the question is
   * whether what remains is a whole task (the limit trimmed idle time, or a
   * finished task's tail) or a fragment. Only the model can read that off the
   * trace, so it answers one boolean before the compile is allowed to run —
   * which is what "not silently compiled" means here. A `false` settles the
   * recording with the model's reason; an error answering the question
   * settles it too, because an undecidable truncated trace must not fall
   * through to a compile.
   */
  private async judgeTruncated(
    recordingId: string,
    model: TextModel,
    intent: string | null,
    screen: ScreenSize,
    rows: readonly TraceRow[],
    warning: RecordingWarning,
  ): Promise<void> {
    let decision: CompilabilityDecision;
    try {
      const reply = await withDeadline(SkillCompileService.DEADLINE_MS, (signal) =>
        askModelText(model, {
          system: `${COMPILABILITY_SYSTEM_PROMPT}

${answerInstructions(CompilabilitySchema)}`,
          // Text-only: the question is where the trace ends relative to the
          // task, which the trace answers by itself; the crops disambiguate
          // individual clicks and would only be noise here.
          prompt: describeTask(intent, screen, renderTrace(rows, []), 0),
          signal,
        }),
      );
      // A single bounded attempt, per D-042: an answer that cannot be judged
      // settles the recording rather than falling through to a compile. The
      // same sentence pattern as the model-failure catch below — the
      // operator reads the truncation context, not just the parse verdict.
      const parsed = parseJsonAnswer(reply);
      if (!parsed.ok) {
        throw new CompileRefused(
          `the trace was truncated (${warning}) and the judgement was unreadable: ${parsed.problem}`,
        );
      }
      const shape = CompilabilitySchema.safeParse(parsed.value);
      if (!shape.success) {
        const at = shape.error.issues.map((issue) => `"${issue.path.join('.')}"`).join(', ');
        throw new CompileRefused(
          `the trace was truncated (${warning}) and the judgement did not match the requested shape: ${at}`,
        );
      }
      decision = shape.data;
    } catch (error: unknown) {
      // The deadline already speaks in the right vocabulary.
      if (error instanceof CompileRefused) throw error;
      const refused = refuseModelFailure(error, 'judging a truncated trace', this.logger);
      throw new CompileRefused(
        `the trace was truncated (${warning}) and could not be judged: ${refused.message}`,
      );
    }

    if (!decision.worthCompiling) {
      throw new CompileRefused(
        `the trace was truncated (${warning}) and does not contain a complete task: ${decision.reason}`,
      );
    }
    this.logger.log(
      `recording ${recordingId}: truncated at ${warning}, judged worth compiling: ${decision.reason}`,
    );
  }

  /**
   * §6: "the sandbox resolution".
   *
   * Refused rather than defaulted when the row is gone. Every coordinate in
   * the trace is meaningless without the screen it was measured on, and
   * quietly substituting §5.1's 1280x800 would tell the model something that
   * might not be true about the desktop these clicks landed on.
   */
  private async screenOf(botId: string): Promise<ScreenSize> {
    const sandbox = await computerOfBot(this.prisma, botId, {
      widthPx: true,
      heightPx: true,
    });
    if (sandbox === null) {
      throw new CompileRefused(
        `bot ${botId} has no computer on record, so the resolution these coordinates ` +
          'were captured at is unknown',
      );
    }
    return sandbox;
  }

  /**
   * The crop images that could be read, in trace order.
   *
   * A missing file costs its image and not the compile: the trace is the
   * substance — §6 sends "up to 8" crops precisely because they are an aid —
   * and a click's coordinates are in the trace whether or not its picture
   * survived (M3-BE-04 stores a null key for a capture that failed, and
   * artifact retention may remove an old one).
   *
   * What it must not do is shift everyone else's index: the trace's
   * `screenshot` references are numbered by the caller, over what is
   * RETURNED, so a crop that dropped out renumbers the crops after it
   * instead of leaving a reference that points at the wrong image. The
   * dropped click loses `cropX`/`cropY` with its picture — they locate a
   * click inside a crop this request is not attaching.
   */
  private async readCrops(candidates: readonly CropCandidate[]): Promise<LoadedCrop[]> {
    const crops: LoadedCrop[] = [];
    for (const candidate of candidates) {
      try {
        const image = await this.artifacts.get(candidate.screenshotKey);
        if (image === null) {
          this.logger.warn(`skipping crop ${candidate.screenshotKey}: not in the artifact store`);
          continue;
        }
        crops.push({ candidate, image });
      } catch (error: unknown) {
        this.logger.warn(`skipping crop ${candidate.screenshotKey}: ${readableError(error)}`);
      }
    }
    return crops;
  }

  /**
   * Write the skill and settle the recording, or neither.
   *
   * One transaction because they are one fact. A `READY` recording whose skill
   * was never written is a dead end the UI reports as success; a skill whose
   * recording is still `COMPILING` is work that looks unfinished forever.
   *
   * `compiled` arrives already validated (M3-BE-08): the name is snake_case
   * and `paramsSchema` is assembled, so everything this method writes has
   * passed §6's output checks exactly once — in the validator, where the
   * corrective retry can still act on a refusal.
   */
  private async persist(
    recordingId: string,
    botId: string,
    compiled: ValidatedSkill,
  ): Promise<void> {
    const skill = await this.prisma.$transaction(async (tx) => {
      // The fence. `updateMany` rather than `update` so a row someone else
      // already settled reports zero rows instead of throwing.
      const settled = await tx.recording.updateMany({
        where: { id: recordingId, state: 'COMPILING' },
        data: { state: 'READY', error: null },
      });
      if (settled.count === 0) return null;

      // §3 keys skills `[botId, name, version]`. Two recordings of similar
      // tasks land on the same name often enough that failing would be a
      // recurring dead end for the operator, so this takes the next free
      // version — which is the shape the constraint already describes.
      // M3-BE-09 owns what a version MEANS on edit; this only avoids
      // colliding with one.
      const latest = await tx.skill.findFirst({
        where: { botId, name: compiled.name },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      return await tx.skill.create({
        data: {
          botId,
          name: compiled.name,
          description: compiled.description,
          paramsSchema: compiled.paramsSchema,
          // D-098's column: the summary a person reviews instead of the
          // source. A spread, not an assignment — the validated list is
          // readonly and Prisma's Json write input is not.
          steps: [...compiled.steps],
          script: compiled.script,
          version: (latest?.version ?? 0) + 1,
          // §6: "Stopping produces a DRAFT skill". Approval is a human act
          // (M3-BE-09), and nothing model-generated may run unreviewed (§7.3).
          status: 'DRAFT',
          sourceRecordingId: recordingId,
        },
      });
    });

    if (skill === null) {
      this.logger.log(`skill.compile for ${recordingId}: settled by someone else first`);
      return;
    }

    this.events.emitRecordingState(botId, recordingId, 'READY');
    this.events.emitSkillCompiled(botId, recordingId, skill.id, skill.name);
    this.logger.log(
      `bot ${botId}: recording ${recordingId} compiled to skill ${skill.id} (${skill.name} v${skill.version})`,
    );
  }

  /**
   * Settle a compile that could not produce a skill, with the reason (D-044).
   *
   * The compare-and-set comes first and stands alone: it is the row write
   * everything else exists for, so nothing that only serves the notification
   * — the botId read below, the frame — runs before it or can take it down
   * with it. The botId is read afterwards because the fence deliberately
   * moves a row without returning it, and only the frame needs one.
   */
  private async fail(recordingId: string, message: string): Promise<void> {
    let settled: number;
    try {
      settled = (
        await this.prisma.recording.updateMany({
          where: { id: recordingId, state: 'COMPILING' },
          data: { state: 'FAILED', error: message },
        })
      ).count;
    } catch (error: unknown) {
      // The database is the only place this could be reported, so there is
      // nowhere left to put it but the log. The row stays COMPILING and
      // remains a candidate for a later retry or a restart's recovery.
      this.logger.error(
        `recording ${recordingId} failed to compile (${message}) and the failure could not ` +
          `be recorded: ${readableError(error)}`,
      );
      return;
    }
    if (settled === 0) return;

    this.logger.error(`recording ${recordingId} failed to compile: ${message}`);
    try {
      const recording = await this.prisma.recording.findUnique({
        where: { id: recordingId },
        select: { botId: true },
      });
      if (recording !== null) {
        this.events.emitRecordingState(recording.botId, recordingId, 'FAILED');
      }
    } catch {
      // The row already carries the reason; a frame that could not be emitted
      // is the client's next status read's problem, not a reason to call the
      // settled row unsettled.
    }
  }

  /**
   * Settle a recording whose job the machinery abandoned (D-044).
   *
   * Called from the worker's `failed` event by `SkillCompileProcessor` — a
   * stall past its allowance, a worker gone mid-job, a connection lost —
   * paths `run` never sees an error for because they never reach it. The
   * compare-and-set inside `fail` leaves a row someone else already settled
   * untouched.
   */
  async settleAbandoned(recordingId: string, reason: string): Promise<void> {
    await this.fail(recordingId, `the compile job failed: ${reason}`);
  }
}

/** A crop image that exists on disk, with the click that referenced it. */
interface LoadedCrop {
  readonly candidate: CropCandidate;
  readonly image: Buffer;
}

/**
 * One sentence an operator can act on, for `Recording.error`.
 *
 * Everything that came out of a provider has ALREADY been through
 * `normalizeModelError` by the time it arrives here — `askModel` and
 * `judgeTruncated` convert at the call, which is the only place that knows a
 * model was involved. So D-006 is satisfied upstream, and what is left here is
 * the orchestrator's own failures: a unique-violation from `persist`, a
 * missing `ARTIFACT_DIR`, an unreadable crop.
 *
 * Those keep their own words. Running them through the normalizer too is what
 * this used to do, and it told an operator whose database rejected a duplicate
 * skill name that "the model provider returned an unexpected error" — a
 * sentence that sends them to the wrong system entirely, and that
 * `classifyMessage` could even mis-code as PROVIDER_UNAVAILABLE if the text
 * happened to contain the word "unavailable".
 */
function readableError(error: unknown): string {
  if (error instanceof CompileRefused) return error.message;
  return error instanceof Error ? error.message : String(error);
}

const SYSTEM_PROMPT = `You compile a recording of someone doing a task on a Linux desktop into a
reusable skill: a TypeScript module that reproduces the same task.

The module default-exports \`async function run(ctx, params)\`, where \`ctx\` is:

${SKILL_CONTEXT_SOURCE}

Rules:
  - Use only the methods above. There is no other API, no imports, and no
    filesystem or network access.
  - Coordinates are absolute, in the screen resolution given below.
  - A step the trace shows a selector for is replayed through the page, not
    the pixels: emit \`ctx.page.click('<selector>')\` for a click with
    "candidates" and \`ctx.page.fill('<selector>', value)\` for an input/change
    row. An action captured on both layers appears ONCE in the trace, and it
    must appear once in the script: never emit both the page call and the raw
    coordinate or keystroke form of the same action. A row without
    "candidates" keeps the raw-input form: \`ctx.click(x, y)\` for a click (the
    row carries "x"/"y" whether it happened outside the browser or the
    recorder could not name its element with a selector the page can
    execute), and \`ctx.type\` / \`ctx.key\` for the rest.
  - Waits in a browser task are page waits: \`ctx.page.waitForLoadState('load')\`
    across a navigate/load pair, \`ctx.page.waitForSelector\` before acting on
    an element a load or an earlier step brought in. The page methods follow
    the timing rule below like everything else — their timeout is the longest
    you are willing to wait, never a duration to spend.
  - ${TIMING_RULE}
  - Turn the values the task should vary — a search term, a filename, a URL —
    into parameters. Everything else stays a literal.
  - A "type" row with "secret": true was typed into a password field, and its
    text was never recorded. Make it a string parameter and type the
    parameter; never type the placeholder text.
  - \`ctx.log\` each meaningful step, so a failed run says where it stopped.
  - \`steps\` is the same task in the words of the person who will approve it:
    one short sentence per meaningful action, in order ("Open Chrome.", "Type
    the search term.", "Press Enter."). Written for a reader who has never
    seen a trace; no coordinates, selectors, variable names, or code in them.`;

/**
 * The D-042 judgement prompt. Separate from `SYSTEM_PROMPT` because it asks a
 * different question of the same input — "does this trace reach a natural
 * end" rather than "build the skill" — and because its failure mode is a
 * burned recording: a soft answer lets two thirds of a task through, which is
 * the outcome D-042 exists to prevent. It also carries the timing rule
 * (`TIMING_RULE`): the judgement reads the same trace the compiler will, and
 * the rule is what says how its gaps read — waits, never durations.
 */
const COMPILABILITY_SYSTEM_PROMPT = `You decide whether a desktop-task recording that a hard limit stopped can still be
compiled into a trustworthy skill.

The trace you receive was cut off automatically — at the 20-minute or the 5000-event limit —
so it may end mid-task. Answer worthCompiling = true only when the captured part reaches a
natural completion: the cutoff trimmed idle time, repetition, or steps after the task was
already done. Answer worthCompiling = false when the task is visibly unfinished — the trace
stops in the middle of a gesture, inside a form, or before the outcome the stated intent
describes.

The compile this judgement permits is held to the timing rule below — read the trace the same
way the compiler will:

  - ${TIMING_RULE}

reason: one sentence naming the evidence that decided it; it is shown to the operator when
the answer is no.`;

/**
 * The user turn: §6's "intent, trace, resolution, crops", in that order.
 * `warning` adds the truncation note when a hard limit cut the capture short.
 */
function describeTask(
  intent: string | null,
  screen: ScreenSize,
  trace: string,
  imageCount: number,
  warning: RecordingWarning | null = null,
): string {
  const stated =
    intent === null || intent.trim() === ''
      ? 'The person did not say what they were doing; infer it from the trace.'
      : `The person said they were doing this: ${intent}`;
  const images =
    imageCount === 0
      ? 'No screenshots are attached.'
      : `${imageCount} screenshot${imageCount === 1 ? '' : 's'} follow${
          imageCount === 1 ? 's' : ''
        } this message, in trace order, referenced by the "screenshot" field.`;
  // A judged-worthy truncated trace still says WHY it ends where it does: the
  // model must not fill in an ending the recording never showed.
  const truncated =
    warning === null
      ? ''
      : `\n\nNOTE: capture stopped automatically at the ${
          warning === 'TIME_LIMIT' ? '20-minute' : '5000-event'
        } hard limit, so the trace ends where capture stopped — mid-task in the worst case. Compile only as far as the trace actually goes: never invent the ending, and never guess steps it does not show.`;

  return `${stated}

The desktop is ${screen.widthPx}x${screen.heightPx} pixels.

${TRACE_LEGEND}

${images}${truncated}

Trace:
${trace}`;
}
