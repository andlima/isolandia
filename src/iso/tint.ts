/** Day/night tint for the iso scene (pure; the scene applies it to Pixi containers). */

import { timeOfDayAt, tintAt, type Definition } from '../core/index.ts';

/**
 * Tint of the ground and object layers at `tick + alpha` (so it changes
 * smoothly between ticks), or null when no pack defines `lighting`.
 */
export function sceneTint(def: Definition, tick: number, alpha: number): number | null {
  if (!def.lighting) return null;
  return tintAt(def.lighting, timeOfDayAt(def.clock, tick + alpha, def.ticksPerSecond));
}
