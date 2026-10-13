# Spike: Kenney's CC0 art as a Zombie Town skin

*October 2026. Pack `packs/zombie-kenney`, recipe
`art/imports/zombie-kenney.mjs`, script `scripts/import-art.mjs`.*

**Question.** What does it take to use free third-party art in isolandia,
with the zombie game as the guinea pig?

## Packs considered

No free pixel-art pack is urban, zombie-themed and drawn at our 64×32
tile. Checked and rejected:

- **Kenney Isometric Miniature** series: a 30°×45° projection at 256 px,
  not our 2:1.
- **PixVoxel wargame sprites** (CC0): the only free zombie sprites, but
  4-way, 88×108 and military.
- **RatMoleRat Isometric Furniture and Building Interiors** (CC0): 64 px
  and rendered, but only a handful of pieces.
- **Devil's Workshop** and **Newc42** isometric pixel tiles (CC0): nature
  only.
- **Screaming Brain Studios** floor, wall, object and town packs (CC0):
  128/64 px, rendered, a different look per pack.
- **intellikat** 32 px isometric modern character template (CC0): its
  directions are unverified.
- **SmallScaleInt** and **monogon** zombie iso packs: paid.

**Kenney won** because Isometric City, Isometric Landscape and Isometric
Vehicles #1 are the most complete set that is free, coherent and in a 2:1
projection. They are CC0, and all three come from one artist in one style:
flat-shaded 3D renders on 132 px tiles. The licence asks nothing, and we
credit Kenney anyway (`packs/zombie-kenney/CREDITS.md`).

## What the skin covers, and what it could not

**Covered** (five `sprite` overrides, nothing else changed): `town:road`
(asphalt `cityTiles_080`), `town:grass` (`landscapeTiles_075`),
`std:floor` and `std:landing` (concrete `cityTiles_072`), and `town:car`
(a black sedan, frames 004 and 009, standing on the skin's road tile). A
test checks that the skin changes nothing but sprites and that it runs to
the same world hash as `zombie`.

**Not covered**, because Kenney has nothing that fits our projection or
our scale: walls, doors and windows (Kenney's are whole building blocks,
not thin edge slabs), furniture, the crate, the stove, stairs, broken
glass, all characters and all items. They keep the pixel art.

## Pipeline

1. **Recipe** (`art/imports/<pack>.mjs`): the source zips with their
   SHA-256, and a table of output images. Each is a zip entry and data-like
   ops (`crop`, `resize`, `scale`, `diamond`) or layers on a canvas.
2. **Script** (`scripts/import-art.mjs`): it downloads into
   `.cache/art/`, verifies the hashes, and writes deterministic PNGs. The
   only dependency is `node:zlib`, through `art/png.mjs` (zip reader, PNG
   decoder, RGBA encoder).
3. **`@Nx` convention** in the renderer: `road@2x.png` is loaded at
   resolution 2, so 128×64 image px cover the 64×32 diamond and stay sharp
   up to the 3× zoom. Hit masks keep one cell per logical pixel.
4. **Tests**: the size table applies to PNGs (over N). Imported PNGs must
   be referenced, `@Nx`-named and credited, and flat tiles must carry the
   exact diamond alpha.

Geometry was easy. A Kenney tile's top face is a 132×66 diamond, and a
×0.97 area-average resample turns it into our 128×64 almost losslessly.
Two adjustments were needed:

- **Seams.** Kenney shades each tile's lower edges. Tiled on a grid, that
  shading draws a visible lattice over the road. The `diamond` op refills
  a 2 px edge ring from the interior, so neighbouring tiles join without a
  drawn grid.
- **Staircase.** The mask is judged per *art pixel* (4 px at `@2x`), so
  its staircase is the pixel-art flats' own, and Kenney and pixel-art
  tiles share edges exactly. The design notes suggested a per-pixel mask.
  At 1× that does not reproduce `road.svg`, and next to a pixel-art tile
  it would leave 1 px gaps and overlaps.

The car took judgement. Kenney draws cars a quarter of a tile wide. At ×2
(the plan) the sedan was narrower than a character and read as a toy. At
×4 it overflowed the diamond. ×3 (48 iso px wide) sits inside the cell
and reads as a parked car. The `w` frame (009) shows the car from behind
on the up-left/down-right axis. Kenney has no frame that reads
unambiguously as "front up-left", so the mirrored `n` and `e` are an
approximation.

## Visual verdict

The browser smoke test could not run in this sandbox: Chromium cannot
create its sockets. So there is no `docs/screens/zombie-kenney.png` yet.
`npm run smoke` takes it on a machine with a browser. The verdict below
comes from contact sheets and an offline composite of a 6×6 street patch,
pixel-art version beside Kenney version, using the committed PNGs.

- **The ground works.** Roads, grass and concrete join cleanly into
  continuous surfaces. They are lighter and calmer than the noisy
  pixel-art ground, so the city reads more like a map, which suits a
  zombie night under the tint.
- **The ground is also bland.** Kenney's tiles are flat fills with no
  texture. Without markings, curbs or cracks, a 343×343 city of plain
  asphalt looks empty, and nothing reads as decay.
- **The style clash is real.** Flat-shaded, anti-aliased renders sit under
  pixel-art people, walls and furniture with 1 px dark outlines. The
  ground reads as a different game from what stands on it. The car is the
  worst case: a smooth, shiny black sedan beside pixel-art crates and
  shamblers. It does not look wrecked, and it is drawn at a different
  pixel density from its neighbours.
- **Verdict:** the *pipeline* is a success and is reusable: recipe,
  checksums, deterministic import, `@Nx`, credits and tests. The *skin* is
  a curiosity, not a better default. Mixing a 3D-rendered ground with
  pixel-art objects costs more coherence than it gains.

## Next steps

1. **Draw the walls to match.** A hand-made, flat-shaded wall slab (40×64
   at `@2x`) in Kenney's palette and lighting, so at least the town's
   outlines share the ground's style. Furniture and characters would
   follow only if that works.
2. **Use Kenney's road variety.** Isometric City has lane markings, curbs,
   crossings and sidewalks. A map-aware recipe (or a few more road tiles
   placed by the city generator) would make the ground less bland and
   read as a street grid.
3. **Try a 128×64 render mode** (out of scope here). Kenney's art at its
   native scale would need no ×0.97 resample and no ×3 car. It would only
   pay off with a full Kenney set, which does not exist for interiors and
   people.
