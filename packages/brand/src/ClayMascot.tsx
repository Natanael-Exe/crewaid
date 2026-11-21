'use client';

import { useId, type CSSProperties } from 'react';
import { CLAY_ASSETS } from './clay-assets.js';
import { CLAY_GEOMETRY } from './clay-geometry.js';
import { mascotHash } from './mascot.js';

/**
 * `greeting` is not a status: it is the hello a mascot gives once, where it
 * first meets someone, and then it rests like `idle`.
 */
export type MascotActivity = 'idle' | 'thinking' | 'acting' | 'greeting';

/** Approved clay artwork, with separately animated features and a tintable body. */
export function ClayMascot({
  name,
  color,
  variant,
  activity = 'idle',
  detail = false,
  className = '',
}: {
  name: string;
  color: string;
  variant: number;
  activity?: MascotActivity;
  detail?: boolean;
  className?: string;
}) {
  const id = `clay-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const index =
    Number.isInteger(variant) && variant >= 0
      ? variant % CLAY_ASSETS.length
      : mascotHash(name) % CLAY_ASSETS.length;
  const assets = CLAY_ASSETS[index] ?? CLAY_ASSETS[0];
  const geometry = CLAY_GEOMETRY[index] ?? CLAY_GEOMETRY[0];
  const channels = [1, 3, 5].map(
    (offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255,
  );
  const state = activity === 'idle' ? undefined : activity;
  return (
    <svg
      viewBox="0 0 100 100"
      aria-hidden
      className={`crewaid-clay-mascot ${className}`}
      data-mascot-shape={geometry.id}
      style={
        {
          '--crewaid-mascot-phase': `${(mascotHash(name) % 7) * 0.45}s`,
          '--mascot-eye-origin': `${geometry.eyeCenter[0]}px ${geometry.eyeCenter[1]}px`,
        } as CSSProperties
      }
    >
      <defs>
        {/* Piecewise tint preserves the clay's dark recesses and pale highlights.
            The neutral face/ink features never pass through the body filter. */}
        <filter id={id} colorInterpolationFilters="sRGB" x="0" y="0" width="100%" height="100%">
          <feComponentTransfer>
            <feFuncR type="table" tableValues={`0 ${channels[0]} 1`} />
            <feFuncG type="table" tableValues={`0 ${channels[1]} 1`} />
            <feFuncB type="table" tableValues={`0 ${channels[2]} 1`} />
          </feComponentTransfer>
        </filter>
      </defs>
      {activity === 'acting' && detail ? (
        <circle
          className="crewaid-mascot-ring"
          cx="50"
          cy="50"
          r="55"
          fill="none"
          stroke={color}
          strokeOpacity=".45"
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray="16 14"
        />
      ) : null}
      <g className="crewaid-mascot-body" data-activity={state}>
        <image href={assets.body} width="100" height="100" filter={`url(#${id})`} />
        <image href={assets.face} width="100" height="100" />
        <g className="crewaid-mascot-eyes" data-activity={state}>
          <g className="crewaid-mascot-blink">
            <image href={assets.eyes} width="100" height="100" />
          </g>
          <image href={assets.nose} width="100" height="100" />
        </g>
      </g>
      {activity === 'thinking' && detail ? (
        <g data-mascot-thinking>
          <circle className="crewaid-mascot-dot" cx="74" cy="-4" r="5" fill={color} />
          <circle className="crewaid-mascot-dot" cx="88" cy="-13" r="6.5" fill={color} />
          <circle className="crewaid-mascot-dot" cx="105" cy="-24" r="8" fill={color} />
        </g>
      ) : null}
    </svg>
  );
}
