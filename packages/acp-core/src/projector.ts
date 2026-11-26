import path from 'node:path';
import type { SessionUpdate, ToolCallContent } from '@agentclientprotocol/sdk';
import {
  boundSummary,
  formatDiffExcerpt,
  MAX_DIFF_EXCERPT_CHARS,
  MAX_TRANSCRIPT_EXCERPT_CHARS,
  relativizeReportedPath,
  sanitizeOneLine,
  truncateText,
} from './privacy.js';
import type {
  AcpCommandRecord,
  AcpProgressUpdate,
  AcpReportMode,
  AcpRunOutput,
  AcpSessionStatus,
} from './types.js';

interface TrackedToolCall {
  kind: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  locations: string[];
  emittedStep: boolean;
}

const MUTATING_TOOL_KINDS = new Set<string>(['edit', 'delete', 'move']);

export function mapToolKindToName(kind: string | undefined | null): string {
  switch (kind) {
    case 'read':
      return 'fs_read';
    case 'edit':
    case 'delete':
    case 'move':
      return 'fs_edit';
    case 'search':
      return 'fs_grep';
    case 'execute':
      return 'shell';
    default:
      return 'acp_tool';
  }
}

function mapCommandStatus(
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | null | undefined,
): AcpCommandRecord['status'] {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  return 'unknown';
}

/**
 * Stateful reducer converting raw ACP v1 `session/update` notifications into
 * sanitized Crewaid progress events and the final `AcpRunOutput`.
 *
 * In `summary` mode (default), raw file contents, diffs, and tool outputs are
 * discarded immediately and never retained.
 */
export class AcpSessionProjector {
  private readonly cwd: string;
  private readonly reportMode: AcpReportMode;
  private readonly messages = new Map<string, string>();
  private readonly messageOrder: string[] = [];
  private readonly toolCalls = new Map<string, TrackedToolCall>();
  private readonly filesChanged = new Set<string>();
  private readonly commandsRun = new Map<string, AcpCommandRecord>();
  private readonly transcriptParts: string[] = [];
  private transcriptChars = 0;
  private readonly diffParts: string[] = [];
  private diffChars = 0;
  private stepCount = 0;

  constructor(options: { readonly cwd: string; readonly reportMode: AcpReportMode }) {
    this.cwd = options.cwd;
    this.reportMode = options.reportMode;
  }

  get steps(): number {
    return this.stepCount;
  }

  get filesChangedCount(): number {
    return this.filesChanged.size;
  }

  apply(acpSessionId: string, update: SessionUpdate): AcpProgressUpdate | undefined {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        if (update.content.type !== 'text') return undefined;
        const chunk = update.content.text;
        const messageKey = update.messageId ?? '__default__';
        if (!this.messages.has(messageKey)) {
          this.messageOrder.push(messageKey);
          this.messages.set(messageKey, chunk);
        } else {
          this.messages.set(messageKey, `${this.messages.get(messageKey) ?? ''}${chunk}`);
        }
        this.appendTranscript(chunk);
        return undefined;
      }

      case 'tool_call': {
        const kind = update.kind ?? 'other';
        const title = sanitizeOneLine(update.title);
        const status = update.status ?? 'in_progress';
        const locations = (update.locations ?? [])
          .map((loc) => relativizeReportedPath(this.cwd, loc.path))
          .filter((loc) => loc !== '');

        const tracked: TrackedToolCall = {
          kind,
          title,
          status,
          locations,
          emittedStep: true,
        };
        this.toolCalls.set(update.toolCallId, tracked);
        this.recordToolSideEffects(update.toolCallId, tracked, update.content);
        this.stepCount += 1;
        return this.buildStepEvent(acpSessionId, tracked);
      }

      case 'tool_call_update': {
        const existing = this.toolCalls.get(update.toolCallId);
        const kind = update.kind ?? existing?.kind ?? 'other';
        const title =
          update.title !== undefined && update.title !== null
            ? sanitizeOneLine(update.title)
            : (existing?.title ?? '');
        const status = update.status ?? existing?.status ?? 'in_progress';
        const locations =
          update.locations !== undefined && update.locations !== null
            ? update.locations
                .map((loc) => relativizeReportedPath(this.cwd, loc.path))
                .filter((loc) => loc !== '')
            : (existing?.locations ?? []);

        const tracked: TrackedToolCall = {
          kind,
          title,
          status,
          locations,
          emittedStep: existing?.emittedStep ?? false,
        };
        this.toolCalls.set(update.toolCallId, tracked);
        this.recordToolSideEffects(update.toolCallId, tracked, update.content ?? undefined);

        if (!tracked.emittedStep) {
          tracked.emittedStep = true;
          this.stepCount += 1;
          return this.buildStepEvent(acpSessionId, tracked);
        }
        return undefined;
      }

      default:
        return undefined;
    }
  }

  finalize(input: {
    readonly status: AcpSessionStatus;
    readonly stopReason?: string | undefined;
    readonly acpSessionId: string | null;
    readonly agentName?: string | undefined;
    readonly durationMs: number;
    readonly error?: { readonly code: string; readonly message: string } | undefined;
  }): AcpRunOutput {
    const summary = this.buildSummary();
    const filesChanged = [...this.filesChanged].sort();
    const commandsRun = [...this.commandsRun.values()];
    const transcriptExcerpt =
      this.reportMode === 'full' && this.transcriptParts.length > 0
        ? truncateText(this.transcriptParts.join(''), MAX_TRANSCRIPT_EXCERPT_CHARS)
        : undefined;
    const diffExcerpt =
      this.reportMode === 'full' && this.diffParts.length > 0
        ? truncateText(this.diffParts.join('\n\n'), MAX_DIFF_EXCERPT_CHARS)
        : undefined;

    return {
      status: input.status,
      ...(input.stopReason === undefined ? {} : { stopReason: input.stopReason }),
      acpSessionId: input.acpSessionId,
      ...(input.agentName === undefined ? {} : { agentName: input.agentName }),
      reportMode: this.reportMode,
      summary,
      filesChanged,
      commandsRun,
      steps: this.stepCount,
      durationMs: Math.max(0, Math.round(input.durationMs)),
      ...(transcriptExcerpt === undefined ? {} : { transcriptExcerpt }),
      ...(diffExcerpt === undefined ? {} : { diffExcerpt }),
      ...(input.error === undefined ? {} : { error: input.error }),
    };
  }

  private recordToolSideEffects(
    toolCallId: string,
    tracked: TrackedToolCall,
    content: readonly ToolCallContent[] | undefined,
  ): void {
    if (MUTATING_TOOL_KINDS.has(tracked.kind)) {
      for (const loc of tracked.locations) {
        if (loc !== '' && loc !== '.') this.filesChanged.add(loc);
      }
    }
    if (tracked.kind === 'execute' && tracked.title !== '') {
      this.commandsRun.set(toolCallId, {
        command: tracked.title,
        status: mapCommandStatus(tracked.status),
      });
    }
    if (content === undefined) return;
    for (const item of content) {
      if (item.type === 'diff') {
        const rel = relativizeReportedPath(this.cwd, item.path);
        if (rel !== '' && rel !== '.') this.filesChanged.add(rel);
        const excerpt = formatDiffExcerpt(
          this.reportMode,
          this.cwd,
          item.path,
          item.oldText,
          item.newText,
        );
        if (excerpt !== undefined) {
          this.appendDiff(excerpt);
        }
      } else if (item.type === 'content' && this.reportMode === 'full') {
        if (item.content.type === 'text' && item.content.text.trim() !== '') {
          this.appendTranscript(
            `\n[tool:${tracked.title || tracked.kind}]\n${item.content.text}\n`,
          );
        }
      }
    }
  }

  private buildStepEvent(acpSessionId: string, tracked: TrackedToolCall): AcpProgressUpdate {
    const firstLoc = tracked.locations[0];
    const target =
      firstLoc !== undefined
        ? path.posix.basename(firstLoc)
        : tracked.title !== ''
          ? tracked.title
          : undefined;
    return {
      kind: 'step',
      acpSessionId,
      step: this.stepCount,
      toolKind: tracked.kind,
      toolName: mapToolKindToName(tracked.kind),
      title: tracked.title || tracked.kind,
      ...(target === undefined ? {} : { target }),
      ...(firstLoc === undefined ? {} : { file: firstLoc }),
      filesChangedCount: this.filesChanged.size,
    };
  }

  private buildSummary(): string {
    // Prefer the agent's last non-empty assistant message as its final account.
    for (let i = this.messageOrder.length - 1; i >= 0; i -= 1) {
      const key = this.messageOrder[i];
      if (key === undefined) continue;
      const text = (this.messages.get(key) ?? '').trim();
      if (text !== '') return boundSummary(this.reportMode, text);
    }
    return '';
  }

  private appendTranscript(text: string): void {
    if (this.reportMode !== 'full') return;
    if (this.transcriptChars >= MAX_TRANSCRIPT_EXCERPT_CHARS) return;
    const remaining = MAX_TRANSCRIPT_EXCERPT_CHARS - this.transcriptChars;
    const slice = text.slice(0, remaining);
    this.transcriptParts.push(slice);
    this.transcriptChars += slice.length;
  }

  private appendDiff(excerpt: string): void {
    if (this.reportMode !== 'full') return;
    if (this.diffChars >= MAX_DIFF_EXCERPT_CHARS) return;
    const remaining = MAX_DIFF_EXCERPT_CHARS - this.diffChars;
    const slice = excerpt.slice(0, remaining);
    this.diffParts.push(slice);
    this.diffChars += slice.length;
  }
}
