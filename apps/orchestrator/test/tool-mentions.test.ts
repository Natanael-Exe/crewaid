import { describe, expect, it } from 'vitest';
import { explicitToolMentions, withToolMentionHint } from '../src/agent/tool-mentions.js';
import { resolveToolToken } from '../src/agent/tool-vocabulary.js';

/**
 * `/tool` mentions — the composer's palette, read back on the orchestrator.
 *
 * A mention is only a mention when it names a REGISTERED tool: the user's
 * prose may contain paths, versions and URLs, and none of those may turn
 * into a directive the model obeys.
 */

const KNOWN = ['capture_screen', 'mouse_click', 'record_screen_start', 'shell'];
const resolve = (token: string): string | null => resolveToolToken(token, KNOWN);

describe('explicitToolMentions', () => {
  it('reads a leading mention', () => {
    expect(explicitToolMentions('/capture_screen and click the checkbox', resolve)).toEqual([
      'capture_screen',
    ]);
  });

  it('reads mid-sentence mentions after whitespace', () => {
    expect(explicitToolMentions('please use /shell to check the log', resolve)).toEqual(['shell']);
  });

  it('keeps the order the user typed and collapses duplicates', () => {
    expect(
      explicitToolMentions(
        '/capture_screen first, then /shell, and /capture_screen again later',
        resolve,
      ),
    ).toEqual(['capture_screen', 'shell']);
  });

  it('ignores tokens that name no registered tool', () => {
    // Paths, versions and invented names are the user's words, not commands.
    expect(explicitToolMentions('/etc/hosts says /usr/bin/env; try /not_a_tool', resolve)).toEqual(
      [],
    );
  });

  it('does not fire mid-word', () => {
    expect(explicitToolMentions('see docs/shell for details', resolve)).toEqual([]);
  });

  it('resolves the user-facing alias back to the tool the model will call', () => {
    // The palette inserts `/screen` (capture_screen's alias), and the hint
    // must name what the model can actually call.
    expect(explicitToolMentions('please /screen now', resolve)).toEqual(['capture_screen']);
    expect(explicitToolMentions('/click the button', resolve)).toEqual(['mouse_click']);
  });

  it('answers with the internal name when both spellings appear', () => {
    expect(explicitToolMentions('/screen then /capture_screen', resolve)).toEqual([
      'capture_screen',
    ]);
  });
});

describe('withToolMentionHint', () => {
  it('passes content through when nothing was mentioned', () => {
    expect(withToolMentionHint('hello', [])).toBe('hello');
  });

  it('appends a bracketed directive, not new user words', () => {
    const hinted = withToolMentionHint('check the captcha', ['capture_screen', 'mouse_click']);
    expect(hinted.startsWith('check the captcha')).toBe(true);
    expect(hinted).toContain('capture_screen, mouse_click');
    expect(hinted).toContain('rather than working around them');
    // Missing inputs become a QUESTION, which is what makes tools that need
    // parameters usable from a mention.
    expect(hinted).toContain('ask the user for them');
  });
});
