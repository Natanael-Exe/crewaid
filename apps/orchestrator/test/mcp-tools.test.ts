import { describe, expect, it } from 'vitest';

import { McpProtocolError, toToolDescriptor } from '../src/mcp/mcp-tools.js';

/**
 * M6-BE-01 — `tools/list` as the rest of M6 will read it.
 *
 * These cases drive the two functions directly rather than through a stub
 * server, because the thing under test is the CONTRACT with M6-BE-06/07/08 and
 * not with the SDK: the SDK's own tool schema is looser than the spec in one
 * place (`annotations` is only typed as `title`, so `readOnlyHint` arrives
 * unvalidated) and stricter in another (`inputSchema` is required), and a suite
 * that only went through the SDK would be testing the SDK's schema drift
 * instead of this client's promise.
 *
 * The promise is narrow on purpose: carry what the server sent, refuse what
 * cannot be carried, and make "the annotation was absent" and "the annotation
 * was a string" the same answer instead of two different runtime surprises in
 * the classifier (M6-BE-08).
 */

const tool = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  name: 'send_email',
  description: 'Sends an email',
  inputSchema: { type: 'object', properties: { to: { type: 'string' } } },
  ...overrides,
});

describe('toToolDescriptor', () => {
  it('carries the name, description and schema through unchanged', () => {
    expect(toToolDescriptor(tool({}))).toEqual({
      name: 'send_email',
      description: 'Sends an email',
      inputSchema: { type: 'object', properties: { to: { type: 'string' } } },
      readOnlyHint: undefined,
    });
  });

  it('reads readOnlyHint from the annotation', () => {
    expect(toToolDescriptor(tool({ annotations: { readOnlyHint: true } })).readOnlyHint).toBe(true);
    expect(toToolDescriptor(tool({ annotations: { readOnlyHint: false } })).readOnlyHint).toBe(
      false,
    );
  });

  it('keeps "no claim" distinct from "not read-only", which is the distinction M6-BE-08 needs', () => {
    // Absent falls through to the name pattern; `false` does not. Collapsing
    // them here would silently turn every unannotated write tool into a
    // pattern match away from being allowed.
    expect(toToolDescriptor(tool({})).readOnlyHint).toBeUndefined();
    expect(toToolDescriptor(tool({ annotations: {} })).readOnlyHint).toBeUndefined();
    expect(toToolDescriptor(tool({ annotations: { title: 'Send' } })).readOnlyHint).toBeUndefined();
  });

  it('treats a malformed annotation as no claim rather than as a refusal', () => {
    // `annotations` is server-controlled and the spec grows keys this build
    // does not know. A string where a boolean belongs is a server to fix, not
    // a tool to drop: the tool itself is usable.
    expect(toToolDescriptor(tool({ annotations: { readOnlyHint: 'true' } })).readOnlyHint).toBe(
      undefined,
    );
    expect(toToolDescriptor(tool({ annotations: ['readOnlyHint'] })).readOnlyHint).toBeUndefined();
  });

  it('defaults a missing description to the empty string §3 stores, and a missing schema to {}', () => {
    const descriptor = toToolDescriptor({ name: 'ping' });
    expect(descriptor.description).toBe('');
    expect(descriptor.inputSchema).toEqual({});
  });

  it('refuses a tool it cannot name, naming the field', () => {
    expect(() => toToolDescriptor({})).toThrow(McpProtocolError);
    expect(() => toToolDescriptor({})).toThrow(/name:/);
    expect(() => toToolDescriptor({ name: '' })).toThrow(/name:/);
    expect(() => toToolDescriptor({ name: 42 })).toThrow(/name:/);
  });

  it('refuses a schema that is not a JSON Schema object, instead of passing junk to the model', () => {
    expect(() => toToolDescriptor({ name: 'ping', inputSchema: 'nope' })).toThrow(/inputSchema:/);
  });

  it('is a refusal of the listing, not a skip of the tool', () => {
    // The caller decides whether to fail the server. What this function must
    // not do is return a descriptor missing a name, which is how a tool
    // disappears from a model's list with nothing to notice.
    const thrown = (() => {
      try {
        toToolDescriptor({ name: '' });
        return undefined;
      } catch (error) {
        return error as McpProtocolError;
      }
    })();
    expect(thrown?.code).toBe('MCP_PROTOCOL');
  });
});
