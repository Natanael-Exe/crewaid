import { describe, expect, it } from 'vitest';
import type { BotWithSandbox } from '@crewaid/shared';
import type { WakeStatus } from '../src/renderer/state/chatReducer';
import {
  FULLSCREEN_QUALITY,
  screenCardPresentation,
  screenCardView,
  THUMBNAIL_QUALITY,
  VIEWER_DISPLAY_POLICY,
} from '../src/renderer/screen/screenCardState';

const bot = (sandbox: BotWithSandbox['sandbox']): BotWithSandbox =>
  ({ id: 'b1', name: 'Quill', sandbox }) as BotWithSandbox;

const sandbox = (
  state: string,
  extra: Partial<{ lastError: string | null; widthPx: number; heightPx: number }> = {},
): BotWithSandbox['sandbox'] =>
  ({
    state,
    widthPx: extra.widthPx ?? 1280,
    heightPx: extra.heightPx ?? 800,
    lastError: extra.lastError ?? null,
  }) as unknown as BotWithSandbox['sandbox'];

describe('screenCardView (M2-FE-01)', () => {
  it('has nothing to show without a bot', () => {
    expect(screenCardView(null)).toEqual({ kind: 'no-bot' });
  });

  it('treats a bot that was never started the same as a stopped one', () => {
    // A missing `Sandbox` row is our schema, not something the operator can
    // act on differently from STOPPED.
    expect(screenCardView(bot(null))).toEqual({
      kind: 'stopped',
      caption: "Quill's screen",
    });
  });

  it('goes live only for RUNNING, and carries the geometry with it', () => {
    // The geometry is what the synthetic ServerInit declares, so it has to
    // come from the row rather than a constant that happens to match §5.
    expect(screenCardView(bot(sandbox('RUNNING', { widthPx: 1024, heightPx: 768 })))).toEqual({
      kind: 'live',
      caption: "Quill's screen",
      widthPx: 1024,
      heightPx: 768,
    });
  });

  it.each(['STARTING', 'STOPPED'])('shows %s without a canvas', (state) => {
    const view = screenCardView(bot(sandbox(state)));
    expect(view.kind).not.toBe('live');
  });

  it.each(['UNHEALTHY', 'ERROR'])('keeps the stored reason for %s, as a reason', (state) => {
    // The §4.2 frame that announced the transition is long gone by the time
    // anyone looks at the rail; `lastError` is where the reason survives. It
    // rides as `reason` and NOT as `detail`, because `detail` is what the card
    // says out loud and this text was written for whoever is debugging the
    // host (D-093).
    expect(screenCardView(bot(sandbox(state, { lastError: 'bridge probe timed out' })))).toEqual({
      kind: 'failed',
      caption: "Quill's screen",
      detail: null,
      reason: 'bridge probe timed out',
    });
  });

  it('asks for a low quality, because the shared stream settles on the max', () => {
    // A rail thumbnail cannot show the difference, and M2-BE-06 gives every
    // subscriber the best quality anyone asked for — so a modest request here
    // never degrades the operator's full-screen view.
    expect(THUMBNAIL_QUALITY).toBeLessThan(5);
    expect(THUMBNAIL_QUALITY).toBeGreaterThanOrEqual(0);
  });
});

describe('screenCardPresentation (M2-FE-02)', () => {
  const live = bot(sandbox('RUNNING'));

  it('offers the expand affordance only when there is a picture to expand', () => {
    // Expanding a placeholder would be a full-window box reading "not running".
    expect(screenCardPresentation(live, false).canExpand).toBe(true);
    for (const state of ['STARTING', 'STOPPED', 'UNHEALTHY', 'ERROR']) {
      expect(screenCardPresentation(bot(sandbox(state)), false).canExpand).toBe(false);
    }
    expect(screenCardPresentation(null, false).canExpand).toBe(false);
  });

  it('raises the §4.3 quality for the full-screen surface and drops it back', () => {
    // The two surfaces are ONE subscription that changes level (D-037), so the
    // quality is the whole of the difference between them on the wire.
    expect(screenCardPresentation(live, false).quality).toBe(THUMBNAIL_QUALITY);
    expect(screenCardPresentation(live, true).quality).toBe(FULLSCREEN_QUALITY);
    expect(FULLSCREEN_QUALITY).toBeGreaterThan(THUMBNAIL_QUALITY);
    // §4.2 `screen.subscribe` validates 0..9 server-side; a request outside it
    // is refused with an error frame rather than clamped.
    expect(FULLSCREEN_QUALITY).toBeLessThanOrEqual(9);
  });

  it('keeps the viewer open when the desktop dies under it', () => {
    // The operator asked for full screen; the sandbox falling over is not a
    // reason to drop them back to the rail with the reason off screen.
    const dead = screenCardPresentation(
      bot(sandbox('UNHEALTHY', { lastError: 'bridge probe timed out' })),
      true,
    );
    expect(dead.expanded).toBe(true);
    // The operator reads a sentence; the probe's own words stay reachable.
    expect(dead.placeholder).not.toContain('bridge probe');
    expect(dead.placeholder).toMatch(/Something went wrong/);
    expect(dead.placeholderDetail).toBe('bridge probe timed out');
    expect(dead.canExpand).toBe(false);
  });

  it('has placeholder copy for every state but the live one', () => {
    expect(screenCardPresentation(live, false).placeholder).toBeNull();
    expect(screenCardPresentation(null, false).placeholder).toBe('No bot selected');
    expect(screenCardPresentation(bot(sandbox('STARTING')), false).placeholder).toMatch(/Waking/);
    expect(screenCardPresentation(bot(sandbox('STOPPED')), false).placeholder).toMatch(/asleep/);
    // A failure with nothing stored in `lastError` still has to say something,
    // and it is the same sentence as a failure that has one — the difference
    // is only whether there is a diagnostic behind it.
    const bare = screenCardPresentation(bot(sandbox('ERROR')), false);
    expect(bare.placeholder).toMatch(/Something went wrong/);
    expect(bare.placeholderDetail).toBeNull();
  });

  it('never puts a runtime id or a volume name in front of the operator', () => {
    // The sweep's own sentence, verbatim: every noun in it names something the
    // person looking at this card cannot reach.
    const swept = screenCardPresentation(
      bot(
        sandbox('UNHEALTHY', {
          lastError:
            'Runtime cmu5xx1420005z33btg0tr7yb is missing; workspace ' +
            'crewaid-workspace-cmu5xx1420005z33btg0tr7yb was preserved. Replacement ' +
            'requires an explicit start/recovery action.',
        }),
      ),
      false,
    );
    expect(swept.placeholder).not.toMatch(/cmu5xx|workspace|Runtime|recovery action/);
    expect(swept.placeholder).toBe(
      'Something went wrong with this computer. If it keeps happening, contact your team.',
    );
    // Still recoverable by whoever runs the server, just not as the message.
    expect(swept.placeholderDetail).toContain('cmu5xx1420005z33btg0tr7yb');
  });

  it('takes input only on the full-screen surface (M2-FE-03)', () => {
    // The rail is a few hundred pixels wide and `scaleViewport` multiplies a
    // click in it up to somewhere the operator never aimed, on a desktop they
    // are watching out of the corner of their eye. View-only there is the
    // point of the surface, not a limitation waiting to be lifted.
    expect(screenCardPresentation(live, false).interactive).toBe(false);
    expect(screenCardPresentation(live, true).interactive).toBe(true);
  });

  it('stops taking input the moment there is no live desktop under it', () => {
    // The viewer deliberately stays open when the sandbox dies (above), so
    // `expanded` alone would keep forwarding keystrokes at a placeholder —
    // and every one of them would come back as a §4.2 error frame, because
    // the subscription they were authorised by is gone with the desktop.
    for (const state of ['STARTING', 'STOPPED', 'UNHEALTHY', 'ERROR']) {
      expect(screenCardPresentation(bot(sandbox(state)), true).interactive).toBe(false);
    }
    expect(screenCardPresentation(null, true).interactive).toBe(false);
  });

  it('names the card when no bot is selected', () => {
    expect(screenCardPresentation(null, false).caption).toBe('No bot selected');
    expect(screenCardPresentation(live, false).caption).toBe("Quill's screen");
  });
});

describe('the wake laid over the row (CC-16, D-039 §16)', () => {
  const waking: WakeStatus = { kind: 'waking' };
  const capacity: WakeStatus = { kind: 'capacity', message: 'This host is already running six.' };
  const failed: WakeStatus = { kind: 'failed', message: 'Could not reach the server.' };

  it('shows the click before the row has caught up with it', () => {
    // The moment the whole feature turns on. For the first beat after the
    // press the row still honestly reads STOPPED, and rendering that would
    // answer "open this computer" with "the computer is asleep".
    const view = screenCardView(bot(sandbox('STOPPED')), waking);

    expect(view.kind).toBe('starting');
    expect(screenCardPresentation(bot(sandbox('STOPPED')), false, waking).placeholder).toMatch(
      /Waking/,
    );
  });

  it('wakes a bot that has no sandbox row at all', () => {
    // A bot created before M3-BE-10 has no row until the orchestrator writes
    // one, and it is exactly the bot most likely to be woken by hand.
    expect(screenCardView(bot(null), waking).kind).toBe('starting');
  });

  it('lets a live desktop outrank any request for it', () => {
    // A wake resolving against an already-running computer is what M3-BE-11's
    // idempotent ensure-ready is for. Showing "Waking…" over a picture would
    // hide the desktop behind a description of a request about it.
    for (const wake of [waking, capacity, failed]) {
      expect(screenCardView(bot(sandbox('RUNNING')), wake).kind).toBe('live');
    }
  });

  it('keeps a full host separate from a broken computer', () => {
    // D-039 §16.1. One means someone else is using the slot and the identical
    // request works later; the other means this bot's computer is unwell.
    // Folding them together sends the operator looking for a fault that is
    // not there — or worse, ignoring one that is.
    const full = screenCardView(bot(sandbox('STOPPED')), capacity);
    const broken = screenCardView(bot(sandbox('ERROR', { lastError: 'bridge probe timed out' })));

    expect(full).toEqual({
      kind: 'capacity',
      caption: "Quill's screen",
      detail: 'This host is already running six.',
    });
    expect(broken.kind).toBe('failed');
  });

  it('offers a retry for both refusals and none while one is in flight', () => {
    // A second press during a wake asks the same question of a host that is
    // already answering it.
    expect(screenCardPresentation(bot(sandbox('STOPPED')), false, waking).action).toBeNull();
    expect(screenCardPresentation(bot(sandbox('STARTING')), false).action).toBeNull();
    expect(screenCardPresentation(bot(sandbox('STOPPED')), false, capacity).action).toEqual({
      kind: 'retry',
      label: 'Try again',
    });
    expect(screenCardPresentation(bot(sandbox('STOPPED')), false, failed).action).toEqual({
      kind: 'retry',
      label: 'Try again',
    });
  });

  it('asks to open a computer nobody has asked for yet', () => {
    // "Try again" on a first attempt implies a failure that never happened.
    expect(screenCardPresentation(bot(sandbox('STOPPED')), false).action).toEqual({
      kind: 'open',
      label: 'Open computer',
    });
    expect(screenCardPresentation(bot(null), false).action).toEqual({
      kind: 'open',
      label: 'Open computer',
    });
  });

  it('offers nothing to press on a live computer or with no bot', () => {
    // There is no Stop: D-041 made idle stop the way a computer goes down, and
    // a Stop button could pull the desktop out from under a turn still using it.
    expect(screenCardPresentation(bot(sandbox('RUNNING')), false).action).toBeNull();
    expect(screenCardPresentation(null, false).action).toBeNull();
  });

  it('lets the row report a start it knows about over a stale refusal', () => {
    // Something IS coming up — a skill or a recording woke the same computer
    // (§16) — so the last refusal this window saw is no longer the news.
    expect(screenCardView(bot(sandbox('STARTING')), capacity).kind).toBe('starting');
  });
});

describe('VIEWER_DISPLAY_POLICY (R8)', () => {
  it('scales the picture and never the display', () => {
    // R8 fixes the framebuffer for the container's lifetime. `resizeSession`
    // is noVNC asking the server to change it, which is the one thing this
    // renderer may never do; `scaleViewport` is how the same pixels fit a
    // 355px rail and a 27" monitor.
    expect(VIEWER_DISPLAY_POLICY).toEqual({ scaleViewport: true, resizeSession: false });
  });
});
