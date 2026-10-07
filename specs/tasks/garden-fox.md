---
id: garden-fox
area: packs
priority: 40
depends_on: []
description: Bunny Garden gets a fox — a night prowler that sleeps in a new `den` tile by day, comes out at dusk to sneak around and playfully chase the bunny (startling it like the cat, never hurting it), with 8-way pixel art and tests; pack content only, no engine changes
---

# Bunny Garden: a fox that prowls at night

## Goal

`packs/garden` (Bunny Garden, namespace `gdn`) has a sleepy cat and
butterflies. This task adds a **fox**. It is a night prowler. By day it
sleeps in its **den** in a quiet corner of the garden. At dusk
(`world.is_day` becomes false) it comes out and sneaks around the garden.
If it spots the bunny in the open, it chases it playfully. Like the cat,
its only "cost" is the existing mild `startled` energy drain when it is
right next to the bunny. Nothing gets hurt. At dawn it trots back to the
den and sleeps.

This is **pack content only**: YAML and pixel art on the existing engine.
No engine code may name garden content (VISION.md §3.8).

## Acceptance Criteria

### Pack content

1. **Tile** `den`: flat, walkable, tagged `den`, sprite `den_img`. It is a
   small dug-out hollow under roots or a bush, visibly different from the
   bunny's `burrow`. It is **not** tagged `burrow`, so the bunny cannot
   nap there.
2. **Archetype** `fox` (label "Fox", a glyph such as `f`, an orange/rust
   colour): tags `[fox]`, `behavior: fox`, sprite `fox_img`. It has no
   measurements and no health. Choose its `ticks_per_step` so that the
   bunny can still get away (the cat's speed or slower is fine).
3. **Status** on the fox, for example `sly`. It works like the cat's
   `curious`, but **only at night**. It is entered when
   `not world.is_day`, the fox can see the player within about 6 tiles,
   and the player is not `hidden`. It is exited when it is day, the fox
   loses sight past about 9 tiles, or the bunny is `hidden`.
4. **System** `yip` (the fox's counterpart of `meow`): it emits a noise
   of radius about 1.5 while the fox has its chase status and is within
   Chebyshev distance 1 of the player. The existing `startled` status
   (`heard(self, 1)`) then applies, and no new drain is added.
5. **Behavior** `fox`, with roughly these states:
   - `sleep`: `idle` at home (the den). It moves to `prowl` when
     `not world.is_day`;
   - `prowl`: `wander` with a radius of about 8. It moves to `chase` on
     the chase status, to `investigate` on `heard(self, 1)`, and to
     `den` when `world.is_day`;
   - `chase`: `pursue` the player. It moves to `prowl` when the status
     drops and to `den` when it is day, with a timeout to a `bored` state
     (like the cat) so that a chase never lasts forever;
   - `investigate`: when done, it goes back to `prowl`. Sight beats sound
     (the chase status wins), and it moves to `den` when it is day;
   - `den` (home) and, when done, `sleep`.

   The exact state names are flexible. The observable rules are: no
   leaving the den by day, prowling and chasing only at night, and home
   by morning.
6. **Map** `garden`: add one `den` tile with a fox spawn. Place it in a
   quiet corner away from the bunny's start, the burrow and the cat at
   (14, 4), for example in the south-east near the bushes around
   (20–21, 14). Add legend entries as needed. Keep the cats, butterflies,
   carrot patches and rooms where they are, so that the existing garden
   tests keep their coordinates. The fox's spawn cell is its home.
7. Update the comment headers in `content.yaml`/`rules.yaml`/`behaviors.yaml`
   and the `pack.yaml` description, if worthwhile, to mention the fox.

### Pixel art

8. Sprites follow docs/art.md and are drawn in `art/garden.mjs` (generated
   by `scripts/pixel-art.mjs garden`):
   - `fox_img` is **8-way** (5 drawings: s, se, ne, w, nw), with anchor
     `[0.5, 0.92]` like the cat. It is cute: round shapes, big eyes, a
     rust-orange coat, a cream chest, a white-tipped bushy tail and dark
     socks/ear tips. It must read as clearly different from the
     orange cat: a pointed snout, big pointed ears and a big tail;
   - `den_img` is a flat 64×32 tile.

   Add them to `packs/garden/assets.yaml`. Keep the palette at 32 colours
   or fewer. If colours are added, update the garden palette in
   `docs/art.md`. `test/art.test.ts` must pass, and it must expect `fox`
   to be 8-way (extend its expectations if it lists characters
   explicitly).

### Tests

9. `test/boundaries.test.ts`: add `fox` to the genre-word regex. `src/`
   must stay free of it.
10. Add behavior tests in `test/behaviors.test.ts`, next to the
    existing garden cases:
    - **by day** (the game starts at 07:00): the fox stays asleep in its
      den for a good while (for example 200 ticks) even with the bunny
      placed in plain view nearby;
    - **at night**: advance or construct the world to night (for example
      step to past 20:00, or use a test helper that sets the clock if one
      exists). The fox leaves the den and prowls. With the bunny placed
      in view, it chases, gets adjacent and the bunny becomes
      `gdn:startled`. There is no `std:hp`;
    - **hiding**: at night, a bunny that steps into a bush makes the fox
      give up the chase;
    - **dawn**: a prowling fox goes back to its den and sleeps once it is
      day.
11. Noise (optional but welcome, in `test/noise.test.ts`): at night, a
    bunny hopping on gravel within earshot draws a prowling fox to
    investigate.
12. The existing garden tests must still pass unchanged, or with
    coordinate-only updates if the map change truly requires them. These
    are the cat/butterfly behaviors, sight, noise, the determinism loops,
    the idle-bunny scenario (it never wins and gets sleepy on day 1) and
    the collecting bot, which **still wins within 1 in-game day on seeds
    1–5**. If the fox makes the bot fail, tune the fox (speed, range or
    den location), not the bot or the victory count.

### Gates

13. `npm run typecheck`, `npm test` and `npm run check -- packs/std
    packs/garden` pass, and the other packs' check gates still pass.
14. If a browser is available, run `npm run smoke` and commit the
    refreshed garden screenshot. Smoke is not a gate. If it cannot run,
    say so in the completion report.

## Out of Scope

- Any engine change: no new activities, expressions or schedule
  features. Day/night gating uses `world.is_day` in status conditions
  and behavior transitions.
- The fox stealing carrots, damaging the bunny or any defeat condition.
- More than one fox, fox cubs, or a fox in the zombie/vampire/town packs.
- Animation and sound.

## Design Notes

- Mirror the cat: `curious` → `meow` → `startled` becomes the fox's own
  chase status → `yip` → (shared) `startled`. Give the fox its **own**
  status rather than widening `curious`, so that the night gate stays
  local to the fox and the cat tests stay untouched.
- The fox's yip noise can also be heard by a nearby cat
  (`heard(self, 1)`). That is fine, and even charming.
- The collecting bot runs from 07:00 for 1 day, so it overlaps one night
  (from 20:00 by default). Keep the fox gentle enough that the bot still
  wins on every seed.
- Check `docs/expressions.md` for `world.is_day` and `has_status`, and
  `docs/packs.md` (Behaviors) for the transition and timeout syntax.

## Agent Notes

- Read `packs/garden/*`, `art/garden.mjs`, `docs/art.md` and the garden
  cases in `test/behaviors.test.ts`, `test/noise.test.ts` and
  `test/scenario.test.ts` first.
- Write the YAML and tests first, with a placeholder sprite, and do the
  pixel art last. Use `node scripts/pixel-art.mjs garden --preview out.png`
  to inspect the drawings, and do not commit the preview.
