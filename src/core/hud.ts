/**
 * Renderer-independent HUD data: both the ASCII HUD block and the browser
 * overlay are built from `hudModel`, so they always show the same values.
 */

import { clockAt, type ClockTime } from './clock.ts';
import type { Container } from './sim/containers.ts';
import type { ActionRecord, OutcomeRecord, World } from './sim/world.ts';

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
  /** Set once the world is won. */
  readonly victory: HudVictory | null;
  /** The player's inventory, or null when the player has none. */
  readonly inventory: HudInventory | null;
  /** Containers the player can reach now, in id order (never the player's own inventory). */
  readonly nearby: readonly HudContainer[];
  /** `Nearby: …`, or null when nothing is reachable. */
  readonly nearbyLine: string | null;
  /** Short text for the latest action (e.g. `Took 2 Canned beans`, `Too heavy`), or null once it is stale. */
  readonly lastAction: string | null;
}

export interface HudStack {
  /** Qualified item id (what actions take). */
  readonly item: string;
  readonly label: string;
  readonly glyph: string;
  readonly color: string;
  readonly count: number;
  /** Weight of the whole stack, in normal units. */
  readonly weight: number;
  /** The item's use verb, or null when it cannot be used. */
  readonly useLabel: string | null;
  /** `Label xN`. */
  readonly text: string;
}

export interface HudInventory {
  readonly stacks: readonly HudStack[];
  /** Load and capacity, in normal units. */
  readonly weight: number;
  readonly capacity: number;
  /** `Carrying: w/cap`. */
  readonly carrying: string;
  /** `Inventory: 1) A x2  2) B x1`, or `Inventory: empty`. */
  readonly line: string;
}

export interface HudContainer {
  readonly id: number;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly stacks: readonly HudStack[];
  /** `Label [A x2, B x1]` or `Label [empty]`. */
  readonly text: string;
}

export interface HudOutcome {
  readonly message: string;
  /** In-game clock at the defeat/victory tick, `Day D HH:MM`. */
  readonly clock: string;
  /** `message (Day D HH:MM)`. */
  readonly text: string;
}

export type HudDefeat = HudOutcome;
export type HudVictory = HudOutcome;

function fmt(n: number): string {
  return n.toFixed(1);
}

/** Label of a ground pile (engine-level, not pack data). */
export const GROUND_LABEL = 'Ground';
/** How long (sim seconds) the latest action stays in the HUD. */
const ACTION_SECONDS = 3;

/**
 * HUD text lines shared by the shells: time, measurements, then — only when
 * present — carrying/inventory, status, nearby, latest action and defeat/victory.
 */
export function hudLines(m: HudModel): string[] {
  const lines = [m.time, ...m.measurements.map((x) => x.text)];
  if (m.inventory) lines.push(m.inventory.carrying, m.inventory.line);
  if (m.statusLine) lines.push(m.statusLine);
  if (m.nearbyLine) lines.push(m.nearbyLine);
  if (m.lastAction) lines.push(m.lastAction);
  if (m.defeat) lines.push(m.defeat.text);
  if (m.victory) lines.push(m.victory.text);
  return lines;
}

/** Weight in hundredths → normal units. */
function units(hundredths: number): number {
  return hundredths / 100;
}

function stacksOf(world: World, c: Container): HudStack[] {
  return c.stacks.map((s): HudStack => {
    const item = world.def.items[s.item]!;
    return {
      item: item.id,
      label: item.label,
      glyph: item.glyph,
      color: item.color,
      count: s.count,
      weight: units(item.weight * s.count),
      useLabel: item.use?.label ?? null,
      text: `${item.label} x${s.count}`,
    };
  });
}

function containerLabel(world: World, c: Container): string {
  return c.kind === 'tile' ? world.def.tiles[c.tile]!.label : GROUND_LABEL;
}

/** Short feedback text for an action record. */
export function actionText(world: World, a: ActionRecord): string {
  const idx = world.def.ids.items[a.item];
  const label = idx === undefined ? a.item : world.def.items[idx]!.label;
  if (a.ok) {
    switch (a.kind) {
      case 'take':
        return `Took ${a.moved} ${label}`;
      case 'put':
        return `Put ${a.moved} ${label}`;
      case 'drop':
        return `Dropped ${a.moved} ${label}`;
      case 'use':
        return `${world.def.items[idx!]!.use!.label}: ${label}`;
    }
  }
  switch (a.reason) {
    case 'out_of_reach':
      return 'Out of reach';
    case 'too_heavy':
      return 'Too heavy';
    case 'cannot_use':
      return `Cannot use ${label}`;
    case 'no_inventory':
      return 'No inventory';
    case 'unknown_container':
      return 'No such container';
    default:
      return `No ${label}`;
  }
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
  let inventory: HudInventory | null = null;
  if (player.inv) {
    const stacks = stacksOf(world, player.inv);
    const weight = units(player.inv.load);
    const capacity = units(player.inv.capacity);
    inventory = {
      stacks,
      weight,
      capacity,
      carrying: `Carrying: ${weight}/${capacity}`,
      line: `Inventory: ${stacks.length ? stacks.map((s, i) => `${i + 1}) ${s.text}`).join('  ') : 'empty'}`,
    };
  }
  const nearby = world.reachableContainers().map((c): HudContainer => {
    const stacks = stacksOf(world, c);
    const label = containerLabel(world, c);
    return { id: c.id, label, x: c.x, y: c.y, stacks, text: `${label} [${stacks.length ? stacks.map((s) => s.text).join(', ') : 'empty'}]` };
  });
  const a = world.lastAction;
  const fresh = a !== null && world.tick - a.tick <= ACTION_SECONDS * world.def.ticksPerSecond;
  const outcome = (r: OutcomeRecord | null): HudOutcome | null => {
    if (!r) return null;
    const at = formatClock(clockAt(world.def.clock, r.tick, world.def.ticksPerSecond));
    return { message: r.message, clock: at, text: `${r.message} (${at})` };
  };
  return {
    clock,
    tick: world.tick,
    time: `Time: ${clock} (tick ${world.tick})`,
    measurements,
    statuses,
    statusLine: statuses.length ? `Status: ${statuses.join(', ')}` : null,
    defeat: outcome(world.defeat),
    victory: outcome(world.victory),
    inventory,
    nearby,
    nearbyLine: nearby.length ? `Nearby: ${nearby.map((c) => c.text).join('; ')}` : null,
    lastAction: fresh ? actionText(world, a) : null,
  };
}
