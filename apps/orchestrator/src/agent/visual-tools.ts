import type { ToolSandboxSession } from '@crewaid/sandbox-core';
import {
  NativeToolInputs,
  VISUAL_INLINE_ACK,
  VisualResolvedOutputSchema,
  hasVisualSource,
  summarizeResolvedVisualForModel,
  type PresentVisualInput,
  type VisualResolvedOutput,
  type VisualSourceResolvedBlock,
} from '@crewaid/shared';
import { tool } from './tool-contract.js';
import { OBSERVING_BUILTIN, type RegisteredTool, type ToolContext } from './tool-registry.js';
import {
  parseVisualDataset,
  readBoundedWorkspaceText,
  resolveChartFromDataset,
  resolveTableFromDataset,
  type ParsedDataset,
} from './visual-data.js';
import { resolveWorkspacePath } from './workspace-paths.js';

function displayFilename(resolvedPath: string): string {
  const base = resolvedPath.split('/').pop();
  return base !== undefined && base !== '' ? base : resolvedPath;
}

/**
 * Read-only visual presentation tool (`present_visual`).
 *
 * Inline-only calls never start a sandbox and return a 1-line acknowledgement
 * (matching `preview_email`), avoiding duplicate storage in `Message.parts`.
 * When a chart or table block references a workspace CSV/TSV/JSON `source`,
 * the file is size-checked and parsed server-side into a durable resolved
 * snapshot so the visual still renders after sandbox teardown.
 */
export function visualTools(): RegisteredTool[] {
  return [
    {
      name: 'present_visual',
      behavior: OBSERVING_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description:
            'Display an interactive visual card in chat (metrics, bar/hbar/line/area/donut charts, ' +
            'sortable tables, side-by-side comparisons, timelines, or callouts). Bundle related ' +
            'blocks into one call, use columnar arrays for inline data, or pass `source` to plot ' +
            'a workspace CSV/TSV or JSON array directly.',
          inputSchema: NativeToolInputs.present_visual,
          execute: async (input: PresentVisualInput): Promise<string | VisualResolvedOutput> => {
            if (!hasVisualSource(input)) {
              return VISUAL_INLINE_ACK;
            }

            let sessionPromise: Promise<ToolSandboxSession> | undefined;
            const getSession = () => {
              sessionPromise ??= context.session();
              return sessionPromise;
            };
            const datasetCache = new Map<
              string,
              { readonly dataset: ParsedDataset; readonly label: string }
            >();

            const loadDataset = async (
              requestedFile: string,
            ): Promise<
              | { readonly ok: true; readonly dataset: ParsedDataset; readonly label: string }
              | { readonly ok: false; readonly message: string }
            > => {
              const verdict = resolveWorkspacePath(
                context.botId,
                requestedFile,
                context.groupId ?? null,
              );
              if (!verdict.ok) {
                return { ok: false, message: `present_visual refused: ${verdict.reason}` };
              }
              const cached = datasetCache.get(verdict.path);
              if (cached !== undefined) return { ok: true, ...cached };

              let session: ToolSandboxSession;
              try {
                session = await getSession();
              } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                return { ok: false, message: `present_visual failed: ${detail}` };
              }

              const read = await readBoundedWorkspaceText(session, verdict.path);
              if (!read.ok) {
                return { ok: false, message: `present_visual refused: ${read.reason}` };
              }
              const label = displayFilename(verdict.path);
              const parsed = parseVisualDataset(read.text, label);
              if (!parsed.ok) {
                return { ok: false, message: `present_visual failed: ${parsed.reason}` };
              }
              const entry = { dataset: parsed.dataset, label };
              datasetCache.set(verdict.path, entry);
              return { ok: true, ...entry };
            };

            const resolved: Record<string, VisualSourceResolvedBlock> = {};
            const sources: string[] = [];
            const seenSources = new Set<string>();
            const notes: string[] = [];

            for (let i = 0; i < input.blocks.length; i += 1) {
              const block = input.blocks[i];
              if (block === undefined) continue;
              if (block.kind !== 'chart' && block.kind !== 'table') continue;
              if (block.source === undefined) continue;

              const loaded = await loadDataset(block.source.file);
              if (!loaded.ok) return loaded.message;

              if (!seenSources.has(loaded.label)) {
                seenSources.add(loaded.label);
                sources.push(loaded.label);
              }

              const built =
                block.kind === 'chart'
                  ? resolveChartFromDataset(block, loaded.dataset, loaded.label)
                  : resolveTableFromDataset(block, loaded.dataset, loaded.label);
              if (!built.ok) {
                return `present_visual failed: ${built.reason}`;
              }
              resolved[String(i)] = built.block;
              if (built.note !== undefined) notes.push(built.note);
            }

            const result: VisualResolvedOutput = {
              version: 1,
              resolved,
              sources,
              ...(notes.length > 0 && { notes }),
            };
            // A refusal the model can act on, not a thrown ZodError, so it can
            // shorten the offending field and retry like every other failure path.
            const checked = VisualResolvedOutputSchema.safeParse(result);
            if (!checked.success) {
              const issue = checked.error.issues[0];
              const where =
                issue !== undefined && issue.path.length > 0 ? ` at ${issue.path.join('.')}` : '';
              return `present_visual failed: the resolved visual is invalid${where} (${issue?.message ?? 'unknown error'}).`;
            }
            return checked.data;
          },
          toModelOutput: ({ output }: { output: string | VisualResolvedOutput }) => {
            if (typeof output === 'string') {
              return { type: 'text' as const, value: output };
            }
            const parsed = VisualResolvedOutputSchema.safeParse(output);
            if (!parsed.success) {
              return { type: 'text' as const, value: VISUAL_INLINE_ACK };
            }
            return {
              type: 'text' as const,
              value: summarizeResolvedVisualForModel(parsed.data),
            };
          },
        }),
    },
  ];
}
