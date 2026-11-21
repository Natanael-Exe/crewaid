import { describe, expect, it, vi } from 'vitest';
import { WsAdapter } from '@nestjs/platform-ws';

import { CrewaidWsAdapter } from '../src/ws/crewaid-ws.adapter.js';
import {
  nestsDeeperThan,
  sendBounded,
  WS_MAX_BUFFERED_BYTES,
  WS_MAX_FRAME_DEPTH,
  WS_MAX_INBOUND_FRAME_BYTES,
} from '../src/ws/ws-limits.js';

function socket(bufferedAmount: number) {
  return { bufferedAmount, send: vi.fn(), terminate: vi.fn() };
}

describe('sendBounded', () => {
  it('sends while the peer keeps reading', () => {
    const client = socket(WS_MAX_BUFFERED_BYTES);
    expect(sendBounded(client, 'frame')).toBe(true);
    expect(client.send).toHaveBeenCalledWith('frame');
    expect(client.terminate).not.toHaveBeenCalled();
  });

  it('ends a socket whose peer stopped reading instead of queueing more', () => {
    const client = socket(WS_MAX_BUFFERED_BYTES + 1);
    expect(sendBounded(client, 'frame')).toBe(false);
    expect(client.send).not.toHaveBeenCalled();
    expect(client.terminate).toHaveBeenCalledOnce();
  });
});

describe('nestsDeeperThan', () => {
  it('measures depth without recursing, however deep the frame', () => {
    let deep: unknown = 1;
    for (let depth = 0; depth < 500_000; depth += 1) deep = [deep];
    expect(nestsDeeperThan(deep, WS_MAX_FRAME_DEPTH)).toBe(true);
  });

  it('passes every frame the contract can produce', () => {
    const frame = {
      id: 'x',
      type: 'approval.respond',
      payload: { toolCallId: 't', approved: true, editedArgs: { a: { b: [1, { c: 'd' }] } } },
    };
    expect(nestsDeeperThan(frame, WS_MAX_FRAME_DEPTH)).toBe(false);
    expect(nestsDeeperThan('text', 0)).toBe(false);
  });
});

describe('§4.2 inbound frame bound', () => {
  it('hands the server a maxPayload far below ws’s 100 MiB default', () => {
    const create = vi
      .spyOn(WsAdapter.prototype, 'create')
      .mockImplementation(() => ({}) as ReturnType<WsAdapter['create']>);
    try {
      new CrewaidWsAdapter({} as never).create(0, {});
      const options = create.mock.calls[0]?.[1] as { maxPayload?: number } | undefined;
      expect(options?.maxPayload).toBe(WS_MAX_INBOUND_FRAME_BYTES);
      expect(WS_MAX_INBOUND_FRAME_BYTES).toBeLessThanOrEqual(1024 * 1024);
    } finally {
      create.mockRestore();
    }
  });
});
