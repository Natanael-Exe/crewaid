import { describe, expect, it, vi } from 'vitest';
import { encodeScreenInputFrame } from '@crewaid/shared';
import { WsGateway } from '../src/ws/ws.gateway.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('ordered screen input', () => {
  const botId = 'bot';
  const key = (down: boolean) =>
    Buffer.from(
      encodeScreenInputFrame(botId, 1, new Uint8Array([4, down ? 1 : 0, 0, 0, 0, 0, 0, 97])),
    );
  function fixture() {
    const first = deferred<{ userId: string; scopes: string[] }>();
    const principals = {
      principalFor: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockResolvedValue({ userId: 'user', scopes: ['*'] }),
    };
    const screens = { input: vi.fn(), detach: vi.fn() };
    const socket = { readyState: 1, close: vi.fn(), send: vi.fn() };
    const gateway = new WsGateway({} as never, {} as never, screens as never, principals as never);
    return { gateway, socket, screens, principals, first };
  }
  it('preserves press/release order across slow authentication', async () => {
    const { gateway, socket, screens, principals, first } = fixture();
    const press = gateway.handleBinary(socket as never, key(true));
    const up = gateway.handleBinary(socket as never, key(false));
    await Promise.resolve();
    expect(principals.principalFor).toHaveBeenCalledTimes(1);
    expect(screens.input).not.toHaveBeenCalled();
    first.resolve({ userId: 'user', scopes: ['*'] });
    await Promise.all([press, up]);
    expect(screens.input.mock.calls.map((x) => x[2][1])).toEqual([1, 0]);
  });
  it('drops input after the socket closes during authentication', async () => {
    const { gateway, socket, screens, first } = fixture();
    const press = gateway.handleBinary(socket as never, key(true));
    await Promise.resolve();
    socket.readyState = 3;
    first.resolve({ userId: 'user', scopes: ['*'] });
    await press;
    expect(screens.input).not.toHaveBeenCalled();
  });
  it('bounds queued input instead of retaining an unlimited backlog', async () => {
    const { gateway, socket, screens, first } = fixture();
    const work = Array.from({ length: 257 }, () =>
      gateway.handleBinary(socket as never, key(true)),
    );
    expect(socket.close).toHaveBeenCalledWith(1008, expect.any(String));
    expect(screens.detach).toHaveBeenCalledWith(socket);
    socket.readyState = 3;
    first.resolve({ userId: 'user', scopes: ['*'] });
    await Promise.all(work);
    expect(screens.input).not.toHaveBeenCalled();
  });
});
