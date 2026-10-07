// garden: a sunny, fenced garden, the bunny, the sleepy cat, the
// butterflies and the night fox. Round shapes, big eyes and a bright pastel palette.

import { finish, item, FACINGS } from './characters.mjs';
import { blockTile, Canvas, flatTile, hash, px } from './lib.mjs';

export const palette = {
  outline: '#4a3848',
  shadow: ['#000000', 0.25],
  grass_hi: '#b4e88a',
  grass: '#8fd16a',
  grass_lo: '#6ab450',
  leaf_hi: '#74c466',
  leaf: '#4fa858',
  leaf_lo: '#3a8448',
  soil_hi: '#c08a60',
  soil: '#9a6a48',
  soil_lo: '#74503a',
  gravel_hi: '#f2eada',
  gravel: '#d8cbb0',
  gravel_lo: '#b4a68a',
  water_hi: '#d0f2fc',
  water: '#8ad4f0',
  water_lo: '#5ab0d8',
  pink: '#ffb4d2',
  pink_lo: '#e87cac',
  yellow: '#ffe27a',
  orange: '#ff9a3c',
  orange_lo: '#d8742a',
  red: '#ff5a70',
  white: '#fffaf4',
  white_lo: '#e0d8ea',
  cream: '#f6deb4',
  lilac: '#c8a4f6',
  lilac_lo: '#9a78d4',
  blue: '#7ab8f2',
  blue_lo: '#5288c8',
  rust: '#e0703a',
  rust_lo: '#b4502e',
};

// ── Flat tiles ────────────────────────────────────────────────────────────

/** Speckled lawn; `seed` varies the speckles between tiles. */
function lawn(seed) {
  const { c, I } = flatTile();
  I.top(0, 0, 1, 1, 0, (u, v, x, y) => {
    const n = hash(x, y, seed);
    return n < 0.1 ? 'grass_lo' : n > 0.9 ? 'grass_hi' : 'grass';
  });
  return c;
}

function grass() {
  const c = lawn(41);
  // Tufts: a light blade over a darker root.
  for (const [x, y] of [[9, 7], [20, 5], [15, 11], [24, 9], [12, 4], [6, 8]]) c.set(x, y, 'grass_hi'), c.set(x, y + 1, 'grass_lo');
  return c;
}

/** A round little bloom: four petals around a centre. */
function bloom(c, x, y, petal, centre = 'yellow') {
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) c.set(x + dx, y + dy, petal);
  c.set(x, y, centre);
  c.set(x + 1, y + 1, 'leaf_lo');
}

function flowers() {
  const c = lawn(42);
  const blooms = [[8, 7, 'pink'], [13, 4, 'lilac'], [18, 6, 'white'], [23, 8, 'pink'], [12, 10, 'yellow'], [17, 11, 'lilac'], [20, 3, 'pink'], [5, 8, 'white']];
  for (const [x, y, p] of blooms) bloom(c, x, y, p, p === 'yellow' ? 'orange' : 'yellow');
  return c;
}

function gravel() {
  const { c, I } = flatTile();
  I.top(0, 0, 1, 1, 0, (u, v, x, y) => {
    const n = hash(x, y, 43);
    return n < 0.18 ? 'gravel_lo' : n > 0.82 ? 'gravel_hi' : 'gravel';
  });
  // A few round pebbles: lit on top, shaded below.
  for (const [x, y] of [[10, 6], [19, 8], [14, 10], [22, 5], [7, 8]]) {
    c.set(x, y, 'gravel_hi');
    c.set(x + 1, y, 'gravel_hi');
    c.set(x, y + 1, 'gravel_lo');
    c.set(x + 1, y + 1, 'gravel_lo');
  }
  return c;
}

function burrow() {
  const c = grass();
  c.shade((x, y) => {
    const dx = (x + 0.5 - 16) / 10;
    const dy = (y + 0.5 - 8) / 5;
    const r = dx * dx + dy * dy;
    if (r < 0.4) return dy < -0.15 ? 'outline' : 'soil_lo'; // the hole, darker at the back
    if (r < 1) return dy < 0 ? 'soil' : 'soil_hi'; // a mound of dug earth
    return null;
  });
  // Pebbles and a stray clover leaf on the mound.
  c.set(9, 9, 'gravel');
  c.set(22, 7, 'gravel');
  c.set(20, 11, 'leaf');
  return c;
}

/** The fox's den: a dark hollow under an arch of roots, with leaf litter around it. */
function den() {
  const c = lawn(56);
  c.shade((x, y) => {
    const dx = (x + 0.5 - 15) / 11;
    const dy = (y + 0.5 - 9) / 5.5;
    const r = dx * dx + dy * dy;
    if (r < 0.45) return dy < 0.2 ? 'outline' : 'soil_lo'; // the hollow, deep at the back
    if (r < 1) return hash(x, y, 57) < 0.3 ? 'soil_lo' : 'soil'; // trodden earth
    return null;
  });
  // Gnarled roots arching over the back of the hollow.
  for (const [x, y] of [[7, 7], [8, 6], [9, 5], [10, 5], [11, 4], [12, 4], [13, 4], [14, 4], [15, 5], [16, 5], [17, 6], [18, 6], [19, 7], [20, 8]]) c.set(x, y, 'soil_hi');
  for (const [x, y] of [[12, 5], [13, 6], [17, 7], [18, 8]]) c.set(x, y, 'soil');
  // Fallen leaves and a lost feather.
  for (const [x, y, k] of [[5, 9, 'orange_lo'], [24, 10, 'leaf_lo'], [21, 12, 'orange'], [9, 12, 'leaf_lo'], [26, 8, 'orange_lo']]) c.set(x, y, k);
  c.set(18, 11, 'white'), c.set(19, 11, 'white_lo');
  return c;
}

function carrotPatch() {
  const { c, I } = flatTile();
  I.top(0, 0, 1, 1, 0, (u, v, x, y) => {
    const V = px(v);
    if (u < 0.06 || v < 0.06 || u >= 0.94 || v >= 0.94) return 'grass_lo'; // the bed's edge
    if (V % 5 === 2) return 'soil_lo'; // furrows
    return hash(x, y, 44) < 0.12 ? 'soil_hi' : 'soil';
  });
  // Carrot tops: an orange shoulder under a leafy tuft.
  for (const [x, y] of [[11, 5], [17, 4], [9, 9], [15, 8], [21, 7], [13, 12], [19, 11]]) {
    c.set(x, y, 'orange');
    c.set(x + 1, y, 'orange_lo');
    c.set(x, y - 1, 'leaf');
    c.set(x + 1, y - 1, 'leaf_hi');
    c.set(x - 1, y - 2, 'leaf_hi');
    c.set(x + 1, y - 2, 'leaf');
  }
  return c;
}

function pond() {
  const { c, I } = flatTile();
  I.top(0, 0, 1, 1, 0, (u, v, x, y) => (hash(x, y, 45) < 0.06 ? 'water_lo' : 'water'));
  // Sparkles and gentle ripples.
  for (const [x, y, w] of [[10, 5, 3], [18, 9, 4], [14, 11, 2], [21, 6, 2]]) c.rect(x, y, w, 1, 'water_hi');
  for (const [x, y, w] of [[11, 6, 2], [19, 10, 2]]) c.rect(x, y, w, 1, 'water_lo');
  // A lily pad with a pink flower.
  for (const [x, y] of [[7, 8], [8, 8], [9, 8], [7, 9], [8, 9]]) c.set(x, y, 'leaf');
  c.set(9, 9, 'leaf_lo');
  c.set(8, 7, 'pink');
  return c;
}

// ── Blocks ────────────────────────────────────────────────────────────────

/** A block canvas with a lawn diamond under it (a raised tile replaces the ground). */
function onLawn(seed) {
  const b = blockTile();
  b.I.top(0, 0, 1, 1, 0, (u, v, x, y) => (hash(x, y, seed) < 0.1 ? 'grass_lo' : 'grass'));
  return b;
}

/** A round dome of leaves centred at (cx, cy) with radii (rx, ry), lit from the top-left. */
function dome(c, cx, cy, rx, ry, seed) {
  // Shade on the ground at the base.
  c.shade((x, y) => {
    const dx = (x + 0.5 - cx) / (rx - 1);
    const dy = (y + 0.5 - (cy + ry * 0.75)) / (ry * 0.45);
    return dx * dx + dy * dy < 1 ? 'leaf_lo' : null;
  });
  c.shade((x, y) => {
    const dx = (x + 0.5 - cx) / rx;
    const dy = (y + 0.5 - cy) / ry;
    const r = dx * dx + dy * dy;
    if (r >= 1) return null;
    const light = -dx * 0.6 - dy * 0.8; // top-left light
    const n = hash(x, y, seed);
    if (light > 0.45 + n * 0.2) return 'leaf_hi';
    if (light < -0.35 - n * 0.2 || r > 0.85) return 'leaf_lo';
    return n < 0.12 ? 'leaf_lo' : 'leaf';
  });
  return c;
}

function bush() {
  const { c } = onLawn(46);
  dome(c, 16, 19, 12, 9.5, 47);
  // A couple of round leaf clumps on top for a bumpy, cuddly outline.
  dome(c, 11, 14, 5, 4, 48);
  dome(c, 20, 13, 6, 4.5, 49);
  return c;
}

function berryBush() {
  const { c } = onLawn(50);
  dome(c, 16, 19, 12, 9.5, 51);
  dome(c, 15, 13, 7, 5, 52);
  // Strawberries (red with a light glint) and white blossoms.
  for (const [x, y] of [[9, 18], [14, 14], [20, 17], [12, 22], [22, 22], [17, 11], [18, 21]]) {
    c.set(x, y, 'red');
    c.set(x + 1, y, 'red');
    c.set(x, y + 1, 'red');
    c.set(x + 1, y + 1, 'pink_lo');
    c.set(x, y, 'pink');
  }
  for (const [x, y] of [[11, 12], [24, 19], [7, 21]]) c.set(x, y, 'white'), c.set(x + 1, y, 'yellow');
  return c;
}

/** A white picket fence post with rails running along both map axes, so neighbours join up. */
function fence() {
  const { c, I } = onLawn(53);
  const rail = (lit) => (a, z) => (px(z) % 8 === 7 ? 'white_lo' : lit ? 'white' : 'white_lo');
  // Rails along u (east–west), then along v (north–south), low and thin.
  I.box(0, 0.44, 1, 0.56, 0.2, 0.3, { left: rail(true), right: 'white_lo', top: 'white' });
  I.box(0.44, 0, 0.56, 1, 0.2, 0.3, { left: 'white', right: rail(false), top: 'white' });
  I.box(0, 0.44, 1, 0.56, 0.5, 0.6, { left: rail(true), right: 'white_lo', top: 'white' });
  I.box(0.44, 0, 0.56, 1, 0.5, 0.6, { left: 'white', right: rail(false), top: 'white' });
  // The picket: a post with a pointed (stepped) cap.
  I.box(0.38, 0.38, 0.62, 0.62, 0, 0.75, { left: 'white', right: 'white_lo', top: 'white' });
  I.box(0.44, 0.44, 0.56, 0.56, 0.75, 0.88, { left: 'white', right: 'white_lo', top: 'pink' });
  return c;
}

/**
 * A blue wheelbarrow full of earth. Drawn `s`, its wheel is at the front
 * (the screen-left face) and the handles reach back; drawn `w`, the wheel is
 * on the hidden up-left side and the handles come toward the viewer.
 */
function wheelbarrow(facing) {
  const { c, I } = onLawn(54);
  const tray = { left: (a, z) => (px(z) >= 13 ? 'blue' : 'blue_lo'), right: (a, z) => (px(z) >= 13 ? 'blue_lo' : 'outline'), top: 'soil' };
  const load = (u, v, x, y) => (hash(x, y, 55) < 0.25 ? 'soil_hi' : 'soil');
  if (facing === 's') {
    // Handles (north), legs, tray, then the wheel in front (south).
    I.box(0.3, 0.02, 0.36, 0.4, 0.38, 0.44, { left: 'soil_hi', right: 'soil', top: 'soil_hi' });
    I.box(0.64, 0.02, 0.7, 0.4, 0.38, 0.44, { left: 'soil_hi', right: 'soil', top: 'soil_hi' });
    I.box(0.32, 0.3, 0.36, 0.36, 0, 0.3, { left: 'outline', right: 'outline' });
    I.box(0.64, 0.3, 0.68, 0.36, 0, 0.3, { left: 'outline', right: 'outline' });
    I.box(0.2, 0.25, 0.8, 0.82, 0.3, 0.62, tray);
    I.top(0.24, 0.29, 0.76, 0.78, 0.62, load);
    I.south(0.94, 0.4, 0.6, 0, 0.36, (u, z) => {
      const r = Math.hypot((u - 0.5) * 2, (z - 0.18) * 1.8);
      return r < 0.14 ? 'white_lo' : r < 0.3 ? 'outline' : null;
    });
  } else {
    // Wheel at the back (west), tray, then the handles toward the viewer (east).
    I.east(0.08, 0.4, 0.6, 0, 0.36, (v, z) => {
      const r = Math.hypot((v - 0.5) * 2, (z - 0.18) * 1.8);
      return r < 0.3 ? 'outline' : null;
    });
    I.box(0.18, 0.2, 0.75, 0.8, 0.3, 0.62, tray);
    I.top(0.22, 0.24, 0.71, 0.76, 0.62, load);
    I.box(0.64, 0.32, 0.68, 0.36, 0, 0.3, { left: 'outline', right: 'outline' });
    I.box(0.64, 0.64, 0.68, 0.68, 0, 0.3, { left: 'outline', right: 'outline' });
    I.box(0.6, 0.3, 0.98, 0.36, 0.38, 0.44, { left: 'soil_hi', right: 'soil', top: 'soil_hi' });
    I.box(0.6, 0.64, 0.98, 0.7, 0.38, 0.44, { left: 'soil_hi', right: 'soil', top: 'soil_hi' });
  }
  return c;
}

// ── Characters ────────────────────────────────────────────────────────────
//
// Text grids, 16 wide, pasted so that the last row sits on row 21; the drop
// shadow is centred on row 22. Keys per character are below each set.

/** Paste `rows` bottom-aligned on row 21 (or `bottom`), outline, and add a shadow. */
function critter(rows, key, { bottom = 21, rx = 5, ry = 1.6 } = {}) {
  const body = new Canvas(16, 24);
  body.grid(0, bottom - rows.length + 1, rows, key);
  return finish(body, 'outline', 8, 22, rx, ry);
}

// Bunny: w white, W white (shaded side), p pink (inner ears, nose, cheeks),
// k eye, c cream belly, t tail.
const BUNNY = {
  se: [
    '....ww...ww.....',
    '...wpw...wpW....',
    '...wpw...wpW....',
    '...wpw...wpW....',
    '...wpw...wpW....',
    '....ww...wW.....',
    '...wwwwwwwwW....',
    '..wwwwwwwwwWW...',
    '..wkkwwwwkkWW...',
    '..wkkwwwwkkWW...',
    '..pwwwwpwwwWp...',
    '...wwwwwwwWW....',
    '....wwwwwWW.....',
    '...wwwccwwWW....',
    '..wwwccccwwWW...',
    '..wwwccccwwWW...',
    '...wwwccwwWW....',
    '..ww.wwwwW.WW...',
  ],
  s: [
    '...ww..ww.......',
    '..wpw..wpW......',
    '..wpw..wpW......',
    '..wpw..wpW......',
    '..wpw..wpW......',
    '...ww..wW.......',
    '..wwwwwwwW......',
    '.wwwwwwwwWW.....',
    '.wkkwwwkkwW.....',
    '.wkkwwwkkwWW....',
    'pwwpwwwwwWWWW...',
    '.wwwwwwwWWWWWW..',
    '..wwwwwwwWWWWW..',
    '..wccwwwwwWWWWt.',
    '.wcccwwwwwWWWWt.',
    '.wcccwwwwwWWWW..',
    '..wccwwwwwWWW...',
    '.ww..wwwW..WW...',
  ],
  ne: [
    '..ww............',
    '..wpw...........',
    '...wpw..........',
    '...wpw..ww......',
    '....wpwwpW......',
    '.....wwpW.......',
    '......wwwww.....',
    '.....wwwwwwww...',
    '.....wwwwwkkw...',
    '.....wwwwwkkwp..',
    '..wwwwwwwwwwwW..',
    '.wwwwwwwwwwwW...',
    'twwwwwwwwwcW....',
    'twwwwwwwwccW....',
    '.wwwwwwwwccW....',
    '.WwwwwwwwwWW....',
    '..WWWWWWWWW.....',
    '...WW....WWw....',
  ],
  w: [
    '..ww...ww.......',
    '.www...wwW......',
    '.www...wwW......',
    '..www..wwW......',
    '..www..wwW......',
    '...ww..wW.......',
    '..wwwwwwwW......',
    '.wwwwwwwwWW.....',
    '.kwwwwwwwWW.....',
    '.wwwwwwwwWWW....',
    '.wwwwwwwWWWW....',
    '..wwwwwwwwWWW...',
    '..wwwwwwwwWWWW..',
    '..wwwwwwwwWWWW..',
    '.wwwwwwwwwWtt...',
    '.wwwwwwwwwWtt...',
    '..wwwwwwwwWW....',
    '...ww.....WW....',
  ],
  nw: [
    '....ww...ww.....',
    '...www...wwW....',
    '...www...wwW....',
    '...www...wwW....',
    '...www...wwW....',
    '....ww...wW.....',
    '...wwwwwwwwW....',
    '..wwwwwwwwwWW...',
    '..wwwwwwwwwWW...',
    '..wwwwwwwwwWW...',
    '..wwwwwwwwwWW...',
    '...wwwwwwwWW....',
    '...wwwwwwwWWW...',
    '..wwwwwwwwwWWW..',
    '..wwwwwttwwWWW..',
    '..wwwwwttwwWWW..',
    '...wwwwwwwWWW...',
    '...WW.....WW....',
  ],
};
const bunnyKey = { w: 'white', W: 'white_lo', p: 'pink', k: 'outline', c: 'cream', t: 'white' };

// Cat: o orange, O orange (shaded side), c cream (muzzle, chest, paws),
// k eye, p pink nose and inner ears, s stripes.
const CAT = {
  se: [
    '...o.......o....',
    '..oop.....poO...',
    '..ooooooooooO...',
    '..oskkoookksO...',
    '..ookkcpckkOO...',
    '...occcccccO....',
    '....ooooooO.....',
    '...ooocccoOO..o.',
    '..oooocccoOOO.oO',
    '..soooccooOsO.o.',
    '..oooocccoOOOoO.',
    '..soooooooOsOO..',
    '..cc.oooooO.cc..',
  ],
  s: [
    '..o......o......',
    '.oop....poO.....',
    '.oooooooooO.....',
    '.okkoooookkO....',
    '.okkcpcckkOO....',
    '..occcccccO.....',
    '...ooooooO......',
    '..occcooooOO....',
    '.ooccooooosOO.o.',
    '.oocooooooOsO.oO',
    '.ooooooooooOOoO.',
    '.oooooooooOsOO..',
    '.cc..ooooO..cc..',
  ],
  ne: [
    '.........o...o..',
    '.........op.op..',
    '.........ooooo..',
    '.........oookko.',
    '.........ooookkcp',
    'O........oocccc.',
    'Oo......ooooo...',
    '.oo.ooooososoo..',
    '..oooooooooooO..',
    '..ososooooooooO.',
    '..OOoooooooccO..',
    '...OOOOOOOOOO...',
    '...cc.cc..cc.cc.',
  ],
  w: [
    '..o......o......',
    '.ooo....ooO.....',
    '.oooooooooO.....',
    '.koooooooooO....',
    '.cooosoosooO....',
    '..ooooooooO.....',
    '...ooooooO......',
    '..oooooooooO....',
    '.oosooooosoOO...',
    '.ooooooooooOO...',
    '.oosooooosoOOo..',
    '.oooooooooOOOoO.',
    '.cc..ooooO..ccO.',
  ],
  nw: [
    '...o.......o....',
    '..ooo.....ooO...',
    '..ooooooooooO...',
    '..oooosoosooO...',
    '..oooooooooOO...',
    '...oooooooOO....',
    '....ooooooO.....',
    '...oooooooOO....',
    '..oosoooosoOO...',
    '..ooooooooOOO...',
    '..oosoooosoOO...',
    '..oooooooooOO...',
    '..cc..oOOO..cc..',
  ],
};
// The tail curls up from behind (back views): drawn as part of the grids.
CAT.nw[8] = '..oosoooosoOO.o.';
CAT.nw[9] = '..ooooooooOOOoO.';
CAT.nw[10] = '..oosoooosoOOO..';
const catKey = { o: 'orange', O: 'orange_lo', c: 'cream', k: 'outline', p: 'pink', s: 'orange_lo' };

// Fox: r rust, R rust (shaded side), c cream (cheeks, muzzle, chest),
// w white tail tip and eye glint, k eye, n nose, d dark socks and ear tips.
const FOX = {
  s: [
    '.d........d.....',
    '.dd......dd.....',
    '.rcr....rcR.....',
    '.rccr..rccR.....',
    '.rrrrrrrrrR.....',
    'rrrrrrrrrrRR....',
    'rrkwrrrrkwRR....',
    'rrkkrrrrkkRR....',
    'ccrrrrrrrrcc....',
    '.ccrrccrrcc.....',
    '..cccccccc...ww.',
    '...ccnncc...wwww',
    '...rcccR...rrrrR',
    '..rrccccR..rrrR.',
    '..rrccccRRrrrR..',
    '..rrrccRRRrrR...',
    '..ddrrrRRdd.....',
    '..dd....dd......',
  ],
  se: [
    '...d........d...',
    '...dd......dd...',
    '...rcr....rcR...',
    '...rccr..rccR...',
    '...rrrrrrrrrR...',
    '..rrrrrrrrrrRR..',
    '..rrkwrrrrkwRR..',
    '..rrkkrrrrkkRR..',
    '..ccrrrrrrrrcc..',
    '...ccrrrccrcc...',
    '.w..ccccccccc...',
    'www..ccccnnc....',
    'wrrr.rcccRR.....',
    '.rrrrrccccRR....',
    '..rrrrcccRRR....',
    '...rrrrrRRRR....',
    '...ddrrRRdd.....',
    '...dd....dd.....',
  ],
  ne: [
    '..........d..d..',
    '.........dd.dd..',
    '.........rcrrc..',
    '.........rrrrrR.',
    '........rrrrwk..',
    '........rrrrkkcc',
    'ww......ccrrcccn',
    'wwr.....cccccc..',
    '.rrr.rrrrrrrr...',
    '..rrrrrrrrrrrR..',
    '..rrrrrrrrrrRR..',
    '...RRrrrrrrrcR..',
    '....RRRRRRRRR...',
    '....dd.dd.dd.dd.',
  ],
  w: [
    '......d.d.......',
    '.....drdrd......',
    '.....rcrcR......',
    '.....rcrrR......',
    '....rrrrrRR.....',
    '...rrwkrrrR.....',
    '..rrrkkrrrR.....',
    'ncccrrrrrrR.....',
    '.ccccccrrRR.....',
    '...cccccRR......',
    '....cccrrrrrr...',
    '....ccrrrrrrrRr.',
    '....ccrrrrrrRRrr',
    '....crrrrrrRRrrw',
    '....rrrrrrRRR.ww',
    '....ddrr..Rdd.w.',
    '....dd.....dd...',
  ],
  nw: [
    '..d.......d.....',
    '.dd.......dd....',
    '.rrr.....rrR....',
    '.rrrr...rrrR....',
    '.rrrrrrrrrrR....',
    '.rrrrrrrrrrR....',
    'crrrrrrrrrrRc...',
    '.crrrrrrrrRc....',
    '..rrrrrrrRR.....',
    '...rrrrrrR......',
    '..rrrrrrrRR.....',
    '..rrrrrrrRRR.rr.',
    '..rrrrrrrRRRrrrR',
    '..rrrrrrrRRRrrR.',
    '..rrrrRRRRRRrw..',
    '..ddrrrrRRddww..',
    '..dd.....dd.....',
  ],
};
const foxKey = { r: 'rust', R: 'rust_lo', c: 'cream', w: 'white', k: 'outline', n: 'outline', d: 'soil_lo' };

// Butterfly: l lilac wing, L lilac (shaded), y yellow spot, b body, a antenna.
const BUTTERFLY = {
  se: [
    '.....a....a.....',
    '......a..a......',
    '.lll...bb...lll.',
    'lllyl..bb..lylLL',
    'llyyll.bb.llyyLL',
    '.llllllbbllllLL.',
    '..llll.bb.llLL..',
    '..lyl..bb..lyL..',
    '...l...bb...L...',
  ],
  s: [
    '....a...a.......',
    '.....a.a........',
    'lll...bb....lll.',
    'llyl..bb...lylL.',
    'lyyll.bb..llyyL.',
    'lllllbbbllllLL..',
    '.llll.bb.llLL...',
    '.lyl..bb..lyL...',
    '..l...b....L....',
  ],
  ne: [
    '..............a.',
    '.............a..',
    '....lll.....a...',
    '...lllyl...bb...',
    '...llyyllbbb....',
    '....llllbbbb....',
    '.....lllLbb.....',
    '.....lyLL.......',
    '......L.........',
  ],
  w: [
    '.......a...a....',
    '........a.a.....',
    '.lll....bb...lll',
    'lllll...bb..lllL',
    'llllll..bb.llllL',
    '.lllllllbbllllL.',
    '..llll..bb.llL..',
    '..lll...bb..lL..',
    '...l....b....L..',
  ],
  nw: [
    '.....a....a.....',
    '......a..a......',
    '.lll...bb...lll.',
    'lllll..bb..llllL',
    'llllll.bb.lllllL',
    '.llllllbbllllll.',
    '..llll.bb.lllL..',
    '..lll..bb..llL..',
    '...l...bb...L...',
  ],
};
const butterflyKey = { l: 'lilac', L: 'lilac_lo', y: 'yellow', b: 'outline', a: 'outline' };

/** A small flier hovering above its shadow (like the vampire pack's bat). */
function butterfly(facing) {
  const body = new Canvas(16, 24);
  body.grid(0, 5, BUTTERFLY[facing], butterflyKey);
  // Only the wings get an outline (the body and antennae are already dark).
  return finish(body, 'outline', 8, 21.5, 3, 1);
}

// ── Items ─────────────────────────────────────────────────────────────────

const K = { o: 'orange', O: 'orange_lo', g: 'leaf_hi', G: 'leaf', r: 'red', R: 'pink_lo', y: 'yellow', s: 'soil_hi', S: 'soil', w: 'white', W: 'white_lo', p: 'pink', l: 'leaf_lo' };

const ITEMS = {
  carrot: ['......gG', '.....gGg', '..ooooO.', '.oooOO..', 'ooOO....', 'O.......'],
  clover: ['.gg.gg.', 'gGGgGGg', '.gGGGg.', 'gGGgGGg', '.gg.gg.', '...l...', '....l..'],
  strawberry: ['..gGg..', '.rrrrr.', 'rryrrRr', 'rrrryRr', '.rrRRR.', '..rRR..'],
  acorn: ['.sSSs.', 'sSSSSS', '.oOOO.', '.oOOO.', '..OO..'],
  feather: ['.......w', '.....wWw', '...wwWw.', '.wwWWw..', 'wwWw....', 'w.......'],
};
// Acorn nut in brown, not orange.
ITEMS.acorn = ['..S...', '.sSSs.', 'sSSSSS', '.ssSs.', '.sSSS.', '..SS..'];

export function images() {
  const furn = (name, draw) => ['s', 'w'].map((f) => ({ file: `${name}_${f}.svg`, canvas: draw(f), note: `block, facing ${f}` }));
  return [
    { file: 'grass.svg', canvas: grass(), note: 'flat tile' },
    { file: 'flowers.svg', canvas: flowers(), note: 'flat tile' },
    { file: 'gravel.svg', canvas: gravel(), note: 'flat tile' },
    { file: 'burrow.svg', canvas: burrow(), note: 'flat tile' },
    { file: 'den.svg', canvas: den(), note: 'flat tile' },
    { file: 'carrot_patch.svg', canvas: carrotPatch(), note: 'flat tile' },
    { file: 'pond.svg', canvas: pond(), note: 'flat tile' },
    { file: 'bush.svg', canvas: bush(), note: 'block' },
    { file: 'berry_bush.svg', canvas: berryBush(), note: 'block' },
    { file: 'fence.svg', canvas: fence(), note: 'block' },
    ...furn('wheelbarrow', wheelbarrow),
    ...FACINGS.map((f) => ({ file: `bunny_${f}.svg`, canvas: critter(BUNNY[f], bunnyKey), note: `facing ${f}` })),
    ...FACINGS.map((f) => ({ file: `cat_${f}.svg`, canvas: critter(CAT[f], catKey, { rx: 6 }), note: `facing ${f}` })),
    ...FACINGS.map((f) => ({ file: `fox_${f}.svg`, canvas: critter(FOX[f], foxKey, { rx: 6 }), note: `facing ${f}` })),
    ...FACINGS.map((f) => ({ file: `butterfly_${f}.svg`, canvas: butterfly(f), note: `facing ${f}` })),
    ...Object.entries(ITEMS).map(([id, rows]) => ({ file: `${id}.svg`, canvas: item(rows, K, 'outline'), note: 'ground pile' })),
  ];
}
