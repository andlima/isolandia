/**
 * DOM layer of the key hints (the decisions are in `hints.ts`): `show()`
 * collects every enabled, visible `<button>` of the open window roots
 * (`#transfer`, `#crafting`, `#game`, `#log`, looked up by id at that moment,
 * so a world rebuilt by a load needs no re-wiring), draws one chip per
 * button in the `#hints` layer and, while shown, feeds every key to `hintKey`.
 * A completed label dispatches a synthetic click (with `shiftKey` and
 * `detail: 1`, so the transfer window treats it as a real click) on the
 * button and hides. The layer lives for the whole page.
 */

import { hintKey, hintLabels } from './hints.ts';

/** The window roots whose buttons get labels, in label order (then document order inside each). */
export const HINT_ROOTS: readonly string[] = ['transfer', 'crafting', 'game', 'log'];

/** Every enabled, visible `<button>` inside the open roots, in label order. */
function collectTargets(): HTMLButtonElement[] {
  const out: HTMLButtonElement[] = [];
  for (const id of HINT_ROOTS) {
    const root = document.getElementById(id);
    if (!root || root.hidden) continue;
    for (const b of root.querySelectorAll('button')) {
      if (b.disabled) continue;
      const r = b.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      out.push(b);
    }
  }
  return out;
}

function sameTargets(a: readonly Element[], b: readonly Element[]): boolean {
  return a.length === b.length && a.every((el, i) => el === b[i]);
}

export class KeyHints {
  private readonly layer: HTMLDivElement;
  private targets: HTMLButtonElement[] = [];
  private labels: string[] = [];
  private chips: HTMLSpanElement[] = [];
  private typed = '';
  private readonly observer: MutationObserver;
  private frame = 0;

  constructor(parent: HTMLElement = document.body) {
    this.layer = document.createElement('div');
    this.layer.id = 'hints';
    this.layer.hidden = true;
    parent.append(this.layer);
    this.observer = new MutationObserver(this.schedule);
    // Any press anywhere ends hint mode (a click on a labelled button then does its own thing).
    window.addEventListener('pointerdown', this.onPointerDown, true);
    // Panes scroll internally: capture sees their scroll events too.
    window.addEventListener('scroll', this.schedule, true);
    window.addEventListener('resize', this.schedule);
  }

  /** Whether the labels are showing (hint mode is on). */
  get shown(): boolean {
    return !this.layer.hidden;
  }

  /** `F`: label the buttons of the open windows. With no target this does nothing. */
  show(): void {
    const targets = collectTargets();
    if (targets.length === 0) return;
    this.layer.hidden = false;
    this.setTargets(targets);
    this.observer.disconnect();
    for (const id of HINT_ROOTS) {
      const root = document.getElementById(id);
      if (root) this.observer.observe(root, { childList: true, attributes: true, subtree: true });
    }
    // A root replaced wholesale (a load rebuilds `#transfer` and `#crafting`) shows up as a body child change.
    this.observer.observe(document.body, { childList: true });
  }

  /** Cancel: remove the chips and stop watching. */
  hide(): void {
    if (this.frame !== 0) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    this.observer.disconnect();
    this.layer.hidden = true;
    this.layer.replaceChildren();
    this.targets = [];
    this.labels = [];
    this.chips = [];
    this.typed = '';
  }

  /**
   * A key press while hints show: returns whether it was consumed (`false`
   * when hints are not shown, or for `?`, which must reach the shell). An
   * auto-repeat is consumed and ignored, so a held letter types once.
   */
  key(code: string, key: string, shift: boolean, repeat: boolean): boolean {
    if (!this.shown) return false;
    if (repeat) return true;
    const r = hintKey(this.labels, this.typed, code, key, shift);
    switch (r.kind) {
      case 'pass':
        this.hide();
        return false;
      case 'cancel':
        this.hide();
        break;
      case 'typed':
        this.typed = r.typed;
        this.renderChips();
        break;
      case 'activate': {
        const target = this.targets[r.index];
        target?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: r.shift, detail: 1 }));
        this.hide();
        break;
      }
      case 'ignore':
        break;
    }
    return true;
  }

  dispose(): void {
    this.hide();
    window.removeEventListener('pointerdown', this.onPointerDown, true);
    window.removeEventListener('scroll', this.schedule, true);
    window.removeEventListener('resize', this.schedule);
    this.layer.remove();
  }

  private readonly onPointerDown = (): void => {
    if (this.shown) this.hide();
  };

  /** Re-collect once per animation frame at most (hint mode is short-lived). */
  private readonly schedule = (): void => {
    if (!this.shown || this.frame !== 0) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.refresh();
    });
  };

  /** The targets may have moved, changed or gone: move the chips, relabel from scratch, or hide. */
  private refresh(): void {
    if (!this.shown) return;
    const targets = collectTargets();
    if (targets.length === 0) return this.hide();
    if (sameTargets(targets, this.targets)) this.position();
    else this.setTargets(targets);
  }

  /** New target set: fresh labels, `typed` cleared, one chip per target. */
  private setTargets(targets: HTMLButtonElement[]): void {
    this.targets = targets;
    this.labels = hintLabels(targets.length);
    this.typed = '';
    this.chips = this.labels.map(() => {
      const chip = document.createElement('span');
      chip.className = 'hint-chip';
      return chip;
    });
    this.layer.replaceChildren(...this.chips);
    this.renderChips();
  }

  /** Chips whose label does not start with `typed` hide; the others show the typed prefix dimmer. */
  private renderChips(): void {
    const t = this.typed;
    this.chips.forEach((chip, i) => {
      const label = this.labels[i]!;
      chip.dataset['match'] = label.startsWith(t) ? '1' : '';
      chip.replaceChildren();
      if (t) {
        const typed = document.createElement('span');
        typed.className = 'typed';
        typed.textContent = t.toUpperCase();
        chip.append(typed);
      }
      chip.append(label.slice(t.length).toUpperCase());
    });
    this.position();
  }

  /** Each chip at its target's top-left corner, kept inside the viewport; chips of targets scrolled out of their window hide. */
  private position(): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    this.chips.forEach((chip, i) => {
      const target = this.targets[i]!;
      const r = target.getBoundingClientRect();
      const root = target.closest<HTMLElement>('.panel') ?? target;
      const bounds = root.getBoundingClientRect();
      const inView = r.bottom > bounds.top && r.top < bounds.bottom && r.right > bounds.left && r.left < bounds.right;
      chip.hidden = chip.dataset['match'] === '' || !inView;
      if (chip.hidden) return;
      const x = Math.max(0, Math.min(r.left, vw - chip.offsetWidth));
      const y = Math.max(0, Math.min(r.top, vh - chip.offsetHeight));
      chip.style.left = `${Math.round(x)}px`;
      chip.style.top = `${Math.round(y)}px`;
    });
  }
}
