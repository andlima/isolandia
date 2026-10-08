/**
 * Hover feedback for mouse and pen (the model is `hoverInfo` in `menu.ts`):
 * the canvas cursor and a tooltip near the pointer with what is under it and
 * what a click does. The shell calls `update` once per frame, so picking is
 * throttled to the frame rate; `hoverInfo` is recomputed only when the target
 * or the world (tick, containers, tiles) changes.
 */

import type { World } from '../core/index.ts';
import type { PickTarget } from '../iso/pick.ts';
import { clampMenu, hoverInfo, hoverTitleLine, type HoverInfo } from './menu.ts';

/** How long the pointer rests on a target before its tooltip shows. */
export const TOOLTIP_DELAY_MS = 150;
/** Tooltip offset from the pointer. */
const OFFSET_X = 14;
const OFFSET_Y = 18;

export class Hover {
  private readonly el: HTMLDivElement;
  private readonly titleEl: HTMLDivElement;
  private readonly labelEl: HTMLSpanElement;
  private readonly standingEl: HTMLSpanElement;
  private readonly hintEl: HTMLDivElement;
  private point: { sx: number; sy: number } | null = null;
  /** The hovered target's identity, when it became hovered, and its cached info (with the world versions it is for). */
  private targetKey = '';
  private since = 0;
  private infoKey = '';
  private info: HoverInfo | null = null;
  private shown = '';

  constructor(
    parent: HTMLElement,
    private readonly canvas: HTMLElement,
  ) {
    this.el = document.createElement('div');
    this.el.id = 'tooltip';
    this.el.hidden = true;
    this.titleEl = document.createElement('div');
    this.labelEl = document.createElement('span');
    this.standingEl = document.createElement('span');
    this.titleEl.append(this.labelEl, this.standingEl);
    this.hintEl = document.createElement('div');
    this.hintEl.className = 'tooltip-hint';
    this.el.append(this.titleEl, this.hintEl);
    parent.append(this.el);
  }

  /** The pointer's position over the canvas, or null when it left, drags or presses. */
  move(p: { sx: number; sy: number } | null): void {
    this.point = p;
  }

  /**
   * Once per frame: pick the hovered target and refresh the cursor and the
   * tooltip. `active` false (menu open, game over…) hides everything;
   * `tooltip` false hides only the tooltip. Returns the target whose cell
   * gets the hover outline, or null.
   */
  update(world: World, pick: (sx: number, sy: number) => PickTarget, now: number, active: boolean, tooltip: boolean): PickTarget | null {
    const p = this.point;
    if (!p || !active) {
      this.hide();
      this.targetKey = '';
      return null;
    }
    const t = pick(p.sx, p.sy);
    const key = `${t.kind}:${t.x},${t.y},${t.z}:${t.kind === 'entity' ? t.entity.id : t.kind === 'pile' ? t.container.id : t.kind === 'edge' ? t.side : ''}`;
    if (key !== this.targetKey) {
      this.targetKey = key;
      this.since = now;
    }
    const infoKey = `${key}:${world.tick}:${world.containerVersion}:${world.tileVersion}:${world.journalVersion}`;
    if (infoKey !== this.infoKey || !this.info) {
      this.infoKey = infoKey;
      this.info = hoverInfo(world, t);
    }
    const info = this.info;
    this.canvas.style.cursor = info.cursor;
    if (!tooltip || now - this.since < TOOLTIP_DELAY_MS || (!info.title && !info.hint && !info.standing)) {
      this.el.hidden = true;
      return t;
    }
    const text = `${hoverTitleLine(info)}\n${info.hint}\n${info.hostile === true}`;
    if (text !== this.shown) {
      this.shown = text;
      this.labelEl.textContent = info.title;
      // A hostile faction's tier shows in the danger colour.
      this.standingEl.textContent = info.standing ? ` · ${info.standing}` : '';
      this.standingEl.className = info.hostile === true ? 'tooltip-danger' : '';
      this.hintEl.textContent = info.hint;
      this.hintEl.hidden = info.hint === '';
    }
    this.el.hidden = false;
    const r = this.el.getBoundingClientRect();
    const at = clampMenu(p.sx + OFFSET_X, p.sy + OFFSET_Y, r.width, r.height, window.innerWidth, window.innerHeight);
    this.el.style.left = `${at.x}px`;
    this.el.style.top = `${at.y}px`;
    return t;
  }

  private hide(): void {
    this.el.hidden = true;
    this.canvas.style.cursor = '';
  }
}
