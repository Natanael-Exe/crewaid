import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';

import { CdpAttachService } from './cdp-attach.service.js';
import type { CdpConnection, CdpEvent } from './cdp-connection.js';
import { CAPTURE_BINDING_NAME, CAPTURE_SCRIPT_SOURCE } from './cdp-capture-script.js';
import { parseCaptureReport } from './cdp-events.js';
import {
  createNavPairingState,
  noteDocumentRequest,
  noteFrameNavigated,
  takeDocumentLoadFinished,
  type NavPairingState,
} from './cdp-nav-events.js';
import { RecordingTeeService } from './recording-tee.service.js';

/**
 * The capture script, installed per page and reported into the tee.
 *
 * What arming one page is
 *
 * "Inject a capture script via `Page.addScriptToEvaluateOnNewDocument`
 * listening for `click`, `input`, `change`, and `submit` in the capture phase,
 * reporting over a CDP binding." Arming is the five-command sequence that
 * makes that true for one page — and the order in it is load-bearing. Every
 * step was probed against the sandbox's own Chrome (152) rather than assumed;
 * the surprises are called out where they bite:
 *
 * 1. `Target.attachToTarget` (flattened). `Page.*` and `Runtime.*` are
 * per-target domains; the attach connection is browser-scoped.
 * 2. `Runtime.enable`. Without it, no `Runtime.bindingCalled` is delivered.
 * 3. `Runtime.addBinding`. BEFORE the script runs: the script snapshots the
 * binding when it runs, and a binding is added to contexts created later
 * as well, so documents that load after this point still have it.
 * 4. `Page.enable`. The least obvious step and the one a probe found: with
 * the Page domain disabled, `Page.addScriptToEvaluateOnNewDocument`
 * still answers `{identifier}` and the registration is silently never
 * delivered to the renderer — a canary script registered that way ran on
 * no later document at all. With it, every navigation runs the script.
 * 5. `Network.enable`. Not part of §6's injection sentence, but the domain
 * that carries `Network.loadingFinished`; its failure is
 * forgiven in place, because the interactions the recording is really
 * made of do not depend on it (see `armTarget`).
 * 6. `Page.addScriptToEvaluateOnNewDocument` with `runImmediately: true`.
 * The registration covers every future document; `runImmediately` covers
 * the document already loaded, so a page that has been open for hours
 * still captures its next interaction.
 *
 * Which pages
 *
 * Every `page` target of the sandbox's browser, now and for the recording's
 * duration: `Target.setDiscoverTargets` announces the targets that already
 * exist and every later one — a second tab opened mid-recording is a page the
 * operator is interacting with. Non-page targets (`browser_ui`, `iframe`,
 * workers) are ignored; the four interactions happen in pages. The sweep that
 * follows discovery is not a second mechanism racing it: both go through one
 * map, and a target's slot is claimed synchronously before its attach is
 * sent, so a target announced twice is attached once.
 *
 * Why navigation events are filtered by session
 *
 * Chrome delivers a page's protocol events to EVERY session attached to its
 * target, so one navigation is one `Page.frameNavigated` per attached session
 * (M4-BE-04's probe saw two sessions receive the same commit). These
 * listeners live on the connection, which may carry sessions this service
 * does not own, so an event counts only when its sessionId is one this
 * capture armed — otherwise a navigation would reach the trace as many times
 * as something happens to be attached to the tab.
 *
 * Why nothing here can fail a recording
 *
 * Same polarity as the attach: every failure — no connection, a
 * target that died mid-attach, a command that times out — is logged and costs
 * the CDP layer for that page, nothing else. The X11 tee is untouched by any
 * of it, which is what §6/M4's degradation clause asks for.
 *
 * Why disarm asks before anything closes
 *
 * Disarm removes the registrations while the connection is still open:
 * `Page.removeScriptToEvaluateOnNewDocument` and `Runtime.removeBinding` are
 * commands, and there is nothing left to send them over once the socket the
 * attach service owns has closed. The order — disarm, then detach — belongs
 * to the lifecycle (`recordings.service.ts`), which is the only thing that
 * knows when a recording begins and ends. The Network domain has
 * nothing to add to that list: it is session-scoped and page-invisible, so
 * it cannot outlive the socket the way a registered script or a page global
 * can — dropping the listener is the whole of stopping it.
 */

/** One page target with the capture installed in it. */
interface ArmedTarget {
  readonly sessionId: string;
  /** The registration handle, so disarm can take the script back out. */
  readonly scriptId: string | null;
}

/** One recording's capture, in flight or armed. */
interface ArmedCapture {
  readonly recordingId: string;
  /** Set by `disarm`: an install still running ends itself. */
  detached: boolean;
  connection: CdpConnection | null;
  /**
   * Targets handled, keyed by targetId. A `null` value is a claim in flight —
   * set synchronously so a target announced twice is only attached once.
   */
  readonly targets: Map<string, ArmedTarget | null>;
  /**
   * One navigation pairing state per armed session, keyed by
   * sessionId. Entries live exactly as long as their target's slot does:
   * created when the attach answers, deleted when the target dies or its
   * install fails.
   */
  readonly nav: Map<string, NavPairingState>;
  /** Listeners to drop on the way out. */
  readonly unsubscribers: Array<() => void>;
  /** The install in flight; resolves without rejecting. */
  settled: Promise<void>;
}

@Injectable()
export class CdpCaptureService implements OnModuleDestroy {
  private readonly logger = new Logger(CdpCaptureService.name);

  private readonly captures = new Map<string, ArmedCapture>();

  // Explicit tokens: vitest/esbuild emits no design:paramtypes, so type-based
  // DI resolution silently fails in the integration suite.
  constructor(
    @Inject(CdpAttachService) private readonly cdp: CdpAttachService,
    @Inject(RecordingTeeService) private readonly tee: RecordingTeeService,
  ) {}

  /**
   * Begin arming the capture for a recording. Returns immediately — the
   * connect is in flight from here (it awaits the attach through
   * `connectionFor`), and nothing in the recording path waits on it.
   */
  arm(botId: string, recordingId: string): void {
    const existing = this.captures.get(botId);
    if (existing !== undefined) {
      if (existing.recordingId === recordingId) return;
      // Same self-heal as the attach: a slot can only survive a recording
      // that ended without disarming. Replacing it is the difference between
      // a later recording that captures and one that silently does not.
      this.logger.warn(
        `bot ${botId}: replacing a CDP capture left over from recording ${existing.recordingId}`,
      );
      void this.disarm(botId);
    }
    const capture: ArmedCapture = {
      recordingId,
      detached: false,
      connection: null,
      targets: new Map(),
      nav: new Map(),
      unsubscribers: [],
      settled: Promise.resolve(),
    };
    this.captures.set(botId, capture);
    capture.settled = this.install(botId, capture);
  }

  /**
   * Stop the capture for a recording and take its registrations back out.
   * Idempotent, never rejects, safe to call for a bot that never armed — the
   * same contract as the attach's `detach`, and for the same reason: every
   * path that ends a recording calls it, including paths that never armed.
   */
  async disarm(botId: string, recordingId?: string): Promise<void> {
    const capture = this.captures.get(botId);
    if (capture === undefined) return;
    if (recordingId !== undefined && capture.recordingId !== recordingId) return;
    this.captures.delete(botId);
    capture.detached = true;
    await capture.settled;
    const connection = capture.connection;
    if (connection !== null && !connection.closed) {
      for (const armed of capture.targets.values()) {
        if (armed !== null) await this.removeTarget(connection, armed);
      }
    }
    for (const unsubscribe of capture.unsubscribers.splice(0)) unsubscribe();
  }

  /**
   * A process that is going away leaves nothing behind in any page it can
   * still reach. The connection itself is closed by the attach service's own
   * shutdown hook; this only gets the script and the binding out first.
   */
  async onModuleDestroy(): Promise<void> {
    for (const botId of [...this.captures.keys()]) await this.disarm(botId);
  }

  /**
   * Resolve the connection, subscribe to what pages report, and arm what is
   * already open. Resolves on any failure — it never rejects, because every
   * caller is on a path where a missing browser is a degradation.
   */
  private async install(botId: string, capture: ArmedCapture): Promise<void> {
    try {
      const connection = await this.cdp.connectionFor(botId, capture.recordingId);
      if (connection === null) return;
      // A disarm that landed while this was resolving has already dropped the
      // slot; nothing may be installed after it.
      if (capture.detached || connection.closed) return;
      capture.connection = connection;

      // D-060 — which pages are THIS bot's: all of them, on this connection.
      //
      // This used to need a filter. A machine is shared and its screen is not,
      // so when every bot's window lived in the machine's one browser, a
      // recording armed every page that browser had open: two bots recording at
      // once each captured the other's navigations, and even one recording
      // captured the machine's launch window, which belongs to nobody. M5-BE-24
      // filtered on the seat's Chrome WINDOW id to fix that.
      //
      // A seat is now a browser of its own on its own `--user-data-dir`, and
      // `endpointFor` dials that browser — so the connection is the scope and
      // the filter is gone. It is a stronger guarantee than the window id was:
      // a tab the bot opens later is on this endpoint too, and a second seat's
      // pages are not reachable from it at all.

      capture.unsubscribers.push(
        connection.on('Runtime.bindingCalled', (event) => {
          this.report(botId, event);
        }),
        connection.on('Target.targetCreated', (event) => {
          const targetId = pageTargetIdOf(event.params['targetInfo']);
          if (targetId !== null) void this.armTarget(capture, targetId);
        }),
        connection.on('Target.targetDestroyed', (event) => {
          const targetId = readString(event.params, 'targetId');
          if (targetId === null) return;
          const armed = capture.targets.get(targetId);
          capture.targets.delete(targetId);
          // The page is gone, so its pairing state has no events left to
          // judge; a navigation from a destroyed target is not evidence.
          if (armed !== null && armed !== undefined) capture.nav.delete(armed.sessionId);
        }),
        // M4-BE-04's three: the commit that earns a `navigate` row, the
        // document requests that make later completions recognizable, and the
        // completion that earns a `load` row (see `cdp-nav-events.ts`).
        connection.on('Page.frameNavigated', (event) => {
          this.frameNavigated(botId, capture, event);
        }),
        connection.on('Network.requestWillBeSent', (event) => {
          this.documentRequest(capture, event);
        }),
        connection.on('Network.loadingFinished', (event) => {
          this.loadFinished(botId, capture, event);
        }),
      );

      // Discovery first: it announces every existing target, so a page
      // created while the sweep below runs cannot fall between the two.
      await connection.send('Target.setDiscoverTargets', { discover: true });
      const targets = await connection.send('Target.getTargets');
      await Promise.all(pageTargetIds(targets).map((id) => this.armTarget(capture, id)));

      const armed = [...capture.targets.values()].filter((target) => target !== null).length;
      this.logger.log(
        `recording ${capture.recordingId}: capture armed for ${armed} page target(s)`,
      );
    } catch (error: unknown) {
      this.logger.warn(
        `recording ${capture.recordingId}: the CDP capture could not be armed for bot ` +
          `${botId}: ${describe(error)}. The recording continues at the X11 layer.`,
      );
    }
  }

  /**
   * Attach to one page target and install the capture in it.
   *
   * Failures cost this page and nothing else. The slot is claimed before the
   * first await so a target announced twice — once by discovery, once by the
   * sweep — is attached once.
   */
  private async armTarget(capture: ArmedCapture, targetId: string): Promise<void> {
    if (capture.detached) return;
    if (capture.targets.has(targetId)) return;
    capture.targets.set(targetId, null);

    const connection = capture.connection;
    if (connection === null) {
      capture.targets.delete(targetId);
      return;
    }

    let sessionId: string | null = null;
    try {
      const attached = await connection.send('Target.attachToTarget', {
        targetId,
        flatten: true,
      });
      sessionId = readString(attached, 'sessionId');
      if (sessionId === null || capture.detached) {
        capture.targets.delete(targetId);
        return;
      }

      // M4-BE-04: the pairing state exists from here, BEFORE any domain is
      // enabled — an event that arrives the instant an enable answers must
      // find somewhere to land, not race this registration.
      capture.nav.set(sessionId, createNavPairingState());

      // The arm sequence documented at the top of the file. Steps 2 and 3
      // first, because the script about to be registered snapshots the
      // binding; step 4 is what makes step 6 take effect at all.
      await connection.send('Runtime.enable', {}, sessionId);
      await connection.send('Runtime.addBinding', { name: CAPTURE_BINDING_NAME }, sessionId);
      await connection.send('Page.enable', {}, sessionId);
      // M4-BE-04's domain, and the one step of this sequence that is
      // forgiven rather than fatal. The navigation rows are an addition on
      // top of the page's interaction capture, not a condition of it: a page
      // whose Network domain refuses still contributes its clicks, its
      // `navigate` rows and everything the X11 layer sees.
      await connection.send('Network.enable', {}, sessionId).catch((error: unknown) => {
        this.logger.warn(
          `recording ${capture.recordingId}: the navigation capture could not enable the ` +
            `Network domain in page ${targetId}: ${describe(error)}. Interaction capture ` +
            `continues; document loads will not be recorded.`,
        );
      });
      const added = await connection.send(
        'Page.addScriptToEvaluateOnNewDocument',
        { source: CAPTURE_SCRIPT_SOURCE, runImmediately: true },
        sessionId,
      );
      const registered: ArmedTarget = { sessionId, scriptId: readString(added, 'identifier') };
      if (capture.detached) {
        // A disarm raced this install and has already walked past this
        // target's slot (it was still a claim). The registration it cannot
        // see comes back out here, while the socket may still be open.
        capture.nav.delete(sessionId);
        await this.removeTarget(connection, registered);
        return;
      }
      capture.targets.set(targetId, registered);
      this.logger.debug(`recording ${capture.recordingId}: capture installed in page ${targetId}`);
    } catch (error: unknown) {
      capture.targets.delete(targetId);
      // A page that failed to arm contributes no rows, navigation or
      // otherwise; its pairing state goes with its slot.
      if (sessionId !== null) capture.nav.delete(sessionId);
      this.logger.warn(
        `recording ${capture.recordingId}: the capture could not be installed in page ` +
          `${targetId}: ${describe(error)}`,
      );
    }
  }

  /**
   * Take one target's registration and binding back out. Best-effort by
   * design: a page that navigated away or a target that died since is not a
   * reason to skip the others, and the socket close that follows ends
   * anything these commands did not.
   */
  private async removeTarget(connection: CdpConnection, armed: ArmedTarget): Promise<void> {
    if (connection.closed) return;
    if (armed.scriptId !== null) {
      await connection
        .send(
          'Page.removeScriptToEvaluateOnNewDocument',
          { identifier: armed.scriptId },
          armed.sessionId,
        )
        .catch(() => undefined);
    }
    await connection
      .send('Runtime.removeBinding', { name: CAPTURE_BINDING_NAME }, armed.sessionId)
      .catch(() => undefined);
  }

  /**
   * One binding call, turned into one trace event — or into nothing.
   *
   * The binding is callable by any script on the page (§7.3: the sandbox is
   * the untrusted side of this connection), so a payload is inspected, never
   * trusted: `parseCaptureReport` returns null for anything that does not
   * survive field-by-field validation, and null is simply not evidence. The
   * call site counts nothing and rethrows nothing — a page calling the
   * binding with junk is a page doing what pages may do.
   *
   * Unlike the navigation handlers, this one does NOT filter on
   * `event.sessionId`, and the difference is deliberate. Those subscribe to
   * Page and Network events, which Chrome broadcasts to every session
   * attached to a target — including sessions this capture never armed (the
   * M4-BE-04 probe saw two receive the same commit), so they must ask whether
   * the event is theirs. `Runtime.bindingCalled` is not broadcast: it is
   * delivered only to the session that called `Runtime.addBinding`, which is
   * this capture's. Adding a filter here would change behaviour in one case
   * only — a report that arrives just after its target was destroyed and its
   * session forgotten — and dropping that would lose a real interaction the
   * operator performed. (M4-RV-01: verified as reasoning, not changed.)
   */
  private report(botId: string, event: CdpEvent): void {
    const name = event.params['name'];
    if (name !== CAPTURE_BINDING_NAME) return;
    const payload = event.params['payload'];
    if (typeof payload !== 'string') return;
    const captured = parseCaptureReport(payload);
    if (captured === null) return;
    // Synchronous, unawaited, never throws: the tee's contract for a caller
    // that is a WebSocket frame from a sandbox.
    this.tee.teeCdp(botId, captured);
  }

  /**
   * A document committed in some frame; a main-frame one earns a `navigate`
   * row (M4-BE-04). Subframe commits are dropped in the parser, which is the
   * filter the trace's wait conditions want: `waitForLoadState` is a promise
   * about the main frame (`cdp-nav-events.ts`).
   *
   * Same posture as everything else on this path: synchronous, unawaited,
   * never throws — an event from the peer is not allowed to cost a recording
   * that would otherwise have been fine.
   */
  private frameNavigated(botId: string, capture: ArmedCapture, event: CdpEvent): void {
    const state = this.navState(capture, event);
    if (state === null) return;
    const row = noteFrameNavigated(state, event.params);
    if (row !== null) this.tee.teeCdp(botId, row);
  }

  /**
   * A request began; the ones that carry documents are remembered so their
   * completions can be recognized (M4-BE-04). No row comes from this — it is
   * the pairing mechanism, not evidence the compiler reads.
   */
  private documentRequest(capture: ArmedCapture, event: CdpEvent): void {
    const state = this.navState(capture, event);
    if (state === null) return;
    noteDocumentRequest(state, event.params);
  }

  /**
   * A request finished; a main-frame document's becomes a `load` row
   * (M4-BE-04). The event alone cannot be judged — it is identical for the
   * page's own load and for the hundredth image — so the parser answers only
   * for requests its session watched being documents (see `cdp-nav-events.ts`).
   */
  private loadFinished(botId: string, capture: ArmedCapture, event: CdpEvent): void {
    const state = this.navState(capture, event);
    if (state === null) return;
    const row = takeDocumentLoadFinished(state, event.params);
    if (row !== null) this.tee.teeCdp(botId, row);
  }

  /**
   * The pairing state of the page session this event arrived on, or null.
   *
   * Chrome delivers a target's events to every session attached to it, and
   * this connection's listener set is not limited to this capture's sessions
   * — so an event whose sessionId this capture never armed is not this
   * capture's evidence. See the session filter note at the top of the file.
   */
  private navState(capture: ArmedCapture, event: CdpEvent): NavPairingState | null {
    if (event.sessionId === undefined) return null;
    return capture.nav.get(event.sessionId) ?? null;
  }
}

/** One `targetInfos` entry (or `Target.targetCreated`'s `targetInfo`) → a page's id. */
function pageTargetIdOf(info: unknown): string | null {
  if (typeof info !== 'object' || info === null) return null;
  const record = info as Record<string, unknown>;
  if (record['type'] !== 'page') return null;
  return readString(record, 'targetId');
}

/** `Target.getTargets` result → the ids of every page target it lists. */
function pageTargetIds(result: Record<string, unknown>): string[] {
  const infos = result['targetInfos'];
  if (!Array.isArray(infos)) return [];
  const ids: string[] = [];
  for (const info of infos) {
    const targetId = pageTargetIdOf(info);
    if (targetId !== null) ids.push(targetId);
  }
  return ids;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
