import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NativeToolInputs } from './native-tools.js';

const pairs = z
  .record(z.string(), z.object({ valid: z.unknown(), invalid: z.unknown() }))
  .parse(
    JSON.parse(
      readFileSync(new URL('../test-fixtures/native-tools.json', import.meta.url), 'utf8'),
    ),
  );
describe('D-175 shared native tool contracts', () => {
  it('requires a fixture pair for every catalog entry, with no orphan fixtures', () => {
    expect(Object.keys(pairs).sort()).toEqual(Object.keys(NativeToolInputs).sort());
  });
  for (const [name, schema] of Object.entries(NativeToolInputs)) {
    it(`${name} accepts its native arguments and rejects malformed input`, () => {
      expect(schema.safeParse(pairs[name]?.valid).success).toBe(true);
      expect(schema.safeParse(pairs[name]?.invalid).success).toBe(false);
    });
  }
});
