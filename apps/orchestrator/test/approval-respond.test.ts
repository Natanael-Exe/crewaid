import { describe, expect, it, vi } from 'vitest';
import { ToolApprovalHub } from '../src/agent/policy/approval-hub.js';
import type { ApprovalDecision } from '../src/agent/tool-approval.js';
import type { PolicyPrompt } from '../src/agent/policy/runtime.js';

const scope = { userId: 'owner', botId: 'bot', conversationId: 'thread', runId: 'run' };
const prompt: PolicyPrompt = {
  approvalId: 'sdk-id',
  toolCallId: 'server-proposal',
  toolName: 'shell',
  args: { command: 'ls' },
  binding: {
    toolName: 'shell',
    effect: 'unknown',
    scope: 'call',
    argsHash: 'a'.repeat(64),
    grantRevision: 'b'.repeat(64),
    resourceRevision: null,
    seat: null,
    commit: null,
  },
};
function fixture() {
  let durable: 'pending' | 'resolved' | 'cancelled' = 'pending';
  const frames: { type: string; payload: unknown }[] = [];
  const answer = vi.fn(async (_id: string, reply: ApprovalDecision) => {
    if (durable !== 'pending') return null;
    durable = 'resolved';
    return reply;
  });
  const cancel = vi.fn(async () => {
    if (durable === 'pending') durable = 'cancelled';
  });
  const events = {
    emitApprovalRequested: vi.fn((_bot: string, payload: unknown) => {
      frames.push({ type: 'requested', payload });
    }),
    emitApprovalResolved: vi.fn((_bot: string, payload: unknown) => {
      expect(durable).not.toBe('pending');
      frames.push({ type: 'resolved', payload });
    }),
  };
  const hub = new ToolApprovalHub(
    { runInterrupt: { findMany: async () => [] } } as never,
    events as never,
  );
  hub.register(scope, prompt.toolCallId, answer, cancel);
  return { hub, answer, cancel, events, frames };
}

describe('owned durable approval transport', () => {
  it('sends the exact binding and accepts an answer inside the announcement callback', async () => {
    const f = fixture();
    f.events.emitApprovalRequested.mockImplementation((_bot, payload) => {
      expect(payload).toEqual({
        turnId: scope.runId,
        toolCallId: prompt.toolCallId,
        toolName: prompt.toolName,
        args: prompt.args,
        binding: prompt.binding,
      });
      void f.hub.respond(scope.userId, prompt.toolCallId, { approved: true });
    });
    expect(await f.hub.wait(scope, prompt, f.answer, f.cancel)).toEqual({ approved: true });
    expect(f.answer).toHaveBeenCalledOnce();
    expect(f.events.emitApprovalResolved).toHaveBeenCalledOnce();
  });
  it('retains an answer obtained from GET before the coordinator parks', async () => {
    const f = fixture();
    expect(await f.hub.respond(scope.userId, prompt.toolCallId, { approved: true })).toBe(true);
    expect(await f.hub.wait(scope, prompt, f.answer, f.cancel)).toEqual({ approved: true });
    expect(f.events.emitApprovalRequested).not.toHaveBeenCalled();
  });
  it('refuses unknown ids and foreign principals without touching authority', async () => {
    const f = fixture();
    expect(await f.hub.respond('foreign', prompt.toolCallId, { approved: true })).toBe(false);
    expect(await f.hub.respond(scope.userId, 'missing', { approved: true })).toBe(false);
    expect(f.answer).not.toHaveBeenCalled();
    await expect(
      f.hub.wait({ ...scope, runId: 'different' }, prompt, f.answer, f.cancel),
    ).rejects.toThrow('not owned');
    await f.hub.finishRun(scope.userId, scope.runId);
  });
  it('settles a concurrent double-click exactly once', async () => {
    const f = fixture();
    const waiting = f.hub.wait(scope, prompt, f.answer, f.cancel);
    expect(
      await Promise.all([
        f.hub.respond(scope.userId, prompt.toolCallId, { approved: true }),
        f.hub.respond(scope.userId, prompt.toolCallId, { approved: true }),
      ]),
    ).toEqual([true, false]);
    expect(await waiting).toEqual({ approved: true });
    expect(f.answer).toHaveBeenCalledOnce();
    expect(f.events.emitApprovalResolved).toHaveBeenCalledOnce();
  });
  it('serializes an answer and cancellation instead of broadcasting a contradictory result', async () => {
    const f = fixture();
    const waiting = f.hub.wait(scope, prompt, f.answer, f.cancel);
    const answering = f.hub.respond(scope.userId, prompt.toolCallId, { approved: true });
    expect(f.hub.cancelBot(scope.userId, scope.botId)).toBe(true);
    expect(await answering).toBe(true);
    expect(await waiting).toEqual({ approved: true });
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.events.emitApprovalResolved).toHaveBeenCalledOnce();
  });
  it('bot cancellation also settles a scheduled skill without a chat abort controller', async () => {
    const f = fixture();
    const waiting = f.hub.wait(scope, prompt, f.answer, f.cancel);
    expect(f.hub.cancelBot('foreign', scope.botId)).toBe(false);
    expect(f.hub.cancelBot(scope.userId, scope.botId)).toBe(true);
    expect(await waiting).toMatchObject({ approved: false });
    expect(f.cancel).toHaveBeenCalledOnce();
  });
  it('run cleanup resolves proposals that the runner never announced', async () => {
    const f = fixture();
    await f.hub.finishRun(scope.userId, scope.runId);
    expect(f.cancel).toHaveBeenCalledOnce();
    expect(f.events.emitApprovalResolved).toHaveBeenCalledOnce();
    expect(await f.hub.respond(scope.userId, prompt.toolCallId, { approved: true })).toBe(false);
  });
  it('a run that parked leaves its proposals open for the resume to answer', async () => {
    const f = fixture();
    void f.hub.wait(scope, prompt, f.answer, f.cancel);
    f.hub.forgetRun(scope.userId, scope.runId);
    // Cancelling here would close the very question the operator is about to
    // answer, and the resume that carries the answer would find nothing open.
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.events.emitApprovalResolved).not.toHaveBeenCalled();
    // Nothing in this process waits on it any more; the store does.
    expect(await f.hub.respond(scope.userId, prompt.toolCallId, { approved: true })).toBe(false);
  });
  it('fails the wait if persistence fails during cancellation instead of hanging', async () => {
    const f = fixture();
    f.cancel.mockRejectedValue(new Error('database unavailable'));
    const waiting = f.hub.wait(scope, prompt, f.answer, f.cancel);
    const rejected = expect(waiting).rejects.toThrow('database unavailable');
    f.hub.cancelBot(scope.userId, scope.botId);
    await rejected;
    expect(f.events.emitApprovalResolved).not.toHaveBeenCalled();
  });
});
