---
id: iso-directional-sprites
area: iso
priority: 45
depends_on: [m3-items-loot]
description: Directional sprites in the iso renderer — characters face their movement direction (8-way, derived at render time from the last step, no sim state), map tiles get a 4-way `facing` from the legend, `assets` gain a mirrored per-direction form, placeholders show facing, and both genre packs ship directional art
---

# Directional sprites (facing characters and oriented objects)

## Goal

Make the iso view feel less flat by giving things an orientation, in the
pre-rendered-sprite style of classic isometric games:

- **characters face where they walk**, in 8 directions;
- **objects** (car, coffin, fridge…) are placed in one of 4 orientations
  from the map;
- packs supply one image per direction, and **horizontal mirroring** fills
  in the rest, so 8 directions need only 5 drawings and 4 need only 2.

This is a **renderer and pack-schema** change. The simulation gains no
state: a character's facing is derived from the step data it already
stores, so ticks, snapshots, hashes and determinism do not change. No
engine code may be genre-specific (VISION.md §3.8).

## Facing conventions

Facings are named on the **map compass** (ASCII maps are drawn north-up;
`x` grows east and `y` grows south). On screen, with the 2:1 projection in
`docs/iso.md`:

| Facing | Map step `(dx, dy)` | Screen direction | Mirror partner |
|--------|---------------------|------------------|----------------|
| `n`    | `( 0, −1)`          | up-right         | `w`            |
| `ne`   | `( 1, −1)`          | right            | `sw`           |
| `e`    | `( 1,  0)`          | down-right       | `s`            |
| `se`   | `( 1,  1)`          | down (toward the camera) | itself |
| `s`    | `( 0,  1)`          | down-left        | `e`            |
| `sw`   | `(−1,  1)`          | left             | `ne`           |
| `w`    | `(−1,  0)`          | up-left          | `n`            |
| `nw`   | `(−1, −1)`          | up (away from the camera) | itself |

Mirroring an image horizontally swaps a facing with its partner (a screen
flip swaps `dx` and `dy`). The 4-way set is `n`, `e`, `s`, `w`, which are
the four faces of the tile diamond. The **default facing** is `s`.

## Acceptance Criteria

### Pack schema

1. **Directional assets.** An `assets` entry takes **either** `file` (as
   today) **or** `directions`, never both (load error):

   ```yaml
   assets:
     - id: shambler_img
       anchor: [0.5, 0.92]        # shared by every direction
       directions:
         s:  assets/shambler_s.svg
         se: assets/shambler_se.svg
         e:  assets/shambler_e.svg
         ne: assets/shambler_ne.svg
         nw: { file: assets/shambler_nw.svg, anchor: [0.5, 0.9] }
   ```

   - The keys are facing names from the table above. Each value is either
     a path or `{ file, anchor? }`. The per-direction `anchor` overrides the
     entry's `anchor`. Each file follows the existing `file` rules (it must
     exist in the pack, end in `.svg`/`.png`, near-miss suggestions).
   - If any diagonal key (`ne`, `se`, `sw`, `nw`) is present, the asset is
     **8-way**. Otherwise it is **4-way**.
   - The set must be **complete under mirroring**. A 4-way asset needs one
     of `n`/`w` and one of `e`/`s`. An 8-way asset also needs `se`, `nw`
     and one of `ne`/`sw`. When the set is incomplete, the load error names
     the facings that cannot be produced.
   - A missing facing uses its partner's image, flipped horizontally around
     the anchor spot. A facing listed explicitly is never mirrored.
   - Unknown keys and an empty `directions` mapping are load errors.
2. **Legend `facing`.** Map legend entries accept an optional
   `facing: n | e | s | w` (default `s`). It orients the **tile** of that
   cell. Diagonals and unknown values are load errors. It does not affect
   `spawn` or `player` (spawned entities start with the default facing).
   The facing is stored per map cell in the definition (e.g. a `facings`
   array next to `MapDef.cells`). It is static map data: it is not part of
   world snapshots or hashes, and walkability, opacity, containers, sight
   and the ASCII renderer ignore it.
3. Any `sprite` reference (tiles, archetypes, items) may name a
   directional asset:
   - **tiles** use their cell's facing;
   - **archetypes** use the entity's facing (AC 4);
   - **ground piles** (items) always use `s`.

   An 8-way asset on a tile only ever shows `n`/`e`/`s`/`w`.

### Facing and direction selection

4. **Entity facing is derived, not stored.** A pure core function (e.g.
   `facingOf(entity)` in `src/core/sim/motion.ts`) returns the facing of
   the entity's current or last step, `sign(x − fromX), sign(y − fromY)`.
   It returns `s` when the entity has never moved (`x == fromX`,
   `y == fromY`). An entity that stops keeps facing the way it last
   stepped. A blocked step changes nothing. The function adds no field to
   `Entity` and is not used by the simulation.
5. **Snapping to 4 directions.** When an 8-way facing must be shown with a
   4-way asset, the diagonal snaps to one of its two neighbours: the
   neighbour shown last for that sprite (if it is one of the two),
   otherwise the clockwise one (`ne→e`, `se→s`, `sw→w`, `nw→n`).
   Remembering the last neighbour is renderer state only. A pure function
   implements the rule, returning `{ image, mirrored }` from (asset
   directions, facing, previous shown facing), and is unit-tested for
   every facing on both kinds of asset.
6. **The scene updates facing every frame.** Its texture, anchor and
   mirroring change only when the resolved direction changes, not every
   frame. An entity's facing turns when its step starts showing, at the
   same moment interpolation starts. Depth sorting, culling and day/night
   tint behave exactly as before for directional and mirrored sprites.

### Placeholders

7. **Entity placeholders show facing.** The generated marker gets a facing
   cue: a wedge on its drop shadow pointing in the facing's screen
   direction, readable at zoom 1. Textures are still baked at most once
   per (archetype, facing), lazily. The glyph and colours are unchanged.
8. **Tile placeholders show facing when it is set.** A cell whose legend
   sets `facing` explicitly draws a front-edge cue (a darker stripe along
   the diamond edge, on the top face for raised blocks) on the side it
   faces. Cells without an explicit `facing` look exactly as they do today.

### Packs (two-genre rule)

9. **Zombie:** the `shambler` asset becomes 8-way (5 hand-written SVGs in
   the style of `shambler.svg`, each clearly showing the direction: face
   and eyes visible from the front, back of the head from behind, profile
   from the sides). The `car` asset becomes 4-way (2 SVGs). `maps/town.yaml`
   places cars in at least two different facings. At least one other
   oriented container tile with a placeholder (e.g. a fridge against a
   wall) gets a `facing`.
10. **Vampire:** the `vampire` asset becomes 8-way (5 SVGs) and the
    `coffin` asset 4-way (2 SVGs). `maps/mansion.yaml` places coffins in at
    least two different facings, plus at least one oriented placeholder
    tile (e.g. a bookshelf against a wall).
11. Archetypes without a sprite (survivor, crawler, bat) keep the
    placeholder from AC 7. `npm run check` passes for both genres.

### Docs and tests

12. `docs/packs.md` documents `directions` (assets section), legend
    `facing` (maps section) and the facing table. `docs/iso.md` documents
    facing derivation, mirroring, snapping and the placeholder cues.
    VISION.md §5/§7 records the decision in a short entry (directional
    sprites, render-derived facing, no real-time 3D).
13. Tests (`node:test`):
    - loader: valid 4-way and 8-way assets, `file` + `directions` together,
      incomplete sets (the error names the missing facings), unknown keys,
      missing files, per-direction anchors, legend `facing` valid/invalid,
      and the per-cell facing array;
    - `facingOf` for all 8 step directions plus the never-moved case, and
      facing persisting after the step completes;
    - the direction-resolution function (AC 5) across facings and asset
      kinds, including mirroring and snap stickiness;
    - the existing simulation determinism/hash tests still pass unchanged.
14. `npm run smoke` passes for both genres and refreshes the screenshots
    in `docs/screens/`. The screenshots visibly show oriented cars/coffins
    and a directional character. The typecheck, test and build gates pass.

## Out of Scope

- Walk/idle **animation** frames and spritesheets (a natural follow-up on
  top of this).
- Real-time 3D (three.js, Pixi 3D) or any change to the projection.
- Facing as **simulation state**: turning without moving, facing used by
  sight/actions/behaviors, and an initial facing for spawns or the player.
  This can be promoted later (e.g. M5, when actions need to face a target).
- **Multi-tile** objects (a car spanning 2 cells) and rotating objects at
  runtime.
- Facing in the ASCII renderer.
- Changes to depth sorting or cutaway walls.

## Design Notes

- **Where the code goes:** `src/core/sim/motion.ts` (`facingOf`, next to
  `renderPosition`); `src/core/load/load.ts` (`asset`, the map legend);
  `src/core/definition.ts` (`AssetDef` gains a per-facing image table,
  `MapDef` a facing per cell); `src/iso/textures.ts` (per-direction
  textures, placeholder cues); `src/iso/scene.ts` (choosing and swapping
  textures); `src/web/packs.ts` + `main.ts` (URLs per direction file).
  Put the facing table and the mirroring/snap logic in one small pure
  module (e.g. `src/iso/facing.ts`, or core if the loader needs the names)
  so the loader, textures and scene share it.
- **`AssetDef` shape.** Normalize at load time so the renderer never
  re-derives anything. For example: `images: { file, anchor }[]` (the
  distinct files) plus `byFacing: { image: number; mirrored: boolean }[8]`.
  A single-file asset is the special case with one image, used unmirrored
  for every facing. Then `loadAssetTextures` loads one texture per *image*
  instead of one per asset, and `assetUrls` resolves one URL per image.
- **Mirroring in Pixi:** `sprite.scale.x = -1` with the anchor unchanged
  flips around the anchor spot, which is what AC 1 requires. Remember to
  reset `scale.x` when switching back to an unmirrored image.
- **Facing from steps:** `World.move` already sets `fromX/fromY` to the
  pre-step cell and leaves them there after the step completes, so the
  last direction persists without new state. Check `stepTick` to time the
  turn (AC 6). Before the step starts showing, the previous step's facing
  is no longer recoverable, so turning as the step starts showing is the
  simple rule.
- Directional SVGs can be small (32×48 like `shambler.svg`). The goal is
  legible direction, not art quality. Draw the mirror-partner-free facings
  (`se`, `nw`) carefully, because they are never flipped.

## Agent Notes

- Read `docs/iso.md`, the `assets` and `maps` sections of `docs/packs.md`,
  `src/iso/textures.ts` and `src/iso/scene.ts` first.
- The engine guard test (`test/boundaries.test.ts`) scans `src/` for genre
  and stdpack words. Keep example names like "car" or "coffin" out of
  `src/` comments.
- Do the loader + `AssetDef` normalization and its tests first, then the
  pure facing/resolution functions, then the renderer, then the pack art
  and maps, and the smoke screenshots last.
