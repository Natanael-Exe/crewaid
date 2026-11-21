import { describe, expect, it } from 'vitest';
import { seatControlView } from '../src/renderer/screen/seatControlState';
import { chatReducer, initialChatState } from '../src/renderer/state/chatReducer';

describe('control UI', () => {
  const human = {
    botId: 'bot',
    mode: 'human',
    holder: 'self',
    epoch: 3,
    leaseExpiresAt: 10000,
    observationRequired: false,
  } as const;
  it('offers input only for this window’s human grant', () => {
    expect(seatControlView(undefined).kind).toBe('available');
    expect(seatControlView(human)).toEqual({ kind: 'driving', epoch: 3 });
    expect(seatControlView({ ...human, holder: 'other' }).kind).toBe('taken');
  });
  it('clears remembered control on disconnection', () => {
    const state = chatReducer(initialChatState, {
      type: 'ws/frame',
      frame: {
        id: '00000000-0000-4000-8000-000000000000',
        type: 'screen.control.state',
        ts: 1,
        payload: human,
      },
    });
    expect(state.seatControlByBot.bot).toEqual(human);
    const disconnected = chatReducer(state, { type: 'seat-control/reset' });
    expect(disconnected.seatControlByBot).toEqual({});
    expect(chatReducer(disconnected, { type: 'seat-control/reset' })).toBe(disconnected);
  });
});
