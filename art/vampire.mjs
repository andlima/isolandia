// vampire: a gothic mansion, its crypt, the vampire and the bats.

import { bat, humanoid, item, FACINGS } from './characters.mjs';
import { blockTile, flatTile, hash, px } from './lib.mjs';

export const palette = {
  outline: '#16121a',
  shadow: ['#000000', 0.3],
  crimson_hi: '#b03040',
  crimson: '#8b1e2d',
  crimson_lo: '#661622',
  gold: '#d0a848',
  board_hi: '#9a5c48',
  board: '#7a4234',
  board_lo: '#5a2e26',
  sun_hi: '#f6e8b0',
  sun: '#e8d27a',
  stone_hi: '#8e86a0',
  stone: '#6c6480',
  stone_lo: '#4e4860',
  crypt: '#3e3650',
  blood: '#c0182c',
  blood_lo: '#80101e',
  ebony_hi: '#6a4a38',
  ebony: '#4a3426',
  ebony_lo: '#33231a',
  oak_hi: '#b08850',
  oak: '#8a6a3a',
  oak_lo: '#644a28',
  glass: ['#8cc0ec', 0.65],
  bottle: '#2e5a3a',
  tome: '#3a4a7a',
  pale: '#e4e2f2',
  pale_lo: '#b0aec8',
  cape: '#2a2836',
  bat: '#7a5c8a',
  bat_lo: '#563e66',
  wax: '#f0e8c0',
};

// ── Flat tiles ────────────────────────────────────────────────────────────

function carpet() {
  const { c, I } = flatTile();
  I.top(0, 0, 1, 1, 0, (u, v, x, y) => {
    const [U, V] = [px(u), px(v)];
    if (U === 1 || V === 1 || U === 14 || V === 14) return 'gold'; // border
    if ((U + V) % 8 === 0 || Math.abs(U - V) % 8 === 4) return 'crimson_lo'; // diamond lattice
    return hash(x, y, 31) < 0.05 ? 'crimson_hi' : 'crimson';
  });
  return c;
}

/** Floorboards running along u; `lit` brightens them as a sunbeam. */
function boards(seed, lit) {
  const { c, I } = flatTile();
  I.top(0, 0, 1, 1, 0, (u, v, x, y) => {
    const [U, V] = [px(u), px(v)];
    const plank = Math.floor(V / 4);
    if (V % 4 === 3) return lit ? 'sun' : 'board_lo'; // gaps
    if ((U + plank * 5) % 16 === 0) return lit ? 'sun' : 'board_lo'; // butt joints
    if (lit) return hash(x, y, seed) < 0.08 ? 'sun' : 'sun_hi';
    return hash(x, y, seed) < 0.1 ? 'board_hi' : 'board';
  });
  return c;
}

function creaky() {
  const c = boards(32, false);
  // Sprung, warped boards: lighter raised edges and a dark crack.
  for (const [x, y] of [[12, 6], [13, 6], [14, 7], [19, 9], [20, 9]]) c.set(x, y, 'board_hi');
  for (const [x, y] of [[13, 7], [15, 7], [16, 8], [20, 10]]) c.set(x, y, 'board_lo');
  return c;
}

function crypt() {
  const { c, I } = flatTile();
  I.top(0, 0, 1, 1, 0, (u, v, x, y) => {
    const [U, V] = [px(u), px(v)];
    if (U % 8 === 0 || (V + (Math.floor(U / 8) % 2) * 4) % 8 === 0) return 'outline'; // flagstone joints
    return hash(x, y, 33) < 0.08 ? 'stone_lo' : 'crypt';
  });
  return c;
}

/** A shallow stone basin of blood set into crypt flagstones. */
function font() {
  const c = crypt();
  c.shade((x, y) => {
    const dx = (x + 0.5 - 16) / 11;
    const dy = (y + 0.5 - 8) / 5.5;
    const r = dx * dx + dy * dy;
    if (r < 0.45) return dy < -0.2 && dx < 0 ? 'blood' : r < 0.2 ? 'blood' : 'blood_lo';
    if (r < 1) return dy < 0 ? 'stone_lo' : 'stone_hi'; // rim: lit near edge, inner wall in shade
    return null;
  });
  c.set(13, 6, 'pale');
  c.set(14, 6, 'pale');
  return c;
}

// ── Blocks ────────────────────────────────────────────────────────────────

/** A stone wall with a tall gothic window on both visible faces. */
function windowBlock() {
  const { c, I } = blockTile();
  const face = (lit) => (a, z) => {
    const [A, Z] = [px(a), px(z)];
    const inArch = A >= 4 && A <= 11 && Z >= 2 && Z <= 13 - (A <= 4 || A >= 11 ? 1 : 0) - (A <= 5 || A >= 10 ? 1 : 0);
    if (inArch) return A === 7 || A === 8 || Z === 8 ? 'outline' : 'glass'; // leaded panes
    if (Z % 4 === 3 || (A + (Math.floor(Z / 4) % 2) * 4) % 8 === 0) return lit ? 'stone_lo' : 'crypt';
    return lit ? 'stone' : 'stone_lo';
  };
  I.box(0, 0, 1, 1, 0, 1, { left: face(true), right: face(false), top: (u, v) => (px(u) === 0 || px(v) === 0 ? 'stone' : 'stone_hi') });
  return c;
}

/**
 * Oriented furniture on a full-cell footprint, as in art/zombie.mjs:
 * `front(A, Z)`/`side(A, Z, lit)`/`back` get art-px face coordinates and
 * `top(a, b)` object-space top coordinates (b = 0 at the back).
 */
function furniture(facing, h, { front, side, back = side, top }) {
  const { c, I } = blockTile();
  const p2 = (f) => (a, z, lit) => f(px(a), px(z), lit);
  if (facing === 's') {
    I.box(0, 0, 1, 1, 0, h, { left: (u, z) => p2(front)(u, z, true), right: (v, z) => p2(side)(v, z, false), top: (u, v) => top(u, v) });
  } else {
    I.box(0, 0, 1, 1, 0, h, { left: (u, z) => p2(side)(1 - u, z, true), right: (v, z) => p2(back)(1 - v, z, false), top: (u, v) => top(v, 1 - u) });
  }
  return c;
}

/** Coffin on a stone bier; its head end (with a gold cross) is the front. */
function coffin(facing) {
  const { c, I } = blockTile();
  const bier = { left: 'stone', right: 'stone_lo', top: 'stone_hi' };
  const H0 = 0.25;
  const H1 = 0.5;
  const lid = (a, b) => {
    const [A, B] = [px(a), px(b)];
    if ((A === 7 || A === 8) && B >= 2 && B <= 6) return 'gold'; // cross: upright
    if (B === 3 && A >= 5 && A <= 10) return 'gold'; // cross: bar
    return A === 2 || A === 13 ? 'ebony' : 'ebony_hi';
  };
  I.box(0, 0, 1, 1, 0, H0, bier);
  if (facing === 's') {
    // Head at the south (front), tapering toward the foot at the north.
    I.box(0.19, 0.06, 0.81, 0.94, H0, H1, {
      left: (u, z) => (px(z) === 7 ? 'gold' : 'ebony'),
      right: (v, z) => (px(z) === 7 ? 'oak_lo' : 'ebony_lo'),
      top: (u, v) => lid((u - 0.19) / 0.62, 1 - (v - 0.06) / 0.88),
    });
  } else {
    I.box(0.06, 0.19, 0.94, 0.81, H0, H1, {
      left: (u, z) => (px(z) === 7 ? 'gold' : 'ebony'),
      right: (v, z) => (px(z) === 7 ? 'oak_lo' : 'ebony_lo'),
      top: (u, v) => lid((v - 0.19) / 0.62, (u - 0.06) / 0.88),
    });
  }
  return c;
}

const BOOKS = ['crimson', 'tome', 'bottle', 'oak_hi', 'crimson_lo', 'gold'];

const bookshelf = (f) =>
  furniture(f, 1, {
    front: (A, Z) => {
      if (A === 0 || A === 15 || Z === 0 || Z >= 15 || Z % 5 === 0) return 'ebony_lo'; // carcass and shelves
      if (Z % 5 === 4 && A % 5 === 2) return 'ebony'; // a gap above some books
      return BOOKS[(A * 7 + Math.floor(Z / 5) * 3) % BOOKS.length];
    },
    side: (A, Z, lit) => (Z === 0 ? 'ebony_lo' : lit ? 'ebony' : 'ebony_lo'),
    top: () => 'ebony_hi',
  });

const chest = (f) =>
  furniture(f, 0.5, {
    front: (A, Z) => {
      if (A === 2 || A === 13 || Z === 0 || Z === 5) return 'gold'; // iron-bound, gilded bands
      if ((A === 7 || A === 8) && Z >= 3 && Z <= 4) return 'outline'; // lock
      return Z > 5 ? 'oak_hi' : 'oak';
    },
    side: (A, Z, lit) => (A === 2 || A === 13 || Z === 0 || Z === 5 ? (lit ? 'gold' : 'oak_lo') : lit ? 'oak' : 'oak_lo'),
    top: (a, b) => (px(a) === 2 || px(a) === 13 ? 'gold' : px(b) === 15 ? 'oak' : 'oak_hi'),
  });

const wineRack = (f) =>
  furniture(f, 1, {
    front: (A, Z) => {
      if (A === 0 || A === 15 || Z === 0 || Z >= 15) return 'ebony_lo';
      // Diamond lattice of cubbies, each holding a bottle seen end-on.
      const [i, j] = [A % 4, Z % 4];
      if (i === 0 || j === 0) return 'ebony';
      return i === 2 && j === 2 ? 'blood_lo' : 'bottle';
    },
    side: (A, Z, lit) => (Z === 0 ? 'ebony_lo' : lit ? 'ebony' : 'ebony_lo'),
    top: (a, b) => (px(b) % 4 === 0 ? 'ebony' : 'ebony_hi'),
  });

// ── Characters ────────────────────────────────────────────────────────────

const vampireKey = { H: 'cape', h: 'outline', s: 'pale', S: 'pale_lo', k: 'blood', t: 'cape', T: 'outline', p: 'cape', P: 'outline', f: 'outline', x: 'crimson', X: 'crimson_lo', y: 'stone_lo', Y: 'cape', w: 'pale' };
const vampire = {
  outline: 'outline',
  key: vampireKey,
  // The cape behind the body, its red lining showing at the edges, and a high collar.
  under: {
    se: { 9: '....X......X....', 10: '....XX....XX....', 11: '....x......x....', ...cape('...x........x...', 12, 21) },
    s: { 9: '...X.....X......', 10: '...XX...XX......', ...cape('...x.......xx...', 11, 21) },
    ne: { 9: '.....X..........', 10: '....XX..........', ...cape('...xx...........', 11, 21) },
  },
  over: {
    // A white shirt front and crimson cravat.
    se: { 11: '.......ww.......', 12: '.......xx.......' },
    s: { 11: '......ww........', 12: '......xx........' },
    ne: { 11: '.........w......' },
    // From behind the cape (with darker folds) hides the body.
    w: { 7: '...X......X.....', 8: '...XX....XX.....', 9: '...yy....yy.....', 10: '....y...yy......', ...cape('...yyYyyYyyy....', 11, 21) },
    nw: { 7: '....X......X....', 8: '....XX....XX....', 9: '....yy....yy....', 10: '.....y....y.....', ...cape('...yyYyyYyyYy...', 11, 21) },
  },
};
/** The same cape row repeated over rows [from, to]. */
function cape(row, from, to) {
  return Object.fromEntries(Array.from({ length: to - from + 1 }, (_, i) => [from + i, row]));
}
// Widow's peak on the front views.
vampire.over.se[7] = '.....HsHHsH.....';
vampire.over.s[7] = '....sHHssH......';

const batLook = { outline: 'outline', key: { w: 'bat', W: 'bat_lo', b: 'bat', B: 'bat_lo', k: 'blood' } };

// ── Items ─────────────────────────────────────────────────────────────────

const K = { g: 'glass', r: 'blood', R: 'blood_lo', o: 'oak_hi', O: 'oak', c: 'cape', C: 'outline', x: 'crimson', X: 'crimson_lo', b: 'bottle', l: 'pale', t: 'tome', T: 'outline', G: 'gold', W: 'wax', y: 'sun', e: 'ebony' };

const ITEMS = {
  blood_vial: ['.....oo.', '..gggoo.', '.grrrrg.', 'grrrrrg.', 'gRRRRg..', '.ggg....'],
  cloak: ['...cccc....', '.ccccccxc..', 'cccxxccccc.', 'ccccccxxccc', '.cccccccccC', '..CCCCCCC..'],
  wine: ['...........', 'GG.bbbbbbb.', 'bbbbllllbbb', '.bbbxxxxbbb', '...bbbbbbb.'],
  tome: ['...tttttt..', '.ttttGtttt.', 'ttttGGGtttl', 'llllllllll.', '.TTTTTTTT..'],
  candle: ['..y..', '.yWy.', '..C..', '.WWW.', '.WWW.', '.WWW.', 'eeeee'],
};

export function images() {
  const furn = (name, draw) => ['s', 'w'].map((f) => ({ file: `${name}_${f}.svg`, canvas: draw(f), note: `block, facing ${f}` }));
  return [
    { file: 'carpet.svg', canvas: carpet(), note: 'flat tile' },
    { file: 'creaky.svg', canvas: creaky(), note: 'flat tile' },
    { file: 'sunbeam.svg', canvas: boards(34, true), note: 'flat tile' },
    { file: 'crypt.svg', canvas: crypt(), note: 'flat tile' },
    { file: 'font.svg', canvas: font(), note: 'flat tile' },
    { file: 'window.svg', canvas: windowBlock(), note: 'block' },
    ...furn('coffin', coffin),
    ...furn('bookshelf', bookshelf),
    ...furn('chest', chest),
    ...furn('wine_rack', wineRack),
    ...FACINGS.map((f) => ({ file: `vampire_${f}.svg`, canvas: humanoid(f, vampire), note: `facing ${f}` })),
    ...FACINGS.map((f) => ({ file: `bat_${f}.svg`, canvas: bat(f, batLook), note: `facing ${f}` })),
    ...Object.entries(ITEMS).map(([id, rows]) => ({ file: `${id}.svg`, canvas: item(rows, K, 'outline'), note: 'ground pile' })),
  ];
}
