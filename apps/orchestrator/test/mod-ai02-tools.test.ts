import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { JsonSchema, NativeToolInputs, type Json } from '@crewaid/shared';
import {
  tool,
  jsonSchema,
  toolInputValidator,
  parseToolInput,
  type ToolSet,
} from '../src/agent/tool-contract.js';
import { tanstackTools } from '../src/agent/execution/tanstack-tools.js';
import { projectToolHistory } from '../src/agent/execution/tool-history-projection.js';
import {
  OBSERVING_BUILTIN,
  CONTAINED_BUILTIN,
  SENSITIVE_BUILTIN,
  SEAT_BUILTIN,
  type RegisteredTool,
} from '../src/agent/tool-registry.js';
import { bindMcpTool, type CachedMcpTool } from '../src/mcp/mcp-tool-binding.js';
import { policyHash } from '../src/agent/policy/policy.js';
import { toolFixture } from './mod-ai02-harness.js';

const entry = (
  name: string,
  definition: ToolSet[string],
  behavior = CONTAINED_BUILTIN,
): RegisteredTool => ({ name, behavior, build: () => definition });
const pairs = z
  .record(z.string(), z.object({ valid: JsonSchema, invalid: JsonSchema }))
  .parse(
    JSON.parse(
      readFileSync(
        new URL('../../../packages/shared/test-fixtures/native-tools.json', import.meta.url),
        'utf8',
      ),
    ),
  );

describe('D-175 neutral tool adapters', () => {
  it.each(Object.entries(NativeToolInputs))(
    '%s: the engine adapter validates and dispatches what the definition does',
    async (name, inputSchema) => {
      const definition = tool({ inputSchema, execute: (args) => args });
      const target = tanstackTools({ [name]: definition })[0]!;
      const fixture = pairs[name]!;
      const validate = toolInputValidator(inputSchema);
      expect((await validate(fixture.valid)).ok).toBe(true);
      expect((await validate(fixture.invalid)).ok).toBe(false);
      const options = { toolCallId: 'model-1', messages: [] };
      expect(await definition.execute!(fixture.valid, options)).toEqual(
        await target.execute!(fixture.valid, {
          toolCallId: 'model-1',
          emitCustomEvent: () => undefined,
        }),
      );
      await expect(
        target.execute!(fixture.invalid, {
          toolCallId: 'model-1',
          emitCustomEvent: () => undefined,
        }),
      ).rejects.toThrow();
    },
  );
  it('fills trusted native defaults before binding but rejects supplied-value changes and stripping', async () => {
    const input = { fact: 'Use English', kind: 'fact', scope: 'workspace' };
    expect(await parseToolInput(NativeToolInputs.remember, input)).toEqual({
      ...input,
      detail: '',
    });
    await expect(parseToolInput(z.object({ n: z.coerce.number() }), { n: '3' })).rejects.toThrow(
      'transformations',
    );
    await expect(
      parseToolInput(z.object({ name: z.string().trim() }), { name: ' Quill ' }),
    ).rejects.toThrow('transformations');
    await expect(parseToolInput(NativeToolInputs.board_read, { approved: true })).rejects.toThrow(
      'transformations',
    );
  });
  it('validates outputs after execution without replaying effects', async () => {
    const execute = vi.fn(() => ({ count: 'bad' }));
    const definition = tool({
      inputSchema: z.object({}),
      outputSchema: z.object({ count: z.number() }),
      execute: execute as never,
    });
    await expect(
      tanstackTools({ check: definition })[0]!.execute!(
        {},
        { toolCallId: 'call', emitCustomEvent: () => undefined },
      ),
    ).rejects.toThrow('TOOL_OUTPUT_INVALID');
    expect(execute).toHaveBeenCalledOnce();
  });
  it('does not forward definition properties or admit a client implementation', async () => {
    const execute = vi.fn(() => 'server');
    const definition = tool({ inputSchema: z.object({}), execute });
    const target = tanstackTools({
      read: {
        ...definition,
        needsApproval: false,
        credentials: 'fake',
        metadata: { grantValid: true },
      } as never,
    })[0]!;
    expect(target).not.toHaveProperty('credentials');
    expect(target).not.toHaveProperty('metadata');
    expect(target.needsApproval).not.toBe(true);
    await expect(target.execute!({}, { emitCustomEvent: () => undefined })).rejects.toThrow(
      'missing server call id',
    );
    expect(execute).not.toHaveBeenCalled();
    const missing = tanstackTools({ clientOnly: { inputSchema: z.object({}) } })[0]!;
    await expect(
      missing.execute!({}, { toolCallId: 'call', emitCustomEvent: () => undefined }),
    ).rejects.toThrow('no server implementation');
  });
  it('keeps raw MCP content, same argument validation, and cancellation routing', async () => {
    const remote = {
      content: [{ type: 'text', text: 'remote result' }],
      structuredContent: { count: 1 },
    };
    const call = vi.fn(async () => remote);
    const cached: CachedMcpTool = {
      name: 'read',
      description: 'Read',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: { count: { type: 'integer' } },
        required: ['count'],
        additionalProperties: false,
      },
    };
    const binding = bindMcpTool({ id: 'server-1', name: 'Plugin', slug: 'plugin' }, cached, call);
    expect(binding.ok).toBe(true);
    if (!binding.ok) throw new Error('binding');
    const definition = binding.tool.build({} as never);
    const controller = new AbortController();
    const options = { toolCallId: 'model-call', messages: [], abortSignal: controller.signal };
    expect(await definition.execute!({ count: 2 }, options)).toEqual(remote);
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        args: { count: 2 },
        abortSignal: controller.signal,
        timeoutMs: 30000,
      }),
    );
    await expect(definition.execute!({ count: '2' }, options)).rejects.toThrow();
    expect(call).toHaveBeenCalledOnce();
    const target = tanstackTools({ plugin__read: definition })[0]!;
    await expect(
      target.execute!(
        { count: '2' },
        { toolCallId: 'model-call', emitCustomEvent: () => undefined },
      ),
    ).rejects.toThrow();
    expect(
      await definition.toModelOutput!({
        toolCallId: 'model-call',
        input: { count: 2 },
        output: remote,
      }),
    ).toEqual({ type: 'text', value: 'remote result' });
    controller.abort();
    await expect(definition.execute!({ count: 2 }, options)).rejects.toThrow('TOOL_CANCELLED');
    expect(call).toHaveBeenCalledOnce();
  });
  it('MCP defaults, coercion and executable or remote schemas cannot widen accepted arguments', async () => {
    const schema = jsonSchema({
      type: 'object',
      properties: { count: { type: 'integer', default: 1 } },
      required: ['count'],
    });
    await expect(schema.parse({})).rejects.toThrow();
    await expect(schema.parse({ count: '2' })).rejects.toThrow();
    await expect(jsonSchema({ $ref: 'https://evil.example/schema' }).parse({})).rejects.toThrow();
  });
});

describe('real TanStack chat loop over guarded registry dispatch', () => {
  it('runs native read/draft calls with stable IDs, defaulted arguments and no eager computer acquisition', async () => {
    const lazyComputer = vi.fn();
    const seen: unknown[] = [];
    const f = toolFixture(
      [
        entry(
          'remember',
          tool({
            inputSchema: NativeToolInputs.remember,
            execute: (args, context) => {
              seen.push({ args, id: context.toolCallId });
              return 'remembered';
            },
          }),
        ),
        entry(
          'board_read',
          tool({ inputSchema: NativeToolInputs.board_read, execute: () => 'board' }),
          OBSERVING_BUILTIN,
        ),
        entry(
          'screenshot',
          tool({ inputSchema: NativeToolInputs.screenshot, execute: lazyComputer }),
        ),
      ],
      [
        {
          id: 'memory-call',
          name: 'remember',
          args: { fact: 'English', kind: 'fact', scope: 'workspace' },
        },
        { id: 'read-call', name: 'board_read', args: {} },
      ],
    );
    const chunks = await f.start();
    expect(chunks.some((c) => c.type === 'RUN_ERROR')).toBe(false);
    expect(f.proposals.size).toBe(0);
    expect(seen).toEqual([
      {
        args: { fact: 'English', kind: 'fact', scope: 'workspace', detail: '' },
        id: 'memory-call',
      },
    ]);
    expect(lazyComputer).not.toHaveBeenCalled();
    expect(
      f.adapter.observed
        .at(-1)
        ?.filter((m) => m.role === 'tool')
        .map((m) => m.toolCallId),
    ).toEqual(['memory-call', 'read-call']);
  });
  it.each(['approve', 'decline', 'cancel', 'edit', 'invalid edit', 'revoke'] as const)(
    'handles %s through generic interrupts and a final policy fence',
    async (kind) => {
      const execute = vi.fn((args: { command: string }) => `ran ${args.command}`);
      const f = toolFixture(
        [entry('shell', tool({ inputSchema: NativeToolInputs.shell, execute }), SENSITIVE_BUILTIN)],
        [{ id: 'model-call', name: 'shell', args: { command: 'ls' } }],
      );
      expect((await f.start()).some((c) => c.type === 'RUN_ERROR')).toBe(false);
      expect(execute).not.toHaveBeenCalled();
      expect(f.proposals.size).toBe(1);
      expect([...f.proposals.values()][0]?.toolCallId).toBe('model-call');
      const pending = await f.persistence.stores.interrupts.listPending(f.threadId);
      expect(pending[0]!.interruptId).not.toBe('model-call');
      if (kind === 'revoke') f.state.snapshot.grantRevision = policyHash('revoked');
      const chunks = await f.resume(
        {
          approved: kind !== 'decline',
          ...(kind === 'edit' && { editedArgs: { command: 'pwd' } }),
          ...(kind === 'invalid edit' && { editedArgs: { command: 3 } }),
        },
        kind === 'cancel'
          ? (batch) =>
              (batch as Array<Record<string, unknown>>).map((item) => ({
                interruptId: item.interruptId,
                status: 'cancelled',
              }))
          : undefined,
      );
      expect(chunks.some((c) => c.type === 'RUN_ERROR')).toBe(false);
      if (kind === 'approve' || kind === 'edit') {
        expect(execute).toHaveBeenCalledOnce();
        expect(execute.mock.calls[0]?.[0]).toEqual({ command: kind === 'edit' ? 'pwd' : 'ls' });
      } else expect(execute).not.toHaveBeenCalled();
    },
  );
  it('keeps an explicitly denied call isolated while another read succeeds', async () => {
    const denied = vi.fn(() => 'should not run');
    const allowed = vi.fn(() => 'read');
    const f = toolFixture(
      [
        entry(
          'shell',
          tool({ inputSchema: NativeToolInputs.shell, execute: denied }),
          SENSITIVE_BUILTIN,
        ),
        entry(
          'board_read',
          tool({ inputSchema: NativeToolInputs.board_read, execute: allowed }),
          OBSERVING_BUILTIN,
        ),
      ],
      [
        { id: 'denied', name: 'shell', args: { command: 'ls' } },
        { id: 'allowed', name: 'board_read', args: {} },
      ],
    );
    f.state.snapshot.rules = [{ toolPattern: 'shell', decision: 'deny' }];
    expect((await f.start()).some((c) => c.type === 'RUN_ERROR')).toBe(false);
    expect(denied).not.toHaveBeenCalled();
    expect(allowed).toHaveBeenCalledOnce();
  });
  it('refuses a forged resume authorizer result at the registry final fence', async () => {
    const execute = vi.fn(() => 'effect');
    const f = toolFixture(
      [entry('shell', tool({ inputSchema: NativeToolInputs.shell, execute }), SENSITIVE_BUILTIN)],
      [{ id: 'model-call', name: 'shell', args: { command: 'ls' } }],
      {
        authorizeResume: async () => [
          { toolCallId: 'model-call', approved: true, dispatchArgs: { command: 'ls' } },
        ],
      },
    );
    await f.start();
    await f.resume({ approved: true });
    expect(execute).not.toHaveBeenCalled();
  });
  it('keeps seat control barriers and passes cancellation to leased actions', async () => {
    const execute = vi.fn(() => 'clicked');
    const admit = vi.fn(async () => ({
      ok: false as const,
      refusal: { code: 'HUMAN_CONTROL', message: 'A person is controlling the screen.' },
    }));
    const f = toolFixture(
      [
        entry(
          'browser_click',
          tool({ inputSchema: NativeToolInputs.browser_click, execute }),
          SEAT_BUILTIN,
        ),
      ],
      [{ id: 'click', name: 'browser_click', args: { reference: 'r1_e2' } }],
      { seat: { admit: admit as never, beginObservation: () => () => undefined } },
    );
    await f.start();
    expect(admit).toHaveBeenCalledWith('targeted', expect.any(AbortSignal));
    expect(execute).not.toHaveBeenCalled();
  });
  it('rechecks a grant after waiting for manual seat control', async () => {
    const execute = vi.fn(() => 'clicked');
    let f: ReturnType<typeof toolFixture>;
    const release = vi.fn();
    f = toolFixture(
      [
        entry(
          'browser_click',
          tool({ inputSchema: NativeToolInputs.browser_click, execute }),
          SEAT_BUILTIN,
        ),
      ],
      [{ id: 'click', name: 'browser_click', args: { reference: 'r1_e2' } }],
      {
        seat: {
          beginObservation: () => () => undefined,
          admit: async () => {
            f.state.snapshot.grantValid = false;
            return { ok: true, release };
          },
        } as never,
      },
    );
    await f.start();
    expect(execute).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(f.adapter.observed.at(-1)?.find((m) => m.role === 'tool')?.content).toContain(
      'GRANT_REVOKED',
    );
  });
  it('does not admit forwarded grants in a generic approval reply', async () => {
    const execute = vi.fn(() => 'effect');
    const f = toolFixture(
      [entry('shell', tool({ inputSchema: NativeToolInputs.shell, execute }), SENSITIVE_BUILTIN)],
      [{ id: 'call', name: 'shell', args: { command: 'ls' } }],
    );
    await f.start();
    expect(await f.resume({ approved: true, grantValid: true } as never)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'RUN_ERROR', code: 'invalid-payload' }),
      ]),
    );
    expect(execute).not.toHaveBeenCalled();
    expect(f.resolutions.size).toBe(0);
  });
  it('stores full raw output while the provider reads a capped result and screenshot media', async () => {
    const huge = 'x'.repeat(180000);
    const image = { bytes: 8, base64: 'cG5nLWJ5dGVz' };
    const f = toolFixture(
      [
        entry(
          'board_read',
          tool({ inputSchema: NativeToolInputs.board_read, execute: () => huge }),
          OBSERVING_BUILTIN,
        ),
        entry(
          'screenshot',
          tool({
            inputSchema: NativeToolInputs.screenshot,
            execute: () => image,
            toModelOutput: ({ output }) => ({
              type: 'content',
              value: [
                {
                  type: 'file',
                  mediaType: 'image/png',
                  data: { type: 'data', data: output.base64 },
                },
              ],
            }),
          }),
          OBSERVING_BUILTIN,
        ),
      ],
      [
        { id: 'large', name: 'board_read', args: {} },
        { id: 'image', name: 'screenshot', args: {} },
      ],
    );
    await f.start();
    const stored = await f.persistence.stores.messages.loadThread(f.threadId);
    const messages = Array.isArray(stored) ? stored : stored.messages;
    const raw = messages.filter((m) => m.role === 'tool');
    expect(raw.find((m) => m.toolCallId === 'large')?.content).toContain(huge);
    expect(raw.find((m) => m.toolCallId === 'image')?.content).toContain(image.base64);
    const projected = f.adapter.observed.at(-1)!.filter((m) => m.role === 'tool');
    expect(String(projected.find((m) => m.toolCallId === 'large')?.content).length).toBeLessThan(
      105000,
    );
    expect(projected.find((m) => m.toolCallId === 'large')?.content).toContain('[truncated:');
    expect(projected.find((m) => m.toolCallId === 'image')?.content).toEqual([
      { type: 'image', source: { type: 'data', mimeType: 'image/png', value: image.base64 } },
    ]);
    const original = structuredClone(messages);
    await projectToolHistory(messages, f.resolved.toolSet);
    expect(messages).toEqual(original);
  });
});
