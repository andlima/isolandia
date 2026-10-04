import { hudLines, hudModel, type World } from '../core/index.ts';

/** DOM overlay with the same data as the ASCII HUD block; toggled with `H`. */
export class Hud {
  private readonly el: HTMLPreElement;
  private readonly banner: HTMLDivElement;
  private readonly victoryBanner: HTMLDivElement;
  private lastTick = -1;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('pre');
    this.el.id = 'hud';
    this.banner = document.createElement('div');
    this.banner.id = 'defeat';
    this.banner.hidden = true;
    this.victoryBanner = document.createElement('div');
    this.victoryBanner.id = 'victory';
    this.victoryBanner.hidden = true;
    parent.append(this.el, this.banner, this.victoryBanner);
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
    if (this.el.hidden || world.tick === this.lastTick) return;
    this.lastTick = world.tick;
    const m = hudModel(world);
    this.el.textContent = [...hudLines(m), '', '[click] walk  [WASD/arrows/numpad] move', '[drag] pan  [wheel] zoom  [space] follow  [H] hud', ...(world.player.inv ? ['[I/Tab] inventory'] : [])].join('\n');
  }
}
