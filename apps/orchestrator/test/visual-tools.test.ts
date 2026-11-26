import { describe, expect, it, vi } from 'vitest';
import type { ToolSandboxSession } from '@crewaid/sandbox-core';
import {
  NativeToolInputs,
  VISUAL_INLINE_ACK,
  VisualResolvedOutputSchema,
  resolveVisualForRender,
} from '@crewaid/shared';
import { toolInputJsonSchema } from '../src/agent/tool-contract.js';
import type { ToolContext } from '../src/agent/tool-registry.js';
import { visualTools } from '../src/agent/visual-tools.js';
import {
  VISUAL_SOURCE_MAX_BYTES,
  parseDelimitedRows,
  parseNumericCell,
  parseVisualDataset,
} from '../src/agent/visual-data.js';

function fakeSession(files: Record<string, string>, statOverrides?: Record<string, string>) {
  const run = vi.fn(async ({ command }: { command: string }) => {
    const head = /^head -c (\d+) -- '([^']+)'$/.exec(command);
    if (head !== null) {
      const content = files[head[2]!];
      if (content === undefined) return { exitCode: 1, stdout: '', stderr: 'No such file' };
      const bytes = Buffer.from(content, 'utf8').subarray(0, Number(head[1]));
      return { exitCode: 0, stdout: bytes.toString('utf8'), stderr: '' };
    }
    const match = /stat -L -c '%F:%s' '([^']+)'/.exec(command);
    const path = match?.[1] ?? '';
    if (statOverrides && Object.hasOwn(statOverrides, path)) {
      return { exitCode: 0, stdout: `${statOverrides[path]}\n`, stderr: '' };
    }
    if (Object.hasOwn(files, path)) {
      const bytes = Buffer.byteLength(files[path]!, 'utf8');
      return { exitCode: 0, stdout: `regular file:${bytes}\n`, stderr: '' };
    }
    return { exitCode: 1, stdout: '', stderr: 'No such file or directory' };
  });
  const session = { run } as unknown as ToolSandboxSession;
  const reads = () =>
    run.mock.calls.filter(([options]) => options.command.startsWith('head -c ')).length;
  return { session, run, reads };
}

function makeContext(sessionFn: () => Promise<ToolSandboxSession>): ToolContext {
  return {
    userId: 'user-1',
    botId: 'bot-1',
    groupId: 'group-1',
    attachmentHost: async () => 'msg-1',
    trigger: { id: 'trig-1', chainId: null, hopCount: 0 },
    browser: async () => {
      throw new Error('browser should not wake');
    },
    session: sessionFn,
    useIdentity: async () => {
      throw new Error('identity should not run');
    },
  };
}

describe('present_visual tool & data loader', () => {
  it('stays within a strict JSON Schema byte budget', () => {
    // Every model call that offers present_visual carries this schema, so the
    // budget keeps its growth a deliberate decision rather than drift. It sits
    // just above the current size: `handoff` (~1.85 KB) moved it from 4,800 to
    // 6,700, `checks` (~0.42 KB) moved it to 7,200, and `diff` (~0.22 KB) moved
    // it to 7,450. Raise it only alongside a new block or field.
    const schema = toolInputJsonSchema(NativeToolInputs.present_visual);
    const serialized = JSON.stringify(schema);
    expect(serialized.length).toBeLessThanOrEqual(7_450);
  });

  it('acknowledges inline visuals without waking the sandbox', async () => {
    const session = vi.fn(async () => {
      throw new Error('sandbox must not wake for inline visuals');
    });
    const entry = visualTools()[0]!;
    const def = entry.build(makeContext(session));
    const output = await def.execute!(
      {
        title: 'MRR',
        blocks: [
          {
            kind: 'metrics',
            items: [{ label: 'MRR', value: '$42k', delta: '+10%', trend: 'up' }],
          },
        ],
      },
      { toolCallId: 'tc-1', messages: [] },
    );

    expect(output).toBe(VISUAL_INLINE_ACK);
    expect(session).not.toHaveBeenCalled();
  });

  it('resolves CSV and JSON array sources into durable visual snapshots and concise model output', async () => {
    const csvPath = '/home/bot/agents/bot-1/revenue.csv';
    const jsonPath = '/home/bot/shared/vendors.json';
    const fake = fakeSession({
      [csvPath]:
        '\uFEFFmonth,revenue,cost\r\n"Jan, 2026","$1,200","$800"\r\n"Feb, 2026","$1,550","$860"\r\n',
      [jsonPath]: JSON.stringify([
        { vendor: 'Acme', price: 49, soc2: true },
        { vendor: 'Beta', price: 79, soc2: false },
      ]),
    });
    const entry = visualTools()[0]!;
    const def = entry.build(makeContext(async () => fake.session));

    const input = {
      title: 'Financials',
      blocks: [
        {
          kind: 'chart' as const,
          chartType: 'bar' as const,
          title: 'Monthly Revenue',
          source: { file: 'revenue.csv', x: 'month', y: ['revenue', 'cost'] },
        },
        {
          kind: 'table' as const,
          title: 'Vendors',
          source: { file: '/home/bot/shared/vendors.json', cols: ['vendor', 'price', 'soc2'] },
        },
      ],
    };

    const output = await def.execute!(input, { toolCallId: 'tc-2', messages: [] });
    const parsed = VisualResolvedOutputSchema.parse(output);
    expect(parsed.sources).toEqual(['revenue.csv', 'vendors.json']);

    const rendered = resolveVisualForRender(input, parsed);
    expect(rendered).not.toBeNull();
    expect(rendered?.blocks[0]).toEqual({
      kind: 'chart',
      chartType: 'bar',
      title: 'Monthly Revenue',
      x: ['Jan, 2026', 'Feb, 2026'],
      series: [
        { name: 'revenue', y: [1200, 1550] },
        { name: 'cost', y: [800, 860] },
      ],
    });
    expect(rendered?.blocks[1]).toEqual({
      kind: 'table',
      title: 'Vendors',
      cols: ['vendor', 'price', 'soc2'],
      rows: [
        ['Acme', 49, true],
        ['Beta', 79, false],
      ],
    });

    const projected = await def.toModelOutput!({
      toolCallId: 'tc-2',
      input,
      output,
    });
    expect(projected.type).toBe('text');
    if (projected.type === 'text') {
      expect(projected.value).toContain('Resolved bar chart');
      expect(projected.value).toContain('total 2,750');
      expect(projected.value).toContain('Resolved table');
    }
  });

  it('clips truncation notes that name a long file so the snapshot stays valid', async () => {
    const name = `${'quarterly-pipeline-export-'.repeat(8)}.csv`;
    const path = `/home/bot/agents/bot-1/${name}`;
    const header = Array.from({ length: 14 }, (_, i) => `c${i}`).join(',');
    const rows = Array.from({ length: 105 }, (_, r) =>
      Array.from({ length: 14 }, (_, c) => r * c).join(','),
    );
    const fake = fakeSession({ [path]: [header, ...rows].join('\n') });
    const def = visualTools()[0]!.build(makeContext(async () => fake.session));
    const input = { blocks: [{ kind: 'table' as const, source: { file: name } }] };

    const output = await def.execute!(input, { toolCallId: 'tc-long', messages: [] });
    const parsed = VisualResolvedOutputSchema.parse(output);
    expect(parsed.notes?.[0]?.length).toBeLessThanOrEqual(240);
    expect(parsed.notes?.[0]).toMatch(/^Showing first 100 of 105 rows/);
    expect(resolveVisualForRender(input, parsed)).not.toBeNull();
  });

  it('refuses oversized files and non-regular files via stat BEFORE reading them', async () => {
    const bigPath = '/home/bot/agents/bot-1/huge.csv';
    const fifoPath = '/home/bot/agents/bot-1/pipe.csv';
    const fake = fakeSession(
      {},
      {
        [bigPath]: `regular file:${VISUAL_SOURCE_MAX_BYTES + 1}`,
        [fifoPath]: 'fifo:0',
      },
    );
    const entry = visualTools()[0]!;
    const def = entry.build(makeContext(async () => fake.session));

    const bigResult = await def.execute!(
      {
        blocks: [{ kind: 'table', source: { file: 'huge.csv' } }],
      },
      { toolCallId: 'tc-3', messages: [] },
    );
    expect(typeof bigResult).toBe('string');
    expect(bigResult).toContain('present_visual refused:');
    expect(bigResult).toContain('Python');
    expect(fake.reads()).toBe(0);

    const fifoResult = await def.execute!(
      {
        blocks: [{ kind: 'table', source: { file: 'pipe.csv' } }],
      },
      { toolCallId: 'tc-4', messages: [] },
    );
    expect(typeof fifoResult).toBe('string');
    expect(fifoResult).toContain('not a regular file');
    expect(fake.reads()).toBe(0);
  });

  it('caps horizontal bars from a file and refuses negative donut shares', async () => {
    const path = '/home/bot/agents/bot-1/regions.csv';
    const rows = Array.from({ length: 45 }, (_, i) => `r${i},${i - 2}`);
    const fake = fakeSession({ [path]: ['region,delta', ...rows].join('\n') });
    const def = visualTools()[0]!.build(makeContext(async () => fake.session));

    const hbar = { kind: 'chart' as const, chartType: 'hbar' as const };
    const hbarInput = {
      blocks: [{ ...hbar, source: { file: 'regions.csv', x: 'region', y: ['delta'] } }],
    };
    const parsed = VisualResolvedOutputSchema.parse(
      await def.execute!(hbarInput, { toolCallId: 'tc-hbar', messages: [] }),
    );
    const block = parsed.resolved['0'];
    expect(block?.kind === 'chart' && block.x.length).toBe(30);
    expect(parsed.notes?.[0]).toContain('Showing first 30 of 45 rows');

    const donut = await def.execute!(
      {
        blocks: [
          {
            kind: 'chart',
            chartType: 'donut',
            source: { file: 'regions.csv', x: 'region', y: ['delta'] },
          },
        ],
      },
      { toolCallId: 'tc-donut', messages: [] },
    );
    expect(donut).toContain('present_visual failed:');
    expect(donut).toContain('negative values');
  });

  it('bounds the read itself when a file grows after stat', async () => {
    const path = '/home/bot/agents/bot-1/growing.csv';
    // stat saw a small file; by the time of the read it is past the limit.
    const fake = fakeSession(
      { [path]: `a,b\n${'1,2\n'.repeat(VISUAL_SOURCE_MAX_BYTES / 2)}` },
      { [path]: 'regular file:1024' },
    );
    const def = visualTools()[0]!.build(makeContext(async () => fake.session));
    const result = await def.execute!(
      { blocks: [{ kind: 'table', source: { file: 'growing.csv' } }] },
      { toolCallId: 'tc-grow', messages: [] },
    );
    expect(result).toContain('present_visual refused:');
    expect(result).toContain('byte limit');
    const head = fake.run.mock.calls.find(([options]) => options.command.startsWith('head -c '));
    expect(head?.[0].command).toContain(`head -c ${VISUAL_SOURCE_MAX_BYTES + 1} -- `);
  });

  it('refuses out-of-workspace paths, binary files, and reports missing columns clearly', async () => {
    const binPath = '/home/bot/agents/bot-1/bin.csv';
    const csvPath = '/home/bot/agents/bot-1/sales.csv';
    const fake = fakeSession({
      [binPath]: 'a,b\n1,\u00002',
      [csvPath]: 'month,revenue\nJan,100\n',
    });
    const entry = visualTools()[0]!;
    const def = entry.build(makeContext(async () => fake.session));

    const escape = await def.execute!(
      { blocks: [{ kind: 'table', source: { file: '/etc/passwd' } }] },
      { toolCallId: 'tc-5', messages: [] },
    );
    expect(escape).toContain('present_visual refused:');
    expect(fake.run).not.toHaveBeenCalled();

    const sibling = await def.execute!(
      { blocks: [{ kind: 'table', source: { file: '/home/bot/agents/other-bot/x.csv' } }] },
      { toolCallId: 'tc-6', messages: [] },
    );
    expect(sibling).toContain("another bot's area");

    const binary = await def.execute!(
      { blocks: [{ kind: 'table', source: { file: 'bin.csv' } }] },
      { toolCallId: 'tc-7', messages: [] },
    );
    expect(binary).toContain('binary data');

    const badCol = await def.execute!(
      {
        blocks: [
          {
            kind: 'chart',
            chartType: 'line',
            source: { file: 'sales.csv', x: 'month', y: ['profit'] },
          },
        ],
      },
      { toolCallId: 'tc-8', messages: [] },
    );
    expect(badCol).toContain('not found');
    expect(badCol).toContain('available: month, revenue');
  });

  it('parses TSV, quoted newlines, and numeric edge cases cleanly', () => {
    expect(parseDelimitedRows('a,b\n"line1\nline2","hello ""world"""', ',')).toEqual([
      ['a', 'b'],
      ['line1\nline2', 'hello "world"'],
    ]);
    const tsv = parseVisualDataset('day\tvisits\nMon\t120\nTue\t145', 'stats.tsv');
    expect(tsv.ok).toBe(true);
    if (tsv.ok) {
      expect(tsv.dataset.headers).toEqual(['day', 'visits']);
      expect(tsv.dataset.records).toHaveLength(2);
    }
    expect(parseNumericCell('$1,250.50')).toBe(1250.5);
    expect(parseNumericCell('(42.5%)')).toBe(-42.5);
    expect(parseNumericCell('N/A')).toBeNull();
  });
});
