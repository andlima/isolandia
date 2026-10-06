# Pixel art

Every image in the shipped packs (`std`, `zombie`, `vampire`, `garden`) is pixel art,
drawn by a small generator and stored as SVG. This guide gives the
conventions. Asset fields, anchors and the facing table are documented in
[packs.md](packs.md#assets); projection and depth sorting are in
[iso.md](iso.md). `test/art.test.ts` enforces the rules marked **(tested)**.

## The art-pixel grid

- One **art pixel** is 2×2 screen px at zoom 1. The 64×32 tile diamond is
  32×16 art pixels.
- An SVG holds only `<rect>` elements (`<g>` for grouping is allowed) with
  even-integer `x`, `y`, `width` and `height`. There are no paths,
  polygons, circles, strokes, gradients, filters or transforms. The root
  `<svg>` has `shape-rendering="crispEdges"` and an even `width`/`height`
  equal to its `viewBox` size. **(tested)**
- Fills are `#rrggbb`. `fill-opacity` is used only for drop shadows and
  glass or light effects. **(tested:** fills are `#rrggbb`, opacities are in
  `(0, 1]`**)**
- Iso edges are the classic 2:1 staircase: two art pixels across per one
  down.
- The renderer rasterizes SVG assets at `MAX_ZOOM` resolution
  (`SVG_RESOLUTION` in `src/iso/textures.ts`), so the pixels stay sharp up
  to the 3× zoom.

## Sizes and anchors per kind **(tested)**

| Kind | Image | Anchor | Notes |
|------|-------|--------|-------|
| Flat tile (floor, road, carpet…) | 64×32 | `[0.5, 1]` (default) | Fills the diamond exactly; neighbours tile without gaps |
| Raised tile (wall, door, window, furniture, car, coffin, crate) | 64×64 | `[0.5, 1]` (default) | A block whose top face sits 32 px above the ground diamond. Taller art is fine if its bottom still lines up with the diamond |
| Character | 32×48 | `[0.5, 0.92]` | Feet on a pixel drop shadow at the tile's ground centre |
| Item ground pile | ≤ 32×32 | `[0.5, 0.5]` | Small, centred on the ground centre, with a small shadow |

A raised tile replaces the ground under it, so a block's art covers its
whole diamond: furniture stands on a full-cell base (the coffin's stone
bier, the bed frame). The door, bed and crate are walkable but set
`raised: true` so that they are drawn as blocks and depth-sorted with
entities.

## Light and shading

Light comes from the **top-left**. On every block the **top face is
lightest**, the **screen-left (south) face mid-tone** and the
**screen-right (east) face darkest**. Each material has a ramp in the
palette (`*_hi`, base, `*_lo`) for this. Characters and items get a 1 art
pixel dark `outline`, and a few shaded pixels on their right side.

The day/night tint multiplies sprite colours (see
[iso.md](iso.md#daynight-tint)), so keep palettes mid-to-light where a
pack has dark nights.

## Facings and mirroring

Characters are **8-way** with five drawings (`s`, `se`, `ne`, `w`, `nw`);
oriented furniture is **4-way** with two (`s`, `w`). The other facings are
the horizontal mirrors of their partners. See the facing table in
[packs.md](packs.md#assets). In practice:

- `se` faces the camera (front view) and `nw` faces away (back view: no
  face). `s` is a three-quarter front view looking screen-left, `w` a
  three-quarter back view looking up-left, and `ne` a profile looking
  screen-right. The mirrors give `e`, `n` and `sw`.
- Furniture drawn `s` has its front (doors, drawers, shelves, headlights,
  the coffin's head end) on the screen-left face. Drawn `w`, the front is
  on the hidden up-left face, so the visible faces show the object's side
  and back (a fridge's coils, a car's tail lights). Mirroring `w` gives
  `n` and mirroring `s` gives `e`.
- Because a mirror flips the light, mirrored blocks are lit from the
  top-right. That is accepted.
- Stairs and ladders (`std:stairs`, `vamp:ladder`) are 4-way blocks that
  **rise toward their facing**: drawn `w`, the risers face the camera on
  the screen-right face; drawn `s`, the staircase climbs toward the
  screen-left face, so its stepped profile shows on the right. Their block
  is a full wall height, the height of one floor.

## The generator

The SVGs are generated. Do not edit them by hand. Instead:

```sh
node scripts/pixel-art.mjs                    # regenerate every pack
node scripts/pixel-art.mjs zombie --preview /tmp/zombie.png              # plus an enlarged contact sheet
node scripts/pixel-art.mjs vampire --only 'bat_' --preview /tmp/bats.png  # just some images, larger
```

- `art/lib.mjs` is a tiny raster library. A canvas holds palette names per
  art pixel. Iso boxes are shaded through the inverse projection, so a
  face shader gets its own coordinates (`px()` turns them into art-pixel
  rows and columns). There are also text grids, outlines and pixel
  shadows, and the SVG and PNG writers. Each SVG row is written as runs
  of one colour, and identical runs on following rows are merged.
- `art/characters.mjs` holds the shared humanoid body (one text grid per
  drawn facing), the crawler, the bat and the item-pile helper.
- `art/<pack>.mjs` holds a pack's palette and its drawings. Its `images()`
  returns the files to write to `packs/<pack>/assets/`.

When you add a drawing, use only names from the pack's palette. Keep each
pack at **32 colours or fewer** **(tested)**. Then reference the file in
the pack's `assets.yaml`.

## Palettes

### `std` (22 colours)

| Name | Colour | Name | Colour |
|------|--------|------|--------|
| `outline` | `#2a2420` | `wood_lo` | `#744c26` |
| `shadow` | `#000000` at 0.3 opacity | `wood_dk` | `#553619` |
| `floor_hi` | `#c4bcac` | `brass` | `#e0c060` |
| `floor` | `#b0a898` | `skin` | `#eab48c` |
| `floor_lo` | `#968e7f` | `skin_lo` | `#c88c68` |
| `stone_hi` | `#e4ded2` | `hair` | `#5a3c24` |
| `stone` | `#c6beae` | `shirt` | `#5f86b8` |
| `stone_lo` | `#9c9484` | `shirt_lo` | `#46689a` |
| `mortar` | `#857d6e` | `pants` | `#55576a` |
| `wood_hi` | `#c08a4e` | `pants_lo` | `#3e404e` |
| `wood` | `#9c6a38` | `shoes` | `#4a3a2e` |

### `zombie` (32 colours)

| Name | Colour | Name | Colour |
|------|--------|------|--------|
| `outline` | `#1e1c20` | `white_lo` | `#a6a8b4` |
| `shadow` | `#000000` at 0.3 opacity | `wood_hi` | `#c89a5a` |
| `asphalt_hi` | `#76767a` | `wood` | `#a07242` |
| `asphalt` | `#606064` | `wood_lo` | `#765232` |
| `asphalt_lo` | `#4c4c50` | `wood_dk` | `#523a22` |
| `paint` | `#d8c050` | `skin` | `#e0b088` |
| `grass_hi` | `#74b052` | `skin_lo` | `#b88464` |
| `grass` | `#55923c` | `zskin` | `#9cc47a` |
| `grass_lo` | `#3e722c` | `zskin_lo` | `#6a9a4c` |
| `rust_hi` | `#c4503a` | `cloth` | `#5a7aaa` |
| `rust` | `#9c3a2a` | `cloth_lo` | `#405c84` |
| `rust_lo` | `#702a20` | `khaki` | `#aa9c72` |
| `glass` | `#a8d8e8` | `khaki_lo` | `#807452` |
| `glass_lo` | `#6a9ab0` | `dark` | `#3a3a40` |
| `white_hi` | `#f2f2f6` | `red` | `#c42a2a` |
| `white` | `#d2d4dc` | `purple` | `#8e6fb5` |

### `vampire` (32 colours)

| Name | Colour | Name | Colour |
|------|--------|------|--------|
| `outline` | `#16121a` | `blood_lo` | `#80101e` |
| `shadow` | `#000000` at 0.3 opacity | `ebony_hi` | `#6a4a38` |
| `crimson_hi` | `#b03040` | `ebony` | `#4a3426` |
| `crimson` | `#8b1e2d` | `ebony_lo` | `#33231a` |
| `crimson_lo` | `#661622` | `oak_hi` | `#b08850` |
| `gold` | `#d0a848` | `oak` | `#8a6a3a` |
| `board_hi` | `#9a5c48` | `oak_lo` | `#644a28` |
| `board` | `#7a4234` | `glass` | `#8cc0ec` at 0.65 opacity |
| `board_lo` | `#5a2e26` | `bottle` | `#2e5a3a` |
| `sun_hi` | `#f6e8b0` | `tome` | `#3a4a7a` |
| `sun` | `#e8d27a` | `pale` | `#e4e2f2` |
| `stone_hi` | `#8e86a0` | `pale_lo` | `#b0aec8` |
| `stone` | `#6c6480` | `cape` | `#2a2836` |
| `stone_lo` | `#4e4860` | `bat` | `#7a5c8a` |
| `crypt` | `#3e3650` | `bat_lo` | `#563e66` |
| `blood` | `#c0182c` | `wax` | `#f0e8c0` |

### `garden` (30 colours)

A bright pastel palette for a cute look: round shapes, big eyes, a soft
plum `outline` instead of near-black. The night tint is a light
blue-violet, so these colours stay readable after dark.

| Name | Colour | Name | Colour |
|------|--------|------|--------|
| `outline` | `#4a3848` | `water` | `#8ad4f0` |
| `shadow` | `#000000` at 0.25 opacity | `water_lo` | `#5ab0d8` |
| `grass_hi` | `#b4e88a` | `pink` | `#ffb4d2` |
| `grass` | `#8fd16a` | `pink_lo` | `#e87cac` |
| `grass_lo` | `#6ab450` | `yellow` | `#ffe27a` |
| `leaf_hi` | `#74c466` | `orange` | `#ff9a3c` |
| `leaf` | `#4fa858` | `orange_lo` | `#d8742a` |
| `leaf_lo` | `#3a8448` | `red` | `#ff5a70` |
| `soil_hi` | `#c08a60` | `white` | `#fffaf4` |
| `soil` | `#9a6a48` | `white_lo` | `#e0d8ea` |
| `soil_lo` | `#74503a` | `cream` | `#f6deb4` |
| `gravel_hi` | `#f2eada` | `lilac` | `#c8a4f6` |
| `gravel` | `#d8cbb0` | `lilac_lo` | `#9a78d4` |
| `gravel_lo` | `#b4a68a` | `blue` | `#7ab8f2` |
| `water_hi` | `#d0f2fc` | `blue_lo` | `#5288c8` |

The bunny, the cat and the butterfly are drawn in `art/garden.mjs` as
their own 16×24 text grids (not the shared humanoid body). The butterfly
hovers above its shadow, like the vampire pack's bat. The fence is a single
image whose rails run along both map axes, so neighbouring fence tiles join
up whichever way the fence line runs.
