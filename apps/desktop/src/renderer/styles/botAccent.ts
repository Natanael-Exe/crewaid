import { useLayoutEffect } from 'react';

function luminance(color: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722;
}

export function contrastRatio(a: string, b: string): number {
  const first = luminance(a),
    second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

export function mixColor(color: string, background: string, amount: number): string {
  return (
    '#' +
    [1, 3, 5]
      .map((offset) =>
        Math.round(
          Number.parseInt(color.slice(offset, offset + 2), 16) * amount +
            Number.parseInt(background.slice(offset, offset + 2), 16) * (1 - amount),
        )
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

function readableInk(color: string, background: string, target: string): string {
  for (let step = 0; step <= 100; step += 1) {
    const ratio = step / 100;
    const mixed =
      '#' +
      [1, 3, 5]
        .map((offset) =>
          Math.round(
            Number.parseInt(color.slice(offset, offset + 2), 16) * (1 - ratio) +
              Number.parseInt(target.slice(offset, offset + 2), 16) * ratio,
          )
            .toString(16)
            .padStart(2, '0'),
        )
        .join('');
    if (contrastRatio(mixed, background) >= 4.5) return mixed;
  }
  return target;
}

/** Keep a bot's stored color, choosing readable ink even for pale custom colors. */
export function botAccentTokens(color: string | undefined): Readonly<Record<string, string>> {
  const accent = color !== undefined && /^#[\da-f]{6}$/i.test(color) ? color : '#000000';
  const lightContrast = 1.05 / (luminance(accent) + 0.05);
  const darkContrast = (luminance(accent) + 0.05) / (luminance('#1D1830') + 0.05);
  // Saturated controls use light ink. A nearby darker shade keeps the same
  // hue readable without putting black glyphs on blue/teal; pale colors retain
  // dark ink. The bot's identity color stays exact; message glass is neutral.
  const lightControlInk = luminance(accent) < 0.35;
  return {
    '--accent': accent,
    '--accent-foreground':
      lightContrast >= 4.5 ? '#FFFFFF' : darkContrast >= 4.5 ? '#1D1830' : '#000000',
    '--accent-control': lightControlInk ? readableInk(accent, '#FFFFFF', '#1D1830') : accent,
    '--accent-control-foreground': lightControlInk ? '#FFFFFF' : '#1D1830',
    '--bot-accent-ink-light': readableInk(accent, mixColor(accent, '#FFFFFF', 0.08), '#1D1830'),
    '--bot-accent-ink-dark': readableInk(accent, mixColor(accent, '#101430', 0.26), '#F4F2FF'),
  };
}

export function useBotAccent(color: string | undefined): void {
  useLayoutEffect(() => {
    // With no selected bot, leave the app's neutral Day/Night tokens in charge.
    // The previous effect's cleanup also removes any prior bot's inline palette.
    if (color === undefined || !/^#[\da-f]{6}$/i.test(color)) return;
    // Bot roles are separate from HeroUI's neutral app roles. Portaled app
    // menus and creation dialogs must not inherit a selected bot's accent.
    const root = document.documentElement;
    const tokens = Object.fromEntries(
      Object.entries(botAccentTokens(color)).map(([key, value]) => [
        key.startsWith('--bot-') ? key : key.replace('--', '--bot-'),
        value,
      ]),
    );
    const previous = Object.keys(tokens).map(
      (key) => [key, root.style.getPropertyValue(key)] as const,
    );
    for (const [key, value] of Object.entries(tokens)) root.style.setProperty(key, value);
    return () => {
      for (const [key, value] of previous) {
        if (value === '') root.style.removeProperty(key);
        else root.style.setProperty(key, value);
      }
    };
  }, [color]);
}
