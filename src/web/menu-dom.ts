/**
 * DOM rendering of the context menu (the model is `menu.ts`). Items are
 * computed when the menu opens; the simulation re-validates on execution,
 * so a stale menu is harmless.
 */

import type { World } from '../core/index.ts';
import { clampMenu, contextMenu, menuTitle, moveSelection, runMenuItem, type MenuItem } from './menu.ts';

export class ContextMenu {
  private readonly el: HTMLDivElement;
  private items: MenuItem[] = [];
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
      if (k >= 0) this.choose(k);
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

  /** Open the menu for cell (x, y) on floor z at screen point (sx, sy); replaces any open menu. */
  open(x: number, y: number, z: number, sx: number, sy: number): void {
    this.close();
    if (this.world.ended) return;
    this.items = contextMenu(this.world, x, y, z);
    if (this.items.length === 0) return;
    this.target = { x, y, z };
    const title = document.createElement('div');
    title.className = 'panel-title';
    title.textContent = menuTitle(this.world, x, y, z);
    this.buttons = this.items.map((it) => {
      const b = document.createElement('button');
      b.className = 'menu-item';
      b.setAttribute('role', 'menuitem');
      b.setAttribute('aria-disabled', String(it.disabled));
      if (it.disabled) b.classList.add('disabled');
      b.textContent = it.label;
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
    const r = this.el.getBoundingClientRect();
    const p = clampMenu(sx, sy, r.width, r.height, window.innerWidth, window.innerHeight);
    this.el.style.left = `${p.x}px`;
    this.el.style.top = `${p.y}px`;
    this.select(this.items.findIndex((it) => !it.disabled));
  }

  close(): void {
    if (!this.target) return;
    this.target = null;
    this.items = [];
    this.buttons = [];
    this.selected = -1;
    this.el.hidden = true;
    this.el.replaceChildren();
  }

  /** Keyboard while open: arrows move, Enter selects, Escape closes. Returns whether the key was used. */
  key(code: string): boolean {
    if (!this.isOpen) return false;
    switch (code) {
      case 'ArrowDown':
      case 'ArrowRight':
        this.select(moveSelection(this.items.length, this.selected, 1));
        return true;
      case 'ArrowUp':
      case 'ArrowLeft':
        this.select(moveSelection(this.items.length, this.selected, -1));
        return true;
      case 'Enter':
      case 'NumpadEnter':
        if (this.selected >= 0) this.choose(this.selected);
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

  /** Disabled items only show their hint (always visible) and keep the menu open. */
  private choose(k: number): void {
    const it = this.items[k];
    if (!it || it.disabled) return;
    const open = runMenuItem(this.world, it);
    this.close();
    if (open && it.run.container !== undefined) this.openLoot(it.run.container);
  }
}
