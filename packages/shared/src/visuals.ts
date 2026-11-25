import { z } from 'zod';

/** Shared bounds for `present_visual` inputs and server-resolved file blocks. */
export const VISUAL_MAX_BLOCKS = 6;
export const VISUAL_MAX_CHART_POINTS = 120;
/** One row per category, so a horizontal bar chart grows downward with every point. */
export const VISUAL_MAX_HBAR_POINTS = 30;
export const VISUAL_MAX_SERIES = 6;
export const VISUAL_MAX_TABLE_ROWS = 100;
export const VISUAL_MAX_TABLE_COLS = 12;
export const VISUAL_MAX_NOTE_CHARS = 240;
export const VISUAL_INLINE_ACK = 'Visual shown in chat.';

// One set of field bounds for both the model's input and the rendered payload:
// an input the tool accepts must never be one the renderer then rejects, or the
// model is told the visual was shown while the user sees an error.
const BlockTitleSchema = z.string().min(1).max(120);
const UnitSchema = z.string().min(1).max(20);
const LabelSchema = z.string().min(1).max(80);

const VisualCellSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
export type VisualCell = z.infer<typeof VisualCellSchema>;

const VisualAlignSchema = z.enum(['l', 'c', 'r']);
export type VisualAlign = z.infer<typeof VisualAlignSchema>;

const VisualChartTypeSchema = z.enum(['bar', 'hbar', 'line', 'area', 'donut']);
export type VisualChartType = z.infer<typeof VisualChartTypeSchema>;

const VisualTrendSchema = z.enum(['up', 'down', 'neutral']);
export type VisualTrend = z.infer<typeof VisualTrendSchema>;

const VisualToneSchema = z.enum(['info', 'success', 'warning', 'danger']);
export type VisualTone = z.infer<typeof VisualToneSchema>;

const VisualTimelineStatusSchema = z.enum(['done', 'active', 'upcoming', 'blocked']);
export type VisualTimelineStatus = z.infer<typeof VisualTimelineStatusSchema>;

/** Workspace CSV/TSV or JSON array reference resolved server-side by `present_visual`. */
export const VisualSourceSchema = z
  .object({
    file: z.string().min(1).max(240),
    x: z.string().min(1).optional(),
    y: z.array(z.string().min(1)).min(1).max(VISUAL_MAX_SERIES).optional(),
    cols: z.array(z.string().min(1)).min(1).max(VISUAL_MAX_TABLE_COLS).optional(),
    limit: z.number().int().min(1).max(VISUAL_MAX_CHART_POINTS).optional(),
  })
  .strict();
export type VisualSource = z.infer<typeof VisualSourceSchema>;

const VisualMetricItemSchema = z
  .object({
    label: z.string().min(1),
    value: z.union([z.string().min(1), z.number().finite()]),
    delta: z.string().optional(),
    trend: VisualTrendSchema.optional(),
    note: z.string().optional(),
    sparkline: z.array(z.number().finite()).min(2).max(24).optional(),
  })
  .strict();
export type VisualMetricItem = z.infer<typeof VisualMetricItemSchema>;

const VisualMetricsBlockSchema = z
  .object({
    kind: z.literal('metrics'),
    title: z.string().optional(),
    items: z.array(VisualMetricItemSchema).min(1).max(6),
  })
  .strict();
export type VisualMetricsBlock = z.infer<typeof VisualMetricsBlockSchema>;

const VisualChartSeriesSchema = z
  .object({
    name: z.string().min(1),
    y: z.array(z.number().finite().nullable()).min(1).max(VISUAL_MAX_CHART_POINTS),
  })
  .strict();
export type VisualChartSeries = z.infer<typeof VisualChartSeriesSchema>;

/**
 * Shape rules every chart must meet, checked on the model's input and again on
 * the resolved payload. A donut shows one series as shares of a whole, so a
 * second series or a negative share would be dropped without a word.
 */
function checkChartShape(
  block: {
    readonly chartType: VisualChartType;
    readonly x?: readonly string[] | undefined;
    readonly series?: readonly { readonly y: readonly (number | null)[] }[] | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (
    block.chartType === 'hbar' &&
    block.x !== undefined &&
    block.x.length > VISUAL_MAX_HBAR_POINTS
  ) {
    ctx.addIssue({
      code: 'custom',
      message: `A horizontal bar chart shows at most ${VISUAL_MAX_HBAR_POINTS} categories; use a vertical bar or line chart, or aggregate first.`,
      path: ['x'],
    });
  }
  if (block.chartType !== 'donut' || block.series === undefined) return;
  if (block.series.length !== 1) {
    ctx.addIssue({
      code: 'custom',
      message: 'A donut chart takes exactly one series; use a bar chart to compare several.',
      path: ['series'],
    });
  }
  if (block.series.some((series) => series.y.some((value) => value !== null && value < 0))) {
    ctx.addIssue({
      code: 'custom',
      message: 'A donut chart cannot show negative values; use a bar chart instead.',
      path: ['series'],
    });
  }
}

const VisualChartBlockInputSchema = z
  .object({
    kind: z.literal('chart'),
    chartType: VisualChartTypeSchema,
    title: BlockTitleSchema.optional(),
    unit: UnitSchema.optional(),
    stacked: z.boolean().optional(),
    x: z.array(LabelSchema).min(1).max(VISUAL_MAX_CHART_POINTS).optional(),
    series: z.array(VisualChartSeriesSchema).min(1).max(VISUAL_MAX_SERIES).optional(),
    source: VisualSourceSchema.optional(),
  })
  .strict()
  .superRefine((block, ctx) => {
    checkChartShape(block, ctx);
    if (block.source !== undefined) {
      if (block.source.x === undefined || block.source.y === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'Chart source requires both x and y column names.',
          path: ['source'],
        });
      } else if (block.chartType === 'donut' && block.source.y.length !== 1) {
        ctx.addIssue({
          code: 'custom',
          message: 'A donut chart takes exactly one y column; use a bar chart to compare several.',
          path: ['source', 'y'],
        });
      }
      return;
    }
    if (block.x === undefined || block.series === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'Chart requires inline x and series, or a source file.',
      });
      return;
    }
    for (let i = 0; i < block.series.length; i += 1) {
      const series = block.series[i];
      if (series !== undefined && series.y.length !== block.x.length) {
        ctx.addIssue({
          code: 'custom',
          message: `Series "${series.name}" length (${series.y.length}) must match x length (${block.x.length}).`,
          path: ['series', i, 'y'],
        });
      }
    }
  });
export type VisualChartBlockInput = z.infer<typeof VisualChartBlockInputSchema>;

const VisualChartBlockResolvedSchema = z
  .object({
    kind: z.literal('chart'),
    chartType: VisualChartTypeSchema,
    title: BlockTitleSchema.optional(),
    unit: UnitSchema.optional(),
    stacked: z.boolean().optional(),
    x: z.array(LabelSchema).min(1).max(VISUAL_MAX_CHART_POINTS),
    series: z.array(VisualChartSeriesSchema).min(1).max(VISUAL_MAX_SERIES),
  })
  .strict()
  .superRefine((block, ctx) => {
    checkChartShape(block, ctx);
    for (let i = 0; i < block.series.length; i += 1) {
      const series = block.series[i];
      if (series !== undefined && series.y.length !== block.x.length) {
        ctx.addIssue({
          code: 'custom',
          message: `Series "${series.name}" length (${series.y.length}) must match x length (${block.x.length}).`,
          path: ['series', i, 'y'],
        });
      }
    }
  });
export type VisualChartBlock = z.infer<typeof VisualChartBlockResolvedSchema>;

const VisualTableBlockInputSchema = z
  .object({
    kind: z.literal('table'),
    title: BlockTitleSchema.optional(),
    cols: z.array(LabelSchema).min(1).max(VISUAL_MAX_TABLE_COLS).optional(),
    rows: z
      .array(z.array(VisualCellSchema).max(VISUAL_MAX_TABLE_COLS))
      .max(VISUAL_MAX_TABLE_ROWS)
      .optional(),
    align: z.array(VisualAlignSchema).max(VISUAL_MAX_TABLE_COLS).optional(),
    source: VisualSourceSchema.optional(),
  })
  .strict()
  .superRefine((block, ctx) => {
    if (block.source !== undefined) return;
    if (block.cols === undefined || block.rows === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'Table requires inline cols and rows, or a source file.',
      });
      return;
    }
    for (let i = 0; i < block.rows.length; i += 1) {
      const row = block.rows[i];
      if (row !== undefined && row.length !== block.cols.length) {
        ctx.addIssue({
          code: 'custom',
          message: `Row ${i} has ${row.length} cells; expected ${block.cols.length}.`,
          path: ['rows', i],
        });
      }
    }
  });
export type VisualTableBlockInput = z.infer<typeof VisualTableBlockInputSchema>;

const VisualTableBlockResolvedSchema = z
  .object({
    kind: z.literal('table'),
    title: BlockTitleSchema.optional(),
    cols: z.array(LabelSchema).min(1).max(VISUAL_MAX_TABLE_COLS),
    rows: z.array(z.array(VisualCellSchema).max(VISUAL_MAX_TABLE_COLS)).max(VISUAL_MAX_TABLE_ROWS),
    align: z.array(VisualAlignSchema).max(VISUAL_MAX_TABLE_COLS).optional(),
  })
  .strict()
  .superRefine((block, ctx) => {
    for (let i = 0; i < block.rows.length; i += 1) {
      const row = block.rows[i];
      if (row !== undefined && row.length !== block.cols.length) {
        ctx.addIssue({
          code: 'custom',
          message: `Row ${i} has ${row.length} cells; expected ${block.cols.length}.`,
          path: ['rows', i],
        });
      }
    }
  });
export type VisualTableBlock = z.infer<typeof VisualTableBlockResolvedSchema>;

const VisualComparisonOptionSchema = z
  .object({
    name: z.string().min(1),
    badge: z.string().optional(),
    highlight: z.boolean().optional(),
    summary: z.string().optional(),
    pros: z.array(z.string().min(1)).max(6).optional(),
    cons: z.array(z.string().min(1)).max(6).optional(),
  })
  .strict();
export type VisualComparisonOption = z.infer<typeof VisualComparisonOptionSchema>;

const VisualComparisonCriterionSchema = z
  .object({
    label: z.string().min(1),
    values: z.array(VisualCellSchema).min(2).max(4),
  })
  .strict();
export type VisualComparisonCriterion = z.infer<typeof VisualComparisonCriterionSchema>;

const VisualComparisonBlockSchema = z
  .object({
    kind: z.literal('comparison'),
    title: z.string().optional(),
    options: z.array(VisualComparisonOptionSchema).min(2).max(4),
    criteria: z.array(VisualComparisonCriterionSchema).max(12).optional(),
  })
  .strict()
  .superRefine((block, ctx) => {
    if (block.criteria === undefined) return;
    for (let i = 0; i < block.criteria.length; i += 1) {
      const criterion = block.criteria[i];
      if (criterion !== undefined && criterion.values.length !== block.options.length) {
        ctx.addIssue({
          code: 'custom',
          message: `Criterion "${criterion.label}" has ${criterion.values.length} values; expected ${block.options.length}.`,
          path: ['criteria', i, 'values'],
        });
      }
    }
  });
export type VisualComparisonBlock = z.infer<typeof VisualComparisonBlockSchema>;

const VisualTimelineItemSchema = z
  .object({
    date: z.string().min(1),
    title: z.string().min(1),
    detail: z.string().optional(),
    status: VisualTimelineStatusSchema.optional(),
  })
  .strict();
export type VisualTimelineItem = z.infer<typeof VisualTimelineItemSchema>;

const VisualTimelineBlockSchema = z
  .object({
    kind: z.literal('timeline'),
    title: z.string().optional(),
    items: z.array(VisualTimelineItemSchema).min(1).max(16),
  })
  .strict();
export type VisualTimelineBlock = z.infer<typeof VisualTimelineBlockSchema>;

const VisualCalloutBlockSchema = z
  .object({
    kind: z.literal('callout'),
    tone: VisualToneSchema,
    title: z.string().min(1),
    body: z.string().min(1),
    points: z.array(z.string().min(1)).max(6).optional(),
  })
  .strict();
export type VisualCalloutBlock = z.infer<typeof VisualCalloutBlockSchema>;

export const VisualBlockInputSchema = z.discriminatedUnion('kind', [
  VisualMetricsBlockSchema,
  VisualChartBlockInputSchema,
  VisualTableBlockInputSchema,
  VisualComparisonBlockSchema,
  VisualTimelineBlockSchema,
  VisualCalloutBlockSchema,
]);
export type VisualBlockInput = z.infer<typeof VisualBlockInputSchema>;

const VisualBlockResolvedSchema = z.discriminatedUnion('kind', [
  VisualMetricsBlockSchema,
  VisualChartBlockResolvedSchema,
  VisualTableBlockResolvedSchema,
  VisualComparisonBlockSchema,
  VisualTimelineBlockSchema,
  VisualCalloutBlockSchema,
]);
export type VisualBlock = z.infer<typeof VisualBlockResolvedSchema>;

const VisualSourceResolvedBlockSchema = z.discriminatedUnion('kind', [
  VisualChartBlockResolvedSchema,
  VisualTableBlockResolvedSchema,
]);
export type VisualSourceResolvedBlock = z.infer<typeof VisualSourceResolvedBlockSchema>;

export const PresentVisualInputSchema = z
  .object({
    title: z.string().min(1).max(160).optional(),
    subtitle: z.string().min(1).max(300).optional(),
    blocks: z.array(VisualBlockInputSchema).min(1).max(VISUAL_MAX_BLOCKS),
  })
  .strict();
export type PresentVisualInput = z.infer<typeof PresentVisualInputSchema>;

/** Tool result stored only when at least one block used a workspace `source` file. */
export const VisualResolvedOutputSchema = z
  .object({
    version: z.literal(1),
    resolved: z.record(z.string(), VisualSourceResolvedBlockSchema),
    sources: z.array(z.string().min(1).max(240)).min(1).max(VISUAL_MAX_BLOCKS),
    notes: z.array(z.string().min(1).max(VISUAL_MAX_NOTE_CHARS)).max(VISUAL_MAX_BLOCKS).optional(),
  })
  .strict();
export type VisualResolvedOutput = z.infer<typeof VisualResolvedOutputSchema>;

/** Canonical visual structure consumed identically by Desktop and Telegram renderers. */
export const VisualPayloadSchema = z
  .object({
    version: z.literal(1),
    title: z.string().min(1).max(160).optional(),
    subtitle: z.string().min(1).max(300).optional(),
    blocks: z.array(VisualBlockResolvedSchema).min(1).max(VISUAL_MAX_BLOCKS),
    sources: z.array(z.string().min(1).max(240)).max(VISUAL_MAX_BLOCKS).optional(),
    notes: z.array(z.string().min(1).max(VISUAL_MAX_NOTE_CHARS)).max(VISUAL_MAX_BLOCKS).optional(),
  })
  .strict();
export type VisualPayload = z.infer<typeof VisualPayloadSchema>;

/** True when any block in the tool input references a workspace file. */
export function hasVisualSource(input: PresentVisualInput): boolean {
  return input.blocks.some(
    (block) => (block.kind === 'chart' || block.kind === 'table') && block.source !== undefined,
  );
}

function parseJsonIfString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/**
 * Merge a `present_visual` tool call's arguments with any server-resolved `source`
 * snapshot from its tool result. Returns `null` when the input is invalid or a
 * file-backed block has no valid resolved output.
 */
export function resolveVisualForRender(input: unknown, output?: unknown): VisualPayload | null {
  const parsedInput = PresentVisualInputSchema.safeParse(input);
  if (!parsedInput.success) return null;

  const data = parsedInput.data;
  const needsResolved = hasVisualSource(data);
  let resolvedOutput: VisualResolvedOutput | undefined;
  if (needsResolved) {
    const parsedOutput = VisualResolvedOutputSchema.safeParse(parseJsonIfString(output));
    if (!parsedOutput.success) return null;
    resolvedOutput = parsedOutput.data;
  }

  const blocks: VisualBlock[] = [];
  for (let i = 0; i < data.blocks.length; i += 1) {
    const block = data.blocks[i];
    if (block === undefined) continue;
    if (block.kind === 'chart') {
      if (block.source !== undefined) {
        const resolved = resolvedOutput?.resolved[String(i)];
        if (resolved === undefined || resolved.kind !== 'chart') return null;
        blocks.push(resolved);
      } else if (block.x !== undefined && block.series !== undefined) {
        blocks.push({
          kind: 'chart',
          chartType: block.chartType,
          ...(block.title !== undefined && { title: block.title }),
          ...(block.unit !== undefined && { unit: block.unit }),
          ...(block.stacked !== undefined && { stacked: block.stacked }),
          x: block.x,
          series: block.series,
        });
      } else {
        return null;
      }
      continue;
    }
    if (block.kind === 'table') {
      if (block.source !== undefined) {
        const resolved = resolvedOutput?.resolved[String(i)];
        if (resolved === undefined || resolved.kind !== 'table') return null;
        blocks.push(resolved);
      } else if (block.cols !== undefined && block.rows !== undefined) {
        blocks.push({
          kind: 'table',
          ...(block.title !== undefined && { title: block.title }),
          cols: block.cols,
          rows: block.rows,
          ...(block.align !== undefined && { align: block.align }),
        });
      } else {
        return null;
      }
      continue;
    }
    blocks.push(block);
  }

  const payload: VisualPayload = {
    version: 1,
    ...(data.title !== undefined && { title: data.title }),
    ...(data.subtitle !== undefined && { subtitle: data.subtitle }),
    blocks,
    ...(resolvedOutput !== undefined && { sources: resolvedOutput.sources }),
    ...(resolvedOutput?.notes !== undefined &&
      resolvedOutput.notes.length > 0 && { notes: resolvedOutput.notes }),
  };
  const checked = VisualPayloadSchema.safeParse(payload);
  return checked.success ? checked.data : null;
}

function formatNumber(value: number): string {
  return Number.isInteger(value)
    ? value.toLocaleString('en-US')
    : Number(value.toFixed(2)).toLocaleString('en-US');
}

function formatUnitValue(value: number | null, unit?: string): string {
  if (value === null) return '—';
  const text = formatNumber(value);
  if (unit === undefined || unit === '') return text;
  if (/^[$€£¥]/.test(unit)) return `${unit}${text}`;
  if (unit === '%') return `${text}%`;
  return `${text} ${unit}`;
}

function formatCell(cell: VisualCell | undefined): string {
  if (cell === undefined || cell === null) return '—';
  if (typeof cell === 'boolean') return cell ? 'Yes' : 'No';
  if (typeof cell === 'number') return formatNumber(cell);
  return cell;
}

function trendArrow(trend?: VisualTrend): string {
  if (trend === 'up') return ' ↑';
  if (trend === 'down') return ' ↓';
  return '';
}

function statusTag(status?: VisualTimelineStatus): string {
  switch (status) {
    case 'done':
      return '[done] ';
    case 'active':
      return '[active] ';
    case 'blocked':
      return '[blocked] ';
    case 'upcoming':
      return '[upcoming] ';
    default:
      return '';
  }
}

/**
 * Render a resolved visual into a clean, mobile-friendly plain-text summary
 * for Telegram and other non-desktop surfaces.
 */
export function formatVisualSummary(payload: VisualPayload): string {
  const sections: string[] = [];

  if (payload.title !== undefined || payload.subtitle !== undefined) {
    const headerLines: string[] = [];
    if (payload.title !== undefined) headerLines.push(`── ${payload.title} ──`);
    if (payload.subtitle !== undefined) headerLines.push(payload.subtitle);
    sections.push(headerLines.join('\n'));
  }

  for (const block of payload.blocks) {
    switch (block.kind) {
      case 'metrics': {
        const lines: string[] = [];
        if (block.title !== undefined) lines.push(block.title);
        for (const item of block.items) {
          const val = typeof item.value === 'number' ? formatNumber(item.value) : item.value;
          const delta = item.delta !== undefined ? ` (${item.delta}${trendArrow(item.trend)})` : '';
          const note = item.note !== undefined ? ` — ${item.note}` : '';
          lines.push(`• ${item.label}: ${val}${delta}${note}`);
        }
        sections.push(lines.join('\n'));
        break;
      }
      case 'chart': {
        const lines: string[] = [];
        const unitSuffix = block.unit !== undefined ? ` (${block.unit})` : '';
        if (block.title !== undefined) lines.push(`${block.title}${unitSuffix}`);
        const maxRows = 20;
        const shownCount = Math.min(block.x.length, maxRows);
        for (let i = 0; i < shownCount; i += 1) {
          const label = block.x[i] ?? '';
          if (block.series.length === 1) {
            const first = block.series[0];
            lines.push(`• ${label}: ${formatUnitValue(first?.y[i] ?? null, block.unit)}`);
          } else {
            const values = block.series
              .map((s) => `${s.name} ${formatUnitValue(s.y[i] ?? null, block.unit)}`)
              .join(' | ');
            lines.push(`• ${label}: ${values}`);
          }
        }
        if (block.x.length > maxRows) {
          lines.push(`… (+${block.x.length - maxRows} more points in Crewaid)`);
        }
        sections.push(lines.join('\n'));
        break;
      }
      case 'table': {
        const lines: string[] = [];
        if (block.title !== undefined) lines.push(block.title);
        const maxRows = 20;
        const shownRows = block.rows.slice(0, maxRows);
        if (block.cols.length <= 3) {
          lines.push(block.cols.join(' | '));
          for (const row of shownRows) {
            lines.push(row.map((cell) => formatCell(cell)).join(' | '));
          }
        } else {
          for (const row of shownRows) {
            const lead = formatCell(row[0]);
            const rest = block.cols
              .slice(1)
              .map((col, idx) => `${col}: ${formatCell(row[idx + 1])}`)
              .join(', ');
            lines.push(`• ${lead}${rest === '' ? '' : ` — ${rest}`}`);
          }
        }
        if (block.rows.length > maxRows) {
          lines.push(`… (+${block.rows.length - maxRows} more rows in Crewaid)`);
        }
        sections.push(lines.join('\n'));
        break;
      }
      case 'comparison': {
        const lines: string[] = [];
        if (block.title !== undefined) lines.push(block.title);
        for (const option of block.options) {
          const badge = option.badge !== undefined ? ` [${option.badge}]` : '';
          const rec =
            option.highlight === true && option.badge === undefined ? ' [Recommended]' : '';
          const summary = option.summary !== undefined ? ` — ${option.summary}` : '';
          lines.push(`• ${option.name}${badge}${rec}${summary}`);
          if (option.pros !== undefined && option.pros.length > 0) {
            lines.push(`  + ${option.pros.join('; ')}`);
          }
          if (option.cons !== undefined && option.cons.length > 0) {
            lines.push(`  - ${option.cons.join('; ')}`);
          }
        }
        if (block.criteria !== undefined && block.criteria.length > 0) {
          for (const criterion of block.criteria) {
            const pairs = block.options
              .map((opt, idx) => `${opt.name}: ${formatCell(criterion.values[idx])}`)
              .join(' | ');
            lines.push(`  ${criterion.label} — ${pairs}`);
          }
        }
        sections.push(lines.join('\n'));
        break;
      }
      case 'timeline': {
        const lines: string[] = [];
        if (block.title !== undefined) lines.push(block.title);
        for (const item of block.items) {
          const detail = item.detail !== undefined ? ` — ${item.detail}` : '';
          lines.push(`• ${item.date}: ${statusTag(item.status)}${item.title}${detail}`);
        }
        sections.push(lines.join('\n'));
        break;
      }
      case 'callout': {
        const tag = block.tone.toUpperCase();
        const lines: string[] = [`[${tag}] ${block.title}`, block.body];
        if (block.points !== undefined) {
          for (const point of block.points) lines.push(`• ${point}`);
        }
        sections.push(lines.join('\n'));
        break;
      }
    }
  }

  if (payload.notes !== undefined && payload.notes.length > 0) {
    sections.push(payload.notes.join('\n'));
  }

  return sections.filter((section) => section !== '').join('\n\n');
}

/**
 * Concise model-facing confirmation for file-backed `present_visual` calls so
 * the bot can write an accurate takeaway without raw rows entering context.
 */
export function summarizeResolvedVisualForModel(output: VisualResolvedOutput): string {
  const parts: string[] = [VISUAL_INLINE_ACK];
  const entries = Object.entries(output.resolved);
  for (const [, block] of entries) {
    if (block.kind === 'chart') {
      const stats = block.series.map((series) => {
        const nums = series.y.filter((v): v is number => v !== null);
        if (nums.length === 0) return `${series.name}: no numeric values`;
        let min = nums[0]!;
        let max = nums[0]!;
        let sum = 0;
        for (const n of nums) {
          if (n < min) min = n;
          if (n > max) max = n;
          sum += n;
        }
        return `${series.name} (min ${formatNumber(min)}, max ${formatNumber(max)}, total ${formatNumber(sum)})`;
      });
      const label = block.title !== undefined ? `"${block.title}" ` : '';
      parts.push(
        `Resolved ${block.chartType} chart ${label}with ${block.x.length} points: ${stats.join('; ')}.`,
      );
    } else {
      const label = block.title !== undefined ? `"${block.title}" ` : '';
      parts.push(
        `Resolved table ${label}with ${block.rows.length} rows and ${block.cols.length} columns (${block.cols.join(', ')}).`,
      );
    }
  }
  if (output.notes !== undefined && output.notes.length > 0) {
    parts.push(output.notes.join(' '));
  }
  return parts.join(' ');
}
