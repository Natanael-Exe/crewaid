import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@heroui/react';
import type { BotWithSandbox } from '@crewaid/shared';
import { ScreenPlaceholder } from '../src/renderer/screen/ScreenPlaceholder';
import { screenCardPresentation } from '../src/renderer/screen/screenCardState';
import type { WakeStatus } from '../src/renderer/state/chatReducer';

/**
 * The card with no picture in it (CC-16).
 *
 * Driven through `screenCardPresentation` rather than with hand-written props,
 * so this asserts what the rail will actually draw rather than what the
 * placeholder can be made to draw. The live surface is a canvas noVNC owns and
 * is covered by the Playwright spec instead.
 */
const bot = (sandbox: BotWithSandbox['sandbox']): BotWithSandbox =>
  ({ id: 'b1', name: 'Quill', sandbox }) as BotWithSandbox;

const sandbox = (state: string, lastError: string | null = null): BotWithSandbox['sandbox'] =>
  ({ state, widthPx: 1280, heightPx: 800, lastError }) as unknown as BotWithSandbox['sandbox'];

function render(
  botRow: BotWithSandbox | null,
  wake: WakeStatus | undefined,
  onAct: () => void = () => undefined,
) {
  const { view, placeholder, placeholderDetail, caption, action } = screenCardPresentation(
    botRow,
    false,
    wake,
  );
  return renderToStaticMarkup(
    <I18nProvider>
      <ScreenPlaceholder
        kind={view.kind}
        message={placeholder ?? caption}
        detail={placeholderDetail}
        action={botRow === null ? null : action}
        onAct={botRow === null ? undefined : onAct}
      />
    </I18nProvider>,
  );
}

describe('ScreenPlaceholder (CC-16)', () => {
  it('offers the computer on a card that has none running', () => {
    const html = render(bot(sandbox('STOPPED')), undefined);
    expect(html).toContain('data-screen-state="stopped"');
    expect(html).toContain('data-screen-action="open"');
    expect(html).toContain('Open computer');
    expect(html).toMatch(/asleep/);
  });

  it('says what it is doing and offers no second press while waking', () => {
    // A second press during a wake asks the same question of a host that is
    // already answering it.
    const html = render(bot(sandbox('STOPPED')), { kind: 'waking' });
    expect(html).toContain('data-screen-state="starting"');
    expect(html).toMatch(/Waking/);
    expect(html).toContain('animate-spin');
    expect(html).not.toContain('data-screen-action');
  });

  it('shows a full host as its own state, with a retry', () => {
    // D-039 §16.1 — capacity is not a broken bot, and the copy has to make
    // that difference visible rather than describing it as a failure.
    const html = render(bot(sandbox('STOPPED')), {
      kind: 'capacity',
      message: 'This host is already running 6 of 6 sandboxes.',
    });
    expect(html).toContain('data-screen-state="capacity"');
    expect(html).toContain('data-screen-action="retry"');
    expect(html).toContain('This host is already running 6 of 6 sandboxes.');
  });

  it('offers a retry for a wake that failed for any other reason', () => {
    const html = render(bot(sandbox('STOPPED')), {
      kind: 'failed',
      message: 'Could not reach the server.',
    });
    expect(html).toContain('data-screen-state="failed"');
    expect(html).toContain('data-screen-action="retry"');
    expect(html).toContain('Could not reach the server.');
  });

  it('still surfaces a stored fault with no request of the operator behind it', () => {
    // `lastError` is where the reason survives after the §4.2 frame is gone —
    // but it is a diagnostic, so it renders one hover away rather than as the
    // sentence on the card (D-093).
    const html = render(bot(sandbox('UNHEALTHY', 'bridge probe timed out')), undefined);
    expect(html).toContain('title="bridge probe timed out"');
    expect(html).toContain('Something went wrong with this computer');
    expect(html).toContain('data-screen-action="retry"');
  });

  it('carries no title when the message is already the whole story', () => {
    // Asserted against a case that DOES render one, above, so this cannot pass
    // by the attribute never being emitted at all.
    const html = render(bot(sandbox('STOPPED')), undefined);
    expect(html).toContain('This computer is asleep.');
    expect(html).not.toContain('title=');
  });

  it('offers nothing to press when there is no bot to press it for', () => {
    const html = render(null, undefined);
    expect(html).toContain('data-screen-state="no-bot"');
    expect(html).not.toContain('data-screen-action');
  });

  it('never offers a stop, in any state', () => {
    // D-041 made idle stop the way a computer goes down. A Stop button would
    // be a lifecycle chore the product exists to remove, and one press could
    // pull the desktop out from under a turn still using it. Asserted over the
    // labels rather than the markup, because "stopped" is a legitimate state
    // name and would match a search of the HTML.
    const wakes: (WakeStatus | undefined)[] = [
      undefined,
      { kind: 'waking' },
      { kind: 'capacity', message: 'full' },
      { kind: 'failed', message: 'nope' },
    ];
    for (const state of ['RUNNING', 'STARTING', 'STOPPED', 'UNHEALTHY', 'ERROR']) {
      for (const wake of wakes) {
        const label = screenCardPresentation(bot(sandbox(state)), false, wake).action?.label ?? '';
        expect(label.toLowerCase()).not.toContain('stop');
      }
    }
  });

  it('draws without asking for anything', () => {
    // §16 lists selecting a bot and rendering its card among the things that
    // must NOT wake a computer. The rail card is mounted for whichever bot is
    // selected, so a wake on render would start a container for every bot the
    // operator clicked past — on a host whose ceiling is six.
    const onAct = vi.fn();
    for (const state of ['STOPPED', 'STARTING', 'UNHEALTHY', 'ERROR']) {
      render(bot(sandbox(state)), undefined, onAct);
    }
    render(bot(sandbox('STOPPED')), { kind: 'capacity', message: 'full' }, onAct);
    expect(onAct).not.toHaveBeenCalled();
  });
});
