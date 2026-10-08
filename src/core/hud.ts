/**
 * Renderer-independent HUD data: both the ASCII HUD block and the browser
 * overlay are built from `hudModel`, so they always show the same values.
 */

import { clockAt, isDayAt, type ClockTime } from './clock.ts';
import { measurementLevels, type StatusTone } from './definition.ts';
import { GROUND_LABEL, type Container } from './sim/containers.ts';

export { GROUND_LABEL };
import type { ActionFailure, ActionRecord, AvailableRecipe, MissingItem, OutcomeRecord, World } from './sim/world.ts';

/** How bad a value is (from a measurement's `hud` levels, or the inventory load). */
export type HudLevel = 'ok' | 'warn' | 'danger';

export interface HudMeasurement {
  /** Qualified measurement id. */
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly min: number;
  /** Infinity when unbounded. */
  readonly max: number;
  /** `label: value/max` (or `label: value` when unbounded), one decimal. */
  readonly text: string;
  /** Position of `value` in `[min, max]`, in [0, 1]; null when `max` is not finite. */
  readonly fraction: number | null;
  /** Which direction is bad (`hud.bad`); null for a neutral measurement. */
  readonly bad: 'high' | 'low' | null;
  /** How bad the value is against the `hud` levels; null for a neutral measurement. */
  readonly level: HudLevel | null;
}

/** One of the player's active statuses, for the browser's chips and the terminal's status colour. */
export interface HudStatusChip {
  readonly id: string;
  readonly label: string;
  readonly tone: StatusTone;
  /** The status's `hud.description` (empty when absent). */
  readonly description: string;
  /** The status's rates on the player's measurements now, `Label −0.2/s, Other +0.1/s` (empty when none). */
  readonly rates: string;
}

export interface HudModel {
  /** In-game date and time, `Day D HH:MM`. */
  readonly clock: string;
  readonly tick: number;
  /** `Time: Day D HH:MM (tick N)`. */
  readonly time: string;
  /** `Floor N` (the player's floor `z`) on a map with more than one floor, else null. */
  readonly floor: string | null;
  readonly measurements: readonly HudMeasurement[];
  /** Labels of the player's active statuses, in definition order. */
  readonly statuses: readonly string[];
  /** `Status: A, B`, or null when no status is active. */
  readonly statusLine: string | null;
  /** The player's active statuses, in definition order. */
  readonly statusChips: readonly HudStatusChip[];
  /** Whether it is day now (`world.is_day`). */
  readonly isDay: boolean;
  /** Day number of the clock. */
  readonly day: number;
  /** Time of day of the clock, `HH:MM`. */
  readonly timeOfDay: string;
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
  /** The player's in-progress activity, or null. */
  readonly activity: HudActivity | null;
}

export interface HudActivity {
  /** Progress text, e.g. `Barricading`. */
  readonly label: string;
  /** In [0, 1]. */
  readonly fraction: number;
  /** `Label [######----] 60%`. */
  readonly text: string;
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
  /** `weight / capacity`, clamped to [0, 1]. */
  readonly fraction: number;
  /** `warn` from 80 % of capacity, `danger` from 100 %. */
  readonly level: HudLevel;
  /** `Inventory: 1) A x2  2) B x1`, or `Inventory: empty`. */
  readonly line: string;
}

export interface HudContainer {
  readonly id: number;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
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

/** How long (sim seconds) the latest action stays in the HUD. */
const ACTION_SECONDS = 3;
/** Cells of the ASCII progress bar. */
const BAR_CELLS = 10;

/** `Label [######----] 60%`. */
export function progressText(label: string, fraction: number): string {
  const filled = Math.min(BAR_CELLS, Math.floor(fraction * BAR_CELLS + 1e-9));
  return `${label} [${'#'.repeat(filled)}${'-'.repeat(BAR_CELLS - filled)}] ${Math.round(fraction * 100)}%`;
}

/**
 * HUD text lines shared by the shells: time, floor (multi-floor maps), measurements, then — only when
 * present — carrying/inventory, status, nearby, latest action and defeat/victory.
 */
export function hudLines(m: HudModel): string[] {
  const lines = [m.time, ...(m.floor ? [m.floor] : []), ...m.measurements.map((x) => x.text)];
  if (m.inventory) lines.push(m.inventory.carrying, m.inventory.line);
  if (m.statusLine) lines.push(m.statusLine);
  if (m.nearbyLine) lines.push(m.nearbyLine);
  if (m.activity) lines.push(m.activity.text);
  if (m.lastAction) lines.push(m.lastAction);
  if (m.defeat) lines.push(m.defeat.text);
  if (m.victory) lines.push(m.victory.text);
  return lines;
}

/** Whether each `hudLines` line should stand out: `warn` (yellow) or `danger` (red) in the terminal, else null. */
export function hudLineLevels(m: HudModel): ('warn' | 'danger' | null)[] {
  const levels: ('warn' | 'danger' | null)[] = [null, ...(m.floor ? [null] : []), ...m.measurements.map((x) => (x.level === 'ok' ? null : x.level))];
  if (m.inventory) levels.push(null, null);
  if (m.statusLine) levels.push(m.statusChips.some((c) => c.tone === 'bad') ? 'danger' : null);
  return [...levels, ...Array<null>(hudLines(m).length - levels.length).fill(null)];
}

/** Inventory load from which the carrying level is `warn`. */
const CARRY_WARN = 0.8;

/** Level of a value against warn/danger levels, bad toward `bad`. */
function levelOf(value: number, bad: 'high' | 'low', warn: number | null, danger: number | null): HudLevel {
  const reached = (at: number | null) => at !== null && (bad === 'high' ? value >= at : value <= at);
  return reached(danger) ? 'danger' : reached(warn) ? 'warn' : 'ok';
}

/** `+0.1/s`, `−0.2/s` (one decimal, a real minus sign). */
function rateText(rate: number): string {
  const t = Math.abs(rate).toFixed(1);
  return `${t === '0.0' ? '' : rate < 0 ? '−' : '+'}${t}/s`;
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

/** `Barricading` → `barricading`, for the middle of a sentence. */
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

const UNREACHABLE_TEXT = "You can't get there.";

/** What the shells show when Escape is refused at a node with `leave: false`. */
export const LEAVE_REFUSED_TEXT = "You can't walk away now.";

/** `Needs: Hammer, 2× Plank`. */
export function needsText(missing: readonly MissingItem[]): string {
  return `Needs: ${missing.map((m) => (m.count > 1 ? `${m.count}× ${m.label}` : m.label)).join(', ')}`;
}

/** Short UI text per failure reason (`missing` and `cannot_act` have richer text, see `reasonText`). */
const REASON_TEXT: Record<ActionFailure, string> = {
  out_of_reach: 'Too far',
  too_heavy: 'Too heavy',
  missing: 'Missing items',
  cannot_use: 'Not now',
  no_inventory: 'No inventory',
  unknown_container: 'Not here',
  unknown_action: 'Unknown action',
  unknown_recipe: 'Unknown recipe',
  invalid_target: "Can't do that here",
  cannot_act: 'Not now',
  occupied: 'Something is in the way',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
  unreachable: "Can't get there",
  unknown_entity: 'Nobody there',
  no_dialogue: 'Nothing to say',
};

/**
 * Why an entry (of `interactionsAt` or `availableActions`) is disabled, as
 * short UI text: `Needs: Hammer, 2× Plank`, the action's `unavailable` text
 * or `Not now`, `Can't do that here`…; `''` when it has no reason.
 */
export function reasonText(entry: { readonly reason?: ActionFailure; readonly missing?: readonly MissingItem[]; readonly unavailable?: string }): string {
  const { reason } = entry;
  if (!reason) return '';
  if (reason === 'missing' && entry.missing?.length) return needsText(entry.missing);
  if (reason === 'cannot_act' && entry.unavailable) return entry.unavailable;
  return REASON_TEXT[reason];
}

/** Label of the first tile (definition order) a recipe's station matches, or null for a recipe without a station. */
export function stationLabel(world: World, recipe: string): string | null {
  const k = world.def.ids.recipes[recipe];
  const station = k === undefined ? null : world.def.recipes[k]!.station;
  if (!station) return null;
  return world.def.tiles.find((t) => station.match[t.index] === 1)?.label ?? null;
}

/** `reasonText` for an `availableRecipes` entry; a station out of reach reads `Go to a Stove`. */
export function recipeHint(world: World, r: AvailableRecipe): string {
  const station = r.reason === 'out_of_reach' ? stationLabel(world, r.recipe) : null;
  return station ? `Go to a ${station}` : reasonText(r);
}

/** `1× Hot beans, 2× Rag`. */
function countsText(world: World, list: readonly { item: number; count: number }[]): string {
  return list.map((c) => `${c.count}× ${world.def.items[c.item]!.label}`).join(', ');
}

/** Short feedback text for a `craft` record. */
function craftText(world: World, a: ActionRecord): string {
  const k = world.def.ids.recipes[a.recipe ?? ''];
  const def = k === undefined ? null : world.def.recipes[k]!;
  if (!def) return `Unknown recipe ${a.recipe ?? ''}`;
  const name = `${def.verb}: ${def.label}`;
  if (a.ok) {
    if (a.stage === 'start') return `You start: ${def.progress}.`;
    return `You make ${countsText(world, def.produce)}.${a.dropped ? ' (some dropped on the ground)' : ''}`;
  }
  switch (a.reason) {
    case 'no_inventory':
      return 'No inventory';
    case 'out_of_reach': {
      const station = stationLabel(world, def.id);
      return station ? `You need to be at a ${station}.` : "You can't reach that.";
    }
    case 'invalid_target':
      return `You can't ${lower(def.verb)} that here.`;
    case 'missing': {
      const items = world.def.items;
      return `You need ${[...def.tools.map((t) => items[t]!.label), ...def.consume.map((c) => `${items[c.item]!.label} x${c.count}`)].join(', ')}.`;
    }
    case 'cannot_act':
      return def.unavailable ?? `You can't ${lower(def.verb)} ${lower(def.label)} now.`;
    case 'cancelled':
      return `${name} cancelled.`;
    case 'interrupted':
      return `${name} interrupted.`;
    case 'unreachable':
      return UNREACHABLE_TEXT;
    default:
      return `${name} failed.`;
  }
}

/** Short feedback text for an `act` record. */
function actText(world: World, a: ActionRecord): string {
  const k = world.def.ids.actions[a.action ?? ''];
  const def = k === undefined ? null : world.def.actions[k]!;
  const label = def?.label ?? a.action ?? '';
  if (a.ok) return a.stage === 'start' ? `You start ${lower(def!.progress)}.` : `You finish ${lower(def!.progress)}.`;
  switch (a.reason) {
    case 'unknown_action':
      return `Unknown action ${label}`;
    case 'no_inventory':
      return 'No inventory';
    case 'out_of_reach':
      return "You can't reach that.";
    case 'invalid_target':
      return `You can't ${lower(label)} that.`;
    case 'missing': {
      const items = world.def.items;
      const need = [...def!.tools.map((t) => items[t]!.label), ...def!.consume.map((c) => `${items[c.item]!.label} x${c.count}`)];
      return `You need ${need.join(', ')}.`;
    }
    case 'cannot_act':
      return `You can't ${lower(label)} now.`;
    case 'occupied':
      return 'Something is in the way.';
    case 'cancelled':
      return `${label} cancelled.`;
    case 'interrupted':
      return `${label} interrupted.`;
    case 'unreachable':
      return UNREACHABLE_TEXT;
    default:
      return `${label} failed.`;
  }
}

/** Short feedback text for a `talk` record (`<Label> is not close enough.`). */
function talkText(world: World, a: ActionRecord): string {
  const npc = a.entity === undefined ? undefined : world.entities[a.entity];
  const label = npc?.archetype.label ?? 'Nobody';
  if (a.ok) return `You talk to ${label}.`;
  switch (a.reason) {
    case 'unknown_entity':
      return 'There is nobody to talk to.';
    case 'no_dialogue':
      return `${label} has nothing to say.`;
    case 'out_of_reach':
      return `${label} is not close enough.`;
    case 'cannot_act': {
      const k = npc?.archetype.dialogue;
      return (k === undefined || k === null ? null : world.def.dialogues[k]!.unavailable) ?? `${label} won't talk now.`;
    }
    case 'unreachable':
      return UNREACHABLE_TEXT;
    default:
      return `You can't talk to ${label}.`;
  }
}

/** Short feedback text for an action record. */
export function actionText(world: World, a: ActionRecord): string {
  if (a.kind === 'talk') return talkText(world, a);
  if (a.kind === 'act') return actText(world, a);
  if (a.kind === 'craft') return craftText(world, a);
  const idx = world.def.ids.items[a.item];
  const label = idx === undefined ? a.item : world.def.items[idx]!.label;
  if (a.kind === 'use' && idx !== undefined && world.def.items[idx]!.use) {
    const verb = world.def.items[idx]!.use!.label;
    if (a.ok && a.stage === 'start') return `You start: ${verb} ${label}.`;
    if (a.reason === 'cancelled') return `${verb} cancelled.`;
    if (a.reason === 'interrupted') return `${verb} interrupted.`;
  }
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
      return "You can't reach that.";
    case 'too_heavy':
      return 'Too heavy';
    case 'cannot_use':
      return `Cannot use ${label}`;
    case 'no_inventory':
      return 'No inventory';
    case 'unknown_container':
      return 'No such container';
    case 'unreachable':
      return UNREACHABLE_TEXT;
    default:
      return `No ${label}`;
  }
}

/** `Day D HH:MM`. */
export function formatClock(t: ClockTime): string {
  return `Day ${t.day} ${timeOfDayText(t)}`;
}

/** `HH:MM`. */
function timeOfDayText(t: ClockTime): string {
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${pad(t.hour)}:${pad(t.minute)}`;
}

export function hudModel(world: World): HudModel {
  const { player } = world;
  const now = world.clock;
  const clock = formatClock(now);
  const measurements = player.archetype.measurements
    .filter((idx) => !world.def.measurements[idx]!.hud.hide)
    .map((idx): HudMeasurement => {
      const md = world.def.measurements[idx]!;
      const { label, min } = md;
      const max = player.max[idx]!;
      const value = player.m[idx]!;
      const finite = Number.isFinite(max);
      const text = finite ? `${label}: ${fmt(value)}/${fmt(max)}` : `${label}: ${fmt(value)}`;
      const fraction = finite ? (max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 1) : null;
      const { bad } = md.hud;
      let level: HudLevel | null = null;
      if (bad !== null) {
        const { warn, danger } = measurementLevels(md, max);
        level = levelOf(value, bad, warn, danger);
      }
      return { id: md.id, label, value, min, max, text, fraction, bad, level };
    });
  const active = world.def.statuses.filter((s) => player.st[s.index] === 1);
  const statuses = active.map((s) => s.label);
  const statusChips = active.map(
    (s): HudStatusChip => ({
      id: s.id,
      label: s.label,
      tone: s.hud.tone,
      description: s.hud.description,
      rates: world
        .statusRatesOf(player, s.index)
        .map((r) => `${world.def.measurements[r.measurement]!.label} ${rateText(r.rate)}`)
        .join(', '),
    }),
  );
  let inventory: HudInventory | null = null;
  if (player.inv) {
    const stacks = stacksOf(world, player.inv);
    const weight = units(player.inv.load);
    const capacity = units(player.inv.capacity);
    const load = capacity > 0 ? weight / capacity : weight > 0 ? 1 : 0;
    inventory = {
      stacks,
      weight,
      capacity,
      carrying: `Carrying: ${weight}/${capacity}`,
      fraction: Math.min(1, Math.max(0, load)),
      level: load >= 1 ? 'danger' : load >= CARRY_WARN ? 'warn' : 'ok',
      line: `Inventory: ${stacks.length ? stacks.map((s, i) => `${i + 1}) ${s.text}`).join('  ') : 'empty'}`,
    };
  }
  const nearby = world.reachableContainers().map((c): HudContainer => {
    const stacks = stacksOf(world, c);
    const label = containerLabel(world, c);
    return { id: c.id, label, x: c.x, y: c.y, z: c.z, stacks, text: `${label} [${stacks.length ? stacks.map((s) => s.text).join(', ') : 'empty'}]` };
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
    day: now.day,
    timeOfDay: timeOfDayText(now),
    isDay: isDayAt(world.def.clock, world.tick, world.def.ticksPerSecond),
    tick: world.tick,
    time: `Time: ${clock} (tick ${world.tick})`,
    floor: world.grid.floors > 1 ? `Floor ${player.z}` : null,
    measurements,
    statuses,
    statusLine: statuses.length ? `Status: ${statuses.join(', ')}` : null,
    statusChips,
    defeat: outcome(world.defeat),
    victory: outcome(world.victory),
    inventory,
    nearby,
    nearbyLine: nearby.length ? `Nearby: ${nearby.map((c) => c.text).join('; ')}` : null,
    lastAction: fresh ? actionText(world, a) : null,
    activity: hudActivity(world),
  };
}

function hudActivity(world: World): HudActivity | null {
  const p = world.activityProgress();
  return p ? { ...p, text: progressText(p.label, p.fraction) } : null;
}
