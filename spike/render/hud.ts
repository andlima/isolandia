export interface HudData {
  fps: number;
  frameMs: number;
  cpuMs: number;
  tickAvgMs: number;
  tickP95Ms: number;
  entities: number;
  visibleEntities: number;
  visibleChunks: number;
  totalChunks: number;
  pathQueue: number;
  zoom: number;
  renderer: string;
  bench: string;
}

/** DOM overlay (cheaper than Pixi text); toggled with `H`. */
export class Hud {
  private readonly el: HTMLPreElement;

  constructor() {
    this.el = document.createElement('pre');
    this.el.id = 'hud';
    document.body.appendChild(this.el);
  }

  toggle(): void {
    this.el.hidden = !this.el.hidden;
  }

  update(d: HudData): void {
    if (this.el.hidden) return;
    this.el.textContent =
      `fps      ${d.fps.toFixed(1)}\n` +
      `frame    ${d.frameMs.toFixed(2)} ms (cpu ${d.cpuMs.toFixed(2)} ms)\n` +
      `tick     avg ${d.tickAvgMs.toFixed(2)} ms  p95 ${d.tickP95Ms.toFixed(2)} ms\n` +
      `entities ${d.entities} (${d.visibleEntities} visible)\n` +
      `chunks   ${d.visibleChunks}/${d.totalChunks} visible\n` +
      `paths    ${d.pathQueue} queued\n` +
      `zoom     ${d.zoom.toFixed(2)}  ${d.renderer}\n` +
      (d.bench ? `bench    ${d.bench}\n` : '') +
      `[H] hud  [space] center player`;
  }
}
