/**
 * The browser HUD overlay. `hudView` turns a `hudModel` into a plain object
 * (no DOM types, tested headless); the `Hud` class renders it top left and
 * re-renders only when the view changes.
 */

import { hudModel, type HudLevel, type HudModel, type StatusTone, type World } from '../core/index.ts';
import { perfLine, type PerfFigures } from './perf.ts';

/** Bar colour: from a measurement's or the inventory's `level`, `neutral` for a neutral measurement. */
export type HudBarColor = HudLevel | 'neutral';

export interface HudClockView {
  /** `Day D · HH:MM`. */
  readonly text: string;
  readonly icon: 'sun' | 'moon';
  /** `Floor N` on a map with more than one floor, else null. */
  readonly floor: string | null;
}

export interface HudBarView {
  readonly id: string;
  readonly label: string;
  /** 2–3 letters for the compact layout: initials of a multi-word label, else its first letters. */
  readonly abbr: string;
  /** Filled width in whole percent; null when the measurement has no finite max (value only). */
  readonly percent: number | null;
  /** `23/100`, or `23` without a finite max (whole numbers). */
  readonly value: string;
  readonly color: HudBarColor;
  /** Pulses gently (a `danger` row). */
  readonly pulse: boolean;
}

export interface HudChipView {
  readonly id: string;
  readonly label: string;
  readonly tone: StatusTone;
  /** Tooltip lines: the label, then the description and the rates when present. */
  readonly tooltip: readonly string[];
}

export interface HudCarryView {
  /** `Carrying w/cap`. */
  readonly text: string;
  readonly percent: number;
  readonly color: HudLevel;
}

export interface HudView {
  readonly clock: HudClockView;
  readonly bars: readonly HudBarView[];
  readonly chips: readonly HudChipView[];
  readonly carrying: HudCarryView | null;
  /** `Nearby: …` (one muted line, cut with `…` by the overlay), or null. */
  readonly nearby: string | null;
  readonly lastAction: string | null;
}

/** `Energy` → `Ene`, `Max power` → `MP`. */
export function abbreviate(label: string): string {
  const words = label.split(/\s+/).filter((w) => w.length > 0);
  if (words.length > 1) return words.slice(0, 3).map((w) => w.charAt(0).toUpperCase()).join('');
  return (words[0] ?? '').slice(0, 3);
}

/** The overlay's content, from the shared HUD model (values rounded so a drifting measurement rarely changes it). */
export function hudView(m: HudModel): HudView {
  const pct = (f: number) => Math.round(f * 100);
  const whole = (v: number) => String(Math.round(v));
  return {
    clock: { text: `Day ${m.day} · ${m.timeOfDay}`, icon: m.isDay ? 'sun' : 'moon', floor: m.floor },
    bars: m.measurements.map((x) => ({
      id: x.id,
      label: x.label,
      abbr: abbreviate(x.label),
      percent: x.fraction === null ? null : pct(x.fraction),
      value: x.fraction === null ? whole(x.value) : `${whole(x.value)}/${whole(x.max)}`,
      color: x.level ?? 'neutral',
      pulse: x.level === 'danger',
    })),
    chips: m.statusChips.map((c) => ({
      id: c.id,
      label: c.label,
      tone: c.tone,
      tooltip: [c.label, ...(c.description ? [c.description] : []), ...(c.rates ? [c.rates] : [])],
    })),
    carrying: m.inventory
      ? { text: `Carrying ${m.inventory.weight}/${m.inventory.capacity}`, percent: pct(m.inventory.fraction), color: m.inventory.level }
      : null,
    nearby: m.nearbyLine,
    lastAction: m.lastAction,
  };
}

/** The progress bar's content: label and filled width in percent; null hides it. */
export function activityBar(m: HudModel): { label: string; percent: number } | null {
  return m.activity ? { label: m.activity.label, percent: Math.round(m.activity.fraction * 100) } : null;
}

/** How long a journal toast stays up. */
export const TOAST_MS = 4000;

function div(className: string, text?: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  if (text !== undefined) d.textContent = text;
  return d;
}

/** A bar of `percent` (null: none) coloured `color`. */
function bar(percent: number | null, color: string): HTMLDivElement {
  const b = div(`hud-bar${percent === null ? ' hud-bar-none' : ''}`);
  const fill = div(`hud-fill hud-${color}`);
  fill.style.width = `${percent ?? 0}%`;
  b.append(fill);
  return b;
}

/** The DOM overlay drawn from `hudView`; toggled with `H`. */
export class Hud {
  private readonly el: HTMLDivElement;
  private readonly tip: HTMLDivElement;
  /** Chip id whose tooltip is shown, or null. */
  private tipChip: string | null = null;
  private view: HudView | null = null;
  private key = '';
  private readonly banner: HTMLDivElement;
  private readonly victoryBanner: HTMLDivElement;
  private readonly bar: HTMLDivElement;
  private readonly barFill: HTMLDivElement;
  private readonly barLabel: HTMLSpanElement;
  private readonly perf: HTMLDivElement;
  private readonly toastEl: HTMLDivElement;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTick = -1;
  private barTick = -1;
  private perfShown = 0;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.id = 'hud';
    this.tip = document.createElement('div');
    this.tip.id = 'hud-tip';
    this.tip.hidden = true;
    // Mouse and pen hover a chip; a touch tap toggles its tooltip (a tap elsewhere hides it).
    this.el.addEventListener('pointerover', (ev) => {
      if (ev.pointerType !== 'touch') this.showTip(this.chipAt(ev.target));
    });
    this.el.addEventListener('pointerout', (ev) => {
      if (ev.pointerType !== 'touch' && this.chipAt(ev.relatedTarget) === null) this.showTip(null);
    });
    document.addEventListener('pointerdown', this.onPointerDown, true);
    this.banner = document.createElement('div');
    this.banner.id = 'defeat';
    this.banner.hidden = true;
    this.victoryBanner = document.createElement('div');
    this.victoryBanner.id = 'victory';
    this.victoryBanner.hidden = true;
    this.bar = document.createElement('div');
    this.bar.id = 'activity';
    this.bar.hidden = true;
    this.barFill = document.createElement('div');
    this.barFill.className = 'activity-fill';
    this.barLabel = document.createElement('span');
    this.barLabel.className = 'activity-label';
    this.bar.append(this.barFill, this.barLabel);
    this.perf = document.createElement('div');
    this.perf.id = 'perf';
    this.perf.hidden = true;
    this.toastEl = document.createElement('div');
    this.toastEl.id = 'journal-toast';
    this.toastEl.hidden = true;
    parent.append(this.el, this.tip, this.banner, this.victoryBanner, this.bar, this.perf, this.toastEl);
  }

  /** Remove the overlay's elements (the world is being replaced). */
  dispose(): void {
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    document.removeEventListener('pointerdown', this.onPointerDown, true);
    for (const el of [this.el, this.tip, this.banner, this.victoryBanner, this.bar, this.perf, this.toastEl]) el.remove();
  }

  private readonly onPointerDown = (ev: PointerEvent): void => {
    if (ev.pointerType !== 'touch') return;
    const id = this.chipAt(ev.target);
    this.showTip(id !== null && id !== this.tipChip ? id : null);
  };

  /** Status id of the chip `target` is in, or null. */
  private chipAt(target: EventTarget | null): string | null {
    if (!(target instanceof Element) || !this.el.contains(target)) return null;
    return (target.closest('.hud-chip') as HTMLElement | null)?.dataset['id'] ?? null;
  }

  /** Show the tooltip of chip `id` under it (null hides it). */
  private showTip(id: string | null): void {
    const chip = id === null || this.el.hidden ? undefined : this.view?.chips.find((c) => c.id === id);
    const el = chip ? this.el.querySelector<HTMLElement>(`.hud-chip[data-id="${CSS.escape(chip.id)}"]`) : null;
    if (!chip || !el) {
      this.tipChip = null;
      this.tip.hidden = true;
      return;
    }
    this.tipChip = chip.id;
    this.tip.replaceChildren(...chip.tooltip.map((line, i) => div(i === 0 ? 'hud-tip-title' : 'hud-tip-line', line)));
    const r = el.getBoundingClientRect();
    this.tip.style.left = `${Math.round(r.left)}px`;
    this.tip.style.top = `${Math.round(r.bottom + 4)}px`;
    this.tip.hidden = false;
  }

  /** Rebuild the overlay's elements from `v`. */
  private render(v: HudView): void {
    const clock = div('hud-card');
    clock.append(div(`hud-icon hud-${v.clock.icon}`, v.clock.icon === 'sun' ? '☀' : '☾'), div('hud-clock', v.clock.text));
    if (v.clock.floor) clock.append(div('hud-floor', v.clock.floor));
    const rows = v.bars.map((b) => {
      const row = div(`hud-row${b.pulse ? ' hud-pulse' : ''}`);
      row.dataset['id'] = b.id;
      row.title = b.label;
      const label = div('hud-label');
      label.append(Object.assign(document.createElement('span'), { className: 'hud-label-full', textContent: b.label }));
      label.append(Object.assign(document.createElement('span'), { className: 'hud-label-abbr', textContent: b.abbr }));
      row.append(label, bar(b.percent, b.color), div('hud-value', b.value));
      return row;
    });
    const parts: HTMLElement[] = [clock, ...rows];
    if (v.chips.length) {
      const chips = div('hud-chips');
      for (const c of v.chips) {
        const chip = div(`hud-chip hud-tone-${c.tone}`, c.label);
        chip.dataset['id'] = c.id;
        chips.append(chip);
      }
      parts.push(chips);
    }
    if (v.carrying) {
      const row = div('hud-row hud-carry');
      row.append(div('hud-label', v.carrying.text), bar(v.carrying.percent, v.carrying.color));
      parts.push(row);
    }
    if (v.nearby) {
      const n = div('hud-nearby', v.nearby);
      n.title = v.nearby;
      parts.push(n);
    }
    if (v.lastAction) parts.push(div('hud-action', v.lastAction));
    this.el.replaceChildren(...parts);
  }

  /** Show a journal toast (`journalToast`) for about 4 s; a newer one replaces it. */
  toast(text: string): void {
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.toastEl.textContent = text;
    this.toastEl.hidden = false;
    this.toastTimer = setTimeout(() => {
      this.toastEl.hidden = true;
      this.toastTimer = null;
    }, TOAST_MS);
  }

  /** Show or hide the perf line (F3). */
  togglePerf(): void {
    this.perf.hidden = !this.perf.hidden;
    this.perfShown = 0;
  }

  get perfVisible(): boolean {
    return !this.perf.hidden;
  }

  /** Refresh the perf line (at most 4 times a second). */
  updatePerf(f: PerfFigures, now: number): void {
    if (this.perf.hidden || now - this.perfShown < 250) return;
    this.perfShown = now;
    this.perf.textContent = perfLine(f);
  }

  /** Whether the HUD (and with it hover tooltips) is shown. */
  get visible(): boolean {
    return !this.el.hidden;
  }

  toggle(): void {
    this.el.hidden = !this.el.hidden;
    this.lastTick = -1;
    if (this.el.hidden) this.showTip(null);
  }

  update(world: World): void {
    if (world.defeat && this.banner.hidden) {
      this.banner.textContent = hudModel(world).defeat!.text;
      this.banner.hidden = false;
      this.lastTick = -1;
    }
    if (world.victory && this.victoryBanner.hidden) {
      this.victoryBanner.textContent = hudModel(world).victory!.text;
      this.victoryBanner.hidden = false;
      this.lastTick = -1;
    }
    if (world.tick !== this.barTick) {
      this.barTick = world.tick;
      const b = activityBar(hudModel(world));
      this.bar.hidden = b === null;
      if (b) {
        this.barFill.style.width = `${b.percent}%`;
        this.barLabel.textContent = `${b.label} ${b.percent}%`;
      }
    }
    if (this.el.hidden || world.tick === this.lastTick) return;
    this.lastTick = world.tick;
    const v = hudView(hudModel(world));
    const key = JSON.stringify(v);
    if (key === this.key) return;
    this.key = key;
    this.view = v;
    this.render(v);
    // Keep an open tooltip on its chip (with fresh rates), or drop it when the status ended.
    if (this.tipChip !== null) this.showTip(this.tipChip);
  }
}
