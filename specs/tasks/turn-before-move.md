---
id: turn-before-move
area: sim
priority: 40
depends_on: []
description: Make facing simulation state. Entities rotate 45° per `ticks_per_turn` beat toward a new direction before they step. Applies to the player and NPCs, for key steps and paths alike.
---

# Turn before moving

## Goal

Right now facing exists only for rendering. `facingOf` works it out from the
last step, so a character snaps straight to any new direction and moves in
the same tick. This task makes facing part of the simulation's state.
To step in a direction it is not facing, an entity first rotates toward it
one compass point (45°) at a time, and each point costs `ticks_per_turn`
ticks. Movement then reads as "turn, then walk", and the sprite visibly
sweeps around. The rule applies to every entity, player and NPCs alike, and
to both single `step` intents and `goto` paths.

## Acceptance Criteria

1. **Facing is entity state.** `Entity` gets a `facing: Facing` field. It
   starts as `DEFAULT_FACING` (`s`) at spawn. It is included in
   `snapshot()` and therefore in the state hash. The doc comment at the top
   of `src/core/facing.ts` stops saying that the simulation never reads a
   facing.
2. **Archetype field `ticks_per_turn`.** It is an optional non-negative
   integer that defaults to `1`. It is loaded into
   `ArchetypeDef.ticksPerTurn`. A negative or non-integer value is a load
   error that follows the `ticks_per_step` pattern and falls back to the
   default. Add a row for it to the archetype field table in
   `docs/packs.md`.
3. **Turning rule.** This runs in `applyIntent` when the entity's
   `moveCooldown` reaches 0 and it wants to step `(dx, dy)`, either from a
   `step` intent or from the next path cell. Let `want = facingOfStep(dx, dy)`.
   - If `facing === want`, the step is attempted exactly as it is today
     (`move`), including `ticks_per_step` cooldown and wall/corner checks.
   - Otherwise the entity rotates **one** compass point toward `want` the
     short way round. On an exact 180° reversal it rotates **clockwise**,
     following `FACINGS` order, so the result is deterministic. It then
     sets `moveCooldown = ticksPerTurn` and does **not** step this tick.
     Turning in place leaves `x`/`y`/`fromX`/`fromY`/`stepTick` unchanged.
   - The pending `step` intent is **not** consumed while turning, and the
     path is **not** advanced. Both stay pending until the entity faces the
     right way and the step is attempted. A tap therefore produces the full
     turn followed by one step. A new intent replaces a pending one as it
     does today, so the turn retargets.
   - With `ticksPerTurn === 0`, all of the needed rotation and the step
     happen in the same tick. That is exactly today's behavior.
   - Example: an entity facing `n` with `ticks_per_turn: 1` and
     `ticks_per_step: 2` gets a step `(0, 1)` (south). It turns `ne`, then
     `e`, then `se`, then `s` over 4 ticks, and steps on the 5th.
   - Example: an entity facing `n` with `ticks_per_turn: 1` gets a step
     `(1, 0)` (east). It turns `ne`, then `e`, then steps on the 3rd tick.
4. **Blocked steps still turn.** If the target cell is walled, or the
   diagonal would cut a corner, the entity still rotates to face it. Only
   the final `move` is rejected, as today. This lets the player turn in
   place to face a wall. A path whose step is rejected is still dropped, as
   today.
5. **`move` sets facing.** A successful step leaves `facing` equal to the
   step's direction. This always holds because steps only happen when
   already facing that way.
6. **Rendering reads sim facing.** `facingOf(e)` in
   `src/core/sim/motion.ts` returns `e.facing`. Its signature may change to
   `Pick<Entity, 'facing'>`. `src/iso/scene.ts` keeps calling it. Turning
   beats show as successive sprite facings, and 4-way sprites snap
   diagonals through `resolveFacing` as they do now. `renderPosition` is
   unchanged.
7. **Web input keeps working.** `src/web/input.ts` re-queues the held
   direction when `moveCooldown <= 1`. That still works because turning
   uses `moveCooldown`. Holding a key in a new direction turns the
   character, then it walks continuously. Releasing mid-turn finishes the
   turn plus one step, because the pending intent is kept. Verify this by
   reasoning and adjust only if it is actually broken. The intent format
   is unchanged.
8. **Tests.**
   - Add a new `test/turning.test.ts` that covers:
     - the two examples in criterion 3, checking `facing` and position on
       each tick;
     - the shortest-way choice for both a clockwise and a counter-clockwise
       90° turn;
     - the clockwise tie-break on a 180° turn;
     - `ticks_per_turn: 0` behaving like before (step on the first tick
       with the facing set);
     - `ticks_per_turn: 3` taking 3 ticks per 45°;
     - turning to face a wall without moving;
     - a `goto` path turning before its first step and at each bend;
     - an NPC (behavior-driven or intent-driven) turning too;
     - the snapshot/hash changing when only `facing` differs.
   - Existing tests that assert exact tick timings for other features
     (movement, npc-movement, behaviors, noise, sight, scenario, etc.)
     should keep their meaning. Either add `ticks_per_turn: 0` to their
     fixture archetypes or adjust the expected ticks. Prefer
     `ticks_per_turn: 0` where turning is beside the point.
   - Update the `facingOf` tests in `test/facing.test.ts` to the new
     semantics. The "no new entity state" test goes away.
   - Add loader tests for `ticks_per_turn`: the default, `0`, and invalid
     values.
9. Packs: the shipped packs keep the default of `1` unless a pack's
   playtesting obviously needs another value. Do not change pack content
   beyond that.
10. Docs: `docs/iso.md` and `VISION.md` mention that facing is now
    simulation state, with a short note on turning, wherever they currently
    say facing is render-derived. `docs/packs.md` documents
    `ticks_per_turn`.
11. `npm run typecheck` and `npm test` pass.

## Out of Scope

- Facing-aware gameplay, such as vision cones, backstab, or "interact with
  the faced tile". Sight and hearing keep ignoring facing.
- A turn-only intent or key, or strafing/backpedaling (moving without
  facing the direction).
- Turn animation interpolation between facings. Each beat is a discrete
  sprite switch.
- Legend-set initial facing for spawned entities.
- Terminal/ASCII rendering changes. The glyph has no facing.

## Design Notes

- Rotation: `i = FACINGS.indexOf(facing)`, `j = FACINGS.indexOf(want)`,
  `d = (j - i + 8) % 8`. Turn clockwise (`i + 1`) when `d` is 1 to 4, and
  counter-clockwise (`i + 7`) when `d` is 5 to 7. A small pure helper
  such as `turnToward(from, to): Facing` in `src/core/facing.ts` keeps this
  testable.
- In `applyIntent`, after the cooldown check, compute the desired
  `(dx, dy)` first, from the intent or from `path[pathPos]` without
  incrementing. Then either turn (and return) or fall through to the
  existing step/path-advance code. With `ticksPerTurn === 0`, loop the
  rotation to completion in the same tick before stepping.
- A zero step `(0, 0)` is already filtered in `queueIntent`, so
  `facingOfStep` returning `null` can't happen here. Guard it anyway.
- `moveCooldown` is shared by turning and stepping, which keeps the web
  input's `moveCooldown <= 1` re-queue timing and NPC behaviors working
  without new hooks.

## Agent Notes

Read `src/core/facing.ts`, `src/core/sim/motion.ts`, `src/core/sim/world.ts`
(`Entity`, `spawn`, `applyIntent`, `move`, `snapshot`), the archetype parsing
in `src/core/load/load.ts` (around `ticks_per_step`), `src/iso/scene.ts`
(its `facingOf` uses), `src/web/input.ts`, `test/facing.test.ts`,
`test/movement.test.ts` and `test/npc-movement.test.ts`. Expect most of the
churn to be in the timing of existing tests. Fix it with
`ticks_per_turn: 0` in fixtures rather than by weakening assertions.
