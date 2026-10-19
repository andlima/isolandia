---
id: walk-cycle
area: iso
priority: 40
depends_on: []
description: "Walk animation for characters: assets gain `animations: { walk: { <facing>: [frames…] } }` next to `directions`, normalized by the loader under the same mirroring rules; the iso scene shows a walk frame chosen from the step progress while an entity is mid-step (a cycle spans two steps, so feet stay locked to the ground) and the standing image otherwise; the shared humanoid body gets a 4-frame cycle in all five drawn facings, so every human character in std, town, zombie, vampire, noir and western walks. Sim, saves, hashes and ASCII untouched."
---

# Walk cycle for the humanoid characters

## Goal

Characters today slide between tiles as a single still drawing per facing.
This task gives them a **walk animation**: while an entity is mid-step the
renderer shows a frame of a walk cycle, and when it stands it shows the
drawing it shows today. It is the first, smallest slice of the M10 "frames
and gaits" item in `VISION.md` §7: the **asset schema** for frames and the
**pose choice** in the renderer, without gaits (no `run`/`sneak`, no change
to speeds or noise) and without idle or activity poses.

Three facts make this cheap. The renderer already interpolates each step
(`renderPosition` in `src/core/sim/motion.ts`) and already swaps the sprite
texture when the facing changes (`src/iso/scene.ts`), so the step progress
is the animation clock and the swap path exists. Hit masks are per texture
(`src/iso/textures.ts`), so frames pick correctly for free. And all nine
human characters across six packs are drawn from **one body grid**
(`humanoid()` in `art/characters.mjs`), so a frame added to the body
reaches every one of them in one regeneration.

Engine code stays genre-agnostic (`VISION.md` §3): the loader and renderer
learn a generic `animations` field; which characters animate is pack data.

## Acceptance Criteria

### Asset schema (`packs.md` → `assets`)

1. **New field `animations`.** An asset entry accepts an optional
   `animations` mapping. In this task its only allowed key is **`walk`**;
   any other key is a load error naming the key and saying `walk` is the
   only animation known. `animations: {}` is a load error ("must list at
   least one animation").
2. **`walk` is a facing → frame-list mapping**, e.g.
   ```yaml
   assets:
     - id: humanoid_img
       anchor: [0.5, 0.92]
       directions:
         s:  assets/humanoid_s.svg
         se: assets/humanoid_se.svg
         ne: assets/humanoid_ne.svg
         w:  assets/humanoid_w.svg
         nw: assets/humanoid_nw.svg
       animations:
         walk:
           s:  [assets/humanoid_s_walk1.svg, assets/humanoid_s_walk2.svg, assets/humanoid_s_walk3.svg, assets/humanoid_s_walk4.svg]
           se: [assets/humanoid_se_walk1.svg, …]
           ne: [assets/humanoid_ne_walk1.svg, …]
           w:  [assets/humanoid_w_walk1.svg, …]
           nw: [assets/humanoid_nw_walk1.svg, …]
   ```
   Each value is a non-empty list of paths. Every path follows the existing
   file rules (`.svg` or `.png`, `@Nx` allowed, must exist in the pack,
   near-miss suggestions on a miss). A frame has **no anchor of its own**:
   it uses the anchor of its facing (the direction's `{ anchor }` if given,
   else the entry's).
3. **Validation**, each a load error with the path to the offending node:
   - `animations` on an asset without `directions` (a `file` asset): "only
     a directional asset can have animations".
   - The set of facing keys under `walk` must **equal** the set of keys
     under `directions`: a facing listed in one and not the other is
     reported by name (both directions: a walk facing with no standing
     image, and a standing facing with no walk frames). Unknown facing keys
     get the same near-miss message as `directions`.
   - Every facing's list has the **same length**, and that length is
     **even and ≥ 2** (a cycle is two steps, see criterion 7). The message
     says which facing differs, or that the count must be even.
   - A value that is not a list of strings: "walk frames for '<facing>'
     must be a list of file paths".
4. **Normalized definition.** `AssetDef` (`src/core/definition.ts`) keeps
   `images`, `ways` and `byFacing` exactly as today for the standing
   drawings, and gains a `walk` table: per facing (indexed like `FACINGS`),
   the list of **image indices** of its frames, or `null` when the asset has
   no walk animation (`walk` is `null` on the asset in that case). Frames
   are appended to `images` (deduplicated by file and anchor as today), and
   a facing that is **mirrored** in `byFacing` uses its partner's frame
   indices with the same `mirrored` flag, so the same `facingTable` rule
   produces the frame table. `assetUrls` (`src/web/packs.ts`) and the
   `TextureBank` constructor need no change beyond seeing more images.
   Overrides (`override: true`) replace `animations` whole, as any mapping
   field; `check --overrides` lists it like any other field.
5. **Everything else ignores it.** The ASCII shell, `check`, the sim, saves
   and the world hash are unchanged; `test/save.test.ts` and the round-trip
   helpers pass untouched, and no save version bump.

### Renderer (`src/iso`)

6. **A pure pose function**, in `src/core` next to `renderPosition` (or in
   `src/iso`, but importable by Node tests without Pixi), e.g.
   `walkFrame(progress, stride, frames)`: given the step progress
   `p ∈ [0, 1]` (the same clamp `renderPosition` computes, exposed as a
   function so both use one formula), the entity's **stride parity** (0 or
   1) and the frame count `n`, it returns `null` when `p ≥ 1` (standing),
   else `floor((stride + p) × n / 2)` clamped to `[0, n − 1]`. So with 4
   frames, the first step of a pair shows frames 0 and 1 and the second
   shows 2 and 3.
7. **A cycle spans two steps.** The scene keeps per entity sprite the last
   `stepTick` it saw and a stride parity; when `stepTick` changes (a new
   step began) the parity flips. Walking continuously, an entity thus plays
   the full cycle every two tiles (one footfall per tile, roughly a human
   stride), and a frame lasts `ticks_per_step × 100 ms / (n / 2)`: 100 ms
   per frame for the default 2-tick step, 300 ms for the crawler's 6. Feet
   stay locked to the ground because the clock is the step itself; speed
   changes (`pace`) and pauses are reflected automatically through `alpha`.
8. **Pose swap.** The scene's per-entity record extends its `shown` facing
   to a **pose** `(shown facing, frame | standing)`. Each frame it computes
   the pose and swaps texture, anchor and mirroring only when the pose
   changes (as it does today for the facing), refreshing the pick candidate
   (`place`) so hover and click use the drawn frame's mask. The standing
   image is the `directions` image resolved exactly as today, including the
   4-way snapping stickiness (`prev`). An asset **without** `walk` shows
   the standing image mid-step too (today's behaviour, byte for byte).
   Placeholder markers (archetypes with no sprite) are unchanged.
9. **`TextureBank.archetype`** (or a sibling `archetypeFrame`) can return
   the texture of `(asset, facing, frame)`; frames of a mirrored facing come
   out mirrored. The hit mask of a frame texture is built in the
   constructor loop like every other image.
10. **No per-frame cost when nothing changes.** Computing the pose is a few
    arithmetic ops per visible entity; no allocation per frame per entity
    (reuse the record's fields). `npm run bench:sim` is unaffected (sim
    unchanged); the browser bench cannot run in the sandbox, so the
    implementing agent states that rather than claiming numbers.

### Art (`art/`, `packs/*/assets/`)

11. **The shared humanoid body gets a 4-frame walk cycle** in each of the
    five drawn facings (`s`, `se`, `ne`, `w`, `nw`), in `art/characters.mjs`:
    `humanoid(facing, look, frame = null)` where `frame` is `null`
    (standing, today's drawing, unchanged pixel for pixel) or `0..3`.
    Frames: **contact** (one leg forward, the other back, arms swinging
    opposite), **passing** (legs together, the body lifted one art pixel
    or not at all), contact with the other leg, passing. Frame 0 and 2 are
    the two contacts. The front (`se`) and back (`nw`) views show the
    stride as feet alternating one art pixel lower/higher and a slight
    leg separation; the profile (`ne`) shows the clearest forward/back
    split; the three-quarter views (`s`, `w`) in between. Guidance:
    - Frames differ from the standing drawing only in the **leg and shoe
      rows (17–22)** and the **arm columns** of the torso rows (12–16); the
      head, hair and torso body are the standing rows. Feet never go
      below row 22 (the ground); the drop shadow is unchanged.
    - `armsForward` (the shambler) still replaces the arms in every frame
      (the `ARMS_FORWARD` overlay applies after the frame's body rows); the
      legs animate the same.
    - `under` and `over` overlays per facing apply to every frame as to
      the standing drawing. Where a pack's `over` rows cover leg rows (a
      coat, boots), the frame's legs show through only where the overlay is
      transparent; if that reads badly for a character, the overlay may be
      given per frame (`over: { s: {…}, …, frames: [ … ] }` or similar) at
      the implementer's discretion. Document the choice in `art.md`.
    - 16×24 art pixels, the pack's palette only, 1 px outline, the same
      `finish()`; `node scripts/pixel-art.mjs <pack> --only 'humanoid_s' --preview …`
      shows the frames beside the standing pose for eyeballing.
12. **Every humanoid character ships frames.** `images()` in `art/std.mjs`,
    `art/town.mjs`, `art/zombie.mjs` (shambler only), `art/vampire.mjs`
    (vampire only), `art/noir.mjs` and `art/western.mjs` emit, per
    character and drawn facing, `<name>_<facing>_walk<k>.svg` for `k` in
    1..4, and the packs' `assets.yaml` list them under `animations.walk`.
    That is: `std:humanoid_img`, `town:resident_img`, `zombie:shambler_img`,
    `vamp:vampire_img`, the six noir people and the western cast. The
    **crawler, bat, bunny, cat, fox and butterfly stay single drawings**
    (no `animations`). The committed SVGs are regenerated by
    `node scripts/pixel-art.mjs` and nothing is edited by hand.
13. **Art test** (`test/art.test.ts`): every walk frame of a shipped
    archetype is 32×48 with the character anchor, uses the pack's palette
    (the 32-colour cap and the SVG rules apply to frames as to any SVG),
    and the characters listed in criterion 12 **have** a `walk` table while
    the critters, crawler and bat do not.

### Tests, docs, vision

14. **Loader tests** (`test/facing.test.ts` or a new `test/animations.test.ts`):
    the happy path (frames appended to `images`, mirrored facings share
    their partner's frame indices, per-direction anchors carried to frames,
    frame files deduplicated) and every error in criterion 3 and 1, each
    asserting file, path and message as the existing `directions` tests do.
15. **Pose tests**: `walkFrame` at `p = 0`, just under each boundary,
    `p = 1` (standing), both parities, `n = 2` and `n = 4`; the progress
    helper agrees with `renderPosition` (same clamp, same `stepTick`
    semantics, including the `t ≤ 0` case right after a step is issued).
16. **`npm test`, `npm run typecheck`, `npm run check` (every shipped
    stack) pass.** The `?bench=` and `npm run smoke` browser runs are
    reported as not runnable in the sandbox if that is still the case, not
    as passing.
17. **Docs.** `docs/packs.md` (`assets`): the `animations` row in the
    field table, the `walk` rules (facing set equals `directions`, even
    equal counts, frame anchor, errors) and an example; drop "no
    spritesheets or animation yet". `docs/art.md`: a "Walk frames"
    subsection (the four frames, the row budget, naming, the generator
    signature, the overlay decision) and the per-kind table gains the
    frame size. `docs/iso.md` (facing/sprite swap bullet): the pose is
    `(facing, frame)`, the cycle-per-two-steps rule and the stride parity
    as renderer-only state. `VISION.md` §7, the M10 "frames and gaits"
    bullet: a short note that walk frames landed as task `walk-cycle`
    (schema `animations.walk`, cycle over two steps), and that gaits,
    `run`/`sneak`, idle and activity poses remain for `m10-anim-gaits`.

## Out of Scope

- Gaits: `run`, `sneak`, archetype `gaits`, speed or footstep-noise
  changes, a held key to toggle them. The sim does not change at all.
- Idle, activity and turning poses; animation stepped from the wall clock;
  ambient (tile) animations; a spritesheet form of `animations`.
- Frames for the crawler, bat, bunny, cat, fox and butterfly (the schema
  allows them; this task does not draw them).
- Any new `@Nx` PNG frames (allowed by the file rules, none shipped).
- Save format, world hash, ASCII rendering, `check` output changes.
- A browser-measured fps number (sandbox has no Chromium).

## Design Notes

- **Where the clock comes from.** `renderPosition` computes
  `t = (tick − stepTick + alpha) / ticksPerStep`, clamped to `[0, 1]`.
  Right after a step is issued `stepTick = tick + 1`, so during the next
  rendered tick `p = alpha / ticksPerStep` and sweeps to 1 exactly when the
  next step may begin; a walking entity therefore never dwells at `p = 1`
  and there is no standing-frame flicker between steps. Expose that clamp
  as `stepProgress(e, tick, alpha)` and use it in both places.
- **Why a cycle over two steps.** One footfall per tile matches a human
  stride on the ~1 m tile and gives 100 ms per frame at the default speed;
  a full cycle per tile would run at 20 fps and look like scurrying. The
  parity is renderer state (like the snapping `prev`), never saved.
- **Frame table shape.** Keep `byFacing` as is so every existing caller
  (`fromAsset`, `edgeFromAsset`, tile textures, the art tests) is
  untouched; add `walk: readonly (readonly number[] | null)[] | null` to
  `AssetDef`, filled through the same `facingTable` pass (map each listed
  facing to its frame image indices; a mirrored facing copies its
  partner's list). `resolveFacing` already returns the shown facing and
  `mirrored`; the frame texture is `assets[index][walk[shown][frame]]`.
- **Scene record.** `{ entity, sprite, pick, floor, bucket, facing, shown }`
  gains `frame: number | -1`, `stepTick: number`, `stride: 0 | 1`. The
  swap condition becomes "shown facing or frame changed".
- **Generator.** `BODY[facing]` is `[...TOP, head rows, ...TORSO, ...LEGS, 2 blank]`.
  Add per-facing `WALK[facing][k]` replacement rows for the leg block
  (rows 17–22) and, where arms swing, the arm columns of `TORSO`, composed
  the same way `ARMS_FORWARD` is pasted with `rowsAt`. The `s` and `ne`
  bodies already have their own leg rows (not `LEGS`); treat each facing's
  frames individually. Keep the standing drawing identical: the art test
  and the committed SVG diffs for `*_s.svg` etc. should be empty.
- **Overrides.** `animations` is a top-level asset field, so a mod can
  patch it whole (`override: true`) or clear it (`animations: null`) under
  the existing shallow-merge rule; nothing new to implement there.

## Agent Notes

- Read first: `AGENTS.md`, this spec, `specs/iso-directional-sprites.md`
  and `specs/tasks/turn-before-move.md` (how facing and mirroring were
  decided), `src/core/facing.ts`, `src/core/load/load.ts` (`asset()`),
  `src/core/sim/motion.ts`, `src/iso/textures.ts`, `src/iso/scene.ts`
  (the entity loop in `update`), `art/characters.mjs`, `docs/art.md`
  (facings, the generator) and `docs/packs.md` (`assets`).
- Order: loader + definition + tests → pose function + tests → scene and
  texture bank → art generator for one character (`std` humanoid), preview
  it, then the other packs → art test → docs and VISION.
- Regenerate art with `node scripts/pixel-art.mjs` (every pack) and
  confirm with `git diff --stat packs/*/assets` that only `*_walk*.svg`
  files are added and no standing drawing changed.
- `node scripts/pixel-art.mjs std --only 'humanoid_(s|ne)_' --preview "$TMPDIR/walk.png"`
  writes a contact sheet without a browser; look at it (the Read tool shows
  PNGs) to check the stride reads before drawing the rest. Do not commit
  previews.
- Chromium cannot start in the sandboxed shell (socket restrictions), so
  `npm run smoke` and `npm run bench` will fail for that reason; say so in
  the report instead of retrying.
- `test/art.test.ts` loads every shipped stack; the `FURNITURE` list and
  the 8-way check for archetypes stay valid since frames do not change
  `ways`.
- Frontmatter note: the `description` is quoted because it contains `: `.
