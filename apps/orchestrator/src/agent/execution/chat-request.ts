import { chatParamsFromRequestBody } from '@tanstack/ai';

/**
 * The library's own `RunAgentInput` parser, behind the execution seam.
 *
 * keeps `@tanstack/ai` inside the seam directories, and the send route
 * lives outside them — but what a client may send is the library's contract,
 * not ours, so re-declaring the shape in a schema would be a second answer
 * that drifts the first time the protocol moves. The seam exports the parser
 * instead, and the route sees a plain object.
 */
export type ChatRequestParams = Awaited<ReturnType<typeof chatParamsFromRequestBody>>;

export class InvalidChatRequestError extends Error {
  constructor() {
    super('INVALID_RUN_AGENT_INPUT');
    this.name = 'InvalidChatRequestError';
  }
}

/** Throws `InvalidChatRequestError`, which the route answers 400. */
export async function parseChatRequest(body: unknown): Promise<ChatRequestParams> {
  try {
    return await chatParamsFromRequestBody(body);
  } catch {
    // The library's message points at its own migration guide, which is not
    // something to put in front of an operator or on the wire.
    throw new InvalidChatRequestError();
  }
}
