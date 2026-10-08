import { hudLines, hudModel, type HudModel, type World } from '../core/index.ts';
import { hasJournal } from './panels.ts';
import { perfLine, type PerfFigures } from './perf.ts';

/** The progress bar's content: label and filled width in percent; null hides it. */
export function activityBar(m: HudModel): { label: string; percent: number } | null {
  return m.activity ? { label: m.activity.label, percent: Math.round(m.activity.fraction * 100) } : null;
}

/** How long a journal toast stays up. */
export const TOAST_MS = 4000;

/** DOM overlay with the same data as the ASCII HUD block; toggled with `H`. */
export class Hud {
  private readonly el: HTMLPreElement;
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
    this.el = document.createElement('pre');
    this.el.id = 'hud';
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
    parent.append(this.el, this.banner, this.victoryBanner, this.bar, this.perf, this.toastEl);
  }

  /** Remove the overlay's elements (the world is being replaced). */
  dispose(): void {
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    for (const el of [this.el, this.banner, this.victoryBanner, this.bar, this.perf, this.toastEl]) el.remove();
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
    const m = hudModel(world);
    this.el.textContent = [...hudLines(m), '', '[click] walk  [WASD/arrows/numpad] move', ...(world.grid.floors > 1 ? ['[PgUp/PgDn or </>] climb'] : []), '[drag] pan  [wheel] zoom  [space] follow  [H] hud  [F3] perf', '[O] game  [F5] quicksave  [F9] quickload', ...(hasJournal(world) ? ['[J] journal'] : []), ...(world.player.inv ? [world.def.recipes.length ? '[I/Tab] inventory  [C] crafting' : '[I/Tab] inventory'] : [])].join('\n');
  }
}
