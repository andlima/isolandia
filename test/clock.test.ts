import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clockAt, DEFAULT_CLOCK, parseTimeOfDay, World, type ClockDef } from '../src/core/index.ts';
import { loadFixture } from './helpers.ts';

const TPS = 10;
/** Ticks for a number of game minutes under the default 1 s = 1 min scale. */
const minutes = (n: number) => n * TPS;

test('clock: tick 0 is the start time on day 1', () => {
  assert.deepEqual(clockAt(DEFAULT_CLOCK, 0, TPS), { day: 1, hour: 8, minute: 0, timeOfDay: 8, isDay: true });
  const dusk: ClockDef = { ...DEFAULT_CLOCK, start: 20 * 60 };
  assert.deepEqual(clockAt(dusk, 0, TPS), { day: 1, hour: 20, minute: 0, timeOfDay: 20, isDay: false });
});

test('clock: minutes floor; tick 25 at 10 ticks/s is Day 1 08:02', () => {
  const t = clockAt(DEFAULT_CLOCK, 25, TPS);
  assert.equal(t.day, 1);
  assert.equal(t.hour, 8);
  assert.equal(t.minute, 2);
  assert.ok(Math.abs(t.timeOfDay - (8 + 2.5 / 60)) < 1e-12);
});

test('clock: rollover past midnight increments the day', () => {
  const before = clockAt(DEFAULT_CLOCK, minutes(16 * 60 - 1), TPS);
  assert.deepEqual([before.day, before.hour, before.minute], [1, 23, 59]);
  const midnight = clockAt(DEFAULT_CLOCK, minutes(16 * 60), TPS);
  assert.deepEqual([midnight.day, midnight.hour, midnight.minute, midnight.timeOfDay], [2, 0, 0, 0]);
  const later = clockAt(DEFAULT_CLOCK, minutes(16 * 60 + 3 * 1440 + 90), TPS);
  assert.deepEqual([later.day, later.hour, later.minute], [5, 1, 30]);
});

test('clock: isDay is true exactly at dawn and false exactly at dusk', () => {
  const atDawn = clockAt(DEFAULT_CLOCK, minutes(22 * 60), TPS); // 08:00 + 22h = 06:00, day 2
  assert.deepEqual([atDawn.day, atDawn.hour, atDawn.minute, atDawn.isDay], [2, 6, 0, true]);
  const beforeDawn = clockAt(DEFAULT_CLOCK, minutes(22 * 60) - 1, TPS);
  assert.equal(beforeDawn.isDay, false);
  const atDusk = clockAt(DEFAULT_CLOCK, minutes(12 * 60), TPS); // 20:00
  assert.deepEqual([atDusk.hour, atDusk.minute, atDusk.isDay], [20, 0, false]);
  assert.equal(clockAt(DEFAULT_CLOCK, minutes(12 * 60) - 1, TPS).isDay, true);
});

test('clock: a non-default day_length scales game time', () => {
  // 240 s per day: 1 sim second = 6 game minutes.
  const fast: ClockDef = { dayLength: 240, start: 0, dawn: 6 * 60, dusk: 18 * 60 };
  assert.deepEqual(clockAt(fast, 10 * TPS, TPS), { day: 1, hour: 1, minute: 0, timeOfDay: 1, isDay: false });
  assert.equal(clockAt(fast, 60 * TPS, TPS).hour, 6);
  assert.equal(clockAt(fast, 60 * TPS, TPS).isDay, true);
  assert.equal(clockAt(fast, 240 * TPS, TPS).day, 2);
  assert.equal(clockAt(fast, 240 * TPS * 1000, TPS).day, 1001);
});

test('clock: parseTimeOfDay accepts HH:MM in range only', () => {
  assert.equal(parseTimeOfDay('00:00'), 0);
  assert.equal(parseTimeOfDay('23:59'), 23 * 60 + 59);
  for (const bad of ['24:00', '12:60', '8:00', '08:0', '08:00:00', 'noon', '']) assert.equal(parseTimeOfDay(bad), null, bad);
});

test('world: clock getter follows the tick and adds no state', () => {
  const w = World.create(loadFixture(), 1);
  assert.deepEqual(w.clock, clockAt(w.def.clock, 0, w.def.ticksPerSecond));
  const hash = w.hash();
  void w.clock;
  assert.equal(w.hash(), hash);
  for (let i = 0; i < 25; i++) w.step();
  assert.equal(w.clock.minute, 2);
});

test('world: expressions read the clock at the tick being simulated', () => {
  const def = loadFixture({
    'clock.yaml': 'clock:\n  start: "19:59"\n',
    'measurements.yaml': `measurements:
  - id: hp
    label: HP
    max: 10
    initial: 10
  - id: food
    label: Food
    max: 100
    initial: 50
    rate: "10 * world.is_day"
`,
  });
  const w = World.create(def, 1);
  const food = () => w.value(w.player, 't:food')!;
  // Ticks 0–9 run at 19:59:xx (day); from tick 10 on it is 20:00 (night).
  for (let i = 0; i < 10; i++) w.step();
  assert.ok(Math.abs(food() - 60) < 1e-9, String(food()));
  for (let i = 0; i < 10; i++) w.step();
  assert.ok(Math.abs(food() - 60) < 1e-9, String(food()));
});
