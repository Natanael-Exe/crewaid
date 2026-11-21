import { MASCOT_GEOMETRY } from './mascot-geometry.js';

/**
 * Measured clay silhouettes, normalized together with each character's face.
 * Stored shape IDs retain their original order. The body has a 45-unit radial
 * reach in a 100×100 viewBox, so every variant fits the shared activity ring.
 */
export { MASCOT_GEOMETRY };
export { MASCOT_PARTS } from './mascot-parts.js';
export const MASCOT_SHAPES = [
  MASCOT_GEOMETRY[0].body,
  MASCOT_GEOMETRY[1].body,
  MASCOT_GEOMETRY[2].body,
  MASCOT_GEOMETRY[3].body,
  MASCOT_GEOMETRY[4].body,
  MASCOT_GEOMETRY[5].body,
  MASCOT_GEOMETRY[6].body,
  MASCOT_GEOMETRY[7].body,
] as const;
export const MASCOT_FACE_PATCHES = [
  MASCOT_GEOMETRY[0].face,
  MASCOT_GEOMETRY[1].face,
  MASCOT_GEOMETRY[2].face,
  MASCOT_GEOMETRY[3].face,
  MASCOT_GEOMETRY[4].face,
  MASCOT_GEOMETRY[5].face,
  MASCOT_GEOMETRY[6].face,
  MASCOT_GEOMETRY[7].face,
] as const;
export const MASCOT_FACE_WHITE = '#FFFFFF';
export const MASCOT_FACE_INK = '#1B1B1B';

/** Stable identity across reloads and surfaces, independent of activity. */
export function mascotHash(name: string): number {
  let hash = 2_166_136_261;
  for (const character of name) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619) >>> 0;
  }
  return hash;
}
