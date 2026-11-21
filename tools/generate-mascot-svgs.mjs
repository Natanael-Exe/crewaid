import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MASCOT_SHAPES,
  MASCOT_FACE_PATCHES,
  MASCOT_FACE_WHITE,
  MASCOT_FACE_INK,
  MASCOT_GEOMETRY,
} from '../packages/brand/dist/mascot.js';

// Derived vector masters stay identical to the live React renderers.
const root = fileURLToPath(new URL('../', import.meta.url));
const variants = [
  {
    id: 'circle',
    name: 'Scout',
    color: '#2FA59A',
    description: 'A wide low pebble with a single notch',
  },
  {
    id: 'square',
    name: 'Forge',
    color: '#E5533D',
    description: 'A broad rounded block with a stepped corner',
  },
  {
    id: 'polygon',
    name: 'Beacon',
    color: '#F2B233',
    description: 'An offset rounded wedge with a sloping top',
  },
  {
    id: 'egg',
    name: 'Ava',
    color: '#3563E9',
    description: 'A tall rounded arch with a deep off-center notch',
  },
  {
    id: 'bulb',
    name: 'Quill',
    color: '#7B5CE0',
    description: 'A leaning bean with an inward left waist',
  },
  {
    id: 'cloud',
    name: 'Warden',
    color: '#EC5FA4',
    description: 'A wide double-lobed shoulder with a central dip',
  },
  {
    id: 'shield',
    name: 'Ledger',
    color: '#5E9E4B',
    description: 'A tall tapered mound with a narrow bent peak',
  },
  {
    id: 'splat',
    name: 'Echo',
    color: '#F27B2A',
    description: 'A low sweeping crescent with an inward left edge',
  },
];
const directory = resolve(root, 'packages/brand/masters/mascots');
await mkdir(directory, { recursive: true });
for (const [index, variant] of variants.entries()) {
  const { eyes, nose } = MASCOT_GEOMETRY[index];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-labelledby="title">
<title id="title">${variant.name} — Pocket Crew</title>
<path d="${MASCOT_SHAPES[index]}" fill="${variant.color}"/>
<path d="${MASCOT_FACE_PATCHES[index]}" fill="${MASCOT_FACE_WHITE}"/>
<g fill="${MASCOT_FACE_INK}">
${eyes.map((eye) => `<ellipse cx="${eye.x}" cy="${eye.y}" rx="${eye.rx}" ry="${eye.ry}" transform="rotate(${eye.angle} ${eye.x} ${eye.y})"/>`).join('\n')}
<rect x="${nose.x - nose.width / 2}" y="${nose.y - nose.height / 2}" width="${nose.width}" height="${nose.height}" rx="${nose.width / 2}" transform="rotate(${nose.angle} ${nose.x} ${nose.y})"/>
</g></svg>\n`;
  await writeFile(resolve(directory, `${variant.id}.svg`), svg);
}
console.log(`Generated ${variants.length} SVGs in packages/brand/masters/mascots`);
