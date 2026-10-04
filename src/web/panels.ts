/**
 * Inventory and loot panels for the browser. The views are pure functions
 * of `hudModel` (so they are testable without a DOM); the `Panels` class
 * only renders them and turns button clicks into `world.queueAction`.
 */

import { hudModel, type Action, type GotoIntent, type HudModel, type World } from '../core/index.ts';

export interface PanelButton {
  readonly label: string;
  /** Queued in order when clicked. */
  readonly actions: readonly Action[];
  /** True once the game has ended (defeat or victory): the panels are read-only. */
  readonly disabled: boolean;
}

export interface PanelRow {
  readonly text: string;
  readonly buttons: readonly PanelButton[];
}

export interface InventoryView {
  /** `Carrying: w/cap`. */
  readonly carrying: string;
  readonly rows: readonly PanelRow[];
}

export interface LootSection {
  readonly title: string;
  readonly rows: readonly PanelRow[];
  /** Takes every stack of the container (as much as fits); null when empty. */
  readonly takeAll: PanelButton | null;
}

export interface LootView {
  readonly sections: readonly LootSection[];
  /** One row per inventory stack, with a Put button per reachable container. */
  readonly put: readonly PanelRow[];
}

const button = (label: string, action: Action | Action[], disabled: boolean): PanelButton => ({
  label,
  actions: Array.isArray(action) ? action : [action],
  disabled,
});

/** Inventory panel: each stack with Use (its use label) and Drop; null without an inventory. */
export function inventoryView(m: HudModel, readOnly: boolean): InventoryView | null {
  if (!m.inventory) return null;
  return {
    carrying: m.inventory.carrying,
    rows: m.inventory.stacks.map((s) => ({
      text: `${s.text} (${s.weight})`,
      buttons: [
        ...(s.useLabel ? [button(s.useLabel, { kind: 'use', item: s.item }, readOnly)] : []),
        button('Drop', { kind: 'drop', item: s.item, count: s.count }, readOnly),
      ],
    })),
  };
}

/** Loot panel: shown when at least one container is reachable (null otherwise). */
export function lootView(m: HudModel, readOnly: boolean): LootView | null {
  if (m.nearby.length === 0) return null;
  const sections = m.nearby.map(
    (c): LootSection => ({
      title: c.label,
      rows: c.stacks.map((s) => ({
        text: s.text,
        buttons: [button('Take', { kind: 'take', container: c.id, item: s.item, count: 1 }, readOnly)],
      })),
      takeAll: c.stacks.length
        ? button(
            'Take all',
            c.stacks.map((s): Action => ({ kind: 'take', container: c.id, item: s.item })),
            readOnly,
          )
        : null,
    }),
  );
  const put = (m.inventory?.stacks ?? []).map((s) => ({
    text: s.text,
    buttons: m.nearby.map((c) => button(`Put → ${c.label}`, { kind: 'put', container: c.id, item: s.item, count: 1 }, readOnly)),
  }));
  return { sections, put };
}

/** Click-to-move: a non-walkable container tile is approached (`adjacent: true`) instead of entered. */
export function clickIntent(world: World, x: number, y: number): GotoIntent {
  const t = world.grid.tileAt(x, y);
  return t?.container && !t.walkable ? { kind: 'goto', x, y, adjacent: true } : { kind: 'goto', x, y };
}

/** DOM rendering of the two panels. Re-renders only when their content changes. */
export class Panels {
  private readonly inv: HTMLDivElement;
  private readonly loot: HTMLDivElement;
  private invKey = '';
  private lootKey = '';
  private lastTick = -1;
  private lastVersion = -1;

  constructor(
    parent: HTMLElement,
    private readonly world: World,
  ) {
    this.inv = document.createElement('div');
    this.inv.id = 'inventory';
    this.inv.className = 'panel';
    this.inv.hidden = true;
    this.loot = document.createElement('div');
    this.loot.id = 'loot';
    this.loot.className = 'panel';
    this.loot.hidden = true;
    parent.append(this.inv, this.loot);
    this.inv.addEventListener('click', (ev) => this.onClick(ev));
    this.loot.addEventListener('click', (ev) => this.onClick(ev));
  }

  /** `I` / `Tab`: show or hide the inventory panel. */
  toggleInventory(): void {
    if (!this.world.player.inv) return;
    this.inv.hidden = !this.inv.hidden;
    this.invKey = '';
  }

  update(): void {
    const w = this.world;
    if (w.tick === this.lastTick && w.containerVersion === this.lastVersion) return;
    this.lastTick = w.tick;
    this.lastVersion = w.containerVersion;
    const m = hudModel(w);
    const readOnly = w.ended;

    const iv = inventoryView(m, readOnly);
    if (iv && !this.inv.hidden) {
      const key = JSON.stringify(iv);
      if (key !== this.invKey) {
        this.invKey = key;
        this.inv.replaceChildren(heading('Inventory'), line(iv.carrying), ...iv.rows.map(row), ...(iv.rows.length ? [] : [line('empty')]));
      }
    }

    const lv = lootView(m, readOnly);
    this.loot.hidden = lv === null;
    if (lv) {
      const key = JSON.stringify(lv);
      if (key !== this.lootKey) {
        this.lootKey = key;
        const parts: HTMLElement[] = [];
        for (const s of lv.sections) {
          const h = heading(s.title);
          if (s.takeAll) h.append(' ', buttonEl(s.takeAll));
          parts.push(h, ...s.rows.map(row), ...(s.rows.length ? [] : [line('empty')]));
        }
        if (lv.put.length) parts.push(heading('Put'), ...lv.put.map(row));
        this.loot.replaceChildren(...parts);
      }
    }
  }

  private onClick(ev: MouseEvent): void {
    const el = (ev.target as HTMLElement).closest('button');
    if (!el || el.disabled) return;
    for (const a of JSON.parse(el.dataset['actions']!) as Action[]) this.world.queueAction(a);
  }
}

function heading(text: string): HTMLDivElement {
  const h = document.createElement('div');
  h.className = 'panel-title';
  h.textContent = text;
  return h;
}

function line(text: string): HTMLDivElement {
  const d = document.createElement('div');
  d.textContent = text;
  return d;
}

function buttonEl(b: PanelButton): HTMLButtonElement {
  const el = document.createElement('button');
  el.textContent = b.label;
  el.disabled = b.disabled;
  el.dataset['actions'] = JSON.stringify(b.actions);
  return el;
}

function row(r: PanelRow): HTMLDivElement {
  const d = line(r.text);
  d.className = 'panel-row';
  for (const b of r.buttons) d.append(' ', buttonEl(b));
  return d;
}
