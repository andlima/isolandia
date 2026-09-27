/**
 * Renderer-independent HUD data: both the ASCII HUD block and the browser
 * overlay are built from `hudModel`, so they always show the same values.
 */

import { clockAt, type ClockTime } from './clock.ts';
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
  /** Labels of the player's active statuses, in definition order. */
  readonly statuses: readonly string[];
  /** `Status: A, B`, or null when no status is active. */
  readonly statusLine: string | null;
  /** Set once the world is defeated. */
  readonly defeat: HudDefeat | null;
}

export interface HudDefeat {
  readonly message: string;
  /** In-game clock at the defeat tick, `Day D HH:MM`. */
  readonly clock: string;
  /** `message (Day D HH:MM)`. */
  readonly text: string;
}

function fmt(n: number): string {
  return n.toFixed(1);
}

/** HUD text lines shared by the shells: time, measurements, then status/defeat lines when present. */
export function hudLines(m: HudModel): string[] {
  const lines = [m.time, ...m.measurements.map((x) => x.text)];
  if (m.statusLine) lines.push(m.statusLine);
  if (m.defeat) lines.push(m.defeat.text);
  return lines;
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
  const statuses = world.def.statuses.filter((s) => player.st[s.index] === 1).map((s) => s.label);
  const d = world.defeat;
  const defeatClock = d ? formatClock(clockAt(world.def.clock, d.tick, world.def.ticksPerSecond)) : '';
  return {
    clock,
    tick: world.tick,
    time: `Time: ${clock} (tick ${world.tick})`,
    measurements,
    statuses,
    statusLine: statuses.length ? `Status: ${statuses.join(', ')}` : null,
    defeat: d ? { message: d.message, clock: defeatClock, text: `${d.message} (${defeatClock})` } : null,
  };
}
