import { hudLines, hudModel, type HudModel, type World } from '../core/index.ts';

/** The progress bar's content: label and filled width in percent; null hides it. */
export function activityBar(m: HudModel): { label: string; percent: number } | null {
  return m.activity ? { label: m.activity.label, percent: Math.round(m.activity.fraction * 100) } : null;
}

/** DOM overlay with the same data as the ASCII HUD block; toggled with `H`. */
export class Hud {
  private readonly el: HTMLPreElement;
  private readonly banner: HTMLDivElement;
  private readonly victoryBanner: HTMLDivElement;
  private readonly bar: HTMLDivElement;
  private readonly barFill: HTMLDivElement;
  private readonly barLabel: HTMLSpanElement;
  private lastTick = -1;
  private barTick = -1;

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
    parent.append(this.el, this.banner, this.victoryBanner, this.bar);
  }

  /** Remove the overlay's elements (the world is being replaced). */
  dispose(): void {
    for (const el of [this.el, this.banner, this.victoryBanner, this.bar]) el.remove();
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
    this.el.textContent = [...hudLines(m), '', '[click] walk  [WASD/arrows/numpad] move', ...(world.grid.floors > 1 ? ['[PgUp/PgDn or </>] climb'] : []), '[drag] pan  [wheel] zoom  [space] follow  [H] hud', '[O] game  [F5] quicksave  [F9] quickload', ...(world.player.inv ? [world.def.recipes.length ? '[I/Tab] inventory  [C] crafting' : '[I/Tab] inventory'] : [])].join('\n');
  }
}
