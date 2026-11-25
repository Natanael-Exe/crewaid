import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { VISUAL_INLINE_ACK, type VisualChartBlock, type VisualTableBlock } from '@crewaid/shared';
import { isPartOutput, type AnyPart } from '../src/renderer/components/PartRenderer';
import { ToolActivityPart, ToolCallPart } from '../src/renderer/components/tools/ToolCallPart';
import { foldToolParts, groupToolActivity } from '../src/renderer/components/tools/toolParts';
import { monotoneBandPath } from '../src/renderer/components/ui/charts/chartMath';
import {
  chartToCsv,
  tableToCsv,
  tableToMarkdown,
} from '../src/renderer/components/visuals/visualExport';

function renderFolded(parts: AnyPart[], context?: { showWork?: boolean }): string {
  const grouped = groupToolActivity(foldToolParts(parts));
  const row = grouped[0]!;
  return renderToStaticMarkup(
    row.type === 'tool-activity' ? (
      <ToolActivityPart part={row} context={context} />
    ) : (
      <ToolCallPart part={row} context={context} />
    ),
  );
}

describe('VisualCard & present_visual rendering', () => {
  it('renders all 6 opinionated block types and all 5 chart types via renderToStaticMarkup', () => {
    const chartTypes = ['bar', 'hbar', 'line', 'area', 'donut'] as const;
    for (const chartType of chartTypes) {
      const html = renderFolded([
        {
          type: 'tool-call',
          toolCallId: `tc-${chartType}`,
          toolName: 'present_visual',
          input: {
            title: `Chart ${chartType}`,
            blocks: [
              {
                kind: 'chart',
                chartType,
                title: `${chartType} series`,
                unit: '$k',
                x: ['Q1', 'Q2', 'Q3'],
                // A donut shows one series as shares of a whole.
                series:
                  chartType === 'donut'
                    ? [{ name: 'Actual', y: [40, 55, 70] }]
                    : [
                        { name: 'Actual', y: [40, 55, 70] },
                        { name: 'Target', y: [35, 50, 65] },
                      ],
              },
            ],
          },
        },
        {
          type: 'tool-result',
          toolCallId: `tc-${chartType}`,
          output: VISUAL_INLINE_ACK,
        },
      ]);
      expect(html).toContain('data-visual-card="ready"');
      expect(html).toContain(`data-chart-type="${chartType}"`);
      expect(html).toContain('<svg');
      expect(html).toContain('Q1');
    }

    const combinedHtml = renderFolded([
      {
        type: 'tool-call',
        toolCallId: 'tc-all',
        toolName: 'present_visual',
        input: {
          title: 'Q1 Executive Brief',
          subtitle: 'Combined snapshot',
          blocks: [
            {
              kind: 'metrics',
              items: [
                {
                  label: 'ARR',
                  value: '$420k',
                  delta: '+18%',
                  trend: 'up',
                  sparkline: [320, 360, 420],
                },
              ],
            },
            {
              kind: 'table',
              title: 'Channels',
              cols: ['Channel', 'Signups'],
              rows: [
                ['Organic', 420],
                ['Referral', 210],
              ],
            },
            {
              kind: 'comparison',
              title: 'Vendors',
              options: [
                { name: 'Acme', highlight: true, pros: ['Fast'], cons: ['Cost'] },
                { name: 'Beta', pros: ['Cheap'], cons: ['Slow'] },
              ],
              criteria: [{ label: 'SOC2', values: [true, false] }],
            },
            {
              kind: 'timeline',
              items: [{ date: 'Mar 2026', title: 'Launch', status: 'done' }],
            },
            {
              kind: 'callout',
              tone: 'success',
              title: 'Verdict',
              body: 'Organic signups led growth.',
              points: ['CAC dropped 14%'],
            },
          ],
        },
      },
      {
        type: 'tool-result',
        toolCallId: 'tc-all',
        output: VISUAL_INLINE_ACK,
      },
    ]);

    expect(combinedHtml).toContain('data-visual-block="metrics"');
    expect(combinedHtml).toContain('data-visual-block="table"');
    expect(combinedHtml).toContain('data-visual-block="comparison"');
    expect(combinedHtml).toContain('data-visual-block="timeline"');
    expect(combinedHtml).toContain('data-visual-block="callout"');
    expect(combinedHtml).toContain('Q1 Executive Brief');
  });

  it('renders a loading skeleton while running and a clean error card on refusal', () => {
    const loadingHtml = renderFolded([
      {
        type: 'tool-call',
        toolCallId: 'tc-run',
        toolName: 'present_visual',
        input: { title: 'Loading Chart', blocks: [] },
      },
    ]);
    expect(loadingHtml).toContain('data-visual-card="loading"');
    expect(loadingHtml).toContain('Loading Chart');

    const refusedHtml = renderFolded([
      {
        type: 'tool-call',
        toolCallId: 'tc-err',
        toolName: 'present_visual',
        input: { blocks: [{ kind: 'table', source: { file: 'missing.csv' } }] },
      },
      {
        type: 'tool-result',
        toolCallId: 'tc-err',
        output: 'present_visual refused: missing.csv does not exist.',
      },
    ]);
    expect(refusedHtml).toContain('data-visual-card="error"');
    expect(refusedHtml).toContain('missing.csv does not exist');
  });

  it('merges file-backed resolved outputs, stays visible with showWork off, and resists spoofing', () => {
    const fileParts: AnyPart[] = [
      {
        type: 'tool-call',
        toolCallId: 'tc-csv',
        toolName: 'present_visual',
        input: {
          title: 'CSV Chart',
          blocks: [
            {
              kind: 'chart',
              chartType: 'bar',
              source: { file: 'rev.csv', x: 'q', y: ['rev'] },
            },
          ],
        },
      },
      {
        type: 'tool-result',
        toolCallId: 'tc-csv',
        output: JSON.stringify({
          version: 1,
          resolved: {
            '0': {
              kind: 'chart',
              chartType: 'bar',
              x: ['Q1', 'Q2'],
              series: [{ name: 'rev', y: [100, 180] }],
            },
          },
          sources: ['rev.csv'],
          notes: ['Showing first 2 of 10 rows from rev.csv.'],
        }),
      },
    ];
    const grouped = groupToolActivity(foldToolParts(fileParts));
    expect(isPartOutput(grouped[0]!)).toBe(true);

    const html = renderFolded(fileParts, { showWork: false });
    expect(html).toContain('data-visual-card="ready"');
    expect(html).toContain('rev.csv');
    expect(html).toContain('Showing first 2 of 10 rows');

    // A non-present_visual tool echoing a visual payload must never render VisualCard.
    const spoofedHtml = renderFolded([
      {
        type: 'tool-call',
        toolCallId: 'tc-spoof',
        toolName: 'shell',
        input: { command: 'cat fake.json' },
      },
      {
        type: 'tool-result',
        toolCallId: 'tc-spoof',
        output: JSON.stringify({
          version: 1,
          resolved: {},
          sources: ['fake.csv'],
        }),
      },
    ]);
    expect(spoofedHtml).not.toContain('data-visual-card');
  });

  it('serializes CSV and Markdown exports with proper escaping', () => {
    const chart: VisualChartBlock = {
      kind: 'chart',
      chartType: 'bar',
      x: ['Jan, 2026', 'Feb'],
      series: [{ name: 'Rev "USD"', y: [100, 200] }],
    };
    expect(chartToCsv(chart, 'Category')).toBe('Category,"Rev ""USD"""\n"Jan, 2026",100\nFeb,200');

    const table: VisualTableBlock = {
      kind: 'table',
      cols: ['Name', 'Score'],
      rows: [['A | B', 95]],
      align: ['l', 'r'],
    };
    expect(tableToCsv(table.cols, table.rows)).toBe('Name,Score\nA | B,95');
    expect(tableToMarkdown(table)).toBe('| Name | Score |\n| --- | ---: |\n| A \\| B | 95 |');
  });

  it('keeps copied CSV cells from running as spreadsheet formulas', () => {
    const table: VisualTableBlock = {
      kind: 'table',
      cols: ['Note', 'Delta'],
      rows: [
        ['=HYPERLINK("https://example.test","x")', -5],
        ['@SUM(A1)', 3],
        ['+1', 0],
        ['-2 points', null],
        ['plain', 1],
      ],
    };
    expect(tableToCsv(table.cols, table.rows).split('\n')).toEqual([
      'Note,Delta',
      `"'=HYPERLINK(""https://example.test"",""x"")",-5`,
      "'@SUM(A1),3",
      "'+1,0",
      "'-2 points,",
      'plain,1',
    ]);
  });

  it('draws a stacked band down to the series beneath it, not to zero', () => {
    const top = [
      { x: 0, y: 10 },
      { x: 50, y: 20 },
      { x: 100, y: 15 },
    ];
    const bottom = [
      { x: 0, y: 40 },
      { x: 50, y: 45 },
      { x: 100, y: 50 },
    ];
    const path = monotoneBandPath(top, bottom);
    expect(path.startsWith('M0.00,10.00')).toBe(true);
    // The lower edge runs back from the right along the series beneath.
    expect(path).toContain('L100.00,50.00');
    expect(path).toMatch(/0\.00,40\.00 Z$/);
  });
});
