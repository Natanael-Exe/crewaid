import { Server } from 'node:net';

/**
 * supertest serves `request(app.getHttpServer())` by calling `listen(0)` and
 * then connecting to `127.0.0.1:<port>`. A bare `listen(0)` binds the
 * wildcard address, and on macOS the kernel will hand the wildcard a port that
 * another program already holds on 127.0.0.1 alone — an editor's language
 * server, a local model runner, an Electron app. The more specific binding
 * wins, so the request goes to that program instead of the suite's own
 * server, and the suite sees whatever it answers: a 403 "Invalid CSRF token",
 * a 400, a socket hang-up. That was the source of the cross-suite 403s and
 * hang-ups a full local run showed and CI never did.
 *
 * Binding the suite's ephemeral servers to 127.0.0.1 — the address supertest
 * connects to — lets the kernel see the conflict and pick another port. Only a
 * bare `listen(0)` is changed; a caller naming a host or a port keeps it.
 */
const listen = Server.prototype.listen;

/**
 * `setupListenHandle`, under its long-standing `_listen2` alias. `listen(0,
 * '127.0.0.1')` would resolve the host on a later tick, and supertest reads
 * `address().port` the moment `listen` returns; binding the handle directly
 * keeps the bind synchronous, as a bare `listen(0)` is. `listening` is
 * emitted on the next tick either way.
 */
type Listen2 = (address: string, port: number, addressType: number, backlog: number) => void;

Server.prototype.listen = function (this: Server, ...args: unknown[]) {
  const bare = args[0] === 0 && (args.length === 1 || typeof args[1] === 'function');
  if (!bare) return listen.apply(this, args as Parameters<Server['listen']>);
  if (typeof args[1] === 'function') this.once('listening', args[1] as () => void);
  (this as unknown as { _listen2: Listen2 })._listen2('127.0.0.1', 0, 4, 511);
  return this;
} as Server['listen'];
