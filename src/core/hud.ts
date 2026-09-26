/**
 * Renderer-independent HUD data: both the ASCII HUD block and the browser
 * overlay are built from `hudModel`, so they always show the same values.
 */

import type { ClockTime } from './clock.ts';
import type { World } from './sim/world.ts';

export interface HudMeasurement {
  readonly label: string;
  readonly value: number;
  /** Infinity when unbounded. */
  readonly max: number;
  /** `label: value/max` (or `label: value` when unbounded), one decimal. */
  readonly text: string;
}

export interface HudModel {
  /** In-game date and time, `Day D HH:MM`. */
  readonly clock: string;
  readonly tick: number;
  /** `Time: Day D HH:MM (tick N)`. */
  readonly time: string;
  readonly measurements: readonly HudMeasurement[];
}

function fmt(n: number): string {
  return n.toFixed(1);
}

/** `Day D HH:MM`. */
export function formatClock(t: ClockTime): string {
  const pad = (v: number) => String(v).padStart(2, '0');
  return `Day ${t.day} ${pad(t.hour)}:${pad(t.minute)}`;
}

export function hudModel(world: World): HudModel {
  const { player } = world;
  const clock = formatClock(world.clock);
  const measurements = player.archetype.measurements.map((idx): HudMeasurement => {
    const label = world.def.measurements[idx]!.label;
    const max = player.max[idx]!;
    const value = player.m[idx]!;
    const text = Number.isFinite(max) ? `${label}: ${fmt(value)}/${fmt(max)}` : `${label}: ${fmt(value)}`;
    return { label, value, max, text };
  });
  return { clock, tick: world.tick, time: `Time: ${clock} (tick ${world.tick})`, measurements };
}
