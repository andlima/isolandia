/**
 * DOM rendering of the message log (`MessageLog`, `src/core/log.ts`): the
 * recent strip at the bottom left (the newest `STRIP_LINES` lines, each
 * fading out `FADE_MS` after it arrived) and the history panel (`M` or the
 * `Log [M]` button). It lives for the whole page, across loaded worlds, and
 * re-renders only when the log's version changes.
 */

import { entryText, type LogEntry, type MessageLog } from '../core/index.ts';

/** Lines shown in the recent strip. */
export const STRIP_LINES = 5;
/** Wall time (ms) after its arrival at which a strip line fades out. */
export const FADE_MS = 8000;

/** The strip's lines: the newest `STRIP_LINES`, oldest at the top. */
export function stripEntries(entries: readonly LogEntry[]): readonly LogEntry[] {
  return entries.slice(-STRIP_LINES);
}

/** A history row: `Day D HH:MM  text (×N)`. */
export function historyRow(e: LogEntry): string {
  return `${e.clock}  ${entryText(e)}`;
}

export interface LogViewHandlers {
  /** The history panel was shown (the transfer window closes). */
  opened?(): void;
}

function div(className: string, text?: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  if (text !== undefined) d.textContent = text;
  return d;
}

export class LogView {
  private readonly strip: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly toggleEl: HTMLButtonElement;
  /** `H`: the strip is hidden with the HUD. */
  private hudHidden = false;
  private stripShown = -1;
  private panelShown = -1;

  constructor(
    parent: HTMLElement,
    private readonly log: MessageLog,
    private readonly on: LogViewHandlers = {},
  ) {
    this.strip = div('');
    this.strip.id = 'log-strip';
    this.panel = div('panel');
    this.panel.id = 'log';
    this.panel.hidden = true;
    const head = div('log-head');
    const close = document.createElement('button');
    close.className = 'log-close';
    close.textContent = '×';
    close.title = 'Close [Esc]';
    close.addEventListener('click', () => this.close());
    head.append(div('panel-title', 'Log'), close);
    this.list = div('log-list');
    this.panel.append(head, this.list);
    this.toggleEl = document.createElement('button');
    this.toggleEl.id = 'log-toggle';
    this.toggleEl.textContent = 'Log [M]';
    this.toggleEl.addEventListener('click', () => this.toggle());
    parent.append(this.strip, this.panel, this.toggleEl);
  }

  get open(): boolean {
    return !this.panel.hidden;
  }

  /** `M` or the button: show or hide the history panel (showing it closes the transfer window). */
  toggle(): void {
    if (this.open) return this.close();
    this.panel.hidden = false;
    this.panelShown = -1;
    this.stripShown = -1;
    this.on.opened?.();
    this.update(performance.now());
    this.list.scrollTop = this.list.scrollHeight;
  }

  /** Escape or the × button. */
  close(): void {
    if (!this.open) return;
    this.panel.hidden = true;
    this.stripShown = -1;
  }

  /** `H`: hide or show the strip along with the HUD (the history panel ignores it). */
  setHudVisible(visible: boolean): void {
    this.hudHidden = !visible;
    this.stripShown = -1;
  }

  update(now: number): void {
    const { version } = this.log;
    if (this.open && version !== this.panelShown) {
      this.panelShown = version;
      const l = this.list;
      const atBottom = l.scrollTop + l.clientHeight >= l.scrollHeight - 4;
      const rows = this.log.entries.map((e) => div(`log-row log-${e.tone}`, historyRow(e)));
      l.replaceChildren(...(rows.length ? rows : [div('log-row', 'Nothing yet.')]));
      if (atBottom) l.scrollTop = l.scrollHeight;
    }
    if (version === this.stripShown) return;
    this.stripShown = version;
    this.strip.hidden = this.open || this.hudHidden;
    if (this.strip.hidden) return;
    const lines = stripEntries(this.log.entries).map((e) => {
      const d = div(`log-line log-${e.tone}`, entryText(e));
      // One CSS transition: the fade starts FADE_MS after the line arrived (a negative delay starts it part-way).
      d.style.transitionDelay = `${Math.round(e.at + FADE_MS - now)}ms`;
      return d;
    });
    this.strip.replaceChildren(...lines);
    void this.strip.offsetWidth;
    for (const d of lines) d.classList.add('log-faded');
  }

  dispose(): void {
    for (const el of [this.strip, this.panel, this.toggleEl]) el.remove();
  }
}
