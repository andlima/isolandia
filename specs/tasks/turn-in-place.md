---
id: turn-in-place
area: web
priority: 40
depends_on: []
description: Browser keyboard turns the player in place. A press in a new direction only rotates, and holding the key past a short threshold starts walking. Adds an opt-in `turnInPlace` flag on step intents. NPCs, paths and the terminal are unchanged.
---

# Turn in place (browser keyboard)

## Goal

Since `turn-before-move`, a step intent toward a direction the entity isn't
facing rotates it 45° per `ticks_per_turn` beat. The intent stays pending,
so the step always follows the turn. In the browser this means a tap in a
new direction turns the player and also moves them a tile. The player
cannot just change orientation.

This task makes a browser key press in a new direction **only turn** the
player. **Holding** the key past a short threshold then walks, as before.
Pressing a direction the player already faces steps immediately, as today.
The simulation gets a small opt-in flag on step intents. Everything that
doesn't set the flag keeps its current behavior: NPC behaviors, `goto`
paths, click-to-move and the ASCII terminal.

## Acceptance Criteria

1. **`StepIntent.turnInPlace?: boolean`.** It is optional, defaults to
   false, and is documented on the interface in `src/core/sim/world.ts`.
   The current doc comment ("One-tile move…") is extended to explain it.
   Intents without the flag behave exactly as today. Every existing test
   keeps passing unchanged, except where this spec says otherwise.
2. **Sim rule for `turnInPlace: true`** (in `applyIntent`, once
   `moveCooldown` reaches 0):
   - If `facing === want`, where `want = facingOfStep(dx, dy)`, the
     intent is consumed and the step is attempted exactly as a plain step
     is today.
   - Otherwise the entity rotates one compass point toward `want`, using
     the existing `turnToward`, and sets
     `moveCooldown = ticksPerTurn`, as today. The intent stays pending
     while more rotation is needed. On the beat where `facing` becomes
     `want`, the intent is **consumed** and **no step** is taken. Position,
     `fromX`/`fromY`/`stepTick` and paths stay untouched.
   - With `ticksPerTurn === 0`, the entity snaps to `want` and the intent
     is consumed in the same tick, with no step and no cooldown.
   - It turns toward walls and corner-cut diagonals like any other step.
     Since it doesn't step, nothing is rejected.
   - As for any step intent, it cancels an active path/`then` and an
     activity, as plain steps do today.
   - Example: facing `n`, `ticks_per_turn: 1`, intent `(1, 0)` with
     `turnInPlace`. Tick 1 gives `ne` at the same position, intent pending.
     Tick 2 gives `e` at the same position, intent `null`. Tick 3 brings
     no change.
3. **Save/load.** If entity intents are serialized, the flag round-trips
   through a save. If intents are not saved, nothing changes. Check
   `src/core/sim/save.ts`.
4. **Web input** (`src/web/input.ts`):
   - A fresh (non-repeat) movement keydown queues the held direction with
     `turnInPlace: true`. If the player already faces that way, the sim
     steps at once, so a tap in the current direction still moves one
     tile.
   - `beforeTick` keeps re-queuing the held direction when
     `moveCooldown <= 1`, as **plain** steps, but only once the latest
     fresh press is at least `HOLD_MS` old. `HOLD_MS` is an exported
     constant, about 200 ms. Before that it queues nothing and leaves the
     pending turn-in-place intent alone. So a tap (released before
     `HOLD_MS`) only turns. A hold turns and then walks continuously at
     the usual pace. If the hold outlasts a long turn, the plain step
     replaces the pending intent, so the turn finishes and the walk
     starts with no extra beat.
   - Changing the held set with a new fresh keydown (e.g. adding a second
     key for a screen diagonal) counts as a new press. It sends a new
     turn-in-place intent and restarts the hold clock.
   - Time comes from an injectable clock, following the `now` parameter
     pattern in `src/web/gestures.ts`. The hold/repeat decision lives in a
     small pure, DOM-free helper, e.g. in `src/web/keys.ts`, so it can be
     unit-tested. The file's top doc comment describes the new behavior.
5. **Unchanged:** NPC behaviors (`src/core/sim/behavior.ts`), `goto` paths
   and click-to-move, the context menu walk-then-act, and the ASCII
   terminal keymap (`src/ascii/terminal.ts`). All of these keep turning
   and then walking.
6. **Tests.**
   - In `test/turning.test.ts`: the criterion 2 example tick by tick;
     already-facing `turnInPlace` steps immediately; `ticks_per_turn: 0`
     snaps without stepping; a 180° reversal takes 4 beats, then the
     intent clears and nothing moves; facing a wall works; a
     `turnInPlace` intent cancels an active path; a plain step after a
     turn-in-place moves at once (no extra turn).
   - In `test/web.test.ts`: the hold helper with a fake clock. A press
     queues turn-in-place. No re-queue before `HOLD_MS`. Plain steps are
     re-queued after `HOLD_MS` when `moveCooldown <= 1`. A release before
     `HOLD_MS` gives no step. A new press resets the clock.
   - If a save test covers intents, add a round-trip for the flag.
7. Docs: wherever `docs/iso.md` and `VISION.md` describe turning/keyboard
   movement, add a line saying a browser tap turns in place and a hold
   walks.
8. `npm run typecheck` and `npm test` pass.

## Out of Scope

- Turn-in-place for NPCs, paths, or the ASCII terminal (the glyph has no
  facing).
- A dedicated "turn" key or modifier, strafing or backpedaling.
- Touch/on-screen d-pad changes.
- Facing-aware gameplay, such as interacting with the faced tile.
- Changing `ticks_per_turn` defaults or pack content.

## Design Notes

- In `applyIntent`, the existing turn block (`want && p.facing !== want`)
  is the hook. After rotating, if `p.intent?.kind === 'step' &&
  p.intent.turnInPlace`, then once `p.facing === want`, set
  `p.intent = null` and return. With `ticksPerTurn === 0`, set facing,
  clear the intent and return before the step code. If it's already
  facing, fall through to the normal step.
- Suggested helper shape: `class MoveRepeat { press(now): void;
  shouldRepeat(now, moveCooldown): boolean }`, or pure functions over a
  `pressedAt` number. Input calls `press` on fresh keydowns that set a
  direction, and `shouldRepeat` in `beforeTick`.
- At 10 ticks/s with the default `ticks_per_turn: 1`, a 45° turn takes
  100 ms. A ~200 ms threshold keeps ordinary taps (80 to 150 ms) from
  stepping.

## Agent Notes

Read `src/core/sim/world.ts` (`StepIntent`, `queueIntent`, `applyIntent`),
`src/core/facing.ts`, `src/web/input.ts`, `src/web/keys.ts`,
`src/web/gestures.ts` (clock injection), `src/web/main.ts` (where
`beforeTick` is called), `src/core/sim/save.ts`, `test/turning.test.ts` and
`test/web.test.ts`. The sim change is a few lines. Most of the work is the
input hold logic and its tests.
