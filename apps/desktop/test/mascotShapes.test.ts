import { describe, expect, it } from 'vitest';

import { MASCOT_SHAPES } from '@crewaid/brand/mascot';

/**
 * Every mascot is the same size: each silhouette reaches as far from the
 * centre as the circle does, so none looks bigger in a list and all of them
 * sit inside the work ring (radius 55, stroke 5) that orbits a working bot.
 */

type Point = readonly [number, number];

/** Points along an SVG path of M/L/H/V/C/S/Z, absolute or relative. */
function sample(d: string): Point[] {
  const tokens = d.match(/[MmLlHhVvCcSsZz]|-?\d*\.?\d+/g) ?? [];
  const points: Point[] = [];
  let i = 0;
  let command = '';
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let lastControl: Point | null = null;
  const num = () => Number(tokens[i++]);
  const cubic = (p1: Point, p2: Point, p3: Point) => {
    const p0: Point = [x, y];
    for (let k = 0; k <= 40; k += 1) {
      const u = k / 40;
      const a = (1 - u) ** 3;
      const b = 3 * (1 - u) ** 2 * u;
      const c = 3 * (1 - u) * u * u;
      const e = u ** 3;
      points.push([
        a * p0[0] + b * p1[0] + c * p2[0] + e * p3[0],
        a * p0[1] + b * p1[1] + c * p2[1] + e * p3[1],
      ]);
    }
  };
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i] ?? '')) command = tokens[i++] ?? '';
    const relative = command === command.toLowerCase();
    const ox = relative ? x : 0;
    const oy = relative ? y : 0;
    switch (command.toUpperCase()) {
      case 'Z':
        x = startX;
        y = startY;
        lastControl = null;
        continue;
      case 'M':
        x = ox + num();
        y = oy + num();
        startX = x;
        startY = y;
        command = relative ? 'l' : 'L';
        lastControl = null;
        break;
      case 'L':
        x = ox + num();
        y = oy + num();
        lastControl = null;
        break;
      case 'H':
        x = ox + num();
        lastControl = null;
        break;
      case 'V':
        y = oy + num();
        lastControl = null;
        break;
      case 'C': {
        const c1: Point = [ox + num(), oy + num()];
        const c2: Point = [ox + num(), oy + num()];
        const end: Point = [ox + num(), oy + num()];
        cubic(c1, c2, end);
        lastControl = c2;
        [x, y] = end;
        break;
      }
      case 'S': {
        const c1: Point = lastControl ? [2 * x - lastControl[0], 2 * y - lastControl[1]] : [x, y];
        const c2: Point = [ox + num(), oy + num()];
        const end: Point = [ox + num(), oy + num()];
        cubic(c1, c2, end);
        lastControl = c2;
        [x, y] = end;
        break;
      }
      default:
        throw new Error(`unsupported path command ${command}`);
    }
    points.push([x, y]);
  }
  return points;
}

const reach = (d: string) => Math.max(...sample(d).map(([px, py]) => Math.hypot(px - 50, py - 50)));

describe('mascot shapes', () => {
  const circle = reach(MASCOT_SHAPES[0]);

  it('all reach as far from the centre as the circle, within half a unit', () => {
    for (const [index, shape] of MASCOT_SHAPES.entries()) {
      expect({ index, reach: Math.abs(reach(shape) - circle) < 0.5 }).toEqual({
        index,
        reach: true,
      });
    }
  });

  it('are all centred, so the ring sits evenly around each', () => {
    for (const [index, shape] of MASCOT_SHAPES.entries()) {
      const points = sample(shape);
      const xs = points.map(([px]) => px);
      const ys = points.map(([, py]) => py);
      const centre = [
        (Math.min(...xs) + Math.max(...xs)) / 2,
        (Math.min(...ys) + Math.max(...ys)) / 2,
      ];
      expect({ index, off: Math.hypot((centre[0] ?? 0) - 50, (centre[1] ?? 0) - 50) < 1 }).toEqual({
        index,
        off: true,
      });
    }
  });

  it('all sit inside the work ring', () => {
    // The ring is r=55 with a 5-unit stroke: its inner edge is at 52.5.
    for (const shape of MASCOT_SHAPES) expect(reach(shape)).toBeLessThan(52.5);
  });

  it('measures a shape that is too big as too big', () => {
    // The old splat reached 64.5; the measure must be able to say so.
    expect(
      reach(
        'M27 8c14-6 23 4 33 6 10 3 23-1 30 10 8 13 0 23 2 35 2 13-5 26-19 31-15 6-24 1-36 4-13 3-28 4-36-8-8-12-1-25-6-35-5-11-8-21-2-31 7-11 18-10 28-14Z',
      ),
    ).toBeGreaterThan(60);
  });
});
