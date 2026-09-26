/**
 * In-game calendar. Game time is a pure function of the tick count and the
 * pack-defined `clock`, so it adds no simulation state.
 */

export const MINUTES_PER_DAY = 1440;

/** Resolved `clock` domain. Times of day are minutes since midnight. */
export interface ClockDef {
  /** Sim seconds per in-game day. */
  readonly dayLength: number;
  /** Time of day at tick 0 (day 1). */
  readonly start: number;
  /** Daylight starts (inclusive). */
  readonly dawn: number;
  /** Daylight ends (exclusive); always after `dawn`. */
  readonly dusk: number;
}

export const DEFAULT_CLOCK: ClockDef = { dayLength: 1440, start: 8 * 60, dawn: 6 * 60, dusk: 20 * 60 };

export interface ClockTime {
  /** Day number, starting at 1. */
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  /** Hours since midnight, in [0, 24). */
  readonly timeOfDay: number;
  readonly isDay: boolean;
}

/**
 * Game minutes since midnight of day 1. Computed from the integer tick in a
 * single division, never by accumulating per-tick increments.
 */
export function gameMinutes(clock: ClockDef, tick: number, ticksPerSecond: number): number {
  return clock.start + (tick * MINUTES_PER_DAY) / (ticksPerSecond * clock.dayLength);
}

/** Minutes since midnight of the current day, in [0, 1440). */
export function minuteOfDay(clock: ClockDef, tick: number, ticksPerSecond: number): number {
  const t = gameMinutes(clock, tick, ticksPerSecond);
  return t - Math.floor(t / MINUTES_PER_DAY) * MINUTES_PER_DAY;
}

export function dayAt(clock: ClockDef, tick: number, ticksPerSecond: number): number {
  return Math.floor(gameMinutes(clock, tick, ticksPerSecond) / MINUTES_PER_DAY) + 1;
}

export function isDayAt(clock: ClockDef, tick: number, ticksPerSecond: number): boolean {
  const m = minuteOfDay(clock, tick, ticksPerSecond);
  return m >= clock.dawn && m < clock.dusk;
}

export function clockAt(clock: ClockDef, tick: number, ticksPerSecond: number): ClockTime {
  const m = minuteOfDay(clock, tick, ticksPerSecond);
  return {
    day: dayAt(clock, tick, ticksPerSecond),
    hour: Math.floor(m / 60),
    minute: Math.floor(m % 60),
    timeOfDay: m / 60,
    isDay: m >= clock.dawn && m < clock.dusk,
  };
}

/** `"HH:MM"` → minutes since midnight, or null if malformed / out of range. */
export function parseTimeOfDay(s: string): number | null {
  const match = /^(\d\d):(\d\d)$/.exec(s);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  return h <= 23 && m <= 59 ? h * 60 + m : null;
}
