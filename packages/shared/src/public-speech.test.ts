import { describe, expect, it } from 'vitest';
import {
  createPublicOutputGuard,
  detectCorruptPublicOutput,
  detectDegenerateRepetition,
  projectPublicSpeech,
} from './public-speech.js';

/** Representative excerpt of the observed Gideon 11:36 AM meltdown trace. */
const GIDEON_MELTDOWN = [
  'tuple shaped wrong — waiting on packet alignment. Actually let me just emit the packet now.',
  Array.from({ length: 60 }, () => 'Produce. Write. Emit. Go. Now. Ok.').join(' '),
].join('\n\n');

const LEGITIMATE_LONG_REPLY = `# Launch Audit Closeout

Here is the verified state after reviewing the homepage, \`/compare\`, and the competitor parity table.

## Key Decisions

1. **AG3 copy**: Switch to "It Pauses, Not Bills" so every ad claim is backed by visible homepage copy.
2. **Download CTA**: Platform detection runs after hydration; prerendered HTML defaults to macOS, and iOS falls through to mac-arm64. Both are tracked as minor risks, not launch blockers.
3. **Measurement**: Gate 1 needs the daily session count for \`/get\` before choosing between Option A (site-side split) and Option B (sequential test).

| Artifact | Owner | Status |
|---|---|---|
| Competitor claims | Diana | Ready |
| Homepage audit | Julian | Ready |
| Test plan | Kira | Waiting on traffic count |

\`\`\`xml
<!-- Example markup inside a code fence must never be stripped or flagged -->
<think>demonstration inside code fence</think>
<fs_write path="/home/bot/demo.md">Emit. Go. Now. Ok. Emit. Go. Now. Ok.</fs_write>
<tool_call>{"name":"fs_read","arguments":{"path":"README.md"}}</tool_call>
\`\`\`

Inline code like \`<think>example</think>\` and \`<fs_write path="a.md" />\` stays verbatim.

Models write <tool_call> when they mean a call, and numeric inequalities like a < b or x < 10 stay intact.`;

function streamInChunks(input: string, chunkSize: number) {
  const guard = createPublicOutputGuard();
  let emitted = '';
  let corrupt = null;
  for (let i = 0; i < input.length; i += chunkSize) {
    const step = guard.push(input.slice(i, i + chunkSize));
    emitted += step.emit;
    if (step.corrupt !== null) {
      corrupt = step.corrupt;
      break;
    }
  }
  if (corrupt === null) {
    const end = guard.flush();
    emitted += end.emit;
    corrupt = end.corrupt;
  }
  return { emitted, corrupt };
}

describe('projectPublicSpeech', () => {
  it('strips paired, split, and unterminated reasoning and control tags outside code', () => {
    expect(
      projectPublicSpeech(
        '<think>internal chain of thought</think>\n\nReady to ship.\n<budget:token_budget>200000</budget:token_budget>',
      ),
    ).toBe('Ready to ship.');

    expect(
      projectPublicSpeech('leaked thinking prefix without opener</think>\n\nFinal answer here.'),
    ).toBe('Final answer here.');

    expect(projectPublicSpeech('Done.\n<think>unterminated reasoning that never closed')).toBe(
      'Done.',
    );

    expect(projectPublicSpeech('<thought>only internal thought')).toBe('');
  });

  it('suppresses the observed Gideon 11:36 AM repetition meltdown completely', () => {
    expect(detectDegenerateRepetition(GIDEON_MELTDOWN)).toMatchObject({
      kind: 'runaway-repetition',
    });
    expect(projectPublicSpeech(GIDEON_MELTDOWN)).toBe('');
  });

  it('catches mid-text leaked tool markup outside code while preserving code examples and prose', () => {
    const leaked =
      'Let me update the file now.\n<fs_write path="/home/bot/shared/BOARD.md">wiped</fs_write>';
    expect(detectCorruptPublicOutput(leaked)).toMatchObject({ kind: 'leaked-tool-markup' });
    expect(projectPublicSpeech(leaked)).toBe('Let me update the file now.');

    const leakedSend = 'Sending update <send_message to="Diana" message="hi" />';
    expect(detectCorruptPublicOutput(leakedSend)).toMatchObject({ kind: 'leaked-tool-markup' });
    expect(projectPublicSpeech(leakedSend)).toBe('Sending update');

    expect(
      detectCorruptPublicOutput('Models write <tool_call> when they mean a call.'),
    ).toBeNull();
    expect(projectPublicSpeech('Models write <tool_call> when they mean a call.')).toBe(
      'Models write <tool_call> when they mean a call.',
    );
  });

  it('preserves legitimate long markdown replies, tables, and fenced code blocks', () => {
    expect(detectCorruptPublicOutput(LEGITIMATE_LONG_REPLY)).toBeNull();
    expect(projectPublicSpeech(LEGITIMATE_LONG_REPLY)).toBe(LEGITIMATE_LONG_REPLY);
  });
});

describe('createPublicOutputGuard (streaming)', () => {
  it.each([1, 3, 7, 29])(
    'strips split reasoning and control tags cleanly at chunk size %i',
    (size) => {
      const raw =
        '<think>private plan with <budget:token_budget>1</budget:token_budget></think>\nHere is the result.\n<system-reminder>hidden</system-reminder>';
      const { emitted, corrupt } = streamInChunks(raw, size);
      expect(corrupt).toBeNull();
      expect(emitted.trim()).toBe('Here is the result.');
    },
  );

  it('drops unterminated reasoning blocks at stream end without leaking content', () => {
    const { emitted, corrupt } = streamInChunks('Summary ready.\n<reasoning>never closed...', 5);
    expect(corrupt).toBeNull();
    expect(emitted.trim()).toBe('Summary ready.');
  });

  it.each([5, 19])(
    'trips before the Gideon meltdown leaks into chat at chunk size %i',
    (size) => {
      const { emitted, corrupt } = streamInChunks(GIDEON_MELTDOWN, size);
      expect(corrupt).toMatchObject({ kind: 'runaway-repetition' });
      // Must trip far earlier than emitting hundreds of loop tokens.
      expect((emitted.match(/Emit\./g) ?? []).length).toBeLessThan(8);
    },
  );

  it('trips on mid-text leaked tool markup outside code across chunk boundaries', () => {
    const raw = 'Updating status now.\n<fs_write path="/home/bot/a.md">body</fs_write>';
    const { emitted, corrupt } = streamInChunks(raw, 4);
    expect(corrupt).toMatchObject({ kind: 'leaked-tool-markup' });
    expect(emitted).not.toContain('<fs_write');
  });

  it.each([3, 17, 64])(
    'streams legitimate long markdown with embedded code fences untouched at chunk size %i',
    (size) => {
      const { emitted, corrupt } = streamInChunks(LEGITIMATE_LONG_REPLY, size);
      expect(corrupt).toBeNull();
      expect(emitted).toBe(LEGITIMATE_LONG_REPLY);
    },
  );
});
