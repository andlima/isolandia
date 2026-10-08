/**
 * The transfer window's view model: one reachable container (picked with a
 * tab) on the left, the player's inventory on the right. A pure function of
 * `hudModel` and the world's containers, so it is testable without a DOM;
 * `transfer-dom.ts` only renders it.
 */

import { DEFAULT_FACING, FACINGS, hudModel, type Action, type Definition, type HudStack, type World } from '../core/index.ts';
import type { PanelButton } from './panels.ts';

/** Icon of an item: its sprite's image file, else a swatch of its colour and glyph. */
export type ItemIcon = { readonly kind: 'image'; readonly url: string } | { readonly kind: 'swatch'; readonly color: string; readonly glyph: string };

/** Icon URL per item index (null without a sprite or a URL for it). */
export type ItemIconUrls = readonly (string | null)[];

export interface TransferTab {
  /** Container id. */
  readonly id: number;
  readonly label: string;
  /** Load, in normal units. */
  readonly weight: number;
  /** Null when unbounded (ground piles). */
  readonly capacity: number | null;
  readonly selected: boolean;
}

export interface TransferStack {
  /** Qualified item id. */
  readonly item: string;
  readonly label: string;
  readonly count: number;
  /** Weight of the whole stack, in normal units. */
  readonly weight: number;
  readonly icon: ItemIcon;
  /** Moves the whole stack to the other side (as many units as fit); null in inventory-only mode. */
  readonly move: Action | null;
  /** Moves one unit; null in inventory-only mode. */
  readonly moveOne: Action | null;
  /** True once the game has ended: moving is disabled. */
  readonly disabled: boolean;
  /** Inventory stacks of usable items: the use label (`Eat`). */
  readonly use?: PanelButton;
  /** Inventory stacks only. */
  readonly drop?: PanelButton;
}

export interface TransferContainer {
  readonly id: number;
  readonly label: string;
  readonly weight: number;
  readonly capacity: number | null;
  readonly stacks: readonly TransferStack[];
}

export interface TransferInventory {
  readonly stacks: readonly TransferStack[];
  readonly weight: number;
  readonly capacity: number;
  /** `Carrying: w/cap`. */
  readonly carrying: string;
  /** Load / capacity in [0, 1], for the weight bar. */
  readonly fill: number;
}

export interface TransferView {
  /** One per reachable container (`reachableContainers` order); empty in inventory-only mode. */
  readonly tabs: readonly TransferTab[];
  /** The selected container, or null (inventory-only mode, or it is out of reach). */
  readonly container: TransferContainer | null;
  /** Null when the player has no inventory. */
  readonly inventory: TransferInventory | null;
  /** Takes every container stack (as much as fits); null without a container or when it is empty. */
  readonly takeAll: PanelButton | null;
  /** Puts every inventory stack into the container; null without a container or when the inventory is empty. */
  readonly putAll: PanelButton | null;
  /** Why the latest take/put/use/drop failed (`Too heavy`), while it is fresh; else null. */
  readonly message: string | null;
}

const MOVE_KINDS: ReadonlySet<Action['kind']> = new Set(['take', 'put', 'use', 'drop']);

const button = (label: string, actions: Action[], disabled: boolean): PanelButton => ({ label, actions, disabled });

/** Hundredths → normal units. */
const units = (hundredths: number) => hundredths / 100;

/**
 * Icon URL of each item (by item index) from the asset URLs the renderer
 * loads (`assetUrls`: `urls[asset][image]`): the image an item pile shows
 * (facing `s`), or null without a sprite.
 */
export function itemIconUrls(def: Definition, urls: readonly (readonly (string | null)[])[]): (string | null)[] {
  const facing = FACINGS.indexOf(DEFAULT_FACING);
  return def.items.map((i) => {
    if (i.sprite === null) return null;
    const image = def.assets[i.sprite]?.byFacing[facing]?.image ?? 0;
    return urls[i.sprite]?.[image] ?? null;
  });
}

function iconOf(world: World, s: HudStack, icons: ItemIconUrls): ItemIcon {
  const url = icons[world.def.ids.items[s.item]!] ?? null;
  return url ? { kind: 'image', url } : { kind: 'swatch', color: s.color, glyph: s.glyph };
}

/**
 * The transfer window over `openContainer` (null: inventory only). A
 * container that is not reachable is not shown (no tab is selected); the
 * window picks another with `reselect`.
 */
export function transferView(world: World, openContainer: number | null, readOnly: boolean, icons: ItemIconUrls = []): TransferView {
  const m = hudModel(world);
  const open = openContainer === null ? null : (m.nearby.find((c) => c.id === openContainer) ?? null);
  const tabs =
    openContainer === null
      ? []
      : m.nearby.map((c): TransferTab => {
          const k = world.containers.get(c.id)!;
          return { id: c.id, label: c.label, weight: units(k.load), capacity: k.capacity === Infinity ? null : units(k.capacity), selected: c.id === open?.id };
        });
  const stack = (s: HudStack, move: Action | null, moveOne: Action | null) => ({
    item: s.item,
    label: s.label,
    count: s.count,
    weight: s.weight,
    icon: iconOf(world, s, icons),
    move,
    moveOne,
    disabled: readOnly,
  });
  let container: TransferContainer | null = null;
  if (open) {
    const tab = tabs.find((t) => t.selected)!;
    container = {
      id: open.id,
      label: open.label,
      weight: tab.weight,
      capacity: tab.capacity,
      stacks: open.stacks.map(
        (s): TransferStack => stack(s, { kind: 'take', container: open.id, item: s.item }, { kind: 'take', container: open.id, item: s.item, count: 1 }),
      ),
    };
  }
  let inventory: TransferInventory | null = null;
  if (m.inventory) {
    const { weight, capacity } = m.inventory;
    inventory = {
      stacks: m.inventory.stacks.map(
        (s): TransferStack => ({
          ...stack(
            s,
            open ? { kind: 'put', container: open.id, item: s.item } : null,
            open ? { kind: 'put', container: open.id, item: s.item, count: 1 } : null,
          ),
          ...(s.useLabel ? { use: button(s.useLabel, [{ kind: 'use', item: s.item }], readOnly) } : {}),
          drop: button('Drop', [{ kind: 'drop', item: s.item, count: s.count }], readOnly),
        }),
      ),
      weight,
      capacity,
      carrying: m.inventory.carrying,
      fill: capacity > 0 ? Math.min(1, weight / capacity) : weight > 0 ? 1 : 0,
    };
  }
  const takeAll = container?.stacks.length ? button('Take all', container.stacks.map((s) => s.move!), readOnly) : null;
  const putAll = container && inventory?.stacks.length ? button('Put all', inventory.stacks.map((s) => s.move!), readOnly) : null;
  const a = world.lastAction;
  const message = a && !a.ok && MOVE_KINDS.has(a.kind) ? m.lastAction : null;
  return { tabs, container, inventory, takeAll, putAll, message };
}

/**
 * The container to show once `selected` may have left reach: `selected`
 * itself while reachable, else the next of the previous tabs (`before`)
 * still reachable, else the first reachable one, else null.
 */
export function reselect(before: readonly number[], selected: number, reachable: readonly number[]): number | null {
  if (reachable.includes(selected)) return selected;
  const i = before.indexOf(selected);
  const next = [...before.slice(i + 1), ...before.slice(0, Math.max(i, 0)).reverse()].find((id) => reachable.includes(id));
  return next ?? reachable[0] ?? null;
}
