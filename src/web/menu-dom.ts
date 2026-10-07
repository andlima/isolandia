/**
 * DOM rendering of the context menu (the model is `menu.ts`). Items are
 * computed when the menu opens; the simulation re-validates on execution,
 * so a stale menu is harmless.
 */

import type { World } from '../core/index.ts';
import { clampMenu, contextMenu, menuRows, menuTitle, moveSelection, runMenuItem, shortcutOf, type Menu, type MenuItem, type MenuOpening, type MenuRow } from './menu.ts';

export class ContextMenu {
  private readonly el: HTMLDivElement;
  private menu: Menu | null = null;
  private expanded = false;
  private rows: MenuRow[] = [];
  private buttons: HTMLButtonElement[] = [];
  private selected = -1;
  /** Target cell while open, or null. */
  target: { x: number; y: number; z: number } | null = null;
  /** Set by a pointer press outside the open menu (which closes it): the shell skips that press's click. */
  dismissed = false;
  private readonly onPointerDown = (ev: PointerEvent) => {
    this.dismissed = this.isOpen && !this.el.contains(ev.target as Node);
    if (this.dismissed) this.close();
  };

  constructor(
    parent: HTMLElement,
    private readonly world: World,
    /** Called for items that open the loot panel at a container. */
    private readonly openLoot: (container: number) => void,
  ) {
    this.el = document.createElement('div');
    this.el.id = 'menu';
    this.el.className = 'panel';
    this.el.hidden = true;
    this.el.setAttribute('role', 'menu');
    parent.append(this.el);
    this.el.addEventListener('click', (ev) => {
      const b = (ev.target as HTMLElement).closest('button');
      const k = b ? this.buttons.indexOf(b) : -1;
      if (k >= 0) this.activate(k);
    });
    this.el.addEventListener('contextmenu', (ev) => ev.preventDefault());
    document.addEventListener('pointerdown', this.onPointerDown, true);
  }

  /** Remove the menu and its listener (the world is being replaced). */
  dispose(): void {
    this.close();
    document.removeEventListener('pointerdown', this.onPointerDown, true);
    this.el.remove();
  }

  get isOpen(): boolean {
    return this.target !== null;
  }

  /**
   * Open the menu for cell (x, y) on floor z at screen point (sx, sy);
   * replaces any open menu. A left click's menu (`click`) has no `Walk here`.
   */
  open(x: number, y: number, z: number, sx: number, sy: number, opening: MenuOpening = 'context'): void {
    this.close();
    if (this.world.ended) return;
    const menu = contextMenu(this.world, x, y, z, opening);
    if (menu.items.length === 0 && menu.disabled.length === 0) return;
    this.menu = menu;
    this.expanded = menu.expanded;
    this.target = { x, y, z };
    this.render();
    const r = this.el.getBoundingClientRect();
    const p = clampMenu(sx, sy, r.width, r.height, window.innerWidth, window.innerHeight);
    this.el.style.left = `${p.x}px`;
    this.el.style.top = `${p.y}px`;
    this.select(0);
  }

  /** Run an item (a menu choice or a left click's default): queue it and open the loot panel when it says so. */
  run(item: MenuItem): void {
    const open = runMenuItem(this.world, item);
    if (open && item.run.container !== undefined) this.openLoot(item.run.container);
  }

  /** (Re)build the rows, keeping the menu's position. */
  private render(): void {
    const { x, y, z } = this.target!;
    const title = document.createElement('div');
    title.className = 'panel-title';
    title.textContent = menuTitle(this.world, x, y, z);
    this.rows = menuRows(this.menu!, this.expanded);
    this.buttons = this.rows.map((row) => {
      const b = document.createElement('button');
      b.setAttribute('role', 'menuitem');
      if (row.kind === 'fold') {
        b.className = 'menu-item menu-fold';
        b.setAttribute('aria-expanded', String(row.expanded));
        b.textContent = row.label;
        return b;
      }
      const it = row.item;
      b.className = 'menu-item';
      b.setAttribute('aria-disabled', String(it.disabled));
      if (it.disabled) b.classList.add('disabled');
      if (row.key) {
        const k = document.createElement('span');
        k.className = 'menu-key';
        k.textContent = String(row.key);
        b.append(k);
      }
      b.append(it.label);
      if (it.default) {
        const c = document.createElement('span');
        c.className = 'menu-click';
        c.textContent = 'click';
        b.append(c);
      }
      if (it.detail) {
        const d = document.createElement('span');
        d.className = 'menu-detail';
        d.textContent = ` · ${it.detail}`;
        b.append(d);
      }
      if (it.hint) {
        const h = document.createElement('span');
        h.className = 'menu-hint';
        h.textContent = it.hint;
        b.append(h);
      }
      return b;
    });
    this.el.replaceChildren(title, ...this.buttons);
    this.el.hidden = false;
  }

  close(): void {
    if (!this.target) return;
    this.target = null;
    this.menu = null;
    this.rows = [];
    this.buttons = [];
    this.selected = -1;
    this.el.hidden = true;
    this.el.replaceChildren();
  }

  /**
   * Keyboard while open: `1`–`9` choose an enabled item, arrows move, `Enter`
   * (or `→` on the fold row) chooses or toggles the fold, `Escape` closes.
   * Returns whether the key was used.
   */
  key(code: string): boolean {
    if (!this.isOpen) return false;
    const n = shortcutOf(code);
    if (n > 0) {
      const k = this.rows.findIndex((r) => r.kind === 'item' && r.key === n);
      if (k >= 0) this.activate(k);
      return true;
    }
    const fold = this.rows[this.selected]?.kind === 'fold';
    switch (code) {
      case 'ArrowRight':
        if (fold) {
          if (!this.expanded) this.activate(this.selected);
          return true;
        }
        this.select(moveSelection(this.rows.length, this.selected, 1));
        return true;
      case 'ArrowLeft':
        if (fold) {
          if (this.expanded) this.activate(this.selected);
          return true;
        }
        this.select(moveSelection(this.rows.length, this.selected, -1));
        return true;
      case 'ArrowDown':
        this.select(moveSelection(this.rows.length, this.selected, 1));
        return true;
      case 'ArrowUp':
        this.select(moveSelection(this.rows.length, this.selected, -1));
        return true;
      case 'Enter':
      case 'NumpadEnter':
        if (this.selected >= 0) this.activate(this.selected);
        return true;
      case 'Escape':
        this.close();
        return true;
      default:
        return false;
    }
  }

  private select(k: number): void {
    this.buttons[this.selected]?.classList.remove('selected');
    this.selected = k;
    const b = this.buttons[k];
    if (b) {
      b.classList.add('selected');
      b.scrollIntoView({ block: 'nearest' });
    }
  }

  /** Choose row `k`: the fold row toggles; disabled items only show their hint (always visible) and keep the menu open. */
  private activate(k: number): void {
    const row = this.rows[k];
    if (!row) return;
    if (row.kind === 'fold') {
      this.expanded = !this.expanded;
      this.render();
      const r = this.el.getBoundingClientRect();
      const p = clampMenu(r.left, r.top, r.width, r.height, window.innerWidth, window.innerHeight);
      this.el.style.left = `${p.x}px`;
      this.el.style.top = `${p.y}px`;
      this.select(k);
      return;
    }
    if (row.item.disabled) return;
    this.close();
    this.run(row.item);
  }
}
