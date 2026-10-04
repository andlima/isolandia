---
id: pack-pixel-art
area: iso
priority: 40
depends_on: []
description: Pixel-art sprites for every tile, archetype and item in the std, zombie and vampire packs (replacing all generated placeholders and the 6 existing flat SVGs), on a 2-px art-pixel grid with per-pack palettes, a style guide in docs/art.md, a test that enforces full coverage and the pixel-art format, and SVG assets rasterized at a resolution that stays sharp at max zoom
---

# Pixel art for the std, zombie and vampire packs

## Goal

The iso view of both games is mostly generated colour placeholders. Only
grass, car, shambler, carpet, coffin and vampire have hand-drawn SVGs, and
those use a simple flat vector style. This task gives **every** entity
that both playable stacks show a **pixel-art** sprite:
`std,std-needs,zombie` and `std,vampire`. That covers every tile, archetype
and item ground pile. It also makes those sprites stay crisp when zoomed.

This is **content plus one small, genre-neutral renderer tweak**. No sim,
schema or loader changes. No engine code may be genre-specific
(VISION.md §3.8).

## Coverage (what gets art)

| Pack | Tiles | Archetypes | Items |
|------|-------|-----------|-------|
| `std` | floor, wall, door | humanoid | — |
| `zombie` | road, grass, car, glass, bed, fridge, cupboard, cabinet, dresser, crate | survivor, shambler, crawler | canned_beans, crackers, water_bottle, soda, coffee, bandage, alarm_clock |
| `vampire` | carpet, creaky, sunbeam, crypt, font, coffin, window, bookshelf, chest, wine_rack | vampire, bat | blood_vial, cloak |

`std-needs` defines no tiles, archetypes or items, so it gets no art. The
`std` art must be **genre-neutral**: plain stone or plaster wall, plain
floor, wooden door and an everyday person. It serves both genres, so it
must not look zombie-ish or gothic.

## Acceptance Criteria

### Coverage and directionality

1. Every tile, archetype and item listed above has a `sprite` that points
   to an asset in its own pack's `assets.yaml`. The `std` pack gains an
   `assets.yaml` and an `assets/` directory. After this task no entry in
   those packs uses a generated placeholder.
2. **Characters are 8-way** (5 drawings: `s`, `se`, `ne`, `w`, `nw`; the
   rest are mirrored). This covers humanoid, survivor, shambler, crawler,
   vampire and bat. Each facing must be readable as that facing: the
   face and eyes point the right way, a `nw` back view shows no face, and
   so on. The crawler is visibly low and dragging itself. The bat is a
   small flying creature, drawn hovering above its shadow.
3. **Oriented furniture is 4-way** (2 drawings: `s` and `w`). This covers
   car, bed, fridge, cupboard, cabinet, dresser, coffin, bookshelf, chest
   and wine_rack. The front of the object (doors, drawers, the coffin's
   head end, shelves, headlights) faces the drawn direction. This matters
   because the maps already place `fridge` with `facing: s`/`n`,
   `bookshelf` with `facing: s`, and `car`/`coffin` with `e`/`w`/`s`.
4. Every other sprite is a single `file`: flat floors (floor, road, grass,
   glass, carpet, creaky, sunbeam, crypt, font), wall, door, window, crate
   and every item.

### Pixel-art format (enforced by a test)

5. Every image under `packs/*/assets/` (existing and new) is an SVG drawn
   on a **2 px art-pixel grid**:
   - the root `<svg>` has `shape-rendering="crispEdges"`, and its
     `width`/`height` are even integers equal to its `viewBox` size;
   - drawable elements are only `<rect>` elements with even-integer `x`,
     `y`, `width` and `height` (`<g>` for grouping is allowed). There are
     no paths, polygons, circles, ellipses, strokes, gradients, filters or
     transforms;
   - fills are `#rrggbb` colours. `opacity`/`fill-opacity` is allowed only
     for drop shadows and glass or light effects.
6. **Image sizes and anchors** keep the existing conventions
   (docs/packs.md, docs/iso.md):
   - flat tiles are 64×32 (32×16 art pixels) with the default anchor, and
     their diamond edges are the classic 2:1 pixel staircase;
   - raised tiles (the non-walkable ones: wall, window, furniture, car,
     coffin, crate) and the door, which is walkable but drawn as a door
     in a wall-height frame, are 64×64 blocks with the default anchor, so the top face sits 32 px above the
     ground diamond. Taller art is fine only if it still lines up with the
     diamond at the bottom;
   - characters are about 32×48 with a pixel drop shadow and
     `anchor: [0.5, 0.92]` (or an anchor tuned so the feet sit on the
     shadow);
   - item ground piles are small (at most 32×32), centred on the anchor,
     and readable as "a thing lying on the floor".
7. **Palettes.** Each pack uses one limited palette, at most 32 distinct
   fill colours across all its images. The palette is listed in
   `docs/art.md`. Light comes from the **top-left**: top faces are
   lightest, the screen-left face is mid-tone and the screen-right face is
   darkest, consistently across all blocks in all packs.
8. A new test (e.g. `test/art.test.ts`) enforces this:
   - every tile, archetype and item of the stacks `std,std-needs,zombie`
     and `std,vampire` (loaded from the real `packs/`) has a non-null
     `sprite`;
   - the archetype sprites above are 8-way and the furniture sprites are
     4-way;
   - every `packs/*/assets/*.svg` satisfies criterion 5;
   - each pack's distinct fill colours number at most 32.

   It parses SVGs with a small regex/XML scan, so no new dependency is
   needed.

### Renderer

9. SVG pack assets are rasterized at a resolution of at least `MAX_ZOOM`
   instead of the current fixed `2`, so pixel edges stay sharp at 3×
   zoom. Use a named constant next to `BAKE_RESOLUTION` in
   `src/iso/textures.ts` (or reuse it if it is already ≥ `MAX_ZOOM`).
   PNG loading does not change. This tweak is generic and not tied to any
   pack.

### Docs and housekeeping

10. Add a new `docs/art.md` style guide covering: the art-pixel grid, the
    image sizes and anchors per kind, light direction and face shading,
    each pack's palette (hex list with names), and how facings and
    mirroring apply to drawings (point to the facing table in
    docs/packs.md rather than copying it). Link it from docs/packs.md's
    `assets` section.
11. Update the `assets.yaml` header comments, which now say "Hand-written
    placeholder art", to describe the pixel-art convention. Also update
    any docs/packs.md example that shows SVG dimensions or anchors which
    no longer match.
12. Verify gates pass: `npm run typecheck`, `npm test`,
    `npm run check -- packs/std packs/std-needs packs/zombie` and
    `npm run check -- packs/std packs/vampire`.
13. If a browser is available, run `npm run smoke` and commit the
    refreshed `docs/screens/` screenshots. Smoke is not a gate. If it
    cannot run, say so in the completion report.

## Out of Scope

- Animation, walk cycles and spritesheets (still one image per facing).
- Wall autotiling or connected walls, and door orientation by
  neighbouring walls. Doors have no legend `facing`, so they stay a
  single image.
- Any sim, schema, loader or ASCII renderer change. New legend `facing`
  values in the maps are allowed only where furniture visibly faces a
  wall the wrong way with the new art; keep such edits minimal.
- PNG assets, texture atlases and nearest-neighbour scale modes.
- Changing tile or archetype `color`/`glyph`. Colours still drive the
  ASCII view and the HUD.
- Art for packs other than std, zombie and vampire.

## Design Notes

- Sprite lookup and fallbacks live in `src/iso/textures.ts` (`tile`,
  `archetype`, `item`, `loadAssetTextures`). `raised` defaults to
  `!walkable` (`src/core/load/load.ts`), which decides block vs diamond
  for placeholders. Match that with real art.
- The day/night tint (`src/iso/tint.ts`) multiplies sprite colours, so
  keep palettes mid-to-light enough that the zombie pack's night stays
  readable.
- Ids are namespaced, so asset ids in `std` (e.g. `wall_img`) cannot clash
  with genre packs.
- Vite bundles pack files via `import.meta.glob` (`src/web/packs.ts`), so
  new files under `packs/std/assets/` are picked up automatically. Check
  that `test/web.test.ts` expectations still hold.

## Agent Notes

- About 75 images is a lot to write by hand. A small **generator** is
  recommended: keep each drawing as a text pixel grid (one character per
  art pixel, with a per-pack palette key) and have a script emit the
  `<rect>` SVGs, merging runs of the same colour along each row. If you do
  this, keep the sources and script **outside `packs/`** (e.g.
  `art/<pack>/*.txt` and `scripts/pixel-art.mjs`), commit both the
  sources and the generated SVGs, and mention the script in
  `docs/art.md`. The generated SVGs must still pass criterion 5.
- Draw the `s` facing first, then derive `w`, `se`, `ne` and `nw`. Check
  the mirror partners in the docs/packs.md facing table: `e` is the
  mirror of `s` and `n` the mirror of `w`, so for example a side-facing
  `w` must look right when flipped to become `n`.
- Read `docs/iso.md` and the "Facing conventions" section of
  `specs/iso-directional-sprites.md` before drawing.
