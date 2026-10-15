/**
 * The benchmark's DOM: a small overlay with the run's progress and then its
 * key figures and a **Copy JSON** button (so a phone or a browser without a
 * debugger attached can still report), and the input guard that keeps play
 * input (pointer, keys, wheel, gestures) from reaching the shell during a
 * run, except the perf line's key and the overlay's own button.
 */

import { bindingFor } from './bindings.ts';
import { benchSummaryLines, type BenchResult } from './bench.ts';

export class BenchOverlay {
  private readonly el: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly lines: HTMLDivElement;
  private readonly copy: HTMLButtonElement;
  private json = '';

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.id = 'bench';
    this.title = document.createElement('div');
    this.title.className = 'bench-title';
    this.lines = document.createElement('div');
    this.lines.className = 'bench-lines';
    this.copy = document.createElement('button');
    this.copy.type = 'button';
    this.copy.className = 'bench-copy';
    this.copy.textContent = 'Copy JSON';
    this.copy.hidden = true;
    this.copy.addEventListener('click', () => this.copyJson());
    this.el.append(this.title, this.lines, this.copy);
    parent.append(this.el);
  }

  /** Whether `target` is part of the overlay (its button must keep working under the input guard). */
  contains(target: EventTarget | null): boolean {
    return target instanceof Node && this.el.contains(target);
  }

  /** The progress line while the run goes (`bench 12.3/60 s · sweep`). */
  progress(text: string): void {
    if (this.title.textContent !== text) this.title.textContent = text;
  }

  /** The result: key figures and the Copy JSON button. */
  show(result: BenchResult): void {
    this.json = JSON.stringify(result);
    this.title.textContent = 'bench done';
    this.lines.replaceChildren(
      ...benchSummaryLines(result).map((text) => {
        const d = document.createElement('div');
        d.textContent = text;
        return d;
      }),
    );
    this.copy.hidden = false;
  }

  private copyJson(): void {
    const done = () => (this.copy.textContent = 'Copied');
    const fail = () => (this.copy.textContent = 'Copy failed: see the console');
    const clipboard = navigator.clipboard;
    if (clipboard?.writeText) {
      clipboard.writeText(this.json).then(done, () => (this.copyFallback() ? done() : fail()));
    } else if (this.copyFallback()) done();
    else fail();
    console.log('BENCH_RESULT ' + this.json);
  }

  /** `execCommand('copy')` from a temporary textarea, for browsers without the async clipboard (or without a secure context). */
  private copyFallback(): boolean {
    const ta = document.createElement('textarea');
    ta.value = this.json;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/** Events a benchmark run swallows at the window, before any handler of the shell sees them. */
const GUARDED = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'click', 'dblclick', 'contextmenu', 'wheel', 'touchstart', 'touchmove', 'touchend', 'keydown', 'keyup'] as const;

/**
 * Stop every pointer, wheel, touch and key event before the shell's handlers
 * run, except those aimed at the overlay and the perf line's key (`F3`),
 * which calls `perf` instead.
 */
export function benchGuard(overlay: BenchOverlay, perf: () => void): void {
  const swallow = (ev: Event) => {
    if (overlay.contains(ev.target)) return;
    if (ev instanceof KeyboardEvent && ev.type === 'keydown' && !ev.repeat && bindingFor(ev.code, ev.key) === 'perf') perf();
    ev.stopImmediatePropagation();
    if (ev.cancelable) ev.preventDefault();
  };
  for (const type of GUARDED) window.addEventListener(type, swallow, { capture: true, passive: false });
}
