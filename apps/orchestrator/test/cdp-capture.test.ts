import { describe, expect, it, vi } from 'vitest';

import type { CdpAttachService } from '../src/recordings/cdp-attach.service.js';
import { CdpCaptureService } from '../src/recordings/cdp-capture.service.js';
import type {
  CdpCloseOutcome,
  CdpConnection,
  CdpEvent,
  CdpEventListener,
} from '../src/recordings/cdp-connection.js';
import {
  CAPTURE_BINDING_NAME,
  CAPTURE_SCRIPT_SOURCE,
} from '../src/recordings/cdp-capture-script.js';
import type { RecordingTeeService } from '../src/recordings/recording-tee.service.js';

/**
 * M4-BE-02 — the arming service; M4-BE-04 — the navigation rows it carries.
 *
 * A fake connection stands in for the socket and a fake tee for the trace.
 * What is under test is the SEQUENCE — which commands, in which order, on
 * which session — the trust boundary in front of the tee, the teardown, and
 * the session-scoped judgement the navigation events get on their way in.
 * What Chrome answers is `cdp-capture-docker.integration.test.ts` and
 * `cdp-nav-docker.integration.test.ts`, against the sandbox's own browser;
 * that is also where the findings this suite pins — `Page.enable` before the
 * registration, replacement across two recordings, and one commit arriving
 * once per attached session — were made.
 */

interface SentCommand {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId: string | undefined;
}

class FakeConnection implements CdpConnection {
  readonly sent: SentCommand[] = [];
  readonly unsubscribed: string[] = [];
  /** The answer `Target.getTargets` gives; tests set this before arming. */
  targets: Array<Record<string, unknown>> = [];
  closed = false;

  private readonly listeners = new Map<string, Set<CdpEventListener>>();
  private readonly closers = new Set<(outcome: CdpCloseOutcome) => void>();
  private registrationCount = 0;

  /** Return an error to make one command fail; null lets it through. */
  failWhen: (
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ) => Error | null = () => null;

  responder: (
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ) => Record<string, unknown> | Promise<Record<string, unknown>> = (method, params, sessionId) => {
    if (method === 'Target.getTargets') return { targetInfos: this.targets };
    if (method === 'Target.attachToTarget') {
      return { sessionId: `session-${String(params['targetId'])}` };
    }
    if (method === 'Page.addScriptToEvaluateOnNewDocument') {
      this.registrationCount += 1;
      return { identifier: `reg:${sessionId ?? `r${this.registrationCount}`}` };
    }
    return {};
  };

  send(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    const copy = { ...params };
    this.sent.push({ method, params: copy, sessionId });
    const failure = this.failWhen(method, copy, sessionId);
    if (failure !== null) return Promise.reject(failure);
    return Promise.resolve(this.responder(method, copy, sessionId));
  }

  on(method: string, listener: CdpEventListener): () => void {
    const set = this.listeners.get(method) ?? new Set<CdpEventListener>();
    this.listeners.set(method, set);
    set.add(listener);
    return () => {
      this.unsubscribed.push(method);
      set.delete(listener);
    };
  }

  onClose(listener: (outcome: CdpCloseOutcome) => void): () => void {
    if (this.closed) {
      listener(null);
      return () => undefined;
    }
    this.closers.add(listener);
    return () => {
      this.closers.delete(listener);
    };
  }

  close(): Promise<void> {
    this.closed = true;
    for (const listener of [...this.closers]) listener(null);
    return Promise.resolve();
  }

  /** Deliver one protocol event to the listeners registered for it. */
  emit(method: string, params: Record<string, unknown>, sessionId?: string): void {
    const event: CdpEvent = { method, params, ...(sessionId === undefined ? {} : { sessionId }) };
    for (const listener of [...(this.listeners.get(method) ?? [])]) listener(event);
  }
}

function setup(connection: CdpConnection | null = new FakeConnection()) {
  // D-060: the capture no longer asks which window a seat is. `connectionFor`
  // resolves the SEAT's own browser, so every page on the connection is this
  // bot's and the endpoint is the scope. What used to be a filter inside this
  // service is now a fact about which port it dialled — asserted in
  // `cdp-attach`, where the port is chosen.
  const connectionFor = vi.fn((_botId: string, _recordingId: string) =>
    Promise.resolve(connection),
  );
  const cdp = { connectionFor } as unknown as CdpAttachService;
  const teeCdp = vi.fn();
  const tee = { teeCdp } as unknown as RecordingTeeService;
  const service = new CdpCaptureService(cdp, tee);
  return { service, cdp, connectionFor, tee, teeCdp, connection };
}

/** The methods this service sent ON one target session, in order. */
function sessionCommands(connection: FakeConnection, sessionId: string): string[] {
  return connection.sent.filter((command) => command.sessionId === sessionId).map((c) => c.method);
}

const page = (targetId: string, type = 'page'): Record<string, unknown> => ({
  targetId,
  type,
  url: 'https://example.test/',
});

describe('CdpCaptureService — arming', () => {
  it('arms every page target of the recorded browser, with Page.enable before the registration', async () => {
    const connection = new FakeConnection();
    connection.targets = [
      page('page-1'),
      page('page-2'),
      page('ui-1', 'browser_ui'),
      page('f-1', 'iframe'),
    ];
    const { service, connectionFor, tee } = setup(connection);

    service.arm('bot-1', 'rec-1');

    await vi.waitFor(() => {
      expect(sessionCommands(connection, 'session-page-1')).toHaveLength(5);
      expect(sessionCommands(connection, 'session-page-2')).toHaveLength(5);
    });
    // The attach service hands back the connection; the capture never builds
    // one of its own.
    expect(connectionFor).toHaveBeenCalledWith('bot-1', 'rec-1');

    // Only pages: `browser_ui` and `iframe` targets are not where the four
    // §6/M4 interactions happen.
    expect(connection.sent.filter((c) => c.method === 'Target.attachToTarget')).toHaveLength(2);
    expect(connection.sent.find((c) => c.method === 'Target.attachToTarget')?.params).toEqual({
      targetId: 'page-1',
      flatten: true,
    });
    // Discovery is announced before the sweep, so a page created while the
    // sweep runs cannot fall between the two.
    const methods = connection.sent.map((c) => c.method);
    expect(methods.indexOf('Target.setDiscoverTargets')).toBeLessThan(
      methods.indexOf('Target.getTargets'),
    );
    expect(connection.sent.find((c) => c.method === 'Target.setDiscoverTargets')?.params).toEqual({
      discover: true,
    });

    // The sequence, in order, from the probe against Chrome 152. `Page.enable`
    // before the script is load-bearing, not decoration: without it the
    // registration is silently never delivered to the renderer. `Network.enable`
    // is M4-BE-04's domain, and it precedes the script so that every document
    // the registration can run in is one the Network domain is watching too.
    expect(sessionCommands(connection, 'session-page-1')).toEqual([
      'Runtime.enable',
      'Runtime.addBinding',
      'Page.enable',
      'Network.enable',
      'Page.addScriptToEvaluateOnNewDocument',
    ]);
    const binding = connection.sent.find((c) => c.method === 'Runtime.addBinding');
    expect(binding?.params).toEqual({ name: CAPTURE_BINDING_NAME });
    const script = connection.sent.find(
      (c) => c.method === 'Page.addScriptToEvaluateOnNewDocument',
    );
    expect(script?.params).toEqual({ source: CAPTURE_SCRIPT_SOURCE, runImmediately: true });

    // A page must not be armed twice per recording — the trace would hold
    // every interaction twice.
    expect(tee.teeCdp).not.toHaveBeenCalled();
  });

  it('arms a page that appears mid-recording, once, whatever announced it twice', async () => {
    const connection = new FakeConnection();
    connection.targets = [];
    const { service } = setup(connection);

    service.arm('bot-1', 'rec-1');
    await vi.waitFor(() => {
      expect(connection.sent.some((c) => c.method === 'Target.setDiscoverTargets')).toBe(true);
    });

    const announcement = { targetInfo: page('page-9') };
    connection.emit('Target.targetCreated', announcement);
    connection.emit('Target.targetCreated', announcement);

    await vi.waitFor(() => {
      expect(sessionCommands(connection, 'session-page-9')).toHaveLength(5);
    });
    expect(
      connection.sent.filter(
        (c) => c.method === 'Target.attachToTarget' && c.params['targetId'] === 'page-9',
      ),
    ).toHaveLength(1);

    // Non-page targets are announcements this service reads and discards.
    connection.emit('Target.targetCreated', { targetInfo: page('worker-1', 'worker') });
    await Promise.resolve();
    expect(
      connection.sent.filter(
        (c) => c.method === 'Target.attachToTarget' && c.params['targetId'] === 'worker-1',
      ),
    ).toHaveLength(0);
  });

  it('forgets a target that died, so a later target with the same id is armed again', async () => {
    const connection = new FakeConnection();
    connection.targets = [page('page-1')];
    const { service } = setup(connection);
    service.arm('bot-1', 'rec-1');
    await vi.waitFor(() => expect(sessionCommands(connection, 'session-page-1')).toHaveLength(5));

    connection.emit('Target.targetDestroyed', { targetId: 'page-1' });
    connection.emit('Target.targetCreated', { targetInfo: page('page-1') });

    await vi.waitFor(() => {
      expect(
        connection.sent.filter(
          (c) => c.method === 'Target.attachToTarget' && c.params['targetId'] === 'page-1',
        ),
      ).toHaveLength(2);
    });
  });

  it('degrades to X11-only when the attach never produced a connection', async () => {
    const { service, connectionFor } = setup(null);

    expect(() => service.arm('bot-1', 'rec-1')).not.toThrow();
    await vi.waitFor(() => expect(connectionFor).toHaveBeenCalled());

    // Nothing to send and nothing to send it over; disarming is a no-op, and
    // a recording keeps capturing at the X11 layer (§6/M4).
    await service.disarm('bot-1', 'rec-1');
  });

  it('degrades when resolving the connection fails outright', async () => {
    const connectionFor = vi.fn(() => Promise.reject(new Error('the sandbox is gone')));
    const cdp = { connectionFor } as unknown as CdpAttachService;
    const teeCdp = vi.fn();
    const service = new CdpCaptureService(cdp, { teeCdp } as unknown as RecordingTeeService);

    service.arm('bot-1', 'rec-1');

    // The rejection is the install's to swallow: nothing in the recording
    // path may throw because Chrome is missing.
    await vi.waitFor(() => expect(connectionFor).toHaveBeenCalled());
    await service.disarm('bot-1', 'rec-1');
  });

  it('drops one target whose commands fail and arms the others', async () => {
    const connection = new FakeConnection();
    connection.targets = [page('page-1'), page('page-2')];
    connection.failWhen = (method, _params, sessionId) =>
      method === 'Runtime.addBinding' && sessionId === 'session-page-1'
        ? new Error('binding refused')
        : null;
    const { service } = setup(connection);

    service.arm('bot-1', 'rec-1');

    await vi.waitFor(() => expect(sessionCommands(connection, 'session-page-2')).toHaveLength(5));
    expect(sessionCommands(connection, 'session-page-1')).not.toContain(
      'Page.addScriptToEvaluateOnNewDocument',
    );

    // The slot was dropped rather than left claimed: a target that gets
    // announced again (or navigates into existence) can be armed later.
    connection.failWhen = () => null;
    connection.emit('Target.targetCreated', { targetInfo: page('page-1') });
    await vi.waitFor(() =>
      expect(sessionCommands(connection, 'session-page-1')).toContain(
        'Page.addScriptToEvaluateOnNewDocument',
      ),
    );
    expect(
      connection.sent.filter(
        (c) =>
          c.method === 'Page.addScriptToEvaluateOnNewDocument' && c.sessionId === 'session-page-1',
      ),
    ).toHaveLength(1);
  });
});

describe('CdpCaptureService — what the page reports', () => {
  async function armed() {
    const connection = new FakeConnection();
    connection.targets = [page('page-1')];
    const { service, teeCdp } = setup(connection);
    service.arm('bot-1', 'rec-1');
    await vi.waitFor(() => expect(sessionCommands(connection, 'session-page-1')).toHaveLength(5));
    return { connection, service, teeCdp };
  }

  it('turns a valid binding call into one tee event', async () => {
    const { connection, teeCdp } = await armed();

    connection.emit(
      'Runtime.bindingCalled',
      {
        name: CAPTURE_BINDING_NAME,
        payload: JSON.stringify({ type: 'click', clientX: 640.4, id: 'pay' }),
        executionContextId: 1,
      },
      'session-page-1',
    );

    // Parsed and bounded on the way through: the raw string is never stored.
    expect(teeCdp).toHaveBeenCalledWith('bot-1', {
      type: 'click',
      payload: { clientX: 640, id: 'pay' },
    });
  });

  it('drops junk rather than asking the tee to judge it', async () => {
    const { connection, teeCdp } = await armed();
    const call = { name: CAPTURE_BINDING_NAME, executionContextId: 1 };

    for (const payload of [
      'not json',
      '"just a string"',
      JSON.stringify({ type: 'scroll' }),
      JSON.stringify({ type: 'click' }).repeat(300),
    ]) {
      connection.emit('Runtime.bindingCalled', { ...call, payload }, 'session-page-1');
    }
    // A page may call any binding it likes; only validated reports count.
    connection.emit(
      'Runtime.bindingCalled',
      {
        name: 'someOtherBinding',
        payload: JSON.stringify({ type: 'click' }),
        executionContextId: 1,
      },
      'session-page-1',
    );
    connection.emit(
      'Runtime.bindingCalled',
      { name: CAPTURE_BINDING_NAME, payload: { not: 'a string' }, executionContextId: 1 },
      'session-page-1',
    );

    expect(teeCdp).not.toHaveBeenCalled();
  });

  it('stops feeding the tee once disarmed', async () => {
    const { connection, service, teeCdp } = await armed();
    await service.disarm('bot-1', 'rec-1');

    connection.emit(
      'Runtime.bindingCalled',
      {
        name: CAPTURE_BINDING_NAME,
        payload: JSON.stringify({ type: 'click' }),
        executionContextId: 1,
      },
      'session-page-1',
    );

    // The recording is over; a frame that arrives afterwards is not evidence.
    expect(teeCdp).not.toHaveBeenCalled();
  });
});

describe('CdpCaptureService — disarming', () => {
  it('takes every registration and binding back out, while the socket is still open', async () => {
    const connection = new FakeConnection();
    connection.targets = [page('page-1'), page('page-2')];
    const { service } = setup(connection);
    service.arm('bot-1', 'rec-1');
    await vi.waitFor(() => expect(sessionCommands(connection, 'session-page-2')).toHaveLength(5));

    await service.disarm('bot-1', 'rec-1');

    for (const sessionId of ['session-page-1', 'session-page-2']) {
      expect(connection.sent).toContainEqual({
        method: 'Page.removeScriptToEvaluateOnNewDocument',
        params: { identifier: `reg:${sessionId}` },
        sessionId,
      });
      expect(connection.sent).toContainEqual({
        method: 'Runtime.removeBinding',
        params: { name: CAPTURE_BINDING_NAME },
        sessionId,
      });
    }
    // Every subscription let go — including the ones whose events would
    // otherwise be fed to a tee that has moved on.
    expect(connection.unsubscribed).toEqual(
      expect.arrayContaining([
        'Runtime.bindingCalled',
        'Target.targetCreated',
        'Target.targetDestroyed',
        'Page.frameNavigated',
        'Network.requestWillBeSent',
        'Network.loadingFinished',
      ]),
    );
    // It does not close the socket: that is the attach's to close, after this.
    expect(connection.closed).toBe(false);

    // Idempotent, and scoped: another recording's disarm is not this one's.
    await service.disarm('bot-1', 'rec-1');
    await service.disarm('bot-1', 'rec-2');
    await service.disarm('bot-9', 'rec-1');
  });

  it('replaces a capture left over from an earlier recording instead of going silent', async () => {
    const connection = new FakeConnection();
    connection.targets = [page('page-1')];
    const { service } = setup(connection);
    service.arm('bot-1', 'rec-1');
    await vi.waitFor(() => expect(sessionCommands(connection, 'session-page-1')).toHaveLength(5));

    service.arm('bot-1', 'rec-2');

    // The old capture is torn down (its registrations removed, its listeners
    // dropped) and the new one arms fresh; a stale slot would have left every
    // later recording for this bot capturing nothing.
    await vi.waitFor(() => {
      expect(
        connection.sent.filter(
          (c) => c.method === 'Target.attachToTarget' && c.params['targetId'] === 'page-1',
        ),
      ).toHaveLength(2);
    });
    expect(connection.unsubscribed.length).toBeGreaterThanOrEqual(3);
    expect(
      connection.sent.filter((c) => c.method === 'Page.removeScriptToEvaluateOnNewDocument'),
    ).toHaveLength(1);

    // Arming the same recording twice is not two captures.
    service.arm('bot-1', 'rec-2');
    await Promise.resolve();
    expect(
      connection.sent.filter(
        (c) => c.method === 'Target.attachToTarget' && c.params['targetId'] === 'page-1',
      ),
    ).toHaveLength(2);
  });

  it('installs nothing when a disarm lands while the connection is still resolving', async () => {
    let resolveConnection!: (connection: CdpConnection) => void;
    const pending = new Promise<CdpConnection>((resolve) => {
      resolveConnection = resolve;
    });
    const connectionFor = vi.fn(() => pending);
    const cdp = { connectionFor } as unknown as CdpAttachService;
    const teeCdp = vi.fn();
    const service = new CdpCaptureService(cdp, { teeCdp } as unknown as RecordingTeeService);
    const connection = new FakeConnection();

    service.arm('bot-1', 'rec-1');
    const disarming = service.disarm('bot-1', 'rec-1');
    resolveConnection(connection);
    await disarming;

    // Nothing may be installed, subscribed or sent after the slot is gone.
    expect(connection.sent).toEqual([]);
    expect(connection.unsubscribed).toEqual([]);
  });

  it('pulls back a registration that landed after disarm had walked past it', async () => {
    const connection = new FakeConnection();
    connection.targets = [];
    const base = connection.responder;
    let releaseScript!: (answer: Record<string, unknown>) => void;
    connection.responder = (method, params, sessionId) => {
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        return new Promise<Record<string, unknown>>((resolve) => {
          releaseScript = resolve;
        });
      }
      return base(method, params, sessionId);
    };
    const { service } = setup(connection);
    service.arm('bot-1', 'rec-1');
    await vi.waitFor(() => {
      expect(connection.sent.some((c) => c.method === 'Target.setDiscoverTargets')).toBe(true);
    });

    // A page appears and its install is in flight when the recording ends.
    connection.emit('Target.targetCreated', { targetInfo: page('page-late') });
    await vi.waitFor(() => {
      expect(
        connection.sent.some((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument'),
      ).toBe(true);
    });
    await service.disarm('bot-1', 'rec-1');
    releaseScript({ identifier: 'reg:late' });

    // The registration disarm could not see (its slot was still a claim) is
    // removed by the install itself, while the socket may still be open.
    await vi.waitFor(() => {
      expect(connection.sent).toContainEqual({
        method: 'Page.removeScriptToEvaluateOnNewDocument',
        params: { identifier: 'reg:late' },
        sessionId: 'session-page-late',
      });
    });
  });

  it('disarms every capture on shutdown', async () => {
    const connection = new FakeConnection();
    connection.targets = [page('page-1')];
    const { service } = setup(connection);
    service.arm('bot-1', 'rec-1');
    service.arm('bot-2', 'rec-2');
    await vi.waitFor(() => {
      expect(connection.sent.filter((c) => c.method === 'Runtime.addBinding')).toHaveLength(2);
    });

    await service.onModuleDestroy();

    expect(connection.unsubscribed).toHaveLength(12);
    expect(connection.sent.filter((c) => c.method === 'Runtime.removeBinding')).toHaveLength(2);
  });
});

describe('CdpCaptureService — navigation rows (M4-BE-04)', () => {
  async function armed() {
    const connection = new FakeConnection();
    connection.targets = [page('page-1')];
    const { service, teeCdp } = setup(connection);
    service.arm('bot-1', 'rec-1');
    await vi.waitFor(() => expect(sessionCommands(connection, 'session-page-1')).toHaveLength(5));
    return { connection, service, teeCdp };
  }

  /** A `Page.frameNavigated` for a main-frame commit, as Chrome 152 sends it. */
  const commit = (url = 'https://example.test/'): Record<string, unknown> => ({
    type: 'Navigation',
    frame: { id: 'frame-1', loaderId: 'loader-1', url },
  });

  it('writes a navigate row for a main-frame commit and a load row when its document finishes', async () => {
    const { connection, teeCdp } = await armed();
    const session = 'session-page-1';
    const url = 'https://example.test/checkout';

    // The wire order the probe saw: request, commit, completion. Only the
    // last pair earns rows, in the order the events arrived.
    connection.emit(
      'Network.requestWillBeSent',
      {
        requestId: 'request-1',
        loaderId: 'loader-1',
        frameId: 'frame-1',
        type: 'Document',
        request: { url },
      },
      session,
    );
    connection.emit('Page.frameNavigated', commit(url), session);
    connection.emit(
      'Network.loadingFinished',
      { requestId: 'request-1', encodedDataLength: 535 },
      session,
    );

    expect(teeCdp.mock.calls).toEqual([
      ['bot-1', { type: 'navigate', payload: { url } }],
      ['bot-1', { type: 'load', payload: { url } }],
    ]);
  });

  it('drops a subframe commit and its document load', async () => {
    const { connection, teeCdp } = await armed();
    const session = 'session-page-1';

    connection.emit(
      'Page.frameNavigated',
      {
        type: 'Navigation',
        frame: {
          id: 'frame-sub',
          parentId: 'frame-1',
          loaderId: 'loader-sub',
          url: 'https://ads.test/frame',
        },
      },
      session,
    );
    connection.emit(
      'Network.requestWillBeSent',
      {
        requestId: 'request-sub',
        frameId: 'frame-sub',
        type: 'Document',
        request: { url: 'https://ads.test/frame' },
      },
      session,
    );
    connection.emit('Network.loadingFinished', { requestId: 'request-sub' }, session);

    expect(teeCdp).not.toHaveBeenCalled();
  });

  it('ignores navigation events from a session this capture did not arm', async () => {
    const { connection, teeCdp } = await armed();

    // Chrome delivers a target's events to every session attached to it; a
    // listener on the connection must not count another session's copy.
    connection.emit('Page.frameNavigated', commit(), 'session-someone-else');
    connection.emit(
      'Network.requestWillBeSent',
      {
        requestId: 'r9',
        frameId: 'frame-9',
        type: 'Document',
        request: { url: 'https://other.test/' },
      },
      'session-someone-else',
    );
    connection.emit('Network.loadingFinished', { requestId: 'r9' }, 'session-someone-else');
    // And an event with no session at all belongs to no page.
    connection.emit('Page.frameNavigated', commit());

    expect(teeCdp).not.toHaveBeenCalled();
  });

  it('drops junk navigation params without spending the recording', async () => {
    const { connection, teeCdp } = await armed();
    const session = 'session-page-1';

    for (const params of [{}, { frame: null }, { frame: { id: 7, url: {} } }, { requestId: {} }]) {
      connection.emit('Page.frameNavigated', params, session);
      connection.emit('Network.requestWillBeSent', params, session);
      connection.emit('Network.loadingFinished', params, session);
    }

    expect(teeCdp).not.toHaveBeenCalled();
  });

  it('forgets a destroyed target’s pairing state', async () => {
    const { connection, teeCdp } = await armed();

    connection.emit('Target.targetDestroyed', { targetId: 'page-1' });
    connection.emit('Page.frameNavigated', commit(), 'session-page-1');

    // The page is gone, so a navigation attributed to its session is not
    // evidence — even in the moment before something re-attaches under the
    // same target id.
    expect(teeCdp).not.toHaveBeenCalled();
  });

  it('stops writing navigation rows once disarmed', async () => {
    const { connection, service, teeCdp } = await armed();
    await service.disarm('bot-1', 'rec-1');

    connection.emit('Page.frameNavigated', commit(), 'session-page-1');
    connection.emit('Network.loadingFinished', { requestId: 'request-1' }, 'session-page-1');

    expect(teeCdp).not.toHaveBeenCalled();
  });

  it('keeps a page usable when its Network domain refuses — commits still land, loads do not', async () => {
    const connection = new FakeConnection();
    connection.targets = [page('page-1')];
    connection.failWhen = (method) =>
      method === 'Network.enable' ? new Error('domain refused') : null;
    const { service, teeCdp } = setup(connection);
    const session = 'session-page-1';

    service.arm('bot-1', 'rec-1');
    await vi.waitFor(() => expect(sessionCommands(connection, session)).toHaveLength(5));

    // The refused step did not cost the page: the script is registered and
    // the binding still reports clicks...
    expect(sessionCommands(connection, session)).toContain('Page.addScriptToEvaluateOnNewDocument');
    connection.emit(
      'Runtime.bindingCalled',
      {
        name: CAPTURE_BINDING_NAME,
        payload: JSON.stringify({ type: 'click' }),
        executionContextId: 1,
      },
      session,
    );
    // ...and a main-frame commit still earns its row, because nothing about
    // `navigate` depends on the Network domain.
    connection.emit('Page.frameNavigated', commit(), session);

    expect(teeCdp).toHaveBeenCalledWith('bot-1', { type: 'click', payload: {} });
    expect(teeCdp).toHaveBeenCalledWith('bot-1', {
      type: 'navigate',
      payload: { url: 'https://example.test/' },
    });
  });
});

/**
 * M5-BE-24 — which pages are THIS bot's.
 *
 * A machine is shared and its screen is not (D-046): every bot on it has its
 * own Chrome window, and `Target.setDiscoverTargets` announces every window's
 * page targets to whoever is listening. Before this, a recording armed all of
 * them — so two bots recording at once each captured the other's navigations,
 * and even one recording captured the machine's own launch window.
 */
describe('CdpCaptureService — a seat owns its pages', () => {
  /**
   * D-060 moved this guarantee from a filter to a connection.
   *
   * When every bot's window lived in the machine's one browser, a recording saw
   * every page that browser had open and had to drop the ones outside the
   * seat's Chrome window — `Browser.getWindowForTarget` on each target, with
   * "arm it anyway" on failure so a page the operator was driving could not be
   * lost. A seat is now a browser of its own, and `endpointFor` dials it, so
   * the pages on this connection ARE the bot's.
   *
   * These cases therefore assert the opposite of what they used to: nothing is
   * dropped, and the browser is never asked to place a target at all.
   */
  it('arms every page on the connection, because they are all this bot’s', async () => {
    const connection = new FakeConnection();
    connection.targets = [page('mine-1'), page('mine-2')];
    const { service } = setup(connection);

    service.arm('bot-1', 'rec-1');
    await vi.waitFor(() =>
      expect(
        connection.sent.filter((command) => command.method === 'Target.attachToTarget'),
      ).toHaveLength(2),
    );

    // The old filter, asserted absent: a seat's browser has nothing to place a
    // target against, and asking would be a round trip per target for an answer
    // that is now always the same.
    expect(connection.sent.some((command) => command.method === 'Browser.getWindowForTarget')).toBe(
      false,
    );
  });

  it('arms a tab opened after the recording started', async () => {
    const connection = new FakeConnection();
    connection.targets = [page('mine-1')];
    const { service } = setup(connection);
    service.arm('bot-1', 'rec-1');
    await vi.waitFor(() => expect(sessionCommands(connection, 'session-mine-1')).toHaveLength(5));

    connection.emit('Target.targetCreated', { targetInfo: page('mine-2') });

    await vi.waitFor(() =>
      expect(
        connection.sent.some(
          (c) => c.method === 'Target.attachToTarget' && c.params['targetId'] === 'mine-2',
        ),
      ).toBe(true),
    );
  });

  it('does not create a seat just because someone pressed record', async () => {
    // `endpointFor` resolves the seat read-only and throws when there is none;
    // `ensureSeat` would put a desktop on the machine as a side effect of
    // observing it. Here that surfaces as a capture that arms nothing and
    // leaves the recording to the X11 layer.
    const { service, connectionFor } = setup(null);

    service.arm('bot-1', 'rec-1');
    await vi.waitFor(() => expect(connectionFor).toHaveBeenCalled());

    expect(connectionFor).toHaveBeenCalledWith('bot-1', 'rec-1');
  });
});
