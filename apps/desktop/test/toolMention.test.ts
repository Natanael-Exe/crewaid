import { describe, expect, it } from 'vitest';
import type { ToolInfo } from '@crewaid/shared';
import {
  activeSlashQuery,
  applyToolMention,
  filterTools,
  toolSummary,
} from '../src/renderer/components/composer/toolMention';

/**
 * The `/` palette's text mechanics.
 *
 * The rules that matter are the ones that keep the palette from being ANNOYING
 * or from eating text: it opens only where the caret sits in a `/token` the
 * user just started, never mid-word, and picking a tool replaces exactly the
 * token — nothing typed before or after it moves.
 */

const TOOLS: ToolInfo[] = [
  {
    name: 'capture_screen',
    alias: 'screen',
    label: 'See the screen',
    summary: 'A picture of the whole screen, not just the page.',
    description: 'A picture of the whole screen. Use it before pointer work.',
    reach: 'contained',
    origin: 'builtin',
  },
  {
    name: 'shell',
    alias: 'run-command',
    label: 'Run a command',
    summary: 'Runs a shell command on the bot’s computer — always asks first.',
    description: 'Run a shell command on this bot’s computer. Always asks first.',
    reach: 'sensitive',
    origin: 'builtin',
  },
];

describe('activeSlashQuery', () => {
  it('opens at a token the caret is inside', () => {
    expect(activeSlashQuery('/capt', 5)).toEqual({ query: 'capt', start: 0 });
  });

  it('opens after whitespace, not only at position zero', () => {
    expect(activeSlashQuery('do it /sh', 9)).toEqual({ query: 'sh', start: 6 });
  });

  it('stays closed mid-word — a path is the user’s text', () => {
    expect(activeSlashQuery('see docs/sh', 11)).toBeNull();
  });

  it('closes once the caret leaves the token', () => {
    expect(activeSlashQuery('/shell done', 11)).toBeNull();
  });
});

describe('filterTools', () => {
  it('matches the alias a person saw, case-insensitively', () => {
    expect(filterTools(TOOLS, 'SCR').map((t) => t.name)).toEqual(['capture_screen']);
  });

  it('also matches the internal name and the label', () => {
    expect(filterTools(TOOLS, 'shell').map((t) => t.name)).toEqual(['shell']);
    expect(filterTools(TOOLS, 'Run a').map((t) => t.name)).toEqual(['shell']);
  });

  it('shows everything for an empty query', () => {
    expect(filterTools(TOOLS, '')).toHaveLength(2);
  });
});

describe('applyToolMention', () => {
  it('inserts the user-facing alias, not the internal name', () => {
    const applied = applyToolMention('look /sc and tell me', 8, 'screen');
    expect(applied.draft).toBe('look /screen  and tell me');
    // Caret lands after the mention's trailing space; the operator's own
    // leading text and trailing sentence survive untouched around it.
    expect(applied.caret).toBe(13);
  });

  it('works when the mention is the whole draft', () => {
    const applied = applyToolMention('/run', 4, 'run-command');
    expect(applied.draft).toBe('/run-command ');
    expect(applied.caret).toBe(13);
  });
});

describe('toolSummary', () => {
  it('prefers the curated, person-facing summary', () => {
    expect(toolSummary(TOOLS[0]!)).toBe('A picture of the whole screen, not just the page.');
  });

  it('falls back to the description, then to the approval fact', () => {
    expect(toolSummary({ ...TOOLS[0]!, summary: '', description: 'Reads. More.' })).toBe('Reads.');
    expect(toolSummary({ ...TOOLS[0]!, summary: '', description: '' })).toBe('Runs directly.');
    expect(toolSummary({ ...TOOLS[1]!, summary: '', description: '' })).toBe('Asks for approval.');
  });
});
