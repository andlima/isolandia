import { hudModel, type World } from '../core/index.ts';

/** DOM overlay with the same data as the ASCII HUD block; toggled with `H`. */
export class Hud {
  private readonly el: HTMLPreElement;
  private lastTick = -1;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('pre');
    this.el.id = 'hud';
    parent.appendChild(this.el);
  }

  toggle(): void {
    this.el.hidden = !this.el.hidden;
    this.lastTick = -1;
  }

  update(world: World): void {
    if (this.el.hidden || world.tick === this.lastTick) return;
    this.lastTick = world.tick;
    const m = hudModel(world);
    this.el.textContent = [m.time, ...m.measurements.map((x) => x.text), '', '[click] walk  [WASD/arrows/numpad] move', '[drag] pan  [wheel] zoom  [space] follow  [H] hud'].join('\n');
  }
}
