/**
 * Crafting panel, journal panel and transfer window for the browser. The
 * views are pure functions of `availableRecipes`, `world.journal()` and
 * `hudModel` (`transfer.ts`), so they are testable without a DOM; the
 * `Panels` class only renders them and turns button clicks into
 * `world.queueAction`. Pack actions live in the context menu (`menu.ts`).
 */

import { journalSections, recipeHint, standingRows, stationLabel, STANDING_TITLE, type Action, type GotoIntent, type JournalSection, type StandingRow, type World } from '../core/index.ts';
import { TransferWindow } from './transfer-dom.ts';
import type { ItemIconUrls } from './transfer.ts';

export interface PanelButton {
  readonly label: string;
  /** Queued in order when clicked. */
  readonly actions: readonly Action[];
  /** True once the game has ended (defeat or victory): the panels are read-only. */
  readonly disabled: boolean;
  /** Why it is disabled (`recipeHint`), when it is not just read-only. */
  readonly hint?: string;
}

const button = (label: string, action: Action | Action[], disabled: boolean): PanelButton => ({
  label,
  actions: Array.isArray(action) ? action : [action],
  disabled,
});

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
    const action: Action = r.station ? { kind: 'craft', recipe: r.recipe, x: r.station.x, y: r.station.y, z: r.station.z } : { kind: 'craft', recipe: r.recipe };
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

/**
 * Journal panel: `Active` and `Done` quests, then one section per entry
 * category (`journalSections`), then the Standing section (label, tier and a
 * bar from -100 to 100 per faction).
 */
export interface JournalPanelView {
  readonly sections: readonly JournalSection[];
  /** Title of the Standing section (shown only when `standing` is not empty). */
  readonly standingTitle: string;
  readonly standing: readonly StandingRow[];
  /** Shown when there is nothing yet. */
  readonly empty: string | null;
}

/** The journal panel's view, a pure function of `world.journal()` (read-only: it has no buttons). */
export function journalView(world: World): JournalPanelView {
  const view = world.journal();
  const sections = journalSections(view);
  const standing = standingRows(view);
  return { sections, standingTitle: STANDING_TITLE, standing, empty: sections.length || standing.length ? null : 'Nothing yet.' };
}

/** Whether the packs have anything for the journal (quests, journal entries or factions that are not hidden). */
export function hasJournal(world: World): boolean {
  return world.def.quests.length > 0 || world.def.journal.length > 0 || world.def.factions.some((f) => !f.hidden);
}

/**
 * Click-to-move to (x, y) on floor `z` (default the player's): a
 * non-walkable container tile is approached (`adjacent: true`) instead of
 * entered.
 */
export function clickIntent(world: World, x: number, y: number, z: number = world.player.z): GotoIntent {
  const t = world.grid.tileAt(x, y, z);
  return t?.container && !t.walkable ? { kind: 'goto', x, y, z, adjacent: true } : { kind: 'goto', x, y, z };
}

/** DOM rendering of the panels. Re-renders only when their content changes. */
export class Panels {
  private readonly craft: HTMLDivElement;
  private readonly transfer: TransferWindow;
  private readonly toggle: HTMLButtonElement | null = null;
  private readonly journal: HTMLDivElement;
  private readonly journalToggle: HTMLButtonElement | null = null;
  private journalShown = -1;
  private craftKey = '';
  private lastTick = -1;
  private lastVersion = -1;
  private lastTileVersion = -1;

  constructor(
    parent: HTMLElement,
    private readonly world: World,
    icons: ItemIconUrls = [],
  ) {
    this.transfer = new TransferWindow(parent, world, icons);
    this.craft = document.createElement('div');
    this.craft.id = 'crafting';
    this.craft.className = 'panel';
    this.craft.hidden = true;
    parent.append(this.craft);
    this.craft.addEventListener('click', (ev) => this.onClick(ev));
    if (world.def.recipes.length > 0 && world.player.inv) {
      const toggle = (this.toggle = document.createElement('button'));
      toggle.id = 'craft-toggle';
      toggle.textContent = 'Crafting [C]';
      toggle.addEventListener('click', () => this.toggleCrafting());
      parent.append(toggle);
    }
    this.journal = document.createElement('div');
    this.journal.id = 'journal';
    this.journal.className = 'panel';
    this.journal.hidden = true;
    parent.append(this.journal);
    if (hasJournal(world)) {
      const toggle = (this.journalToggle = document.createElement('button'));
      toggle.id = 'journal-toggle';
      toggle.textContent = 'Journal [J]';
      toggle.addEventListener('click', () => this.toggleJournal());
      parent.append(toggle);
    }
  }

  /** `J` or the HUD button: show or hide the journal panel. */
  toggleJournal(): void {
    if (!hasJournal(this.world)) return;
    this.journal.hidden = !this.journal.hidden;
    this.journalShown = -1;
  }

  /** Remove the panels' elements (the world is being replaced). */
  dispose(): void {
    this.transfer.dispose();
    for (const el of [this.craft, this.toggle, this.journal, this.journalToggle]) el?.remove();
  }

  /** `C` or the HUD button: show or hide the crafting panel (showing it closes the transfer window). */
  toggleCrafting(): void {
    if (this.world.def.recipes.length === 0 || !this.world.player.inv) return;
    this.craft.hidden = !this.craft.hidden;
    if (!this.craft.hidden) this.transfer.close();
    this.craftKey = '';
    this.lastTick = -1;
  }

  /** `I` / `Tab`: the transfer window in inventory-only mode (see `TransferWindow.toggleInventory`). */
  toggleInventory(): void {
    this.transfer.toggleInventory();
  }

  /** Open the transfer window on container `id` now, or as soon as it is in reach. */
  openLoot(id: number): void {
    this.transfer.openContainer(id);
  }

  /** `Escape`, or the Game panel opening: close the transfer window. */
  closeTransfer(): void {
    this.transfer.close();
  }

  update(): void {
    this.transfer.update();
    const w = this.world;
    if (!this.journal.hidden && w.journalVersion !== this.journalShown) {
      this.journalShown = w.journalVersion;
      const jv = journalView(w);
      const parts: HTMLElement[] = [heading('Journal')];
      for (const s of jv.sections) {
        const h = heading(s.title);
        h.className = 'panel-subtitle';
        parts.push(h, ...s.rows.map(line));
      }
      if (jv.standing.length) {
        const h = heading(jv.standingTitle);
        h.className = 'panel-subtitle';
        parts.push(h, ...jv.standing.map(standingLine));
      }
      if (jv.empty) parts.push(line(jv.empty));
      this.journal.replaceChildren(...parts);
    }
    if (w.tick === this.lastTick && w.containerVersion === this.lastVersion && w.tileVersion === this.lastTileVersion) return;
    this.lastTick = w.tick;
    this.lastVersion = w.containerVersion;
    this.lastTileVersion = w.tileVersion;
    const readOnly = w.ended;

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

/** A Standing row: `Police: Wary (-22)` and a bar from -100 to 100 with a mark at 0. */
function standingLine(r: StandingRow): HTMLDivElement {
  const d = line(r.text);
  d.className = 'standing-row';
  const bar = document.createElement('div');
  bar.className = 'standing-bar';
  const fill = document.createElement('div');
  fill.className = r.value < 0 ? 'standing-fill standing-low' : 'standing-fill';
  // The fill runs from the middle (0) to the value.
  const at = r.fraction * 100;
  fill.style.left = `${Math.min(at, 50)}%`;
  fill.style.width = `${Math.abs(at - 50)}%`;
  bar.append(fill);
  d.append(bar);
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
