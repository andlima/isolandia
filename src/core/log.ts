/**
 * The message log shared by the shells: `logLines` turns one tick's events
 * (`world.actionEvents`, `journalEvents`, `statusEvents`, defeat/victory)
 * into lines, and `MessageLog` keeps the last `LOG_MAX` of them, with shell
 * notes (saves, loads, storage errors) mixed in. Not saved with the game.
 */

import { clockAt } from './clock.ts';
import { actionText, formatClock } from './hud.ts';
import { journalToast } from './journal.ts';
import type { ActionRecord, World } from './sim/world.ts';

export type LogTone = 'info' | 'good' | 'bad';

export interface LogLine {
  readonly tick: number;
  /** In-game clock at `tick`, `Day D HH:MM`. */
  readonly clock: string;
  readonly text: string;
  readonly tone: LogTone;
  /** Dropped (not counted) when the newest buffered line has the same text, e.g. a repeated `You can't get there.`. */
  readonly once?: boolean;
}

/** A buffered line: consecutive identical texts collapse into one with a count. */
export interface LogEntry extends LogLine {
  /** How many times the text arrived in a row (≥ 1). */
  readonly count: number;
  /** Wall time (ms, the shell's clock) of the latest arrival. */
  readonly at: number;
}

/** How many lines the log keeps. */
export const LOG_MAX = 100;

/** `Day D HH:MM` at `tick`. */
function clockText(world: World, tick: number): string {
  return formatClock(clockAt(world.def.clock, tick, world.def.ticksPerSecond));
}

/** A shell note (`Saved to Slot 2.`, `Load failed`…) at the world's current tick. */
export function noteLine(world: World, text: string, tone: 'info' | 'bad' = 'info'): LogLine {
  return { tick: world.tick, clock: clockText(world, world.tick), text, tone };
}

/** Whether an action record is logged: completions, and starts that failed (a started activity shows in the activity bar). */
function logged(a: ActionRecord): boolean {
  return a.stage === 'complete' || !a.ok;
}

/**
 * The log lines of the last stepped tick (or conversation input), in order:
 * action results (`actionText`; failures, cancelled and interrupted
 * activities are `bad`), journal events (one line each, hidden quest stages
 * left out), the player's status changes (`hud.enter` / `hud.exit`, empty
 * texts silent; entering takes the status's tone, leaving a `bad` status is
 * `good`), then defeat or victory on the tick it happened. Call it right
 * after `step()` advanced the tick, or after `choose` / `leaveConversation`.
 */
export function logLines(world: World): LogLine[] {
  const out: LogLine[] = [];
  const line = (tick: number, text: string, tone: LogTone, once = false) => out.push({ tick, clock: clockText(world, tick), text, tone, ...(once ? { once } : {}) });
  for (const a of world.actionEvents) {
    if (logged(a)) line(a.tick, actionText(world, a), a.ok ? 'info' : 'bad', a.reason === 'unreachable');
  }
  for (const e of world.journalEvents) {
    const text = journalToast([e], world);
    if (text) line(e.tick, text, 'info');
  }
  const { statuses, ids } = world.def;
  for (const e of world.statusEvents) {
    const s = statuses[ids.statuses[e.status]!]!;
    const text = e.entered ? s.hud.enter : s.hud.exit;
    if (!text) continue;
    const tone: LogTone = e.entered ? (s.hud.tone === 'neutral' ? 'info' : s.hud.tone) : s.hud.tone === 'bad' ? 'good' : 'info';
    line(e.tick, text, tone);
  }
  // `step` checks the outcome, then advances the tick.
  const outcome = world.defeat ?? world.victory;
  if (outcome && outcome.tick === world.tick - 1) line(outcome.tick, outcome.message, world.defeat ? 'bad' : 'good');
  return out;
}

/** `text`, or `text (×N)` for a collapsed run. */
export function entryText(e: LogEntry): string {
  return e.count > 1 ? `${e.text} (×${e.count})` : e.text;
}

/** `Day D HH:MM` → `HH:MM`. */
export function timeOfDay(clock: string): string {
  return clock.slice(clock.lastIndexOf(' ') + 1);
}

/**
 * The shells' message log: the last `LOG_MAX` lines, oldest first.
 * Consecutive identical texts collapse into one entry with a count.
 * `version` changes whenever the lines do, so views re-render cheaply.
 */
export class MessageLog {
  private list: LogEntry[] = [];
  version = 0;

  constructor(readonly max: number = LOG_MAX) {}

  /** Buffered entries, oldest first. */
  get entries(): readonly LogEntry[] {
    return this.list;
  }

  /** The newest entry, or null. */
  get newest(): LogEntry | null {
    return this.list[this.list.length - 1] ?? null;
  }

  /** Add lines, arriving at wall time `now` (ms). */
  push(lines: readonly LogLine[], now: number): void {
    for (const l of lines) {
      const last = this.newest;
      if (last && last.text === l.text) {
        if (l.once) continue;
        this.list[this.list.length - 1] = { ...l, count: last.count + 1, at: now };
      } else {
        this.list.push({ ...l, count: 1, at: now });
        if (this.list.length > this.max) this.list.splice(0, this.list.length - this.max);
      }
      this.version++;
    }
  }

  /** Forget every line (a load). */
  clear(): void {
    this.list = [];
    this.version++;
  }
}

/** The note a load leaves in the cleared log: `Loaded Day N HH:MM`. */
export function loadedNote(world: World): LogLine {
  return noteLine(world, `Loaded ${formatClock(world.clock)}`);
}
