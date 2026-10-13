---
id: zombie-kenney-skin
area: iso
priority: 40
depends_on: []
description: "Explore free CC0 art: a new `zombie-kenney` skin mod re-skins the zombie stack's road, grass, floor, landing and car with Kenney's Isometric City, Landscape and Vehicles packs, imported by a reproducible no-dependency script with a CREDITS file; the renderer gains a generic `@2x` PNG resolution convention; the art test learns PNG; a spike write-up records what fit and what did not"
---

# Kenney CC0 art skin for Zombie Town

## Goal

Find out what it takes to use **free third-party art packs** in isolandia,
with the zombie game as the guinea pig. Research (October 2026) found no
free pixel-art pack that is urban, zombie-themed and drawn at our 64×32
tile size, so this task takes the most complete coherent free set instead:
**Kenney's CC0 isometric packs** (Isometric City, Isometric Landscape,
Isometric Vehicles #1), rendered flat-shaded 3D at 132 px tiles. They cover
the **outdoors and floors**: road, grass, concrete floor and cars. Walls,
furniture, items and characters have no Kenney counterpart and keep the
pixel art.

The art reaches the game as a **skin mod**, `packs/zombie-kenney`, that
stacks on `zombie` and overrides five `sprite` fields. Nothing in
`packs/std`, `packs/town` or `packs/zombie` changes, the generated pixel
art stays, and the skin is one click away on the title screen. Along the
way the repo gains the three generic pieces every future import needs: a
reproducible **import script** (download, verify, crop, resample, write
PNGs) with **credits**, a **`@2x` PNG resolution** convention in the
renderer so imported art stays sharp when zoomed, and an **art test that
accepts PNG** assets. A short spike write-up records the verdict.

Engine code stays genre-agnostic (VISION.md §3.8): the renderer learns a
file-name convention, nothing about Kenney or zombies.

## Acceptance Criteria

### The skin pack

1. **Manifest.** `packs/zombie-kenney/pack.yaml`: `namespace: zkn`,
   `name: Zombie Town (Kenney art)`, `kind: mod`,
   `depends: [std, town, zombie]`, `featured: 5`, `version: 0.1.0`, and a
   one-line description that says it is the zombie game with Kenney's CC0
   art outdoors. `?packs=zombie-kenney` resolves to
   `std, std_needs, town, zmb, zkn` and plays exactly like `?packs=zombie`
   apart from the art. `npm run check -- zombie-kenney` passes.
2. **Overrides** (one file, e.g. `packs/zombie-kenney/skin.yaml`): tiles
   `std:floor`, `std:landing`, `town:road`, `town:grass` and `town:car`
   restated with `override: true` and only `sprite: <skin asset>`. No
   other field (colour, glyph, walkable, container…) changes, so the ASCII
   view, HUD and sim are untouched. `floor` and `landing` may share one
   asset.
3. **Assets** in `packs/zombie-kenney/assets.yaml` and `assets/`:
   - `road@2x.png`, `grass@2x.png`, `floor@2x.png`: flat tiles,
     **128×64 px** drawn at the `@2x` resolution (criterion 9), so they
     occupy exactly the 64×32 diamond with the default anchor.
   - `car_s@2x.png` and `car_w@2x.png`: a 4-way directional asset
     (`directions: { s, w }`, as `town:car_img`), **128×128 px** at `@2x`:
     the lower 128×64 is the skin's road tile and a Kenney vehicle sits
     centred on that diamond, so a cell with a car reads as a car parked
     on asphalt. `s` is the vehicle facing down-left, `w` up-left; the
     mirrors give `e` and `n` as for the pixel-art car.
   - Every flat tile's alpha is **exactly the 2:1 diamond mask** of its
     size (opaque inside, fully transparent outside, the same staircase
     the pixel-art flats use), so neighbouring tiles meet without hairline
     seams. Pixels the mask makes opaque but the resample left
     semi-transparent take the colour of their nearest opaque neighbour.
   - PNGs are 8-bit RGBA, non-interlaced. The whole `assets/` directory
     stays under 200 KB.
4. **Credits.** `packs/zombie-kenney/CREDITS.md` lists each source: pack
   title, author (Kenney, kenney.nl), licence (CC0 1.0), the
   OpenGameArt page URL, the zip URL, its SHA-256, and which assets were
   made from which files. It says the repository's own art is not covered
   by it.

### The import script

5. **`scripts/import-art.mjs <pack>`** regenerates `packs/<pack>/assets/`
   from a recipe module `art/imports/<pack>.mjs`. The recipe for the skin
   declares its **sources** (`{ id, url, sha256 }` for the three zips) and
   its **images**: for each output file, the source zip entry to read and
   the operations to apply (crop rectangle, resample to a size, diamond
   mask, compose onto another image at an offset, scale by an integer).
   The script:
   - downloads each zip into a git-ignored cache (`.cache/art/`; add it
     to `.gitignore`) unless it is already there, and **verifies the
     SHA-256** before using it (a mismatch is an error naming the file);
   - reads zip entries and decodes/encodes PNG with **`node:zlib` only**:
     no new dependency, native or otherwise. Put the zip reader and the
     PNG decoder/RGBA encoder in `art/png.mjs` (the RGB `png()` writer in
     `art/lib.mjs` may move there or stay; do not duplicate the chunk
     code);
   - resamples with **area averaging** (box filter) for downscales and
     nearest-neighbour for integer upscales;
   - is **deterministic**: running it twice in a row leaves `git status`
     clean (same bytes), so a reviewer can rerun it to check the committed
     PNGs;
   - with no network, fails fast with a message that names the missing
     zip and its URL. The committed PNGs are the deliverable: no gate and
     no test needs the network.
6. `node scripts/import-art.mjs zombie-kenney` run on a clean checkout
   produces the committed assets byte for byte (the implementer runs it
   and commits its output; the test gates only check the result).

### Renderer: `@2x` PNG resolution

7. A PNG asset whose file name ends in **`@<N>x.png`** (N an integer 1–4,
   e.g. `road@2x.png`) is drawn at **1/N of its pixel size**: its texture
   is loaded with `resolution: N` (Pixi's `Assets.load` `data.resolution`,
   next to the existing `SVG_RESOLUTION` path in `src/iso/textures.ts`).
   `road@2x.png` at 128×64 px therefore covers the 64×32 diamond and
   stays sharp up to the 3× zoom, like the SVG art. Other PNGs keep
   `resolution: 1`. SVG loading does not change.
8. The suffix is parsed from the **pack-relative `file`** path, not from
   the served URL (Vite hashes file names), in a small pure helper (e.g.
   `imageResolution(file): number` in a module that does not import
   Pixi, such as `src/iso/projection.ts` or a new `src/iso/resolution.ts`)
   with unit tests: `a@2x.png` → 2, `a@3x.PNG` → 3, `a.png` → 1,
   `a@2x.svg` → 1 (SVGs use `SVG_RESOLUTION`), `a@0x.png` and
   `a@5x.png` → 1.
9. Hit masks keep one cell per **logical** pixel for PNGs (`texture.width`
   is already the logical size; `maskFromRgba` samples the larger pixel
   buffer), so picking a `@2x` tile works as before. `docs/iso.md`'s
   hit-mask paragraph says so.

### Tests

10. **`test/art.test.ts`**:
    - `STACKS` gains `['std', 'std-needs', 'town', 'zombie', 'zombie-kenney']`.
      The coverage and directionality tests pass for it unchanged (the
      skin's tiles are 1-way, `car` 4-way).
    - The size/anchor test reads **PNG** images too: width and height from
      the IHDR chunk, divided by the `@Nx` resolution, checked against the
      same per-kind rules (flat 64×32, raised 64×≥64, and so on). SVGs go
      through `scanSvg` as today.
    - The pixel-grid and 32-colour tests stay SVG-only (imported PNGs are
      exempt by design; say so in a comment and in `docs/art.md`).
    - A new test, **imported art**: for every `packs/*/assets/*.png`: the
      file is referenced by that pack's `assets.yaml`; its name carries an
      `@Nx` suffix and both pixel dimensions are multiples of N; the pack
      has a `CREDITS.md` that mentions the file's source zip name; and, for
      PNG flat tiles of the shipped stacks, the alpha channel equals the
      exact diamond mask (decode with `art/png.mjs`).
11. **`test/stacks.test.ts`**: the shipped catalog list gains
    `['zombie-kenney', 'zkn', 'mod', 'std,town,zmb']` in sorted position;
    the featured test lists five packs with `zombie-kenney` at 5 (rename
    it accordingly); `['std', 'std-needs', 'town', 'zombie', 'zombie-kenney']`
    joins the "every explicit stack resolves to itself" list. Any other
    test that enumerates `packs/` (search `test/` for `'western'`) is
    updated.
12. `scripts/smoke.mjs` `combos` gains `['zombie-kenney']`.

### Docs and write-up

13. `docs/art.md`: a new **Imported art** section: when a pack imports
    third-party art instead of drawing it (PNG, any style), the `@Nx`
    convention, that the pixel-grid and palette rules do not apply but
    the size/anchor table does, `CREDITS.md` is mandatory, licences we
    accept (CC0; CC-BY only with the attribution in `CREDITS.md`), and
    how to run `scripts/import-art.mjs`. Link it from `docs/packs.md`'s
    `assets` section, whose `file` row mentions the `@Nx` suffix.
14. `docs/packs.md` **Shipped packs**: a `zombie-kenney` row (mod, depends
    `std, town, zmb`, "the zombie game with Kenney's CC0 art outdoors")
    and the featured list names five packs. `README.md` mentions the skin
    in one clause where it lists the genre mods.
15. **`docs/spikes/kenney-skin.md`**, a one-page write-up: the packs
    considered and why Kenney won (see Design Notes; keep the list), what
    the skin covers and what it could not (walls, doors, windows,
    furniture, crate, stove, stairs, glass, characters, items), the
    pipeline shape (recipe + script + `@2x`), the visual verdict with the
    skin's `docs/screens/zombie-kenney.png` screenshot if smoke ran, and
    two or three concrete next steps (e.g. a Kenney-style wall slab drawn
    by hand to match, or a 128×64 engine mode). Honest about the style
    clash between flat-shaded ground and pixel-art people.
16. Gates: `npm run typecheck`, `npm test`,
    `npm run check -- zombie-kenney`, `npm run check -- zombie`,
    `npm run check -- vampire`. If a browser is available run
    `npm run smoke` and commit the refreshed `docs/screens/`; smoke is not
    a gate, say in the completion report whether it ran.

## Out of Scope

- Kenney (or any imported) art for walls, doors, windows, furniture,
  crate, stove, stairs, glass, items or characters: no matching free
  assets exist at this projection. They keep the pixel art, and the
  write-up records the clash.
- Changing `packs/std`, `packs/town` or `packs/zombie` beyond nothing: the
  skin overrides, it does not edit. Other genre mods (vampire, noir,
  western) get no skin.
- A pack-configurable tile size or a 128×64 render mode.
- Animation, spritesheets, texture atlases.
- Kenney's Isometric Miniature series (30°×45° projection, 256 px) and
  the Sketch packs: a different projection.
- Committing the downloaded zips or an npm image library.
- Changing how SVG assets load, or any loader/schema change
  (`assets.yaml` already accepts `.png`).

## Design Notes

### Sources (all CC0 1.0, by Kenney, hosted on OpenGameArt)

| Pack | Page | Zip | Size | SHA-256 |
|------|------|-----|------|---------|
| Isometric City | https://opengameart.org/content/isometric-city | https://opengameart.org/sites/default/files/isometricCity.zip | 990 594 B | `bea03c38f340af6df14949cc7ca23ac68f30d087d4867350424f08b697a7e01c` |
| Isometric Landscape | https://opengameart.org/content/isometric-landscape | https://opengameart.org/sites/default/files/isometricLandscape.zip | 1 141 541 B | `18fa4fb22fa18bd4230e2422bc4123c986123c53966846b5a5bc219b331e7d3e` |
| Isometric Vehicles #1 | https://opengameart.org/content/isometric-vehicles-1 | https://opengameart.org/sites/default/files/isometricVehicles.zip | 2 269 908 B | `b478cf692d936e2cfda2368f8d24505841508907adc343f1068a6b2ea457d3fd` |

Checksums were taken on 2026-10-12. If a download no longer matches,
stop and report it rather than editing the recipe's hash. `opengameart.org`
was reachable from the sandbox when this spec was written; if it is not,
report `blocked` with the URLs.

Each zip holds `PNG/<name>_NNN.png` sprites, a `Spritesheet/` with an XML
atlas and `License.txt` (CC0, "credit would be nice but is not mandatory").
Vehicles are under `PNG/Civilian/<Colour>/<Model>/car<Colour><N>_NNN.png`.

### Geometry of the Kenney tiles

City and landscape tiles are mostly 132×101 px (a few 133 wide, 99/104
tall; walls and trees are taller). Each is a **thick slab**: the top face
is a 2:1 diamond with its top vertex at (66, 0), side vertices at y = 33
and bottom vertex at y = 66, and under it a 33 px dirt side. For a flat
tile, crop the **top face** (rows 0–66, full width) and resample it to
**128×64** (a ×0.97 scale, nearly lossless), then apply the diamond mask.
The dirt side is dropped: isolandia's ground is flat.

Recommended picks (verified on a contact sheet; indices are the `_NNN`
numbers): `cityTiles_080` plain asphalt → `road`; `cityTiles_072` or
`074` plain concrete → `floor` (and `landing`); `landscapeTiles_015`,
`016` or `075` plain grass → `grass`. Any plain tile of the same material
is fine; prefer the ones without curbs or markings so the city map's road
grid reads as continuous asphalt.

Vehicles are small (about 32×22 px) because Kenney draws them at a quarter
of the tile width. Each model has 16 frames: `_000`–`_007` are the eight
headings at one camera elevation, `_008`–`_015` the same at another.
Scale the chosen frame ×2 (nearest) to about 64×44 px, place it on the
skin's road tile inside a 128×128 canvas with the vehicle's centre on the
diamond's centre (64, 96) and its ground shadow a few logical px below
it; tune by eye so it reads as parked on the cell. Pick a dark colour
(Black or the Grey of the utility set) so it reads as a wreck; a
different model per facing is not wanted. Choose the `s` and `w` headings
by eye from the frames (down-left and up-left on screen) and note the
frame numbers in the recipe.

### Pipeline shape

- `art/imports/zombie-kenney.mjs` exports `sources` and `images()`
  (parallel to `art/<pack>.mjs` exporting `palette` and `images()` for
  the generator). Keep the ops data-like so the recipe reads as a table.
- Zip reading: walk the central directory (signature `0x02014b50`), read
  each local header (`0x04034b50`), `inflateRawSync` method 8 entries,
  copy method 0 entries. Reject anything else with a clear error. ZIP64
  is not needed (zips are under 3 MB).
- PNG decode: 8-bit, non-interlaced, colour types 0/2/3/4/6 with the five
  filters (the Kenney files are type 6). Encode RGBA with a single IDAT
  (`deflateSync`) and no ancillary chunks; filter type 0 everywhere, so
  output is deterministic.
- Area-average resample: for each output pixel, average the source pixels
  its footprint covers, weighting partial coverage, in **premultiplied**
  alpha, then un-premultiply.
- Diamond mask for a W×H flat: a pixel (x, y) with centre (x + 0.5,
  y + 0.5) is inside when `|cx − W/2| / (W/2) + |cy − H/2| / (H/2) ≤ 1`.
  Check the result against the 64×32 pixel-art flats' staircase at 1×
  (`packs/town/assets/road.svg` is the reference: its even-integer rect
  rows give the expected inside set per row).
- `Assets.load({ src, parser: 'texture', data: { resolution } })`: Pixi 8's
  `loadTextures` uses `asset.data.resolution` (falling back to the `@Nx`
  URL regex). `texture.width` is then the logical size, which both the
  sprite placement and `addMask` use.
- The day/night tint multiplies sprite colours; Kenney's palette is
  mid-to-light, so the zombie night stays readable.

### Research record (for the write-up)

Checked and rejected, so the write-up need not redo the search:
Kenney Isometric Miniature series (30°×45°, 256 px); PixVoxel wargame
sprites (CC0, the only free zombie sprites, but 4-way, 88×108 and
military); RatMoleRat Isometric Furniture and Building Interiors (CC0,
64 px, rendered, a handful of pieces); Devil's Workshop and Newc42
isometric pixel tiles (CC0, nature only); Screaming Brain Studios
floor/wall/object/town packs (CC0, 128/64, rendered); intellikat 32 px
isometric modern character template (CC0, unverified directions);
SmallScaleInt and monogon zombie iso packs (paid).

## Agent Notes

- Read first: `docs/art.md`, the `assets` and "Mods and overrides"
  sections of `docs/packs.md`, `packs/vampire/content.yaml` (a `sprite`
  override of `town:window` is the pattern), `packs/town/assets.yaml`,
  `src/iso/textures.ts` (`loadAssetTextures`, `addMask`), `src/iso/hit.ts`
  (`maskFromRgba`), `test/art.test.ts`, `test/stacks.test.ts` (catalog and
  featured tests), `scripts/pixel-art.mjs` and `art/lib.mjs` (`png()`,
  `chunk()`), `scripts/smoke.mjs`.
- Order of work: `art/png.mjs` (decoder, encoder, zip) with its tests →
  the import script and recipe → run it, inspect the output visually
  (write a contact sheet to `$TMPDIR` like `pixel-art.mjs --preview`) →
  the pack files → the `@2x` renderer tweak → tests and docs → the
  write-up last, from what you saw.
- The size test in `test/art.test.ts` currently calls `scanSvg` on every
  image regardless of extension; branch on the extension there. The PNG
  IHDR is bytes 16–23 (big-endian width, height) after the 8-byte
  signature and the chunk header.
- Tile overrides must use **qualified ids of direct depends**: `std:floor`
  needs `std` in `depends`, hence `depends: [std, town, zombie]`. The
  resolver orders the stack; `zombie-kenney` loads last.
- Loading in the browser: `src/web/main.ts` globs `/packs/**/*`, so the
  new PNGs and `CREDITS.md` are bundled automatically; nothing to
  register. Check `test/web.test.ts` for anything that counts pack files.
- YAML: `featured: 5` is a plain integer; keep the `description` free of
  `: ` sequences or quote it.
- Do not edit the generated SVGs or `art/<pack>.mjs` of the existing
  packs; the skin lives entirely in `packs/zombie-kenney`, `art/imports/`,
  `art/png.mjs`, `scripts/import-art.mjs`, the tests and the docs.
- If smoke runs, look at `docs/screens/zombie-kenney.png` before writing
  the verdict: the point of the task is to see it.
