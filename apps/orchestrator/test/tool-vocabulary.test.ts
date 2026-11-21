import { describe, expect, it } from 'vitest';
import { resolveToolToken, vocabularyFor } from '../src/agent/tool-vocabulary.js';

/**
 * The user-facing half of a tool's identity.
 *
 * The rule under test is one sentence long: a person reading a palette, a
 * transcript or their own message must never be shown `browser_read`. What
 * the MODEL calls is untouched — the internal name is still the wire
 * contract, and every alias resolves back to it.
 */
describe('vocabularyFor', () => {
  it('gives a built-in its curated words', () => {
    expect(vocabularyFor('browser_read', 'model-facing text')).toEqual({
      alias: 'read-page',
      label: 'Read the page',
      summary: 'Reads the current page as text the bot can act on.',
    });
  });

  it('gives an unknown tool — an MCP server’s, a skill’s — readable words anyway', () => {
    // The fallback is the honest answer for a tool this build has never heard
    // of, and it is still a sentence rather than a function signature.
    const entry = vocabularyFor('some_custom_tool', 'Does the thing. More prose follows.');
    expect(entry).toEqual({
      alias: 'some-custom-tool',
      label: 'Some custom tool',
      summary: 'Does the thing.',
    });
  });

  it('survives a description with no sentence at all', () => {
    expect(vocabularyFor('bare_tool', '')).toMatchObject({ summary: '', label: 'Bare tool' });
  });
});

describe('resolveToolToken', () => {
  const known = ['browser_read', 'capture_screen', 'shell', 'some_custom_tool'];

  it('accepts the alias the palette showed', () => {
    expect(resolveToolToken('read-page', known)).toBe('browser_read');
    expect(resolveToolToken('screen', known)).toBe('capture_screen');
  });

  it('accepts the internal name a power user learned', () => {
    expect(resolveToolToken('browser_read', known)).toBe('browser_read');
  });

  it('accepts the dashed fallback alias of a tool with no curated entry', () => {
    expect(resolveToolToken('some-custom-tool', known)).toBe('some_custom_tool');
  });

  it('answers null for prose that names no tool', () => {
    expect(resolveToolToken('etc-hosts', known)).toBeNull();
    expect(resolveToolToken('usr', known)).toBeNull();
  });

  it('refuses an alias for a tool this registry does not have', () => {
    // The vocabulary knows `run_skill`; a registry without it must not
    // resolve the alias into a name the turn could then call.
    expect(resolveToolToken('skill', known)).toBeNull();
  });
});
