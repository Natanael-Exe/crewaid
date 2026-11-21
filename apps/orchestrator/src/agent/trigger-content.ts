import { promptLine } from './agent-instructions.js';

/**
 * Attachment-only USER messages are legitimate — the stored content is
 * `''` with attachments behind it. An empty user message is a protocol smell
 * for providers (some reject empty text parts), so the provider's copy gets a
 * placeholder instead. What is STORED is unaffected; this shapes what is SENT.
 */

export const ATTACHMENT_ONLY_PLACEHOLDER =
  '[The user sent attachments without any text. Ask what they would like you to do with them.]';

/**
 * True when a trigger message carries no user text. `''` is the stored form
 * of absent content (D-022 ruling); a whitespace-only string is text the
 * user effectively did not write and is treated the same way.
 */
export function isAttachmentOnlyTrigger(content: string | undefined | null): boolean {
  return (content ?? '').trim() === '';
}

/**
 * The user-message content streamText receives. Text-bearing triggers pass
 * through verbatim; attachment-only triggers become the placeholder above.
 * The prompt layer is presentation — the transcript still shows the real
 * stored content ('' + attachment cards) per Nathan's renderer contract.
 */
export function triggerToUserContent(content: string | undefined): string {
  return isAttachmentOnlyTrigger(content) ? ATTACHMENT_ONLY_PLACEHOLDER : (content ?? '');
}

/**
 * How an inter-bot message reads in the receiving bot's prompt.
 *
 * §6/M7 delivers to the receiving bot "as if a user had messaged it", and the
 * role really is `user`: it is speech from outside, addressed to this bot,
 * that it is expected to answer. But an unattributed one is a lie the model
 * cannot see through. Without this prefix a bot cannot tell a teammate's
 * request from its operator's, so it cannot know that "ask them to confirm"
 * means a `send_message` back rather than a question into the transcript —
 * and it will address the sender as "you" while talking to a person.
 *
 * The prefix is text rather than a second message, because it has to survive
 * everything that reshapes a prompt: M5-BE-02's trim prunes whole messages
 * pairwise, and a separate attribution line is exactly the kind of small
 * message a trim drops while keeping the large one it explained.
 *
 * This lives here for the reason the module header gives — this is the ONLY
 * place a stored Message becomes prompt text — and it changes nothing about
 * what is STORED. The transcript keeps the sender's words verbatim; the
 * renderer shows who sent them.
 */
export function fromBotPrefix(botName: string): string {
  return `[Message from ${promptLine(botName)}, another bot on this team]`;
}

/**
 * The prompt text for a message that arrived from another bot.
 *
 * Attachment-only tolerance still applies underneath: an inter-bot message
 * with no text is not a case `send_message` can produce today (its schema
 * requires `content`), but routing it through the same bridge means it can
 * never become one silently.
 */
export function interBotToUserContent(content: string | undefined, botName: string): string {
  return `${fromBotPrefix(botName)}\n\n${triggerToUserContent(content)}`;
}

/**
 * What a sender is called once its bot row is gone.
 *
 * A deleted bot's messages stay in the receiving bot's transcript — the
 * column is a plain id, not a cascading relation — so the seed can hold a
 * message from a sender that no longer resolves. Naming that state is better
 * than either dropping the message (leaving a reply answering nothing) or
 * printing a raw id at the model.
 */
export const REMOVED_BOT_NAME = 'a bot that has since been removed';
