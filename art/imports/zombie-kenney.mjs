// Import recipe for packs/zombie-kenney: Kenney's CC0 isometric packs
// (see packs/zombie-kenney/CREDITS.md). Run `node scripts/import-art.mjs
// zombie-kenney` to regenerate packs/zombie-kenney/assets/.
//
// A Kenney city/landscape tile is a 132 px wide slab: the top face is the
// diamond in rows 0–66, a dirt side hangs under it. Flat tiles keep only
// the top face, resampled to 128×64 (the 64×32 diamond at @2x), masked to
// the pixel-art flats' staircase (4 px art pixels at @2x) so imported and
// drawn tiles share their edges; the 2 px inset drops Kenney's shaded tile
// edges, so roads read as one surface.

export const sources = [
  {
    id: 'city',
    url: 'https://opengameart.org/sites/default/files/isometricCity.zip',
    sha256: 'bea03c38f340af6df14949cc7ca23ac68f30d087d4867350424f08b697a7e01c',
  },
  {
    id: 'landscape',
    url: 'https://opengameart.org/sites/default/files/isometricLandscape.zip',
    sha256: '18fa4fb22fa18bd4230e2422bc4123c986123c53966846b5a5bc219b331e7d3e',
  },
  {
    id: 'vehicles',
    url: 'https://opengameart.org/sites/default/files/isometricVehicles.zip',
    sha256: 'b478cf692d936e2cfda2368f8d24505841508907adc343f1068a6b2ea457d3fd',
  },
];

/** The top face of a Kenney tile as a 128×64 flat (the 64×32 diamond at @2x). */
const flat = (source, entry) => ({
  source,
  entry,
  ops: [{ crop: [0, 0, 132, 67] }, { resize: [128, 64] }, { diamond: { cell: 4, inset: 2 } }],
});

const ROAD = flat('city', 'PNG/cityTiles_080.png'); // plain asphalt, no curbs or markings

/**
 * A parked car: the skin's road tile in the lower 128×64 of a 128×128
 * canvas, a ground shadow, and a Kenney sedan (Black, Sedan 1) centred on
 * the diamond's centre (64, 96), nudged up so its wheels sit on it. Kenney
 * draws cars a quarter of a tile wide; ×3 (48 iso px) reads as a car next
 * to the 32 px characters and stays inside the diamond (×2 looked like a
 * toy, ×4 overflows the cell). `frame` is the heading: 004 faces down-left
 * (`s`), 009 up-left (`w`, seen from behind); the renderer mirrors them
 * for `e` and `n`.
 */
const car = (frame) => ({
  canvas: [128, 128],
  layers: [
    { ...ROAD, at: [0, 64] },
    { ellipse: [64, 100, 46, 19], rgba: [0, 0, 0, 77] }, // ground shadow
    { source: 'vehicles', entry: `PNG/Civilian/Black/Sedan 1/carBlack2_${frame}.png`, ops: [{ scale: 3 }], centre: [64, 90] },
  ],
});

export function images() {
  return [
    { file: 'road@2x.png', ...ROAD },
    { file: 'grass@2x.png', ...flat('landscape', 'PNG/landscapeTiles_075.png') }, // plain grass
    { file: 'floor@2x.png', ...flat('city', 'PNG/cityTiles_072.png') }, // plain concrete, also the landing
    { file: 'car_s@2x.png', ...car('004') },
    { file: 'car_w@2x.png', ...car('009') },
  ];
}
