import type { ComponentType, ReactNode } from 'react';
import { projectPublicSpeech, stripModelControlTags, type ToolInfo } from '@crewaid/shared';
import { StreamingMarkdown } from './markdown/StreamingMarkdown';
import type { MentionBot } from './composer/botMention';
import type { CodingTaskProgress } from '../chat/codingProgress';
import type { HandoffActions } from './visuals/HandoffBlock';

/**
 * Part-renderer registry.
 *
 * Adding a new message part type should register a renderer here from its own
 * feature folder rather than editing the transcript component. Unknown types
 * render the fallback renderer without throwing or blanking the transcript.
 */

/** The part shapes the shell knows about. Grows via registration, not edits. */
export interface TextPart {
  type: 'text';
  text: string;
  /**
   * Written by a person, not a model. The public-speech projection exists to
   * hide what a MODEL leaks (reasoning tags, tool markup, runaway loops); run
   * over a person's own words it would blank a pasted log or cut an XML
   * snippet, so their text only loses harness control tags.
   */
  verbatim?: true;
}

/** The text a part shows and copies: a person's words as written, a bot's through the speech projection. */
export function speechOf(part: { readonly text: string; readonly verbatim?: unknown }): string {
  return part.verbatim === true ? stripModelControlTags(part.text) : projectPublicSpeech(part.text);
}

/** Verbatim-unfriendly parts still arrive; the fallback renders them safely. */
export interface UnknownPart {
  type: string;
  [key: string]: unknown;
}

export type AnyPart = TextPart | UnknownPart;

/**
 * Renders markdown text parts for both settled history and in-flight streams
 * through the same sanitized rendering path.
 */
function TextPartRenderer({
  part,
  context,
}: {
  part: AnyPart;
  context?: PartRenderContext | undefined;
}): ReactNode {
  if (typeof part.text !== 'string') return null;
  const cleaned = speechOf({ text: part.text, verbatim: part['verbatim'] });
  if (cleaned === '') return null;
  return (
    <StreamingMarkdown
      source={cleaned}
      streaming={context?.streaming === true}
      {...(context?.mentionBots === undefined ? {} : { mentionBots: context.mentionBots })}
      {...(context?.onBotMention === undefined ? {} : { onBotMention: context.onBotMention })}
    />
  );
}

/**
 * SYSTEM events (author SYSTEM) render as tiny centered muted text, without a
 * bubble. Registered here so the transcript never special-cases by string-matching.
 */
function SystemEventPartRenderer(): ReactNode {
  return null; // layout handled by the transcript (centered row); text comes from the message content
}

function FallbackPartRenderer({ part }: { part: AnyPart }): ReactNode {
  // Must never throw on arbitrary shapes, and must never PRINT one either.
  // It used to render `[unsupported part type: <type>]`, which put an
  // internal vocabulary into the conversation: a reasoning model produced two
  // of them per step, so the operator's transcript read as broken while the
  // bot was working perfectly. The person using this app cannot act on a part
  // type — it names an SDK shape nobody outside this repo has heard of.
  // The part is still in the DOM as an empty marker, so a test can assert
  // that a type is unhandled and a developer can find it in the inspector.
  // That is where an unknown part belongs: in the tooling, not in the chat.
  return <span hidden data-unsupported-part={String(part.type)} />;
}

/**
 * Read a field off a part whose shape the reader does not own.
 *
 * Every part is a plain JSON object, but `AnyPart` is a union with `TextPart`,
 * which has no index signature — so `part[key]` does not type-check even
 * though it is exactly what the data supports. The narrowing is done once,
 * here beside the registry that defines the union, so no renderer repeats it
 * and every reader still has to prove the type of what it got back.
 */
export function partField(part: AnyPart, key: string): unknown {
  return (part as Record<string, unknown>)[key];
}

type PartRenderer = ComponentType<{
  part: AnyPart;
  context?: PartRenderContext | undefined;
}>;

/**
 * What a renderer may need beyond its part, threaded by the caller.
 *
 * Currently one entry: the user-facing LABEL of each tool, from the same
 * `GET /tools` directory the composer's palette reads. The transcript shows
 * `browser_read` as "Read the page" because the person reading it did not
 * write the tool registry — the internal name stays in the part, and in the
 * row's own details, where the tooling can still find it.
 *
 * Optional, and every renderer ignores what it does not use: a renderer that
 * HAD to care about this would make the registry's "adding a part type
 * touches nothing else" property false in the other direction.
 */
export interface PartRenderContext {
  readonly toolLabels?: ReadonlyMap<string, string>;
  readonly tools?: ReadonlyMap<string, ToolInfo>;
  readonly onViewComputer?: (() => void) | undefined;
  readonly pendingToolCalls?: ReadonlySet<string>;
  readonly codingProgress?: ReadonlyMap<string, CodingTaskProgress> | undefined;
  readonly mentionBots?: readonly MentionBot[];
  readonly onBotMention?: (botId: string) => void;
  readonly handoffActions?: HandoffActions | undefined;
  /**
   * The part belongs to the reply still being written. Only then is half-typed
   * Markdown repaired: in settled text an unclosed `[link](` is what was
   * written, and repairing it would hide everything after it.
   */
  readonly streaming?: boolean;
  readonly showWork?: boolean;
}

const registry = new Map<string, PartRenderer>();
const outputVisibility = new Map<string, (part: AnyPart) => boolean>();

export function registerPartRenderer(
  type: string,
  renderer: PartRenderer,
  visibleWithoutWork?: (part: AnyPart) => boolean,
): void {
  if (registry.has(type)) {
    throw new Error(`part renderer already registered for type "${type}"`);
  }
  registry.set(type, renderer);
  if (visibleWithoutWork !== undefined) outputVisibility.set(type, visibleWithoutWork);
}

/** Feature renderers distinguish user results from routine work without teaching the transcript their types. */
export function isPartOutput(part: AnyPart): boolean {
  return outputVisibility.get(part.type)?.(part) ?? false;
}

export function resolvePartRenderer(type: string): PartRenderer {
  return registry.get(type) ?? FallbackPartRenderer;
}

export function renderPart(part: AnyPart, context?: PartRenderContext): ReactNode {
  const Renderer = resolvePartRenderer(part.type);
  return <Renderer part={part} context={context} />;
}

/**
 * Pre-tool working prose emitted on intermediate tool-calling steps. Hidden
 * when "Show thinking and actions" is off; when enabled, shown quietly inside
 * the work log rather than as a permanent speech bubble.
 */
function WorkNotePartRenderer({
  part,
  context,
}: {
  part: AnyPart;
  context?: PartRenderContext | undefined;
}): ReactNode {
  if (typeof part.text !== 'string') return null;
  const cleaned = projectPublicSpeech(part.text);
  if (cleaned === '') return null;
  return (
    <div
      data-work-note
      className="my-0.5 max-w-[72%] border-s-2 border-separator ps-2.5 text-caption leading-[19px] text-muted"
    >
      <StreamingMarkdown
        source={cleaned}
        streaming={context?.streaming === true}
        {...(context?.mentionBots === undefined ? {} : { mentionBots: context.mentionBots })}
        {...(context?.onBotMention === undefined ? {} : { onBotMention: context.onBotMention })}
      />
    </div>
  );
}

registerPartRenderer('text', TextPartRenderer);
registerPartRenderer('work-note', WorkNotePartRenderer);
registerPartRenderer('system-event', SystemEventPartRenderer);
