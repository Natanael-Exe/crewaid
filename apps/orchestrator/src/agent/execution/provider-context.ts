import type { ChatMiddleware, ContentPart, ModelMessage, SystemPrompt } from '@tanstack/ai';
import type { AttachmentsService, ModelAttachment } from '../../attachments/attachments.service.js';
import type { BuiltTextAdapter } from '../../models/tanstack/text-adapter.js';
import { agentInstructionBlocks, agentInstructions } from '../agent-instructions.js';
import { interBotToUserContent, triggerToUserContent } from '../trigger-content.js';
import { projectToolHistory } from './tool-history-projection.js';
import type { ExecutionRequest } from './execution-backend.port.js';
import type { PrivacyVault } from './privacy-vault.js';

/** Provider envelopes change; the prompt text and memory-last prefix come from one builder. */
export function executionSystemPrompts(
  request: ExecutionRequest,
  kind: BuiltTextAdapter['kind'],
  vault?: PrivacyVault,
): SystemPrompt[] {
  const redact = (value: string): string => (vault === undefined ? value : vault.redactText(value));
  // after the persona and after memory, so a continuation changes
  // nothing above the cached prefix — a run that carries work on must not
  // cost the whole prompt its cache hit.
  const carryOn: SystemPrompt[] =
    request.continuation === undefined ? [] : [{ content: redact(request.continuation) }];
  if (kind !== 'anthropic') return [redact(agentInstructions(request.instructions)), ...carryOn];
  const { prefix, memory } = agentInstructionBlocks(request.instructions);
  return [
    { content: redact(prefix), metadata: { cache_control: { type: 'ephemeral' } } },
    ...(memory === null ? [] : [redact(memory)]),
    ...carryOn,
  ];
}

export type ClaimedAttachmentLoader = (
  request: ExecutionRequest,
  messageIds: readonly string[],
  vision: boolean,
) => Promise<ReadonlyMap<string, readonly ModelAttachment[]>>;

/** All reads remain message/bot/principal scoped through the existing attachment service. */
export function claimedAttachmentLoader(service: AttachmentsService): ClaimedAttachmentLoader {
  return async (request, ids, vision) =>
    new Map(
      await Promise.all(
        ids.map(
          async (id) =>
            [id, await service.forModel(request.model.userId, request.botId, id, vision)] as const,
        ),
      ),
    );
}

/**
 * who sent a `user` row, for the rows another bot sent.
 *
 * Resolved for the call rather than read off the row, because the sender's
 * NAME is what the model needs and a name changes: a stored attribution would
 * go stale, and a deleted sender would leave a raw id in the prompt. Keyed by
 * message id so the middleware can ask about the ids it has and cache the
 * answer for the rest of the run.
 */
export type TeammateNameLoader = (
  request: ExecutionRequest,
  messageIds: readonly string[],
) => Promise<ReadonlyMap<string, string>>;

function userContent(
  content: string,
  attachments: readonly ModelAttachment[],
  sender: string | undefined,
): string | ContentPart[] {
  // attribution, on the provider's copy only: the row keeps the
  // sender's words verbatim ( §5).
  const text = sender === undefined ? content : interBotToUserContent(content, sender);
  // a voice note's words ARE the message (its transcript is the
  // content), so the model is told how it arrived rather than that a file it
  // cannot open was attached. Per message, never in the instructions, so the
  // cached prefix does not change when someone speaks.
  const spoken = attachments.some((attachment) => attachment.kind === 'VOICE_NOTE');
  const files = attachments.filter((attachment) => attachment.kind !== 'VOICE_NOTE');
  if (spoken) {
    const said = `${text}\n\n${SPOKEN_NOTE}`;
    if (files.length === 0) return said;
    return [{ type: 'text', content: said }, ...files.map(fileContent)];
  }
  if (attachments.length === 0) return triggerToUserContent(text);
  return [
    { type: 'text', content: text.trim() === '' ? 'The user attached files.' : text },
    ...attachments.map(fileContent),
  ];
}

/** What the model is told about a message that was spoken. */
export const SPOKEN_NOTE =
  '(The user said this in a voice message. Your reply will be read aloud to them, so answer ' +
  'conversationally and keep code, tables and links to what they asked for.)';

function fileContent(attachment: ModelAttachment): ContentPart {
  return attachment.data !== undefined && attachment.mimeType.startsWith('image/')
    ? {
        type: 'image',
        source: {
          type: 'data',
          mimeType: attachment.mimeType,
          value: Buffer.from(attachment.data).toString('base64'),
        },
      }
    : {
        type: 'text',
        content: attachment.mimeType.startsWith('image/')
          ? `Image attachment ${JSON.stringify(attachment.filename)} was uploaded, but Vision is disabled for the selected model in Settings → Models, so the image was not sent.`
          : `Attachment ${JSON.stringify(attachment.filename)} (${attachment.mimeType}) was uploaded, but its contents are unavailable to this model.`,
      };
}

/**
 * The provider's copy starts after any assistant messages that open the
 * thread. A provider may refuse a conversation that opens on the assistant
 * (Anthropic answers 400), and a thread can open on a question the app stored
 * for its bot. The transcript keeps it; only this copy leaves it out. One
 * carrying tool calls is kept, since dropping it would orphan its results.
 */
export function fromFirstUserTurn(messages: readonly ModelMessage[]): ModelMessage[] {
  const start = messages.findIndex(
    (message) => message.role !== 'assistant' || message.toolCalls !== undefined,
  );
  return start === -1 ? [...messages] : messages.slice(start);
}

/**
 * The library's providerMessages seam avoids mutating the canonical persistence input.
 *
 * `readNotices` hands back the run's pending one-shot notices (a budget
 * wrap-up, a stall warning) to append to THIS call's provider copy: a
 * `user`-role row at the very end, so everything above it — the cached
 * prefix, the memory block, the conversation — stays byte-identical,
 * and the canonical transcript never records a sentence nobody said.
 */
export function providerContext(
  request: ExecutionRequest,
  vision: boolean,
  loadAttachments: ClaimedAttachmentLoader,
  loadSenders?: TeammateNameLoader,
  readNotices?: () => readonly string[],
  vault?: PrivacyVault,
): ChatMiddleware {
  const attachments = new Map<string, readonly ModelAttachment[]>();
  const senders = new Map<string, string | undefined>();
  return {
    name: 'crewaid-provider-context',
    async onConfig(ctx, config) {
      if (ctx.phase === 'init') return;
      const missing = config.messages.flatMap((message) =>
        message.role === 'user' && message.id !== undefined && !attachments.has(message.id)
          ? [message.id]
          : [],
      );
      if (missing.length > 0) {
        const loaded = await loadAttachments(request, missing, vision);
        for (const id of missing) attachments.set(id, loaded.get(id) ?? []);
        // The same ids, in the same pass: both questions are about the user
        // rows this call has not seen before, and both answers last the run.
        const named = await loadSenders?.(request, missing);
        for (const id of missing) senders.set(id, named?.get(id));
      }
      const projected = await projectToolHistory(config.messages, request.tools);
      const rawProviderMessages: ModelMessage[] = fromFirstUserTurn(projected).map((message) =>
        message.role === 'user' && typeof message.content === 'string'
          ? {
              ...message,
              content: userContent(
                message.content,
                attachments.get(message.id ?? '') ?? [],
                senders.get(message.id ?? ''),
              ),
            }
          : message,
      );
      const providerMessages =
        vault === undefined ? rawProviderMessages : vault.redactMessages(rawProviderMessages);
      const notices = readNotices?.() ?? [];
      return {
        providerMessages:
          notices.length === 0
            ? providerMessages
            : [
                ...providerMessages,
                ...notices.map(
                  (content): ModelMessage => ({
                    role: 'user',
                    content: vault === undefined ? content : vault.redactText(content),
                  }),
                ),
              ],
      };
    },
  };
}
