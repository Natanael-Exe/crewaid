import { describe, expect, it } from 'vitest';

import { isReadOnlyTool } from '../src/mcp/mcp-readonly.js';
import type { McpToolDescriptor } from '../src/mcp/mcp-tools.js';

/**
 * M6-BE-08 / M6-QA-02 — the read-only ladder.
 *
 * §6/M6 asks for three fixture cases and names them: annotation-present,
 * annotation-absent-name-matches, annotation-absent-name-unmatched. The fourth
 * case here is the one the sentence implies rather than states and is the one
 * that matters most — an annotation of `false` must NOT fall through to the
 * name pattern, or a server's own claim about its own tool is overruled by a
 * prefix.
 */
function tool(overrides: Partial<McpToolDescriptor> = {}): McpToolDescriptor {
  return {
    name: 'do_thing',
    description: '',
    inputSchema: {},
    readOnlyHint: undefined,
    ...overrides,
  };
}

describe('M6-QA-02 the read-only classifier', () => {
  it('takes the server’s annotation when it sent one', () => {
    expect(isReadOnlyTool(tool({ readOnlyHint: true, name: 'delete_everything' }))).toBe(true);
    // …including over a name that looks like a read. The server is the
    // authority on its own tool; the pattern is what stands in when it said
    // nothing.
    expect(isReadOnlyTool(tool({ readOnlyHint: false, name: 'get_report' }))).toBe(false);
  });

  it('falls back to the name pattern when the annotation is absent', () => {
    for (const name of ['get_issue', 'list_issues', 'search_code', 'read_file', 'fetch_page']) {
      expect(isReadOnlyTool(tool({ name })), name).toBe(true);
    }
    // Case is folded, which is normalization and not widening: these are the
    // same names written twice.
    expect(isReadOnlyTool(tool({ name: 'Get_Issue' }))).toBe(true);
  });

  it('treats anything unmatched as a write', () => {
    for (const name of ['send_email', 'create_issue', 'wire_transfer', 'do_thing', '']) {
      expect(isReadOnlyTool(tool({ name })), name).toBe(false);
    }
  });

  it('does not widen the patterns to bare verbs or to substrings', () => {
    // The unsafe direction, pinned so relaxing it is a deliberate edit rather
    // than a plausible-looking one. A tool called `search` gets one approval
    // prompt and one auto-review rule (§6/M6 offers exactly that); a family
    // admitted by `reset`.startsWith-ish matching gets none.
    for (const name of ['search', 'get', 'read', 'reset_database', 'forget_everything']) {
      expect(isReadOnlyTool(tool({ name })), name).toBe(false);
    }
    // A prefix has to be at the START, not anywhere in the name.
    expect(isReadOnlyTool(tool({ name: 'un_get_issue' }))).toBe(false);
  });
});
