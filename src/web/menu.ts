/**
 * The click and context menu model: what a left click does at a cell
 * (`clickPlan`), what the menu offers there (`contextMenu`) and what hovering
 * it shows (`hoverInfo`). Pure functions over `world.interactionsAt` (no DOM
 * types), so the mapping is unit-tested; `menu-dom.ts` only renders the menu
 * and runs items.
 */

import { GROUND_LABEL, reasonText, type Action, type GotoIntent, type Interaction, type World } from '../core/index.ts';
import type { PickTarget } from '../iso/pick.ts';
import { clickIntent } from './panels.ts';

/** What selecting a menu item does, in order: queue the intent, queue the actions, open the transfer window. */
export interface MenuRun {
  readonly intent?: GotoIntent;
  readonly actions?: readonly Action[];
  /** Open the transfer window on `container` (deferred until it is in reach when an intent walks there). */
  readonly openLoot?: boolean;
  readonly container?: number;
}

export interface MenuItem {
  readonly label: string;
  readonly disabled: boolean;
  /** Why it is disabled (`reasonText`). */
  readonly hint?: string;
  /** Duration and costs of an enabled action or recipe (`8s · uses 2× Plank`). */
  readonly detail?: string;
  /** The left-click default (shown first, with a click hint). */
  readonly default?: true;
  readonly run: MenuRun;
}

/** How the menu was opened: by a left click (plan `menu`) or by right-click, long-press or `E`. */
export type MenuOpening = 'click' | 'context';

/** The menu at a cell. */
export interface Menu {
  /** Enabled items in display order: the default, the others, then `Walk here` (context menu only). Numbered 1–9. */
  readonly items: readonly MenuItem[];
  /** Disabled items, folded under `Can't do now (N)`. */
  readonly disabled: readonly MenuItem[];
  /** Whether the fold opens expanded (nothing is enabled). */
  readonly expanded: boolean;
}

/** A displayed menu row: an item (enabled ones with their 1–9 shortcut) or the fold row. */
export type MenuRow = { readonly kind: 'item'; readonly item: MenuItem; readonly key?: number } | { readonly kind: 'fold'; readonly label: string; readonly expanded: boolean };

/** What a plain left click on a target does. */
export type ClickPlan =
  /** Run the safe default (`item` is what choosing `entry` in the menu does). */
  | { readonly kind: 'run'; readonly entry: Interaction; readonly item: MenuItem }
  /** Open the menu (`contextMenu(…, 'click')`). */
  | { readonly kind: 'menu' }
  /** Nothing to do there: walk (next to it when it is not walkable). */
  | { readonly kind: 'walk'; readonly intent: GotoIntent }
  /** The player's own cell with nothing to do. */
  | { readonly kind: 'none' };

/** What hovering a target shows. */
export interface HoverInfo {
  readonly title: string;
  /** What a click does (`Click: Open`), empty for a plain walk. */
  readonly hint: string;
  readonly cursor: 'pointer' | 'default' | 'not-allowed';
}

type Cell = { readonly x: number; readonly y: number; readonly z: number };

/** `8s`, `1m 20s` (sim seconds, rounded to whole seconds; at least `1s`). */
export function formatDuration(seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  const m = Math.floor(s / 60);
  if (m === 0) return `${s}s`;
  return s % 60 === 0 ? `${m}m` : `${m}m ${s % 60}s`;
}

/** The detail line of an enabled `act`/`craft` entry: its duration when > 0 and what it uses up. */
function detailOf(e: Interaction): string | undefined {
  const parts: string[] = [];
  if (e.duration !== undefined && e.duration > 0) parts.push(formatDuration(e.duration));
  if (e.uses?.length) parts.push(`uses ${e.uses.map((u) => (u.count > 1 ? `${u.count}× ${u.label}` : u.label)).join(', ')}`);
  return parts.length ? parts.join(' · ') : undefined;
}

/** An entry's label: recipes add their produce count when > 1 (`Cook: Hot beans ×2`). */
function labelOf(world: World, e: Interaction): string {
  if (e.kind !== 'craft' || e.action?.kind !== 'craft') return e.label;
  const r = world.def.recipes[world.def.ids.recipes[e.action.recipe] ?? -1];
  const n = r?.produce[0]?.count ?? 1;
  return n > 1 ? `${e.label} ×${n}` : e.label;
}

/**
 * The menu item for an `interactionsAt` entry at (x, y, z). `Go up` /
 * `Go down` walk to the far end of the link (through it). Out of reach, tile
 * actions, station recipes and `take all` walk there first
 * (`approachIntent`; a `take all` from afar takes the first stack on arrival
 * and opens the transfer window for the rest), and `open` walks up to the
 * container and opens the panel once it is in reach.
 */
function menuItem(world: World, e: Interaction, x: number, y: number, z: number): MenuItem {
  const label = labelOf(world, e);
  const detail = e.ok && (e.kind === 'act' || e.kind === 'craft') ? detailOf(e) : undefined;
  const base = e.ok ? { label, disabled: false, ...(detail ? { detail } : {}) } : { label, disabled: true, hint: reasonText(e) };
  switch (e.kind) {
    case 'act':
    case 'craft':
      return { ...base, run: e.inReach ? { actions: [e.action!] } : { intent: world.approachIntent(e.action!)! } };
    case 'take_all':
      return {
        ...base,
        run: e.inReach ? { actions: e.actions! } : { intent: world.approachIntent(e.action!)!, openLoot: true, container: e.container! },
      };
    case 'open':
      return { ...base, run: e.inReach ? { openLoot: true, container: e.container! } : { intent: clickIntent(world, x, y, z), openLoot: true, container: e.container! } };
    case 'climb':
      return { ...base, run: { intent: e.intent! } };
    case 'walk':
      return { ...base, run: { intent: clickIntent(world, x, y, z) } };
  }
}

/**
 * The safe default among a cell's entries: the first enabled `open`, else the
 * only `climb`, else `walk`. Stairs that lead both ways have none (the menu
 * picks the direction).
 */
function safeEntry(entries: readonly Interaction[]): Interaction | undefined {
  const open = entries.find((e) => e.kind === 'open' && e.ok);
  if (open) return open;
  const climbs = entries.filter((e) => e.kind === 'climb');
  if (climbs.length > 1) return undefined;
  if (climbs.length === 1) return climbs[0]!.ok ? climbs[0] : undefined;
  // `interactionsAt` never offers `walk` on the player's own cell.
  return entries.find((e) => e.kind === 'walk' && e.ok);
}

/**
 * What a plain left click on `target`'s cell does: `run` the safe default
 * (open a container, the only climb, walk) when the cell has no enabled
 * action or recipe; `menu` when it has one, or has entries but no safe one;
 * `walk` (next to it when not walkable) when it has no entries at all;
 * `none` on the player's own cell with nothing to do.
 */
export function clickPlan(world: World, target: Cell): ClickPlan {
  const { x, y, z } = target;
  const entries = world.interactionsAt(x, y, z);
  if (entries.length === 0) {
    const p = world.player;
    return x === p.x && y === p.y && z === p.z ? { kind: 'none' } : { kind: 'walk', intent: clickIntent(world, x, y, z) };
  }
  const actionable = entries.some((e) => e.ok && (e.kind === 'act' || e.kind === 'craft'));
  const safe = safeEntry(entries);
  if (actionable || !safe) return { kind: 'menu' };
  return { kind: 'run', entry: safe, item: menuItem(world, safe, x, y, z) };
}

/**
 * The menu for (x, y) on floor `z` (default the player's): the default (the
 * click plan's safe entry unless it is `walk`) first, the other enabled
 * entries in `interactionsAt` order, `Walk here` (context menu only), and
 * the disabled entries (with their reason as `hint`) for the fold row.
 */
export function contextMenu(world: World, x: number, y: number, z: number = world.player.z, opening: MenuOpening = 'context'): Menu {
  const entries = world.interactionsAt(x, y, z);
  const safe = safeEntry(entries);
  const first = safe && safe.kind !== 'walk' ? safe : undefined;
  const items: MenuItem[] = [];
  const disabled: MenuItem[] = [];
  if (first) items.push({ ...menuItem(world, first, x, y, z), default: true });
  let walk: MenuItem | undefined;
  for (const e of entries) {
    if (e === first) continue;
    const it = menuItem(world, e, x, y, z);
    if (e.kind === 'walk') walk = it;
    else (e.ok ? items : disabled).push(it);
  }
  if (walk && opening === 'context') items.push(walk);
  return { items, disabled, expanded: items.length === 0 && disabled.length > 0 };
}

/** Every item of a menu: enabled, then disabled. */
export function menuItems(menu: Menu): MenuItem[] {
  return [...menu.items, ...menu.disabled];
}

/** The fold row's label. */
export function foldLabel(count: number, expanded: boolean): string {
  return `Can't do now (${count}) ${expanded ? '▾' : '▸'}`;
}

/** The rows shown: enabled items (the first nine numbered), then the fold row and, when `expanded`, the disabled items. */
export function menuRows(menu: Menu, expanded: boolean): MenuRow[] {
  const rows: MenuRow[] = menu.items.map((item, k) => (k < 9 ? { kind: 'item', item, key: k + 1 } : { kind: 'item', item }));
  if (menu.disabled.length === 0) return rows;
  rows.push({ kind: 'fold', label: foldLabel(menu.disabled.length, expanded), expanded });
  if (expanded) for (const item of menu.disabled) rows.push({ kind: 'item', item });
  return rows;
}

/** The 1–9 shortcut of a key code (`Digit3`, `Numpad3` → 3), or 0. */
export function shortcutOf(code: string): number {
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(code);
  return m ? Number(m[1]) : 0;
}

/** Menu title: the cell's tile label, plus its room tags (`Window · hall`); empty out of bounds or on an empty cell. */
export function menuTitle(world: World, x: number, y: number, z: number = world.player.z): string {
  const tile = world.grid.tileAt(x, y, z);
  if (!tile) return '';
  const rooms = world.roomTagsAt(x, y, z).map((t) => world.def.roomTags[t]!);
  return [tile.label, ...rooms].join(' · ');
}

/** Hover title: an entity's archetype label, `Ground · <first items>` for a pile, else `menuTitle`. */
function hoverTitle(world: World, target: PickTarget): string {
  if (target.kind === 'entity') return target.entity.archetype.label;
  if (target.kind === 'pile') {
    const labels = target.container.stacks.slice(0, 3).map((s) => world.def.items[s.item]!.label);
    const more = target.container.stacks.length > 3 ? ', …' : '';
    return labels.length ? `${GROUND_LABEL} · ${labels.join(', ')}${more}` : GROUND_LABEL;
  }
  return menuTitle(world, target.x, target.y, target.z);
}

/** What hovering `target` shows: its title, what a click does there, and the pointer's cursor. */
export function hoverInfo(world: World, target: PickTarget): HoverInfo {
  const title = hoverTitle(world, target);
  const plan = clickPlan(world, target);
  switch (plan.kind) {
    case 'run': {
      const e = plan.entry;
      if (e.kind === 'walk') return { title, hint: '', cursor: 'default' };
      return { title, hint: `Click: ${e.kind === 'open' ? 'Open' : e.label}`, cursor: 'pointer' };
    }
    case 'menu': {
      const n = contextMenu(world, target.x, target.y, target.z, 'click').items.length;
      return { title, hint: n === 0 ? "Click: Can't do now" : `Click: ${n} action${n === 1 ? '' : 's'}`, cursor: 'pointer' };
    }
    case 'walk':
      return { title, hint: '', cursor: 'default' };
    case 'none':
      return { title, hint: '', cursor: 'not-allowed' };
  }
}

/** Queue a menu item's intent and actions; returns whether the transfer window should open. */
export function runMenuItem(world: World, item: MenuItem): boolean {
  if (item.disabled) return false;
  const { intent, actions, openLoot } = item.run;
  if (intent) world.queueIntent(intent);
  for (const a of actions ?? []) world.queueAction(a);
  return openLoot === true;
}

/** Top-left corner for a `w`×`h` menu opened at (sx, sy), kept `margin` px inside a `vw`×`vh` viewport. */
export function clampMenu(sx: number, sy: number, w: number, h: number, vw: number, vh: number, margin = 4): { x: number; y: number } {
  const x = Math.max(margin, Math.min(sx, vw - w - margin));
  const y = Math.max(margin, Math.min(sy, vh - h - margin));
  return { x, y };
}

/** Selection after an arrow key: `delta` ±1, wrapping; -1 (none) goes to the first or last item. */
export function moveSelection(count: number, selected: number, delta: 1 | -1): number {
  if (count === 0) return -1;
  if (selected < 0) return delta > 0 ? 0 : count - 1;
  return (selected + delta + count) % count;
}
