import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * CC-85: the renderer lays out by reading order — start and end — so Arabic,
 * Hebrew and Urdu mirror it without a second stylesheet. A physical left or
 * right comes back easily (`ml-2`, `text-left`, `padding-left`), and nothing
 * else would notice until someone opened the app in Arabic.
 *
 * The few that must stay physical are listed with the reason: they describe
 * the screen or the operating system, not the reading order.
 */
const RENDERER = join(__dirname, '../src/renderer');

const UTILITY =
  /(?<![\w[-])((?:[\w\-[\]=&.:()]+:)*!?(?:-?(?:ml|mr|pl|pr|left|right)-(?:\d+(?:\.\d+)?|\d+\/\d+|px|auto|full|\[[^\]\s]+\])|text-left|text-right|rounded-[lr](?:-[\w[\]]+)?|rounded-(?:tl|tr|bl|br)(?:-[\w[\]]+)?|border-[lr](?:-\d+)?))(?![\w/\]-])/g;
const DECLARATION =
  /(?<![\w-])(?:(margin-left|margin-right|padding-left|padding-right|border-left|border-right|left|right)\s*:|(text-align:\s*(?:left|right))\b)/g;
const STYLE_KEY = /\b(marginLeft|marginRight|paddingLeft|paddingRight|borderLeft|borderRight)\b/g;

/** `file: token` pairs that are physical on purpose. */
const PHYSICAL = new Map<string, string>([
  ['components/Transcript.tsx: left-1/2', 'centring, which is the same in both directions'],
  ['screen/ScreenCard.tsx: left-1/2', 'centring, which is the same in both directions'],
  ['screen/ScreenCard.tsx: pl-[88px]', 'room for the macOS window buttons, which stay on the left'],
  ['styles/room.css: padding-left', 'room for the macOS window buttons, which stay on the left'],
  ['styles/app.css: left', 'the sash’s hit area and line, symmetric about its edge'],
  ['styles/app.css: right', 'the sash’s hit area, symmetric about its edge'],
  ['styles/app.css: text-align: left', 'code, which reads left to right in every language'],
  ['components/composer/composerLayout.ts: paddingLeft', 'a width measured as left plus right'],
  ['components/composer/composerLayout.ts: paddingRight', 'a width measured as left plus right'],
]);

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'i18n' ? [] : files(path);
    return /\.(tsx?|css)$/.test(entry.name) ? [path] : [];
  });
}

describe('CC-85 — the renderer lays out by reading order', () => {
  it('detects physical text alignment as well as physical edges', () => {
    const source = '.example { text-align: right; margin-left: 1px; }';
    expect([...source.matchAll(DECLARATION)].map((match) => match[1] ?? match[2])).toEqual([
      'text-align: right',
      'margin-left',
    ]);
  });
  it('uses start and end, not left and right, except where the screen or the OS is physical', () => {
    const found: string[] = [];
    for (const path of files(RENDERER)) {
      const source = readFileSync(path, 'utf8');
      const file = relative(RENDERER, path).replaceAll('\\', '/');
      const tokens = path.endsWith('.css')
        ? [...source.matchAll(DECLARATION)].map(
            (match) => (match[1] ?? match[2])?.replace(/\s+/g, ' ') ?? '',
          )
        : [
            ...[...source.matchAll(UTILITY)].map((match) => match[1] ?? ''),
            ...[...source.matchAll(STYLE_KEY)].map((match) => match[1] ?? ''),
          ];
      for (const token of tokens) {
        const bare = path.endsWith('.css')
          ? token
          : token.replace(/^.*:(?=[^:]+$)/, '').replace(/^!/, '');
        if (!PHYSICAL.has(`${file}: ${bare}`)) found.push(`${file}: ${token}`);
      }
    }
    expect(found).toEqual([]);
  });
});
