import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveScreenSeat } from './seat-upstream.js';

describe('the bridge seat binding', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads the existing seat route and accepts only the requested bot', async () => {
    const seat = { seatId: 'immutable-seat', botId: 'bot-a', rfbPort: 5901 };
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ ok: true, seat }));
    expect(await resolveScreenSeat('bot-a')).toEqual(seat);
    const url = fetch.mock.calls[0]?.[0];
    if (!(url instanceof URL)) throw new Error('expected a URL');
    expect(url.href).toBe('http://127.0.0.1:7070/seats?botId=bot-a');
  });

  it.each([
    { ok: true, seat: { seatId: 'other-seat', botId: 'bot-b', rfbPort: 5901 } },
    { ok: true, seat: { botId: 'bot-a', rfbPort: 5901 } },
    { ok: true, seat: { seatId: 'seat', botId: 'bot-a', rfbPort: 7070 } },
    { ok: false, seat: { seatId: 'seat', botId: 'bot-a', rfbPort: 5901 } },
  ])('refuses wrong ownership or malformed identity metadata (%j)', async (body) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(body));
    expect(await resolveScreenSeat('bot-a')).toBeNull();
  });

  it('returns no binding for a retired seat and propagates a bridge failure', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 503 }));
    expect(await resolveScreenSeat('bot-a')).toBeNull();
    await expect(resolveScreenSeat('bot-a')).rejects.toThrow(/lookup failed/);
  });
});
