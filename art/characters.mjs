// Character drawings: a shared humanoid body per drawn facing, plus
// per-archetype overlays (caps, capes, outstretched arms), the crawler and
// the bat. Characters are 16×24 art px (32×48 px) with the feet at row 22,
// which the asset anchor [0.5, 0.92] puts on the tile's ground centre.
//
// Drawn facings (the rest are mirrored, see docs/packs.md):
//   se  toward the camera (front view)     s   three-quarter front, looking screen-left
//   ne  profile, looking screen-right      w   three-quarter back, looking screen-left
//   nw  away from the camera (back view)
//
// Grid keys: H/h hair, s/S skin, k eye, t/T top, p/P trousers, f shoes;
// arms beside the body a/A (sleeve) n/N (hand); arms over the body b/B
// (sleeve) and m (hand). Overlays add x/X/y/Y/w accents.
//
// Rows: 0–4 blank, 5–10 head, 11–15 torso (arms in rows 12–15), 16–21 legs
// (shoes on row 21, their outline on row 22, the ground), 22–23 blank.
// Each facing also has a 4-frame walk cycle (WALK): contact, passing,
// contact with the other leg, passing. A frame replaces leg rows and the
// arm columns of the torso rows only; head, hair and torso stay put.

import { Canvas, shadow } from './lib.mjs';

export const CHAR_W = 16;
export const CHAR_H = 24;
export const FACINGS = ['s', 'se', 'ne', 'w', 'nw'];
/** Frames in the humanoid walk cycle. */
export const WALK_FRAMES = 4;

const LEGS = ['.....ppppPP.....', '.....ppppPP.....', '.....pp..PP.....', '.....pp..PP.....', '.....pp..PP.....', '.....ff..ff.....'];
const TORSO = ['.....ttttTT.....', '....attttTTA....', '....attttTTA....', '....attttTTA....', '....nttttTTN....'];
const TOP = ['................', '................', '................', '................', '................'];

/** Base bodies, rows 0..23. */
const BODY = {
  se: [...TOP, '......HHHH......', '.....HHHHHH.....', '.....HssssH.....', '.....sksskS.....', '.....ssssSS.....', '......sSSS......', ...TORSO, ...LEGS, '................', '................'],
  s: [
    ...TOP,
    '.....HHHH.......',
    '....HHHHHH......',
    '....sssssH......',
    '....skskSH......',
    '....sssSSH......',
    '.....sSS........',
    ...TORSO,
    '.....ppppPP.....',
    '.....ppppPP.....',
    '....pp...PP.....',
    '....pp...PP.....',
    '....pp...PP.....',
    '...fff...ff.....',
    '................',
    '................',
  ],
  ne: [
    ...TOP,
    '......HHHH......',
    '.....HHHHHH.....',
    '.....HHHsss.....',
    '.....HHssks.....',
    '.....hHsssss....',
    '......SSss......',
    '......tttT......',
    '......tbbT......',
    '......tbbT......',
    '......tbbT......',
    '......tmmT......',
    '......pppP......',
    '......pppP......',
    '.....pp..PP.....',
    '.....pp...PP....',
    '....pp.....PP...',
    '....fff....fff..',
    '................',
    '................',
  ],
  w: [...TOP, '.....HHHH.......', '....HHHHHH......', '....HHHHHH......', '....sHHHHh......', '....SHHHhh......', '.....SSS........', ...TORSO, ...LEGS, '................', '................'],
  nw: [...TOP, '......HHHH......', '.....HHHHHH.....', '.....HHHHHH.....', '.....HHHHHh.....', '.....hHHHhh.....', '......SSSS......', ...TORSO, ...LEGS, '................', '................'],
};

/**
 * Walk cycle: per facing, four sets of rows (by index) that replace the
 * body's rows for that frame. Frames 0 and 2 are the contacts (one leg
 * forward, the other back, the back foot one art pixel up, the arms swung
 * opposite: a swinging hand rides one row higher); 1 and 3 the passing
 * poses (legs together, the swinging foot one pixel up). The front and back
 * views (`se`, `nw`) and the three-quarter back (`w`) share the body's leg
 * block and so the same frames; the profile (`ne`) shows the clearest
 * forward/back split; the three-quarter front (`s`) is in between. Feet
 * never go below row 21 and the hips (rows 16–17) never move, so a coat
 * skirt or dress overlay sits as it does on the standing drawing.
 */
const WALK_FRONT = [
  { 14: '....attttTTN....', 15: '....nttttTT.....', 18: '....pp...PP.....', 19: '....pp...PP.....', 20: '....pp...ff.....', 21: '....ff..........' },
  { 20: '.....pp..ff.....', 21: '.....ff.........' },
  { 14: '....nttttTTA....', 15: '.....ttttTTN....', 18: '.....pp...PP....', 19: '.....pp...PP....', 20: '.....ff...PP....', 21: '..........ff....' },
  { 20: '.....ff..PP.....', 21: '.........ff.....' },
];
const WALK = {
  se: WALK_FRONT,
  w: WALK_FRONT,
  nw: WALK_FRONT,
  s: [
    { 14: '....attttTTN....', 15: '....nttttTT.....', 18: '...pp....PP.....', 19: '...pp....PP.....', 20: '...pp....ff.....', 21: '..fff...........' },
    { 18: '.....pp..PP.....', 19: '.....pp..PP.....', 20: '.....pp..ff.....', 21: '....fff.........' },
    { 14: '....nttttTTA....', 15: '.....ttttTTN....', 18: '.....pp.PP......', 19: '.....pp.PP......', 20: '....fffPP.......', 21: '.......ff.......' },
    { 18: '.....pp..PP.....', 19: '.....pp..PP.....', 20: '....fff..PP.....', 21: '.........ff.....' },
  ],
  ne: [
    { 13: '.....abttT......', 14: '....nntttT......', 15: '......tttT......', 18: '.....PP..pp.....', 19: '....PP...pp.....', 20: '...PP.....pp....', 21: '..fff....fff....' },
    { 18: '......ppPP......', 19: '......ppPP......', 20: '......ppfff.....', 21: '......fff.......' },
    { 13: '......ttbA......', 14: '......tttTmm....', 15: '......tttT......' },
    { 18: '......ppPP......', 19: '......ppPP......', 20: '.....fffPP......', 21: '........fff.....' },
  ],
};

/**
 * The 24 body rows of a facing: the standing drawing (`frame` null) or walk
 * frame `frame` (0..3), before any overlay.
 */
export function bodyRows(facing, frame = null) {
  const body = BODY[facing];
  if (frame === null) return body;
  const walk = WALK[facing]?.[frame];
  if (!walk) throw new Error(`humanoid: no walk frame ${frame} for facing '${facing}'`);
  return body.map((row, y) => walk[y] ?? row);
}

/** Arms reaching forward (shamblers), replacing the arms of BODY. */
const ARMS_FORWARD = {
  se: { 12: '....a......A....', 13: '....abbm..mBA...', 14: '.....mm..mm.....' },
  s: { 12: '..nnaab.........', 13: '..nnAAB.........' },
  ne: { 12: '......tbbbaann..', 13: '......tBBBAANN..' },
  w: { 10: '..nn............', 11: '..naa...........', 12: '...aa...........' },
  nw: { 10: '....a......A....', 11: '....a......A....', 12: '....a......A....' },
};

/** Grid rows (by index) pasted over a body. */
function rowsAt(c, rows, key) {
  for (const [y, row] of Object.entries(rows)) c.grid(0, Number(y), [row], key);
}

const ARM_KEYS = new Set(['a', 'A', 'n', 'N', 'b', 'B', 'm']);

/**
 * A humanoid in `facing`, standing (`frame` null) or at walk frame `frame`
 * (0..3, see WALK). `look` maps grid keys to palette names and may add
 * `armsForward`, `under` (rows drawn behind the body) and `over` (rows
 * drawn on top), each per facing. `under` and `over` apply to every frame
 * as to the standing drawing; `over.frames[k][facing]` adds or replaces
 * rows of `over[facing]` for frame `k` alone (per row index).
 */
export function humanoid(facing, look, frame = null) {
  const key = {
    ...look.key,
    a: look.key.t,
    A: look.key.T,
    n: look.key.s,
    N: look.key.S,
    b: look.key.T,
    B: look.key.T,
    m: look.key.s,
  };
  let rows = bodyRows(facing, frame);
  if (look.armsForward) {
    // Drop the hanging arms; the torso shows where they covered it.
    rows = rows.map((r) => [...r].map((ch) => (ARM_KEYS.has(ch) ? ('bm'.includes(ch) ? 't' : ch === 'B' ? 'T' : '.') : ch)).join(''));
  }
  const body = new Canvas(16, 24);
  if (look.under?.[facing]) rowsAt(body, look.under[facing], key);
  body.grid(0, 0, rows, key);
  if (look.armsForward) rowsAt(body, ARMS_FORWARD[facing], key);
  const over = { ...look.over?.[facing], ...(frame === null ? null : look.over?.frames?.[frame]?.[facing]) };
  rowsAt(body, over, key);
  return finish(body, look.outline, 8, 22, 5.5, 1.8);
}

/**
 * The `images()` entries of a humanoid character `name`: per drawn facing
 * the standing drawing `<name>_<facing>.svg` followed by its walk frames
 * `<name>_<facing>_walk1.svg` … `_walk4.svg`.
 */
export function humanoidImages(name, look) {
  return FACINGS.flatMap((f) => [
    { file: `${name}_${f}.svg`, canvas: humanoid(f, look), note: `facing ${f}` },
    ...Array.from({ length: WALK_FRAMES }, (_, k) => ({ file: `${name}_${f}_walk${k + 1}.svg`, canvas: humanoid(f, look, k), note: `facing ${f}, walk frame ${k + 1} of ${WALK_FRAMES}` })),
  ]);
}

/** Outline the figure and put it on a pixel drop shadow centred at (cx, cy). */
export function finish(body, outline, cx, cy, rx, ry) {
  body.outline(outline);
  const c = new Canvas(body.w, body.h);
  shadow(c, cx, cy, rx, ry);
  return c.over(body);
}

// ── Crawler: low, dragging itself on its arms ─────────────────────────────

const CRAWLER = {
  se: [
    '.....ff..ff.....',
    '.....pp..PP.....',
    '.....ttttTT.....',
    '....tttttTTT....',
    '...atHHHHHHTA...',
    '..aa.HsssSH.AA..',
    '.nn..sksskS..NN.',
    '......sSSS......',
  ],
  s: [
    '...........fff..',
    '........pppPP...',
    '......ttttTTT...',
    '..HHHHtttttTT...',
    '.HHHHHHttttTT...',
    '.skskSHtttT.....',
    'naassSSAAA......',
    '....nn..........',
  ],
  ne: [
    '................',
    '................',
    '................',
    '..........HHH...',
    '.........HHHss..',
    '.....tttthssks..',
    '.pppptttttTSSaa.',
    'ffPPPTTTTTaaann.',
  ],
  w: [
    '..HHHH..........',
    '.HHHHHH.........',
    'naHHHHhtttt.....',
    '.aaSSttttttTT...',
    '....TTTTTTTpPPP.',
    '...........ppfff',
  ],
  nw: [
    '..n...HHHH...n..',
    '..a..HHHHHH..A..',
    '...aatttttTAA...',
    '....ttttttTT....',
    '...ppppppPPPP...',
    '..ff........ff..',
  ],
};

export function crawler(facing, look) {
  const key = { ...look.key, a: look.key.t, A: look.key.T, n: look.key.s, N: look.key.S };
  const rows = CRAWLER[facing];
  const body = new Canvas(16, 24);
  body.grid(0, 22 - rows.length, rows, key);
  if (look.over?.[facing]) rowsAt(body, look.over[facing], key);
  return finish(body, look.outline, 8, 21.5, 7, 1.8);
}

// ── Bat: a small flier hovering above its shadow ──────────────────────────

const BAT = {
  se: [
    '................',
    '.w....b..b....w.',
    '.ww...bbbb...ww.',
    '.wwww.kbbk.wwww.',
    '..wwwwbBBBwwww..',
    '...wW.bBBB.Ww...',
    '....w..BB..w....',
  ],
  s: [
    '................',
    '..w..b..b.....w.',
    '..ww.bbbb....ww.',
    '..wwbkbkB.wwwww.',
    '...wwbbBBwwwww..',
    '....w.bBB.wWw...',
    '.......BB..w....',
  ],
  ne: [
    '..ww............',
    '...www..........',
    '....wwww........',
    '.....wWWw..b.b..',
    '......wbbbbbkbb.',
    '.......BBBBBBB..',
    '........wWw.....',
  ],
  w: [
    '................',
    '.w...b..b.....w.',
    '.ww..bbbb....ww.',
    '.wwwwbbbBwwwwww.',
    '..wwwWbBBBWwww..',
    '...wW..BB..Ww...',
    '........B.......',
  ],
  nw: [
    '................',
    '.w....b..b....w.',
    '.ww...bbbb...ww.',
    '.wwww.bbbB.wwww.',
    '..wwwwbBBBwwww..',
    '...wW.bBBB.Ww...',
    '....w..BB..w....',
  ],
};

export function bat(facing, look) {
  const body = new Canvas(16, 24);
  body.grid(0, 4, BAT[facing], look.key);
  return finish(body, look.outline, 8, 21.5, 3.5, 1.2);
}

// ── Items: small ground piles centred on the anchor ───────────────────────

/** A 16×16 item canvas: the drawing centred on (8, 8) over a small shadow. */
export function item(rows, key, outline) {
  const w = Math.max(...rows.map((r) => r.length));
  const body = new Canvas(16, 16);
  const x = Math.round(8 - w / 2);
  const y = Math.round(8 - rows.length / 2);
  body.grid(x, y, rows, key);
  return finish(body, outline, 8, y + rows.length + 0.5, w / 2 + 1, 1.5);
}
