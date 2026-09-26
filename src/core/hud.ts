/**
 * Renderer-independent HUD data: both the ASCII HUD block and the browser
 * overlay are built from `hudModel`, so they always show the same values.
 */

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
  /** In-game clock, `hh:mm:ss`. */
  readonly clock: string;
  readonly tick: number;
  /** `Time: hh:mm:ss (tick N)`. */
  readonly time: string;
  readonly measurements: readonly HudMeasurement[];
}

function fmt(n: number): string {
  return n.toFixed(1);
}

export function formatClock(seconds: number): string {
  const s = Math.floor(seconds);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
}

export function hudModel(world: World): HudModel {
  const { player } = world;
  const clock = formatClock(world.seconds);
  const measurements = player.archetype.measurements.map((idx): HudMeasurement => {
    const label = world.def.measurements[idx]!.label;
    const max = player.max[idx]!;
    const value = player.m[idx]!;
    const text = Number.isFinite(max) ? `${label}: ${fmt(value)}/${fmt(max)}` : `${label}: ${fmt(value)}`;
    return { label, value, max, text };
  });
  return { clock, tick: world.tick, time: `Time: ${clock} (tick ${world.tick})`, measurements };
}
