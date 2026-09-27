/**
 * Day/night tint from the pack-defined `lighting` domain. Visual only: the
 * simulation never reads it.
 */

import { MINUTES_PER_DAY } from './clock.ts';
import type { LightingDef } from './definition.ts';

/** No tint (multiplying by white leaves colours unchanged). */
export const NO_TINT = 0xffffff;

function lerpColor(a: number, b: number, t: number): number {
  const ch = (shift: number) => {
    const x = (a >> shift) & 0xff;
    const y = (b >> shift) & 0xff;
    return Math.round(x + (y - x) * t);
  };
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/**
 * Tint colour (0xRRGGBB) at a time of day in hours ([0, 24), fractional).
 * Linear RGB interpolation between consecutive keyframes, wrapping from the
 * last keyframe back to the first across midnight. `null` means no tint.
 */
export function tintAt(lighting: LightingDef | null, timeOfDay: number): number {
  if (!lighting) return NO_TINT;
  const keys = lighting.tint;
  if (keys.length === 1) return keys[0]!.color;
  const m = timeOfDay * 60 - Math.floor((timeOfDay * 60) / MINUTES_PER_DAY) * MINUTES_PER_DAY;
  // The last keyframe at or before `m`; before the first one, the last of the previous day.
  let i = keys.length - 1;
  for (let k = 0; k < keys.length; k++) {
    if (keys[k]!.at <= m) i = k;
    else break;
  }
  const a = keys[i]!;
  const b = keys[(i + 1) % keys.length]!;
  const from = a.at <= m ? a.at : a.at - MINUTES_PER_DAY;
  const to = b.at > from ? b.at : b.at + MINUTES_PER_DAY;
  return lerpColor(a.color, b.color, (m - from) / (to - from));
}
