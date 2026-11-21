import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { MockLanguageModelV4 } from './model-resolution-fake.js';
import { APICallError } from './model-resolution-fake.js';

import { SkillCompileService } from '../src/skills/skill-compile.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { TurnEventBus } from '../src/agent/turn-event.bus.js';
import type { MockLanguageModelV4 as LanguageModel } from './model-resolution-fake.js';
import type { ResolvedTextModel } from '../src/models/model-resolution.service.js';
import { resolvedTextModelOf } from './model-resolution-fake.js';
import { ModelResolutionService } from '../src/models/model-resolution.service.js';

/**
 * M3-BE-06 — the `skill.compile` job.
 *
 * The REAL `generateObject` runs here, against a mock language model. That is
 * deliberate: a Zod schema that cannot be converted into the grammar a
 * provider constrains generation against fails at run time and nowhere else,
 * so stubbing `generateObject` itself would test the orchestration and leave
 * the one thing §6 actually specifies — the output schema — unexercised.
 */

/**
 * V1-06: the model stub moved from `model-registry.js`'s `resolveModel` export
 * to `ModelResolutionService.resolve` — D-086 made resolution owner-scoped, so
 * it is a service that reads rows rather than a module-level function.
 *
 * The seam keeps its shape on purpose: cases still say
 * `resolveModel.mockReturnValue(model)`, and `resolvedTextModelOf` wraps whatever
 * that returns in the envelope the real service produces. `importActual`
 * preserves the module's error classes, which callers branch on.
 */
const { resolveModel } = vi.hoisted(() => ({ resolveModel: vi.fn() }));
vi.mock('../src/models/model-resolution.service.js', async () => ({
  ...(await vi.importActual<object>('../src/models/model-resolution.service.js')),
  ModelResolutionService: class {
    resolveText = (): Promise<ResolvedTextModel> =>
      Promise.resolve(resolvedTextModelOf(resolveModel() as LanguageModel));
    setAddressResolverForTests = (): void => {};
  },
}));

/**
 * The mocked `ModelResolutionService` (see the `vi.mock` above). Constructed
 * per use rather than shared: it is stateless, and a shared instance is one
 * more thing a case could accidentally come to depend on.
 */
function models(): ModelResolutionService {
  // The mock class ignores both arguments; the real one needs them. Passing
  // them explicitly keeps the call site honest about that.
  return new ModelResolutionService(undefined as never, undefined as never);
}

const ANSWER = {
  name: 'search_the_web',
  description: 'Searches for a term and opens the first result.',
  params: [{ name: 'query', type: 'string', description: 'what to search for', required: true }],
  // D-098: the plain-language summary the review surface opens on.
  steps: ['Open Chrome.', 'Type the search term.', 'Press Enter.'],
  script: 'export default async function run(ctx, params) { await ctx.type(params.query); }',
};

/**
 * The user turn's text, and the bytes of every image attached to it.
 *
 * An `{ type: 'image' }` part reaches a provider as a FILE part whose `data`
 * is wrapped one level (`{ type: 'data', data: Uint8Array }`), so this unwraps
 * rather than asserting on a shape the SDK does not hand over.
 */
function askedFor(prompt: unknown): { text: string; images: string[] } {
  const messages = prompt as { role: string; content: unknown }[];
  const user = messages.find((m) => m.role === 'user');
  const parts = (user?.content ?? []) as { type: string; text?: string; data?: unknown }[];
  const text = parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('\n');
  const images = parts
    .filter((p) => p.type === 'file' || p.type === 'image')
    .map((p) => {
      const wrapper = p.data as { data?: unknown };
      const bytes = (wrapper.data ?? p.data) as Uint8Array;
      return Buffer.from(bytes).toString('utf8');
    });
  return { text, images };
}

/**
 * The system prompt of a request, as text.
 *
 * The AI SDK has no separate `system` field on the provider call — the
 * user-facing `system` is folded into the prompt as its first message — so
 * this reads it back from there rather than from an option that does not
 * exist.
 */
function systemOf(prompt: unknown): string {
  const messages = prompt as { role: string; content: unknown }[];
  const content = messages.find((m) => m.role === 'system')?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part as { text?: string }).text ?? '').join('\n');
  }
  return '';
}

/** The trace lines of a user turn's text, parsed back into objects. */
function traceLines(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('{"ms"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** A model that answers from `next()`, and records what it was asked. */
function modelAnswering(next: () => unknown) {
  const calls: { prompt: unknown }[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      calls.push({ prompt: options.prompt });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(next()) }],
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
  });
  resolveModel.mockReturnValue(model);
  return calls;
}

/** A model that returns `answer` to every call. */
function modelReturning(answer: unknown) {
  return modelAnswering(() => answer);
}

/** A model that answers `answers[i]` on call i — e.g. the judgement, then the compile. */
function modelSequence(answers: unknown[]) {
  let index = 0;
  return modelAnswering(() => answers[index++]);
}

interface Row {
  id: string;
  botId: string;
  state: string;
  intent: string | null;
  warning: string | null;
  error: string | null;
  endedAt: Date | null;
}

function setup(
  options: {
    state?: string;
    vision?: boolean;
    intent?: string | null;
    warning?: 'TIME_LIMIT' | 'EVENT_LIMIT' | null;
    events?: {
      id?: string;
      tsOffsetMs: number;
      layer?: string;
      type: string;
      payload: unknown;
      screenshotKey: string | null;
      correlatedWithId?: string | null;
    }[];
    sandbox?: { widthPx: number; heightPx: number } | null;
    existingSkillVersion?: number | null;
  } = {},
) {
  const row: Row = {
    id: 'rec-1',
    botId: 'bot-1',
    state: options.state ?? 'COMPILING',
    intent: options.intent === undefined ? 'search for otters' : options.intent,
    warning: options.warning ?? null,
    error: null,
    endedAt: new Date('2026-09-11T09:00:00Z'),
  };
  const events = options.events ?? [
    {
      tsOffsetMs: 0,
      type: 'pointer',
      payload: { x: 640, y: 400, buttonMask: 1 },
      screenshotKey: null,
    },
    { tsOffsetMs: 120, type: 'type', payload: { text: 'otters' }, screenshotKey: null },
  ];
  const skills: Record<string, unknown>[] = [];

  const updateMany = vi.fn(({ where, data }: { where: Row; data: Partial<Row> }) => {
    if (where.state !== undefined && row.state !== where.state)
      return Promise.resolve({ count: 0 });
    Object.assign(row, data);
    return Promise.resolve({ count: 1 });
  });
  const create = vi.fn(({ data }: { data: Record<string, unknown> }) => {
    const skill = { id: `skill-${skills.length + 1}`, ...data };
    skills.push(skill);
    return Promise.resolve(skill);
  });

  const client = {
    recording: {
      findUnique: vi.fn(() =>
        Promise.resolve(row.id === 'gone' ? null : { ...row, bot: { modelId: 'default' } }),
      ),
      updateMany,
    },
    recordingEvent: { findMany: vi.fn(() => Promise.resolve(events)) },
    sandbox: {
      findFirst: vi.fn(() =>
        Promise.resolve(
          options.sandbox === undefined ? { widthPx: 1280, heightPx: 800 } : options.sandbox,
        ),
      ),
    },
    skill: {
      findFirst: vi.fn(() =>
        Promise.resolve(
          options.existingSkillVersion == null ? null : { version: options.existingSkillVersion },
        ),
      ),
      create,
    },
  };
  const prisma = {
    ...client,
    $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(client)),
  } as unknown as PrismaService;

  const events_ = {
    emitRecordingState: vi.fn(),
    emitSkillCompiled: vi.fn(),
  } as unknown as TurnEventBus;

  const resolver = models();
  if (options.vision === false) {
    const resolveText = resolver.resolveText.bind(resolver);
    resolver.resolveText = async (...args) => {
      const result = await resolveText(...args);
      return { ...result, capabilities: { ...result.capabilities, vision: false } };
    };
  }
  return {
    service: new SkillCompileService(prisma, events_, resolver),
    row,
    skills,
    bus: events_,
    client,
  };
}

let artifactDir: string;

beforeEach(async () => {
  artifactDir = await mkdtemp(path.join(tmpdir(), 'crewaid-compile-'));
  process.env['ARTIFACT_DIR'] = artifactDir;
  resolveModel.mockReset();
});

afterEach(() => {
  delete process.env['ARTIFACT_DIR'];
  vi.restoreAllMocks();
});

describe('SkillCompileService — the happy path', () => {
  it('compiles with coordinates instead of sending images to a text-only model', async () => {
    await writeFile(path.join(artifactDir, 'crop.png'), 'image bytes');
    const { service, row } = setup({
      vision: false,
      events: [
        {
          tsOffsetMs: 0,
          type: 'pointer',
          payload: { x: 100, y: 150, buttonMask: 1, cropX: 0, cropY: 50 },
          screenshotKey: 'crop.png',
        },
      ],
    });
    const calls = modelReturning(ANSWER);
    await service.run('rec-1');
    expect(row.state).toBe('READY');
    const request = askedFor(calls[0]!.prompt);
    expect(request.images).toEqual([]);
    expect(traceLines(request.text)[0]).toMatchObject({ x: 100, y: 150, buttonMask: 1 });
    expect(traceLines(request.text)[0]).not.toHaveProperty('screenshot');
  });

  it('turns a trace into a DRAFT skill and settles the recording READY', async () => {
    const { service, row, skills, bus, client } = setup();
    const calls = modelReturning(ANSWER);

    await service.run('rec-1');

    expect(row.state).toBe('READY');
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      botId: 'bot-1',
      name: 'search_the_web',
      version: 1,
      // §6: "Stopping produces a DRAFT skill." Nothing model-generated runs
      // unreviewed (§7.3); approval is a human act (M3-BE-09).
      status: 'DRAFT',
      sourceRecordingId: 'rec-1',
    });
    expect(bus.emitRecordingState).toHaveBeenCalledWith('bot-1', 'rec-1', 'READY');
    expect(bus.emitSkillCompiled).toHaveBeenCalledWith(
      'bot-1',
      'rec-1',
      'skill-1',
      'search_the_web',
    );
    // The settle is a compare-and-set pinned to COMPILING: without the state
    // predicate, a job that lost a race — a discard landing mid-compile, a
    // redelivery — would overwrite the outcome the winner already wrote
    // (D-044). Asserted on the call itself, because that predicate is the
    // fence.
    expect(client.recording.updateMany).toHaveBeenCalledWith({
      where: { id: 'rec-1', state: 'COMPILING' },
      data: { state: 'READY', error: null },
    });
    // One model call: a recording the user stopped themselves is not judged —
    // D-042's judgement is for traces a hard limit cut off.
    expect(calls).toHaveLength(1);
  });

  it('stores the assembled schema, not the list the model returned', async () => {
    const { service, skills } = setup();
    modelReturning(ANSWER);

    await service.run('rec-1');

    expect(skills[0]?.['paramsSchema']).toEqual({
      type: 'object',
      properties: { query: { type: 'string', description: 'what to search for' } },
      required: ['query'],
      additionalProperties: false,
    });
  });

  it('shows the model the intent, the resolution and the trace', async () => {
    const { service } = setup();
    const calls = modelReturning(ANSWER);

    await service.run('rec-1');

    const { text } = askedFor(calls[0]?.prompt);
    // §6: "the user's stated intent, the ordered event trace ..., the sandbox
    // resolution".
    expect(text).toContain('search for otters');
    expect(text).toContain('1280x800');
    expect(text).toContain('{"ms":120,"type":"type","text":"otters"}');
  });

  it('says so when the person never stated an intent', async () => {
    const { service } = setup({ intent: null });
    const calls = modelReturning(ANSWER);

    await service.run('rec-1');

    // Better than an empty line where the goal should be: an unlabelled trace
    // is a task the model has to infer, and saying so is what stops it
    // inventing a stated goal that was never given.
    expect(askedFor(calls[0]?.prompt).text).toContain('did not say what they were doing');
  });

  it('takes the next free version when the bot already has that skill name', async () => {
    const { service, skills } = setup({ existingSkillVersion: 3 });
    modelReturning(ANSWER);

    await service.run('rec-1');

    // §3 keys skills [botId, name, version]. Two recordings of similar tasks
    // land on the same name often enough that failing would be a recurring
    // dead end.
    expect(skills[0]).toMatchObject({ version: 4 });
  });

  it('forbids sleeping in the system prompt (M3-BE-07, the timing rule)', async () => {
    const { service } = setup();
    const calls = modelReturning(ANSWER);

    await service.run('rec-1');

    // §6/M3: "the compiler prompt must forbid sleep(n). Every wait becomes a
    // waitFor with an explicit predicate. A gap in the trace is evidence that
    // a wait is needed, not evidence of its duration." The rule lives in the
    // SYSTEM prompt — the part of every request that never varies — so both
    // attempts carry it.
    const system = systemOf(calls[0]?.prompt);
    expect(system).toContain('Never call `sleep(n)`');
    expect(system).toContain('setTimeout');
    expect(system).toContain('ctx.waitFor');
    expect(system).toContain('predicate');
    expect(system).toContain('gap in the trace');
    expect(system).toContain('never evidence of');
  });
});

describe('SkillCompileService — the screenshots §6 attaches', () => {
  it('sends the crops the trace points at, as images', async () => {
    await mkdir(path.join(artifactDir, 'recordings', 'rec-1'), { recursive: true });
    await writeFile(path.join(artifactDir, 'recordings', 'rec-1', 'a.png'), Buffer.from('PNG-A'));
    const { service } = setup({
      events: [
        {
          tsOffsetMs: 0,
          type: 'pointer',
          payload: { x: 640, y: 400, buttonMask: 1, cropX: 540, cropY: 300 },
          screenshotKey: 'recordings/rec-1/a.png',
        },
      ],
    });
    const calls = modelReturning(ANSWER);

    await service.run('rec-1');

    const { text, images } = askedFor(calls[0]?.prompt);
    expect(text).toContain('"screenshot":0');
    expect(text).toContain('"cropX":540');
    // The bytes reached the model, not just the reference to them.
    expect(images).toEqual(['PNG-A']);
  });

  it('compiles without a crop whose file is gone, and references nothing it did not send', async () => {
    const { service, row } = setup({
      events: [
        {
          tsOffsetMs: 0,
          type: 'pointer',
          payload: { x: 1, y: 1, buttonMask: 1 },
          screenshotKey: 'recordings/rec-1/missing.png',
        },
      ],
    });
    const calls = modelReturning(ANSWER);

    await service.run('rec-1');

    // The trace is the substance — §6 sends "up to 8" crops precisely because
    // they are an aid — and retention may have removed an old one.
    expect(row.state).toBe('READY');
    const { text } = askedFor(calls[0]?.prompt);
    // Nothing is sent for a picture that did not survive: no image, and no
    // reference to one. The trace used to say "screenshot: 0" beside a
    // message that said no screenshots were attached.
    expect(text).toContain('No screenshots are attached.');
    expect(traceLines(text).some((line) => 'screenshot' in line)).toBe(false);
  });

  it('renumbers the screenshots by the images actually attached', async () => {
    await mkdir(path.join(artifactDir, 'recordings', 'rec-1'), { recursive: true });
    await writeFile(path.join(artifactDir, 'recordings', 'rec-1', 'b.png'), Buffer.from('PNG-B'));
    const { service } = setup({
      events: [
        {
          tsOffsetMs: 0,
          type: 'pointer',
          payload: { x: 1, y: 1, buttonMask: 1 },
          screenshotKey: 'recordings/rec-1/missing.png',
        },
        {
          tsOffsetMs: 500,
          type: 'pointer',
          payload: { x: 2, y: 2, buttonMask: 1 },
          screenshotKey: 'recordings/rec-1/b.png',
        },
      ],
    });
    const calls = modelReturning(ANSWER);

    await service.run('rec-1');

    // The first click's crop is gone; the second click's image is the FIRST
    // (and only) image attached. A reference of 1 would point past the end of
    // what the model received, and the old numbering would have sent exactly
    // that — pairing the model with the wrong screen.
    const { text, images } = askedFor(calls[0]?.prompt);
    const lines = traceLines(text);
    expect(lines[0]).not.toHaveProperty('screenshot');
    expect(lines[1]).toMatchObject({ screenshot: 0 });
    expect(images).toEqual(['PNG-B']);
  });

  it('compiles without screenshots when there is nowhere to read them from', async () => {
    delete process.env['ARTIFACT_DIR'];
    const { service, row } = setup({
      events: [
        {
          tsOffsetMs: 0,
          type: 'pointer',
          payload: { x: 1, y: 1, buttonMask: 1 },
          screenshotKey: 'recordings/rec-1/a.png',
        },
      ],
    });
    modelReturning(ANSWER);

    await service.run('rec-1');

    expect(row.state).toBe('READY');
  });
});

describe('SkillCompileService — the state fence', () => {
  it('leaves a recording nobody put in COMPILING alone', async () => {
    const { service, row, skills } = setup({ state: 'READY' });
    modelReturning(ANSWER);

    await service.run('rec-1');

    // A redelivered job, or one whose recording someone already settled.
    expect(row.state).toBe('READY');
    expect(skills).toEqual([]);
    expect(resolveModel).not.toHaveBeenCalled();
  });

  it('writes no skill when the row is settled while the model is thinking', async () => {
    const { service, row, skills, client } = setup();
    modelReturning(ANSWER);
    // A discard lands mid-compile — which M3-BE-06 permits precisely because
    // this fence exists.
    client.recording.updateMany.mockImplementationOnce(() => {
      row.state = 'DISCARDED';
      return Promise.resolve({ count: 0 });
    });

    await service.run('rec-1');

    expect(skills).toEqual([]);
    expect(row.state).toBe('DISCARDED');
  });

  it('does nothing at all for a recording that no longer exists', async () => {
    const missing = setup();
    // Deleted with its bot while the job sat in the queue (§3 cascades).
    missing.row.id = 'gone';
    modelReturning(ANSWER);

    await expect(missing.service.run('rec-1')).resolves.toBeUndefined();

    expect(missing.skills).toEqual([]);
    expect(resolveModel).not.toHaveBeenCalled();
  });
});

describe('SkillCompileService — a failure an operator can read (D-044)', () => {
  it('refuses an empty trace rather than letting the model invent one', async () => {
    const { service, row, skills, client } = setup({ events: [] });
    modelReturning(ANSWER);

    await service.run('rec-1');

    // A model handed an empty trace writes a plausible script, which is the
    // worst possible output: it looks like a skill and reproduces nothing.
    expect(row.state).toBe('FAILED');
    expect(row.error).toMatch(/captured no events/);
    expect(skills).toEqual([]);
    expect(resolveModel).not.toHaveBeenCalled();
    // The failure settle is fenced the same way the READY one is: pinned to
    // COMPILING, so a late failure cannot overwrite a row that someone else
    // already moved on (D-044).
    expect(client.recording.updateMany).toHaveBeenCalledWith({
      where: { id: 'rec-1', state: 'COMPILING' },
      data: { state: 'FAILED', error: expect.stringMatching(/captured no events/) },
    });
  });

  it('refuses to guess the resolution these coordinates were captured at', async () => {
    const { service, row } = setup({ sandbox: null });
    modelReturning(ANSWER);

    await service.run('rec-1');

    expect(row.state).toBe('FAILED');
    expect(row.error).toMatch(/no computer on record/);
  });

  it('fails a name that is not snake_case, after one corrective retry', async () => {
    const { service, row, skills } = setup();
    const calls = modelReturning({ ...ANSWER, name: 'SearchTheWeb' });

    await service.run('rec-1');

    // §3 says Skill.name is snake_case. The validator rejects it and the
    // compile asks for a repair exactly once (M3-BE-08); a model that repeats
    // the mistake fails the compile with the offending value named, so the
    // operator is not guessing what the model did.
    expect(row.state).toBe('FAILED');
    expect(row.error).toContain('SearchTheWeb');
    expect(calls).toHaveLength(2);
    expect(skills).toEqual([]);
  });

  it('fails a parameter list that describes one argument twice, after one retry', async () => {
    const { service, row } = setup();
    const calls = modelReturning({
      ...ANSWER,
      params: [
        { name: 'query', type: 'string', description: 'a', required: true },
        { name: 'query', type: 'number', description: 'b', required: false },
      ],
    });

    await service.run('rec-1');

    expect(row.state).toBe('FAILED');
    expect(row.error).toMatch(/twice/);
    expect(calls).toHaveLength(2);
  });

  it('never puts a vendor error string on the row', async () => {
    const { service, row } = setup();
    resolveModel.mockReturnValue(
      new MockLanguageModelV4({
        doGenerate: async () => {
          throw new APICallError({
            message: 'invalid x-api-key: sk-proj-LEAKED-SECRET',
            url: 'https://api.anthropic.com/v1/messages',
            requestBodyValues: {},
            statusCode: 401,
          });
        },
      }),
    );

    await service.run('rec-1');

    // D-006: a vendor's error string must never reach a user-visible surface,
    // and this column is one. The operator gets the normalized code instead.
    expect(row.state).toBe('FAILED');
    expect(row.error).not.toContain('sk-proj-LEAKED-SECRET');
    expect(row.error).toContain('AUTH_FAILED');
  });

  it("names the orchestrator's own failure as itself, not as the provider", async () => {
    const { service, row, client } = setup();
    modelReturning(ANSWER);
    // The database, not the provider: reading the trace this compile is about.
    client.recordingEvent.findMany.mockRejectedValueOnce(
      new Error('connection terminated unexpectedly'),
    );

    await service.run('rec-1');

    // Running everything through `normalizeModelError` used to answer this
    // with "The model provider returned an unexpected error", sending the
    // operator to the wrong system entirely — and D-006 does not ask for that,
    // because no vendor wrote this sentence.
    expect(row.state).toBe('FAILED');
    expect(row.error).toContain('connection terminated unexpectedly');
    expect(row.error).not.toContain('model provider');
  });

  it('logs the vendor detail it is not allowed to store (D-006)', async () => {
    const { service, row } = setup();
    const logged: string[] = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown) => {
      logged.push(String(message));
    });
    resolveModel.mockReturnValue(
      new MockLanguageModelV4({
        doGenerate: async () => {
          throw new APICallError({
            message: 'invalid x-api-key: sk-proj-LEAKED-SECRET',
            url: 'https://api.anthropic.com/v1/messages',
            requestBodyValues: {},
            statusCode: 401,
          });
        },
      }),
    );

    await service.run('rec-1');

    // The operator sentence says "check logs for detail", so the detail has to
    // actually be there — D-006 bars the vendor text from the ROW, not from
    // the log. The chat producer logs it for the same reason.
    expect(row.error).not.toContain('sk-proj-LEAKED-SECRET');
    expect(logged.join('\n')).toContain('sk-proj-LEAKED-SECRET');
  });

  it('does not throw, so the refusal is settled on the row', async () => {
    const { service } = setup({ events: [] });
    modelReturning(ANSWER);

    // A rejection would not be retried — a job gets a single attempt — and
    // the refusal settles on the row instead.
    await expect(service.run('rec-1')).resolves.toBeUndefined();
  });

  it('tells the client the recording failed', async () => {
    const { service, bus } = setup({ events: [] });
    modelReturning(ANSWER);

    await service.run('rec-1');

    expect(bus.emitRecordingState).toHaveBeenCalledWith('bot-1', 'rec-1', 'FAILED');
  });

  it('settles FAILED when the recording cannot be read, with the reason written', async () => {
    const { service, row, client, bus } = setup();
    modelReturning(ANSWER);
    // A transient database error on the job's first read. Rejecting here used
    // to fail the job with no row write at all, and the row then sat
    // COMPILING for good — the stranding D-044 asks not to happen.
    client.recording.findUnique.mockRejectedValueOnce(new Error('connection reset'));

    await expect(service.run('rec-1')).resolves.toBeUndefined();

    expect(row.state).toBe('FAILED');
    expect(row.error).toMatch(/could not read this recording/);
    expect(resolveModel).not.toHaveBeenCalled();
    expect(bus.emitRecordingState).toHaveBeenCalledWith('bot-1', 'rec-1', 'FAILED');
  });
});

describe('SkillCompileService — the corrective retry is exactly one (M3-BE-08)', () => {
  const SLEEPING = {
    ...ANSWER,
    script: 'export default async function run(ctx) { await sleep(500); }',
  };
  /** §6's other named way to fake a wait. */
  const TIMED = {
    ...ANSWER,
    script:
      'export default async function run(ctx) { await new Promise((r) => setTimeout(r, 500)); }',
  };

  it('repairs a script that waits by sleeping, and stores the repair', async () => {
    const { service, row, skills } = setup();
    const calls = modelSequence([SLEEPING, ANSWER]);

    await service.run('rec-1');

    expect(row.state).toBe('READY');
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ script: ANSWER.script });
    // One repair request: the same trace, the same images, the same system
    // prompt — plus the defect. Anything else would be a different question.
    expect(calls).toHaveLength(2);
    const first = askedFor(calls[0]?.prompt);
    const second = askedFor(calls[1]?.prompt);
    expect(first.text).not.toContain('rejected');
    expect(second.text).toContain('rejected by the output validator');
    expect(second.text).toContain('sleep(');
    expect(second.text).toContain('ctx.waitFor');
    // The images ride along on the repair too.
    expect(second.images).toEqual(first.images);
  });

  it('fails after the second answer still has a defect — never a third call', async () => {
    const { service, row, skills } = setup();
    // A different defect the second time: both answers were validated, and
    // the operator hears about the one that ended it.
    const calls = modelSequence([SLEEPING, TIMED]);

    await service.run('rec-1');

    expect(calls).toHaveLength(2);
    expect(row.state).toBe('FAILED');
    expect(row.error).toContain('still unusable after a corrective retry');
    expect(row.error).toContain('setTimeout(');
    expect(skills).toEqual([]);
  });

  it('does not retry an answer that is already usable', async () => {
    const { service, row } = setup();
    const calls = modelReturning(ANSWER);

    await service.run('rec-1');

    expect(row.state).toBe('READY');
    expect(calls).toHaveLength(1);
  });
});

describe('SkillCompileService — the answer is parsed, not constrained', () => {
  /**
   * A model replying with raw text, as an OpenAI-compatible custom endpoint
   * delivers answers: the json_schema constraint never reaches it, so the
   * words come back in whatever wrapper the model chose.
   */
  function modelReplying(...texts: string[]) {
    let index = 0;
    const calls: { prompt: unknown }[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        calls.push({ prompt: options.prompt });
        return {
          content: [{ type: 'text' as const, text: texts[Math.min(index++, texts.length - 1)]! }],
          finishReason: 'stop' as const,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        };
      },
    });
    resolveModel.mockReturnValue(model);
    return calls;
  }

  it('shows the model the required shape in the system prompt', async () => {
    const { service } = setup();
    const calls = modelReplying(JSON.stringify(ANSWER));

    await service.run('rec-1');

    // No capability record promises a provider that constrains generation to
    // a schema, so the schema itself is part of the question. A model that
    // never saw the shape cannot be retried into compliance it cannot see.
    const system = systemOf(calls[0]?.prompt);
    expect(system).toContain('JSON Schema');
    expect(system).toContain('ONLY a JSON object');
    expect(system).toContain('snake_case');
    expect(system).toContain('"params"');
  });

  it('compiles an answer that arrives fenced in markdown', async () => {
    const { service, row, skills } = setup();
    const calls = modelReplying('```json\n' + JSON.stringify(ANSWER) + '\n```');

    await service.run('rec-1');

    expect(row.state).toBe('READY');
    expect(skills).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('retries once when the reply is not a JSON object at all', async () => {
    const { service, row, skills } = setup();
    const calls = modelReplying(
      'I compiled the task into the module shown above; let me know if you want changes.',
      JSON.stringify(ANSWER),
    );

    await service.run('rec-1');

    expect(row.state).toBe('READY');
    expect(skills).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(askedFor(calls[1]?.prompt).text).toContain('rejected by the output validator');
    expect(askedFor(calls[1]?.prompt).text).toContain('no readable JSON object');
  });

  it('retries once when the reply is JSON of the wrong shape', async () => {
    const { service, row, skills } = setup();
    const calls = modelReplying(
      JSON.stringify({ name: ANSWER.name, description: ANSWER.description, script: ANSWER.script }),
      JSON.stringify(ANSWER),
    );

    await service.run('rec-1');

    expect(row.state).toBe('READY');
    expect(skills).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(askedFor(calls[1]?.prompt).text).toContain('"params" is missing');
  });
});

describe('SkillCompileService — a truncated trace is judged first (D-042)', () => {
  it('fails a truncated trace the model does not consider a complete task', async () => {
    const { service, row, skills } = setup({ warning: 'EVENT_LIMIT' });
    const calls = modelSequence([
      { worthCompiling: false, reason: 'the trace stops inside the form' },
      ANSWER,
    ]);

    await service.run('rec-1');

    expect(row.state).toBe('FAILED');
    expect(row.error).toMatch(/truncated \(EVENT_LIMIT\)/);
    expect(row.error).toContain('does not contain a complete task');
    expect(row.error).toContain('stops inside the form');
    expect(skills).toEqual([]);
    // One call, the judgement: the compile never ran.
    expect(calls).toHaveLength(1);
  });

  it('compiles a truncated trace judged complete, and tells the model why it ends', async () => {
    const { service, row, skills } = setup({ warning: 'TIME_LIMIT' });
    const calls = modelSequence([
      { worthCompiling: true, reason: 'the cutoff trimmed idle time after the page opened' },
      ANSWER,
    ]);

    await service.run('rec-1');

    expect(row.state).toBe('READY');
    expect(skills).toHaveLength(1);
    expect(calls).toHaveLength(2);
    // The compile prompt says why the trace stops where it does, so a
    // judged-worthy cut cannot quietly become an invented ending.
    const { text } = askedFor(calls[1]?.prompt);
    expect(text).toContain('20-minute');
    expect(text).toContain('never invent the ending');
  });

  it('carries the timing rule into the judgement request too (M3-BE-07)', async () => {
    const { service } = setup({ warning: 'TIME_LIMIT' });
    const calls = modelSequence([
      { worthCompiling: true, reason: 'the cutoff trimmed idle time after the page opened' },
      ANSWER,
    ]);

    await service.run('rec-1');

    // The judgement is a request of its own — a different question, a
    // different system prompt — and M3-BE-07's claim is that the rule reaches
    // it too: the judgement reads the same trace the compiler will. calls[0]
    // is the judgement; calls[1] is the compile.
    const system = systemOf(calls[0]?.prompt);
    expect(system).toContain('Never call `sleep(n)`');
    expect(system).toContain('setTimeout');
    expect(system).toContain('ctx.waitFor');
    expect(system).toContain('predicate');
    expect(system).toContain('gap in the trace');
    expect(system).toContain('never evidence of');
  });

  it('fails rather than falling through when the judgement cannot be made', async () => {
    const { service, row, skills } = setup({ warning: 'EVENT_LIMIT' });
    resolveModel.mockReturnValue(
      new MockLanguageModelV4({
        doGenerate: async () => {
          throw new Error('the judgement provider is down');
        },
      }),
    );

    await service.run('rec-1');

    // An undecidable truncated trace must not fall through to a compile: the
    // fall-through, not the failure, is what D-042 exists to prevent.
    expect(row.state).toBe('FAILED');
    expect(row.error).toMatch(/could not be judged/);
    expect(skills).toEqual([]);
  });
});

describe('SkillCompileService — the compile is bounded (D-044)', () => {
  it('allows a healthy structured response that takes longer than one minute', async () => {
    const { service, row, skills } = setup();
    resolveModel.mockReturnValue(
      new MockLanguageModelV4({
        doGenerate: async () => {
          await new Promise((resolve) => setTimeout(resolve, 75_000));
          return {
            content: [{ type: 'text', text: JSON.stringify(ANSWER) }],
            finishReason: { unified: 'stop', raw: undefined },
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            warnings: [],
          };
        },
      }),
    );
    vi.useFakeTimers();
    try {
      const running = service.run('rec-1');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(row.state).toBe('COMPILING');
      await vi.advanceTimersByTimeAsync(15_000);
      await running;
      expect(row.state).toBe('READY');
      expect(skills).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails a compile whose model never answers, at the deadline', async () => {
    const { service, row } = setup();
    resolveModel.mockReturnValue(
      new MockLanguageModelV4({
        // Accepts the call and never answers — a provider that is up but
        // wedged. The abort listener is what a real fetch would do; the race
        // settles the compile even if nothing listens.
        doGenerate: (options) =>
          new Promise<never>((_resolve, reject) => {
            options.abortSignal?.addEventListener('abort', () =>
              reject(new Error('the request was aborted')),
            );
          }),
      }),
    );

    vi.useFakeTimers();
    try {
      const running = service.run('rec-1');
      // Let the job reach the model call before advancing to the deadline.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(SkillCompileService.DEADLINE_MS);
      await running;
    } finally {
      vi.useRealTimers();
    }

    expect(row.state).toBe('FAILED');
    expect(row.error).toContain('180 seconds');
  });

  it('bounds the judgement call too, so a truncated trace cannot hang either', async () => {
    const { service, row } = setup({ warning: 'EVENT_LIMIT' });
    let calls = 0;
    resolveModel.mockReturnValue(
      new MockLanguageModelV4({
        doGenerate: () => {
          calls += 1;
          // Never answers. The deadline must settle this on its own.
          return new Promise<never>(() => {});
        },
      }),
    );

    vi.useFakeTimers();
    try {
      const running = service.run('rec-1');
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(SkillCompileService.DEADLINE_MS);
      await running;
    } finally {
      vi.useRealTimers();
    }

    expect(row.state).toBe('FAILED');
    expect(row.error).toContain('180 seconds');
    expect(calls).toBe(1);
  });
});

/**
 * M4-BE-06 — the correlated click, end to end through the service: the pair
 * reaches the model as ONE action (with the DOM identity the Playwright
 * emission needs), and the prompt says never to emit both layers. The fold
 * itself is fenced in `m4-be-06-compiler.test.ts`; this is the wiring — the
 * service reads the correlator's fields, folds before the crops and the
 * prompt, and hands the model the never-both rule.
 */
describe('SkillCompileService — correlated steps are shown once (M4-BE-06)', () => {
  const CORRELATED_EVENTS = [
    {
      id: 'press-1',
      tsOffsetMs: 100,
      layer: 'X11',
      type: 'pointer',
      payload: { x: 640, y: 400, buttonMask: 1 },
      screenshotKey: null,
      correlatedWithId: 'report-1',
    },
    {
      id: 'report-1',
      tsOffsetMs: 130,
      layer: 'CDP',
      type: 'click',
      payload: {
        url: 'https://example.test/',
        testid: 'save',
        candidates: [{ kind: 'testid', selector: '[data-testid="save"]', unique: true }],
      },
      screenshotKey: null,
      correlatedWithId: 'press-1',
    },
    {
      id: 'release-1',
      tsOffsetMs: 150,
      layer: 'X11',
      type: 'pointer',
      payload: { x: 640, y: 400, buttonMask: 0 },
      screenshotKey: null,
    },
  ];

  it('hands the model the pair once, as a browser click at the press’s position', async () => {
    const { service } = setup({ events: CORRELATED_EVENTS });
    const calls = modelReturning(ANSWER);

    await service.run('rec-1');

    const { text } = askedFor(calls[0]?.prompt);
    const lines = traceLines(text);

    // One row — not the X11 press plus the CDP report. The merged row sits at
    // the press's offset (100), because that is when the action happened.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      ms: 100,
      type: 'click',
      url: 'https://example.test/',
      testid: 'save',
      candidates: [{ kind: 'testid', selector: '[data-testid="save"]', unique: true }],
      x: 640,
      y: 400,
    });
    // The raw press row is gone — a left-button-down cannot appear anywhere —
    // while the release still renders (the legend says it belongs to the
    // click, not a step of its own).
    expect(text).not.toContain('"buttonMask":1');
    expect(lines[1]).toMatchObject({ ms: 150, type: 'pointer', buttonMask: 0 });
  });

  it('tells the model the emission rules that keep it to one layer', async () => {
    const { service } = setup({ events: CORRELATED_EVENTS });
    const calls = modelReturning(ANSWER);

    await service.run('rec-1');

    const system = systemOf(calls[0]?.prompt);
    // §6/M4: "The compiler emits page.click('<selector>') rather than
    // ctx.click(x, y) for every correlated interaction" and "The compiler
    // must not emit both."
    expect(system).toContain("ctx.page.click('<selector>')");
    expect(system).toContain('never emit both');
    expect(system).toContain("ctx.page.fill('<selector>', value)");
    expect(system).toContain("ctx.page.waitForLoadState('load')");
    // The legend explains the row vocabulary the folded trace uses, including
    // the guarantee itself.
    expect(system).toContain('appears ONCE');
    expect(system).toContain('"candidates"');
  });

  it('keeps an uncorrelated X11 click on its coordinates, and falls a CDP-only click back to them', async () => {
    const { service } = setup({
      events: [
        {
          id: 'press-1',
          tsOffsetMs: 100,
          layer: 'X11',
          type: 'pointer',
          payload: { x: 10, y: 20, buttonMask: 1 },
          screenshotKey: null,
        },
        {
          id: 'press-2',
          tsOffsetMs: 130,
          layer: 'X11',
          type: 'pointer',
          payload: { x: 10, y: 20, buttonMask: 0 },
          screenshotKey: null,
        },
        {
          id: 'report-1',
          tsOffsetMs: 400,
          layer: 'CDP',
          type: 'click',
          payload: {
            url: 'https://example.test/',
            screenX: 10,
            screenY: 20,
            // The ratio that turns the page's CSS pixels into the desktop
            // pixels the trace's x/y are written in — a real report always
            // carries it, and the fence promotes no position without it.
            dpr: 1,
            candidates: [{ kind: 'text', selector: 'text="Go"', unique: true }],
          },
          screenshotKey: null,
        },
      ],
    });
    const calls = modelReturning(ANSWER);

    await service.run('rec-1');

    const { text } = askedFor(calls[0]?.prompt);
    const lines = traceLines(text);
    // The raw press/release pair keeps its coordinate reading, and a CDP
    // click whose X11 twin was not captured falls back to the coordinates
    // the page itself reported for it: its one candidate was engine syntax
    // the shipped resolver cannot execute, so the compile fence sets it
    // aside (M4-BE-06 fix wave) and the row replays as a coordinate click —
    // never as `ctx.page.click('text="Go"')`, which could not run.
    expect(lines[0]).toEqual({ ms: 100, type: 'pointer', x: 10, y: 20, buttonMask: 1 });
    expect(lines[1]).toEqual({ ms: 130, type: 'pointer', x: 10, y: 20, buttonMask: 0 });
    expect(lines[2]).toEqual({
      ms: 400,
      type: 'click',
      url: 'https://example.test/',
      screenX: 10,
      screenY: 20,
      dpr: 1,
      x: 10,
      y: 20,
    });
    expect(text).not.toContain('text=');
  });

  it('renders a browser field by its selectors and value, not only its keystrokes', async () => {
    const { service } = setup({
      events: [
        {
          id: 'input-1',
          tsOffsetMs: 200,
          layer: 'CDP',
          type: 'input',
          payload: {
            url: 'https://example.test/',
            value: 'otters',
            candidates: [{ kind: 'id', selector: '#query', unique: true }],
          },
          screenshotKey: null,
        },
      ],
    });
    const calls = modelReturning(ANSWER);

    await service.run('rec-1');

    const lines = traceLines(askedFor(calls[0]?.prompt).text);
    expect(lines[0]).toMatchObject({
      ms: 200,
      type: 'input',
      value: 'otters',
      candidates: [{ kind: 'id', selector: '#query', unique: true }],
    });
  });
});
