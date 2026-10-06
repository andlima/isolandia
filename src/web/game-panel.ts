/**
 * DOM rendering of the Game panel (`O` or the HUD button): the quicksave and
 * three slots with Save / Load / Delete, plus Export and Import. The view is
 * `gameView` in `saves.ts`; this class only renders it and reports clicks.
 * It lives for the whole page, across loaded worlds.
 */

import type { GameCommand, GameView, SlotId } from './saves.ts';

export interface GamePanelHandlers {
  command(command: GameCommand, slot: SlotId): void;
  exportFile(): void;
  importFile(file: File): void;
}

/** How long an info note stays up (warnings stay until dismissed). */
const NOTE_MS = 3000;

export class GamePanel {
  private readonly el: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly noteEl: HTMLDivElement;
  private readonly noteText: HTMLDivElement;
  private noteTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    parent: HTMLElement,
    private readonly on: GamePanelHandlers,
  ) {
    this.el = document.createElement('div');
    this.el.id = 'game';
    this.el.className = 'panel';
    this.el.hidden = true;
    this.body = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'panel-title';
    title.textContent = 'Game';

    const files = document.createElement('div');
    files.className = 'panel-row';
    const exportBtn = document.createElement('button');
    exportBtn.textContent = 'Export';
    exportBtn.addEventListener('click', () => this.on.exportFile());
    const importLabel = document.createElement('label');
    importLabel.className = 'file-button';
    importLabel.textContent = 'Import';
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      input.value = '';
      if (f) this.on.importFile(f);
    });
    importLabel.append(input);
    files.append(exportBtn, ' ', importLabel);
    this.el.append(title, this.body, files);
    this.el.addEventListener('click', (ev) => {
      const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-command]');
      if (b && !b.disabled) this.on.command(b.dataset['command'] as GameCommand, b.dataset['slot'] as SlotId);
    });

    const toggle = document.createElement('button');
    toggle.id = 'game-toggle';
    toggle.textContent = 'Game [O]';
    toggle.addEventListener('click', () => this.toggle());

    this.noteEl = document.createElement('div');
    this.noteEl.id = 'game-note';
    this.noteEl.hidden = true;
    this.noteText = document.createElement('div');
    const close = document.createElement('button');
    close.className = 'note-close';
    close.textContent = '×';
    close.title = 'Dismiss';
    close.addEventListener('click', () => (this.noteEl.hidden = true));
    this.noteEl.append(close, this.noteText);
    parent.append(this.el, toggle, this.noteEl);
  }

  /** Run a slot command as if its button was clicked (F5 / F9). */
  command(command: GameCommand, slot: SlotId): void {
    this.on.command(command, slot);
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  toggle(): void {
    this.el.hidden = !this.el.hidden;
  }

  render(view: GameView): void {
    const parts: HTMLElement[] = [];
    for (const r of view.rows) {
      const row = document.createElement('div');
      row.className = 'panel-row';
      const title = document.createElement('span');
      title.className = 'panel-subtitle';
      title.textContent = r.title;
      const text = document.createElement('div');
      text.textContent = r.text;
      row.append(title, text);
      for (const b of r.buttons) {
        const el = document.createElement('button');
        el.textContent = b.label;
        el.disabled = b.disabled;
        el.dataset['command'] = b.command;
        el.dataset['slot'] = b.slot;
        row.append(el, ' ');
      }
      parts.push(row);
    }
    if (view.message) {
      const m = document.createElement('div');
      m.className = 'panel-hint';
      m.textContent = view.message;
      parts.push(m);
    }
    if (view.errors.length) {
      const ul = document.createElement('ul');
      ul.className = 'game-errors';
      for (const e of view.errors) {
        const li = document.createElement('li');
        li.textContent = e;
        ul.append(li);
      }
      parts.push(ul);
    }
    this.body.replaceChildren(...parts);
  }

  /** A dismissible note over the game: info fades after a few seconds, warnings stay. */
  note(text: string, warnings: readonly string[] = []): void {
    if (this.noteTimer !== null) clearTimeout(this.noteTimer);
    this.noteTimer = null;
    this.noteText.replaceChildren(text, ...warnings.map((w) => Object.assign(document.createElement('div'), { className: 'panel-hint', textContent: w })));
    this.noteEl.hidden = false;
    if (warnings.length === 0) this.noteTimer = setTimeout(() => (this.noteEl.hidden = true), NOTE_MS);
  }
}
