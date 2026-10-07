/**
 * DOM rendering of the transfer window (the view is `transferView` in
 * `transfer.ts`): container tabs and stacks on the left, the inventory on
 * the right. Clicking a row moves the whole stack, Shift-click one unit.
 * Opened on a container (`openContainer`, deferred until it is in reach) or
 * with `I` / `Tab` in inventory-only mode; re-renders only when its view changes.
 */

import type { Action, World } from '../core/index.ts';
import type { PanelButton } from './panels.ts';
import { reselect, transferView, type ItemIcon, type ItemIconUrls, type TransferStack, type TransferView } from './transfer.ts';

export class TransferWindow {
  private readonly el: HTMLDivElement;
  private open = false;
  /** Opened with `I` / `Tab`: falls back to inventory-only instead of closing when no container is left. */
  private fromInventory = false;
  /** Selected container, or null in inventory-only mode. */
  private selected: number | null = null;
  /** Container to go back to when `I` switched a transfer window to inventory-only. */
  private held: number | null = null;
  /** Container to open as soon as it is in reach (context menu `Open`), or null. */
  private pending: number | null = null;
  /** Tab ids of the last render, in order (for `reselect`). */
  private tabs: number[] = [];
  private key = '';
  private dirty = true;
  private lastTick = -1;
  private lastVersion = -1;
  private lastTileVersion = -1;

  constructor(
    parent: HTMLElement,
    private readonly world: World,
    private readonly icons: ItemIconUrls,
  ) {
    const el = (this.el = document.createElement('div'));
    el.id = 'transfer';
    el.className = 'panel';
    el.hidden = true;
    parent.append(el);
    el.addEventListener('click', (ev) => {
      // Keyboard activation (Space, Enter) is handled on keydown: only Enter acts.
      if (ev.detail === 0) return;
      const b = (ev.target as HTMLElement).closest('button');
      if (b) this.activate(b, ev.shiftKey);
    });
    el.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      const b = (ev.target as HTMLElement).closest('button');
      if (!b) return;
      ev.preventDefault();
      this.activate(b, ev.shiftKey);
    });
  }

  get isOpen(): boolean {
    return this.open;
  }

  dispose(): void {
    this.el.remove();
  }

  /** Show container `id` now, or as soon as it is in reach. */
  openContainer(id: number): void {
    this.pending = id;
    this.dirty = true;
  }

  /** `I` / `Tab`: open in inventory-only mode, switch a transfer window to inventory-only and back, or close. */
  toggleInventory(): void {
    if (!this.world.player.inv) return;
    if (!this.open) {
      this.open = true;
      this.fromInventory = true;
      this.selected = this.held = null;
    } else if (this.selected !== null) {
      this.held = this.selected;
      this.selected = null;
    } else if (this.held !== null) {
      this.selected = this.held;
      this.held = null;
    } else {
      this.close();
    }
    this.dirty = true;
  }

  /** Escape, the close button, or another panel opening: also forgets a pending `Open`. */
  close(): void {
    this.pending = null;
    this.hide();
  }

  update(): void {
    const w = this.world;
    if (!this.dirty && w.tick === this.lastTick && w.containerVersion === this.lastVersion && w.tileVersion === this.lastTileVersion) return;
    this.dirty = false;
    this.lastTick = w.tick;
    this.lastVersion = w.containerVersion;
    this.lastTileVersion = w.tileVersion;
    const reach = w.reachableContainers().map((c) => c.id);
    if (this.pending !== null && reach.includes(this.pending)) {
      if (!this.open) {
        this.open = true;
        this.fromInventory = false;
      }
      this.selected = this.pending;
      this.held = this.pending = null;
    }
    if (!this.open) return;
    if (this.selected !== null && !reach.includes(this.selected)) {
      this.selected = reselect(this.tabs, this.selected, reach);
      if (this.selected === null && !this.fromInventory) return this.hide();
    }
    if (this.held !== null && !reach.includes(this.held)) this.held = null;
    const view = transferView(w, this.selected, w.ended, this.icons);
    this.tabs = view.tabs.map((t) => t.id);
    this.el.hidden = false;
    const key = JSON.stringify(view);
    if (key === this.key) return;
    this.key = key;
    const focused = this.el.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset['focus'] : undefined;
    this.render(view);
    if (focused) this.el.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focused)}"]`)?.focus();
  }

  private hide(): void {
    this.open = false;
    this.selected = this.held = null;
    this.tabs = [];
    this.key = '';
    this.el.hidden = true;
  }

  private activate(b: HTMLButtonElement, shift: boolean): void {
    if (b.disabled) return;
    const d = b.dataset;
    if (d['close'] !== undefined) return this.close();
    if (d['tab'] !== undefined) {
      this.selected = Number(d['tab']);
      this.held = null;
      this.dirty = true;
      return;
    }
    const json = d['move'] !== undefined ? (shift ? d['one'] : d['move']) : d['actions'];
    if (!json) return;
    for (const a of JSON.parse(json) as Action[]) this.world.queueAction(a);
  }

  private render(v: TransferView): void {
    const head = div('transfer-head');
    if (v.tabs.length) {
      const tabs = div('transfer-tabs');
      for (const t of v.tabs) {
        const b = buttonEl(t.label, 'transfer-tab');
        b.append(span('transfer-dim', ` ${t.capacity === null ? t.weight : `${t.weight}/${t.capacity}`}`));
        if (t.selected) b.classList.add('selected');
        b.dataset['tab'] = String(t.id);
        b.dataset['focus'] = `tab:${t.id}`;
        tabs.append(b);
      }
      head.append(tabs);
    } else {
      head.append(span('panel-title', 'Inventory'));
    }
    const close = buttonEl('×', 'transfer-close');
    close.title = 'Close [Esc]';
    close.dataset['close'] = '';
    head.append(close);

    const panes = div('transfer-panes');
    if (v.container) {
      const c = v.container;
      const pane = div('transfer-pane');
      const title = div('transfer-pane-head');
      title.append(span('panel-title', c.label), span('transfer-dim', ` ${c.capacity === null ? c.weight : `${c.weight}/${c.capacity}`}`));
      if (v.takeAll) title.append(' ', panelButton(v.takeAll));
      pane.append(title, list(c.stacks, `c${c.id}`));
      panes.append(pane);
    }
    const pane = div('transfer-pane');
    if (v.inventory) {
      const inv = v.inventory;
      const title = div('transfer-pane-head');
      title.append(span('panel-title', 'Inventory'));
      if (v.putAll) title.append(' ', panelButton(v.putAll));
      const bar = div('transfer-bar');
      const fill = div('transfer-fill');
      fill.style.width = `${Math.round(inv.fill * 100)}%`;
      if (inv.fill >= 1) fill.classList.add('full');
      bar.append(fill, span('transfer-bar-text', inv.carrying));
      pane.append(title, bar);
      if (v.message) pane.append(div('transfer-message', v.message));
      pane.append(list(inv.stacks, 'inv'));
    } else {
      pane.append(div('', 'No inventory'));
    }
    panes.append(pane);
    this.el.replaceChildren(head, panes);
  }
}

function div(className: string, text?: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  if (text !== undefined) d.textContent = text;
  return d;
}

function span(className: string, text: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = className;
  s.textContent = text;
  return s;
}

function buttonEl(text: string, className: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = className;
  b.textContent = text;
  return b;
}

function panelButton(p: PanelButton): HTMLButtonElement {
  const b = buttonEl(p.label, '');
  b.disabled = p.disabled;
  b.dataset['actions'] = JSON.stringify(p.actions);
  b.dataset['focus'] = p.label;
  return b;
}

function iconEl(icon: ItemIcon): HTMLElement {
  if (icon.kind === 'image') {
    const img = document.createElement('img');
    img.className = 'transfer-icon';
    img.src = icon.url;
    img.alt = '';
    return img;
  }
  const s = span('transfer-icon swatch', icon.glyph);
  s.style.background = icon.color;
  return s;
}

function list(stacks: readonly TransferStack[], side: string): HTMLDivElement {
  const l = div('transfer-list');
  if (stacks.length === 0) l.append(div('transfer-empty', 'empty'));
  for (const s of stacks) {
    const item = div('transfer-item');
    const row = buttonEl('', 'transfer-row');
    row.append(iconEl(s.icon), span('transfer-label', s.label), span('transfer-count', `×${s.count}`), span('transfer-dim', ` ${s.weight}`));
    row.dataset['focus'] = `${side}:${s.item}`;
    row.disabled = s.disabled;
    if (s.move && s.moveOne) {
      row.dataset['move'] = JSON.stringify([s.move]);
      row.dataset['one'] = JSON.stringify([s.moveOne]);
      row.title = 'Click: move all · Shift-click: move one';
    } else {
      row.classList.add('inert');
    }
    item.append(row);
    for (const b of [s.use, s.drop]) {
      if (!b) continue;
      const el = panelButton(b);
      el.dataset['focus'] = `${side}:${s.item}:${b.label}`;
      item.append(el);
    }
    l.append(item);
  }
  return l;
}
