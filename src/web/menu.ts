/**
 * The context menu model: what a right-click, long-press or `E` offers at a
 * cell. Pure functions over `world.interactionsAt` (no DOM types), so the
 * mapping is unit-tested; `menu-dom.ts` only renders it and runs items.
 */

import { reasonText, type Action, type GotoIntent, type World } from '../core/index.ts';
import { clickIntent } from './panels.ts';

/** What selecting a menu item does, in order: queue the intent, queue the actions, open the loot panel. */
export interface MenuRun {
  readonly intent?: GotoIntent;
  readonly actions?: readonly Action[];
  /** Show the loot panel at `container` (deferred until it is in reach when an intent walks there). */
  readonly openLoot?: boolean;
  readonly container?: number;
}

export interface MenuItem {
  readonly label: string;
  readonly disabled: boolean;
  /** Why it is disabled (`reasonText`). */
  readonly hint?: string;
  readonly run: MenuRun;
}

/**
 * Menu items for (x, y), one per `interactionsAt` entry, in its order.
 * Disabled entries stay, with their reason as `hint`. Out of reach, tile
 * actions and `take all` walk there first (`approachIntent`; a `take all`
 * from afar takes the first stack on arrival and opens the loot panel for
 * the rest), and `open` walks up to the container and opens the panel once
 * it is in reach.
 */
export function contextMenu(world: World, x: number, y: number): MenuItem[] {
  return world.interactionsAt(x, y).map((e): MenuItem => {
    const base = e.ok ? { label: e.label, disabled: false } : { label: e.label, disabled: true, hint: reasonText(e) };
    switch (e.kind) {
      case 'act':
        return { ...base, run: e.inReach ? { actions: [e.action!] } : { intent: world.approachIntent(e.action!)! } };
      case 'take_all':
        return {
          ...base,
          run: e.inReach ? { actions: e.actions! } : { intent: world.approachIntent(e.action!)!, openLoot: true, container: e.container! },
        };
      case 'open':
        return { ...base, run: e.inReach ? { openLoot: true, container: e.container! } : { intent: clickIntent(world, x, y), openLoot: true, container: e.container! } };
      case 'walk':
        return { ...base, run: { intent: clickIntent(world, x, y) } };
    }
  });
}

/** Menu title: the cell's tile label, plus its room tags (`Window · hall`); empty out of bounds. */
export function menuTitle(world: World, x: number, y: number): string {
  const tile = world.grid.tileAt(x, y);
  if (!tile) return '';
  const rooms = world.roomTagsAt(x, y).map((t) => world.def.roomTags[t]!);
  return [tile.label, ...rooms].join(' · ');
}

/** Queue a menu item's intent and actions; returns whether the loot panel should open. */
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
