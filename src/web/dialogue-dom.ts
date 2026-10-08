/**
 * DOM rendering of the dialogue box (the model is `dialogue.ts`). It shows
 * while `world.conversation` is open and re-renders when
 * `world.conversationVersion` changes.
 */

import { LEAVE_REFUSED_TEXT, type World } from '../core/index.ts';
import { dialogueBox, dialogueKey, type DialogueBoxView } from './dialogue.ts';

/** How long the box shakes when Escape is refused. */
const SHAKE_MS = 300;

export class DialogueBox {
  private readonly el: HTMLDivElement;
  private box: DialogueBoxView | null = null;
  private buttons: HTMLButtonElement[] = [];
  private selected = -1;
  /** `conversationVersion` last rendered, or -1 while hidden. */
  private shown = -1;
  private note: HTMLDivElement | null = null;
  private shakeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    parent: HTMLElement,
    private readonly world: World,
    private readonly on: {
      /** The box has just opened (a conversation started). */
      opened(): void;
      /** A choice or leave changed the world (e.g. to toast journal events). */
      input(): void;
    },
  ) {
    this.el = document.createElement('div');
    this.el.id = 'dialogue';
    this.el.className = 'panel';
    this.el.hidden = true;
    this.el.setAttribute('role', 'dialog');
    parent.append(this.el);
    this.el.addEventListener('click', (ev) => {
      const b = (ev.target as HTMLElement).closest('button');
      const k = b ? this.buttons.indexOf(b) : -1;
      if (k >= 0 && !this.box?.rows[k]?.disabled) this.choose(k);
    });
    this.el.addEventListener('contextmenu', (ev) => ev.preventDefault());
  }

  dispose(): void {
    if (this.shakeTimer !== null) clearTimeout(this.shakeTimer);
    this.el.remove();
  }

  get isOpen(): boolean {
    return this.world.conversation !== null;
  }

  /** Call once per frame: show, re-render or hide the box. */
  update(): void {
    const w = this.world;
    if (!w.conversation) {
      if (this.shown >= 0) {
        this.shown = -1;
        this.box = null;
        this.el.hidden = true;
        this.el.replaceChildren();
      }
      return;
    }
    if (w.conversationVersion === this.shown) return;
    const opening = this.shown < 0;
    this.shown = w.conversationVersion;
    this.render();
    if (opening) this.on.opened();
  }

  /** Keyboard while open (see `dialogueKey`); returns whether the key was used. */
  key(code: string): boolean {
    if (!this.isOpen) return false;
    this.update();
    if (!this.box) return false;
    const k = dialogueKey(this.box, this.selected, code);
    switch (k.kind) {
      case 'pass':
        return false;
      case 'choose':
        this.choose(k.index);
        break;
      case 'select':
        this.select(k.index);
        break;
      case 'leave':
        this.world.leaveConversation();
        this.on.input();
        this.update();
        break;
      case 'refuse':
        this.refuse();
        break;
      case 'none':
        break;
    }
    return true;
  }

  private choose(index: number): void {
    this.world.choose(index);
    this.on.input();
    this.update();
  }

  private render(): void {
    const view = this.world.conversationView();
    if (!view) return;
    const box = (this.box = dialogueBox(view));
    const speaker = document.createElement('div');
    speaker.className = 'panel-title';
    speaker.textContent = box.speaker;
    const text = document.createElement('div');
    text.className = 'dialogue-text';
    text.textContent = box.text;
    this.buttons = box.rows.map((row) => {
      const b = document.createElement('button');
      b.className = 'dialogue-choice';
      b.setAttribute('aria-disabled', String(row.disabled));
      if (row.disabled) b.classList.add('disabled');
      const k = document.createElement('span');
      k.className = 'menu-key';
      k.textContent = String(row.key);
      b.append(k, row.text);
      if (row.hint) {
        const h = document.createElement('span');
        h.className = 'menu-hint';
        h.textContent = row.hint;
        b.append(h);
      }
      return b;
    });
    const help = document.createElement('div');
    help.className = 'panel-hint';
    help.textContent = box.help;
    this.note = document.createElement('div');
    this.note.className = 'dialogue-note';
    this.note.hidden = true;
    this.selected = -1;
    this.el.replaceChildren(speaker, text, ...this.buttons, this.note, help);
    this.el.hidden = false;
  }

  private select(k: number): void {
    this.buttons[this.selected]?.classList.remove('selected');
    this.selected = k;
    this.buttons[k]?.classList.add('selected');
  }

  /** Escape at a node that cannot be left: shake briefly and say so. */
  private refuse(): void {
    if (this.note) {
      this.note.textContent = LEAVE_REFUSED_TEXT;
      this.note.hidden = false;
    }
    this.el.classList.add('shake');
    if (this.shakeTimer !== null) clearTimeout(this.shakeTimer);
    this.shakeTimer = setTimeout(() => {
      this.el.classList.remove('shake');
      this.shakeTimer = null;
    }, SHAKE_MS);
  }
}
