/**
 * DOM rendering of the controls overlay (`?`, the Help [?] button), the
 * pause menu (`Escape` with nothing open) and the first-run hint. The views
 * are the pure functions in `help.ts`; these classes only render them and
 * report clicks. They live for the whole page, across loaded worlds.
 */

import { BINDINGS } from './bindings.ts';
import { helpView, HINT_MS, pauseMenuView, type HelpRow, type InputKind, type PauseItemId } from './help.ts';

function div(className: string, text?: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  if (text !== undefined) d.textContent = text;
  return d;
}

function closeButton(onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'help-close';
  b.textContent = '×';
  b.title = 'Close [Esc]';
  b.addEventListener('click', onClick);
  return b;
}

/** One row of the overlay: the key chips and gesture on the left, the label on the right. */
function rowEl(r: HelpRow): HTMLDivElement {
  const row = div('help-row');
  row.dataset['id'] = r.id;
  const keys = div('help-keys');
  for (const k of r.keys) {
    const kbd = document.createElement('kbd');
    kbd.textContent = k;
    keys.append(kbd);
  }
  if (r.gesture) keys.append(Object.assign(document.createElement('span'), { className: 'help-gesture', textContent: r.gesture }));
  row.append(keys, div('help-label', r.label));
  return row;
}

/**
 * The centred controls overlay over a full-screen backdrop. Opening it sets
 * the first-run flag (`opened`); a click on the backdrop, the × button,
 * `Escape` or `?` closes it. Every other key is swallowed while it is open.
 */
export class HelpOverlay {
  private readonly el: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly footer: HTMLDivElement;
  private shownFor: InputKind | null = null;

  constructor(
    parent: HTMLElement,
    private readonly input: () => InputKind,
    private readonly on: {
      /** The overlay was shown. */
      opened?(): void;
    } = {},
  ) {
    this.el = div('help-backdrop');
    this.el.id = 'help';
    this.el.hidden = true;
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', 'Controls');
    const panel = div('help-panel');
    const head = div('help-head');
    head.append(div('panel-title', 'Controls'), closeButton(() => this.close()));
    this.body = div('help-body');
    this.footer = div('help-footer');
    panel.append(head, this.body, this.footer);
    this.el.append(panel);
    // A click on the backdrop (not on the panel) closes.
    this.el.addEventListener('click', (ev) => {
      if (ev.target === this.el) this.close();
    });
    parent.append(this.el);
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  /** `?`, the Help button or the pause menu's *Controls*. */
  show(): void {
    const input = this.input();
    if (input !== this.shownFor) {
      this.shownFor = input;
      this.render(input);
    }
    const wasOpen = this.open;
    this.el.hidden = false;
    if (!wasOpen) this.on.opened?.();
  }

  close(): void {
    this.el.hidden = true;
  }

  toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  /** Keyboard while open: `Escape` and `?` close; everything else is swallowed. Returns whether the key was used. */
  key(code: string, key: string): boolean {
    if (!this.open) return false;
    if (code === 'Escape' || key === '?') this.close();
    return true;
  }

  private render(input: InputKind): void {
    const v = helpView(BINDINGS, input);
    const parts: HTMLElement[] = [];
    for (const s of v.sections) {
      const section = document.createElement('section');
      section.className = 'help-section';
      section.append(div('help-section-title', s.title), ...s.rows.map(rowEl));
      for (const g of s.groups) section.append(div('help-context', g.title), ...g.rows.map(rowEl));
      parts.push(section);
    }
    this.body.replaceChildren(...parts);
    this.footer.textContent = v.close;
  }

  dispose(): void {
    this.el.remove();
  }
}

export interface PauseMenuHandlers {
  /** *Controls*: open the overlay (the menu stays open underneath). */
  controls(): void;
  /** *Game…*: open the Game panel (the menu closes). */
  game(): void;
  /** *Title screen*: leave (plain navigation). */
  titleScreen(): void;
}

/**
 * The pause menu: a small centred panel with Resume, Controls, Game… and
 * Title screen. Focus starts on Resume; arrows move it, `Enter` chooses,
 * `Escape` or Resume closes. Every other key is swallowed while it is open.
 */
export class PauseMenu {
  private readonly el: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private buttons: HTMLButtonElement[] = [];
  private shownEnded: boolean | null = null;

  constructor(
    parent: HTMLElement,
    private readonly on: PauseMenuHandlers,
  ) {
    this.el = div('help-backdrop');
    this.el.id = 'pause-menu';
    this.el.hidden = true;
    this.el.setAttribute('role', 'dialog');
    this.panel = div('pause-panel');
    this.title = div('panel-title', 'Paused');
    this.panel.append(this.title);
    this.el.append(this.panel);
    this.panel.addEventListener('click', (ev) => {
      const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-item]');
      if (b) this.activate(b.dataset['item'] as PauseItemId);
    });
    parent.append(this.el);
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  /** `Escape` with nothing open: show the menu (`ended` after defeat or victory, when nothing pauses). */
  show(ended: boolean): void {
    if (ended !== this.shownEnded) {
      this.shownEnded = ended;
      this.render(ended);
    }
    this.el.hidden = false;
    this.focus(0);
  }

  close(): void {
    this.el.hidden = true;
  }

  toggle(ended: boolean): void {
    if (this.open) this.close();
    else this.show(ended);
  }

  /** Keyboard while open; returns whether the key was used (always, while open). */
  key(code: string, key: string): boolean {
    if (!this.open) return false;
    const at = this.buttons.indexOf(document.activeElement as HTMLButtonElement);
    const n = this.buttons.length;
    switch (code) {
      case 'Escape':
        this.close();
        break;
      case 'ArrowDown':
      case 'ArrowRight':
        this.focus((at + 1 + n) % n);
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        this.focus((at < 0 ? n - 1 : at - 1 + n) % n);
        break;
      case 'Enter':
      case 'NumpadEnter':
      case 'Space': {
        const b = this.buttons[at < 0 ? 0 : at];
        if (b) this.activate(b.dataset['item'] as PauseItemId);
        break;
      }
      default:
        if (key === '?') this.on.controls();
    }
    return true;
  }

  private focus(k: number): void {
    this.buttons[k]?.focus();
  }

  private activate(id: PauseItemId): void {
    switch (id) {
      case 'resume':
        this.close();
        break;
      case 'controls':
        this.on.controls();
        break;
      case 'game':
        this.close();
        this.on.game();
        break;
      case 'title':
        this.on.titleScreen();
        break;
    }
  }

  private render(ended: boolean): void {
    const v = pauseMenuView(ended);
    this.title.textContent = v.title;
    this.buttons = v.items.map((it) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pause-item';
      b.dataset['item'] = it.id;
      b.textContent = it.label;
      if (it.hint) b.title = it.hint;
      return b;
    });
    this.panel.replaceChildren(this.title, ...this.buttons);
  }

  dispose(): void {
    this.el.remove();
  }
}

/** The first-run hint under the top edge: shown for `HINT_MS`, then it fades out. */
export class FirstRunHint {
  private readonly el: HTMLDivElement;
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(parent: HTMLElement) {
    this.el = div('');
    this.el.id = 'help-hint';
    this.el.hidden = true;
    parent.append(this.el);
  }

  show(text: string): void {
    this.clear();
    this.el.textContent = text;
    this.el.classList.remove('help-hint-faded');
    this.el.hidden = false;
    this.timers.push(
      setTimeout(() => this.el.classList.add('help-hint-faded'), HINT_MS),
      setTimeout(() => this.dismiss(), HINT_MS + 1000),
    );
  }

  /** Hide at once (the overlay opened). */
  dismiss(): void {
    this.clear();
    this.el.hidden = true;
  }

  private clear(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
