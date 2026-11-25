import { describe, expect, it } from 'vitest';
import {
  PresentVisualInputSchema,
  VISUAL_INLINE_ACK,
  formatVisualSummary,
  hasVisualSource,
  resolveVisualForRender,
  summarizeResolvedVisualForModel,
  type PresentVisualInput,
  type VisualPayload,
  type VisualResolvedOutput,
} from './visuals.js';

describe('visuals shared contract', () => {
  it('validates all 6 opinionated block types inline', () => {
    const input: PresentVisualInput = {
      title: 'Q1 Growth Review',
      subtitle: 'Jan–Mar 2026',
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
            { label: 'Churn', value: '2.1%', delta: '-0.4%', trend: 'down' },
          ],
        },
        {
          kind: 'chart',
          chartType: 'bar',
          title: 'Revenue vs Cost',
          unit: '$k',
          x: ['Jan', 'Feb', 'Mar'],
          series: [
            { name: 'Revenue', y: [120, 140, 160] },
            { name: 'Cost', y: [80, 84, 90] },
          ],
        },
        {
          kind: 'table',
          title: 'Top Channels',
          cols: ['Channel', 'Signups', 'Active'],
          rows: [
            ['Organic', 420, true],
            ['Referral', 210, true],
          ],
          align: ['l', 'r', 'c'],
        },
        {
          kind: 'comparison',
          title: 'Hosting Options',
          options: [
            {
              name: 'Option A',
              badge: 'Best fit',
              highlight: true,
              pros: ['Fast'],
              cons: ['Pricey'],
            },
            { name: 'Option B', summary: 'Budget choice', pros: ['Cheap'], cons: ['Slower'] },
          ],
          criteria: [{ label: 'SOC2', values: [true, false] }],
        },
        {
          kind: 'timeline',
          title: 'Milestones',
          items: [
            { date: 'Jan 15', title: 'Beta', status: 'done' },
            { date: 'Mar 01', title: 'GA', detail: 'Public release', status: 'active' },
          ],
        },
        {
          kind: 'callout',
          tone: 'success',
          title: 'Key Takeaway',
          body: 'Organic acquisition drove 66% of net new ARR.',
          points: ['CAC fell 14%', 'Payback is now 5 months'],
        },
      ],
    };

    expect(PresentVisualInputSchema.safeParse(input).success).toBe(true);
    expect(hasVisualSource(input)).toBe(false);

    const resolved = resolveVisualForRender(input, VISUAL_INLINE_ACK);
    expect(resolved).not.toBeNull();
    expect(resolved?.blocks).toHaveLength(6);
  });

  it('rejects mismatched series lengths, row widths, and incomplete chart sources', () => {
    expect(
      PresentVisualInputSchema.safeParse({
        blocks: [
          {
            kind: 'chart',
            chartType: 'line',
            x: ['Q1', 'Q2'],
            series: [{ name: 'Rev', y: [10] }],
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      PresentVisualInputSchema.safeParse({
        blocks: [
          {
            kind: 'chart',
            chartType: 'bar',
            source: { file: 'data.csv', x: 'month' },
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      PresentVisualInputSchema.safeParse({
        blocks: [
          {
            kind: 'table',
            cols: ['A', 'B'],
            rows: [['only-one']],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects at input time every field the renderer would reject', () => {
    const chart = (extra: Record<string, unknown>) => ({
      blocks: [
        { kind: 'chart', chartType: 'bar', x: ['a'], series: [{ name: 's', y: [1] }], ...extra },
      ],
    });
    const rejected = [
      chart({ x: ['x'.repeat(81)] }),
      chart({ title: '' }),
      chart({ title: 't'.repeat(121) }),
      chart({ unit: 'requests per second (p95)' }),
      { blocks: [{ kind: 'table', title: 't'.repeat(121), cols: ['a'], rows: [[1]] }] },
      { blocks: [{ kind: 'table', cols: ['c'.repeat(81)], rows: [[1]] }] },
    ];
    for (const input of rejected) {
      expect(PresentVisualInputSchema.safeParse(input).success).toBe(false);
    }
    // At the limits, what the tool accepts is exactly what renders.
    const atLimit = chart({ x: ['x'.repeat(80)], title: 't'.repeat(120), unit: 'u'.repeat(20) });
    expect(PresentVisualInputSchema.safeParse(atLimit).success).toBe(true);
    expect(resolveVisualForRender(atLimit)).not.toBeNull();
  });

  it('rejects donuts that would silently drop data and oversized horizontal bar charts', () => {
    const chart = (block: Record<string, unknown>) => ({
      blocks: [{ kind: 'chart', ...block }],
    });
    const invalid = [
      chart({
        chartType: 'donut',
        x: ['a', 'b'],
        series: [
          { name: 'Plan', y: [1, 2] },
          { name: 'Actual', y: [1, 2] },
        ],
      }),
      chart({ chartType: 'donut', x: ['a', 'b'], series: [{ name: 's', y: [3, -1] }] }),
      chart({ chartType: 'donut', source: { file: 'd.csv', x: 'k', y: ['a', 'b'] } }),
      chart({
        chartType: 'hbar',
        x: Array.from({ length: 31 }, (_, i) => `c${i}`),
        series: [{ name: 's', y: Array.from({ length: 31 }, () => 1) }],
      }),
    ];
    for (const input of invalid) {
      expect(PresentVisualInputSchema.safeParse(input).success).toBe(false);
    }
    expect(
      PresentVisualInputSchema.safeParse(
        chart({
          chartType: 'hbar',
          x: Array.from({ length: 30 }, (_, i) => `c${i}`),
          series: [{ name: 's', y: Array.from({ length: 30 }, () => 1) }],
        }),
      ).success,
    ).toBe(true);
  });

  it('merges file-backed resolved outputs with inline blocks', () => {
    const input: PresentVisualInput = {
      title: 'Sales Report',
      blocks: [
        { kind: 'metrics', items: [{ label: 'Total', value: '$50k' }] },
        {
          kind: 'chart',
          chartType: 'area',
          title: 'Monthly Trend',
          source: { file: 'sales.csv', x: 'month', y: ['rev'] },
        },
      ],
    };
    expect(hasVisualSource(input)).toBe(true);
    expect(resolveVisualForRender(input, undefined)).toBeNull();

    const output: VisualResolvedOutput = {
      version: 1,
      resolved: {
        '1': {
          kind: 'chart',
          chartType: 'area',
          title: 'Monthly Trend',
          x: ['Jan', 'Feb'],
          series: [{ name: 'rev', y: [20, 30] }],
        },
      },
      sources: ['sales.csv'],
      notes: ['Showing first 2 of 10 rows from sales.csv.'],
    };

    const resolved = resolveVisualForRender(input, JSON.stringify(output));
    expect(resolved).not.toBeNull();
    expect(resolved?.sources).toEqual(['sales.csv']);
    expect(resolved?.notes).toEqual(['Showing first 2 of 10 rows from sales.csv.']);
    expect(resolved?.blocks[1]?.kind).toBe('chart');

    const modelSummary = summarizeResolvedVisualForModel(output);
    expect(modelSummary).toContain(VISUAL_INLINE_ACK);
    expect(modelSummary).toContain('min 20');
    expect(modelSummary).toContain('max 30');
    expect(modelSummary).toContain('total 50');
  });

  it('formats a readable mobile summary for Telegram across block types', () => {
    const payload: VisualPayload = {
      version: 1,
      title: 'Weekly Pulse',
      blocks: [
        {
          kind: 'metrics',
          items: [{ label: 'Signups', value: 1240, delta: '+9%', trend: 'up' }],
        },
        {
          kind: 'chart',
          chartType: 'bar',
          title: 'Daily',
          unit: '$',
          x: ['Mon', 'Tue'],
          series: [{ name: 'Rev', y: [400, 550] }],
        },
        {
          kind: 'table',
          cols: ['Plan', 'Users', 'MRR', 'Churn'],
          rows: [['Pro', 120, 4800, '1.2%']],
        },
        {
          kind: 'callout',
          tone: 'warning',
          title: 'Watchlist',
          body: 'Trial conversions dipped Tuesday.',
        },
      ],
    };

    const summary = formatVisualSummary(payload);
    expect(summary).toContain('── Weekly Pulse ──');
    expect(summary).toContain('• Signups: 1,240 (+9% ↑)');
    expect(summary).toContain('• Mon: $400');
    expect(summary).toContain('• Pro — Users: 120, MRR: 4,800, Churn: 1.2%');
    expect(summary).toContain('[WARNING] Watchlist');
  });
});
