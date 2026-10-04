/**
 * Inventory, loot and crafting panels for the browser. The views are pure
 * functions of `hudModel` and `availableRecipes` (so they are testable
 * without a DOM); the `Panels` class only renders them and turns button
 * clicks into `world.queueAction`. Pack actions live in the context menu (`menu.ts`).
 */

import { hudModel, recipeHint, stationLabel, type Action, type GotoIntent, type HudModel, type World } from '../core/index.ts';

export interface PanelButton {
  readonly label: string;
  /** Queued in order when clicked. */
  readonly actions: readonly Action[];
  /** True once the game has ended (defeat or victory): the panels are read-only. */
  readonly disabled: boolean;
  /** Why it is disabled (`recipeHint`), when it is not just read-only. */
  readonly hint?: string;
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
  /** Container id. */
  readonly id: number;
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
      id: c.id,
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

/** One recipe of the crafting panel. */
export interface CraftingRow {
  /** Qualified recipe id. */
  readonly recipe: string;
  /** The result's name, e.g. `Hot beans`. */
  readonly label: string;
  /** Consumed items, e.g. `2× Rag`. */
  readonly inputs: string;
  /** Tools, e.g. `Hammer`; `''` for none. */
  readonly tools: string;
  /** `at Stove` (the first matching tile's label), or null without a station. */
  readonly station: string | null;
  /** `Craft`: disabled with a hint when the recipe cannot be started now. */
  readonly craft: PanelButton;
}

export interface CraftingGroup {
  readonly category: string;
  readonly rows: readonly CraftingRow[];
}

/** Crafting panel: every recipe, grouped by category (first-seen order), rows in definition order. */
export interface CraftingView {
  readonly groups: readonly CraftingGroup[];
}

/**
 * The crafting panel's view, a pure function of `world.availableRecipes()`.
 * Craft queues the recipe at its chosen station cell; a station out of reach
 * stays disabled (`Go to a Stove`): the context menu walks there.
 */
export function craftingView(world: World, readOnly: boolean): CraftingView {
  const { items, recipes, ids } = world.def;
  const groups: { category: string; rows: CraftingRow[] }[] = [];
  for (const r of world.availableRecipes()) {
    const def = recipes[ids.recipes[r.recipe]!]!;
    const station = stationLabel(world, r.recipe);
    const action: Action = r.station ? { kind: 'craft', recipe: r.recipe, x: r.station.x, y: r.station.y } : { kind: 'craft', recipe: r.recipe };
    const craft: PanelButton = r.ok ? button('Craft', action, readOnly) : { ...button('Craft', action, true), hint: recipeHint(world, r) };
    const row: CraftingRow = {
      recipe: r.recipe,
      label: r.label,
      inputs: def.consume.map((c) => `${c.count}× ${items[c.item]!.label}`).join(', '),
      tools: def.tools.map((t) => items[t]!.label).join(', '),
      station: station === null ? null : `at ${station}`,
      craft,
    };
    const g = groups.find((x) => x.category === r.category);
    if (g) g.rows.push(row);
    else groups.push({ category: r.category, rows: [row] });
  }
  return { groups };
}

/** One line of a crafting row: `Hot beans: 1× Canned beans · tools: Hammer · at Stove`. */
export function craftingRowText(r: CraftingRow): string {
  return [`${r.label}: ${r.inputs}`, ...(r.tools ? [`tools: ${r.tools}`] : []), ...(r.station ? [r.station] : [])].join(' · ');
}

/** Click-to-move: a non-walkable container tile is approached (`adjacent: true`) instead of entered. */
export function clickIntent(world: World, x: number, y: number): GotoIntent {
  const t = world.grid.tileAt(x, y);
  return t?.container && !t.walkable ? { kind: 'goto', x, y, adjacent: true } : { kind: 'goto', x, y };
}

/** DOM rendering of the panels. Re-renders only when their content changes. */
export class Panels {
  private readonly inv: HTMLDivElement;
  private readonly loot: HTMLDivElement;
  private readonly craft: HTMLDivElement;
  private invKey = '';
  private lootKey = '';
  private craftKey = '';
  private lastTick = -1;
  private lastVersion = -1;
  private lastTileVersion = -1;
  /** Container to bring into view once it is in reach (context menu `Open`), or null. */
  private focus: number | null = null;

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
    this.craft = document.createElement('div');
    this.craft.id = 'crafting';
    this.craft.className = 'panel';
    this.craft.hidden = true;
    parent.append(this.inv, this.loot, this.craft);
    this.inv.addEventListener('click', (ev) => this.onClick(ev));
    this.loot.addEventListener('click', (ev) => this.onClick(ev));
    this.craft.addEventListener('click', (ev) => this.onClick(ev));
    if (world.def.recipes.length > 0 && world.player.inv) {
      const toggle = document.createElement('button');
      toggle.id = 'craft-toggle';
      toggle.textContent = 'Crafting [C]';
      toggle.addEventListener('click', () => this.toggleCrafting());
      parent.append(toggle);
    }
  }

  /** `C` or the HUD button: show or hide the crafting panel. */
  toggleCrafting(): void {
    if (this.world.def.recipes.length === 0 || !this.world.player.inv) return;
    this.craft.hidden = !this.craft.hidden;
    this.craftKey = '';
    this.lastTick = -1;
  }

  /** `I` / `Tab`: show or hide the inventory panel. */
  toggleInventory(): void {
    if (!this.world.player.inv) return;
    this.inv.hidden = !this.inv.hidden;
    this.invKey = '';
  }

  /** Show container `id` in the loot panel now, or as soon as it is in reach. */
  openLoot(id: number): void {
    this.focus = id;
    this.lastTick = -1;
  }

  update(): void {
    const w = this.world;
    if (w.tick === this.lastTick && w.containerVersion === this.lastVersion && w.tileVersion === this.lastTileVersion) return;
    this.lastTick = w.tick;
    this.lastVersion = w.containerVersion;
    this.lastTileVersion = w.tileVersion;
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

    if (!this.craft.hidden) {
      const cv = craftingView(w, readOnly);
      const key = JSON.stringify(cv);
      if (key !== this.craftKey) {
        this.craftKey = key;
        const parts: HTMLElement[] = [heading('Crafting')];
        for (const g of cv.groups) {
          const h = heading(g.category);
          h.className = 'panel-subtitle';
          parts.push(h);
          for (const r of g.rows) {
            const d = line(craftingRowText(r));
            d.className = 'panel-row';
            d.append(' ', buttonEl(r.craft));
            if (r.craft.hint) {
              const hint = document.createElement('span');
              hint.className = 'panel-hint';
              hint.textContent = ` ${r.craft.hint}`;
              d.append(hint);
            }
            parts.push(d);
          }
        }
        this.craft.replaceChildren(...parts);
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
          h.dataset['container'] = String(s.id);
          if (s.takeAll) h.append(' ', buttonEl(s.takeAll));
          parts.push(h, ...s.rows.map(row), ...(s.rows.length ? [] : [line('empty')]));
        }
        if (lv.put.length) parts.push(heading('Put'), ...lv.put.map(row));
        this.loot.replaceChildren(...parts);
      }
      const at = this.focus === null ? null : this.loot.querySelector<HTMLElement>(`[data-container="${this.focus}"]`);
      if (at) {
        this.focus = null;
        at.scrollIntoView({ block: 'nearest' });
        at.classList.remove('focus');
        void at.offsetWidth; // restart the highlight animation
        at.classList.add('focus');
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
  if (b.hint) el.title = b.hint;
  el.dataset['actions'] = JSON.stringify(b.actions);
  return el;
}

function row(r: PanelRow): HTMLDivElement {
  const d = line(r.text);
  d.className = 'panel-row';
  for (const b of r.buttons) d.append(' ', buttonEl(b));
  return d;
}
