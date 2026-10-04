// zombie: suburban town, wrecks, kitchen furniture, survivors and the dead.

import { crawler, humanoid, item, FACINGS } from './characters.mjs';
import { blockTile, flatTile, hash, px } from './lib.mjs';

export const palette = {
  outline: '#1e1c20',
  shadow: ['#000000', 0.3],
  asphalt_hi: '#76767a',
  asphalt: '#606064',
  asphalt_lo: '#4c4c50',
  paint: '#d8c050',
  grass_hi: '#74b052',
  grass: '#55923c',
  grass_lo: '#3e722c',
  rust_hi: '#c4503a',
  rust: '#9c3a2a',
  rust_lo: '#702a20',
  glass: '#a8d8e8',
  glass_lo: '#6a9ab0',
  white_hi: '#f2f2f6',
  white: '#d2d4dc',
  white_lo: '#a6a8b4',
  wood_hi: '#c89a5a',
  wood: '#a07242',
  wood_lo: '#765232',
  wood_dk: '#523a22',
  skin: '#e0b088',
  skin_lo: '#b88464',
  zskin: '#9cc47a',
  zskin_lo: '#6a9a4c',
  cloth: '#5a7aaa',
  cloth_lo: '#405c84',
  khaki: '#aa9c72',
  khaki_lo: '#807452',
  dark: '#3a3a40',
  red: '#c42a2a',
  purple: '#8e6fb5',
};

const frac = (x) => x - Math.floor(x);
/** Distance in art px between two points of a side face (`a` along it, `z` up). */
const facePx = (a, z, ac, zc) => Math.hypot((a - ac) * 16, (z - zc) * 16);

// ── Flat tiles ────────────────────────────────────────────────────────────

function road() {
  const { c, I } = flatTile();
  I.top(0, 0, 1, 1, 0, (u, v, x, y) => {
    const n = hash(x, y, 11);
    // A hairline crack running roughly along u.
    if (Math.abs(v - 0.62 - 0.08 * Math.sin(u * 9)) < 0.03 && u > 0.2 && u < 0.85) return 'asphalt_lo';
    return n < 0.1 ? 'asphalt_lo' : n > 0.93 ? 'asphalt_hi' : 'asphalt';
  });
  return c;
}

function grass() {
  const { c, I } = flatTile();
  I.top(0, 0, 1, 1, 0, (u, v, x, y) => {
    const n = hash(x, y, 12);
    return n < 0.12 ? 'grass_lo' : n > 0.9 ? 'grass_hi' : 'grass';
  });
  // Tufts: a light blade over a dark root.
  for (const [x, y] of [[9, 7], [20, 5], [15, 11], [24, 9], [12, 4], [6, 9]]) c.set(x, y, 'grass_hi'), c.set(x, y + 1, 'grass_lo');
  return c;
}

function glass() {
  const { c, I } = flatTile();
  I.top(0, 0, 1, 1, 0, (u, v, x, y) => (u < 0.06 || v < 0.06 ? 'asphalt' : hash(x, y, 13) < 0.08 ? 'asphalt' : 'asphalt_hi'));
  // Shards: a glint over a darker body.
  for (const [x, y, w] of [[10, 6, 3], [18, 4, 2], [21, 9, 3], [13, 10, 2], [16, 7, 2], [7, 8, 2]]) {
    c.rect(x, y, w, 1, 'glass');
    c.set(x + w - 1, y + 1, 'glass_lo');
  }
  for (const [x, y] of [[11, 6], [22, 9], [19, 4]]) c.set(x, y, 'white_hi');
  return c;
}

// ── Blocks ────────────────────────────────────────────────────────────────

function crate() {
  const { c, I } = blockTile();
  const side = (lit) => (a, z) => {
    const [A, Z] = [px(a), px(z)];
    const dark = lit ? 'wood_lo' : 'wood_dk';
    if (Z === 0 || Z >= 8 || A <= 1 || A >= 14) return dark; // frame
    if (Math.abs(A - 2 - (Z - 1) * 1.7) < 1) return dark; // brace
    return Z === 4 ? dark : lit ? 'wood' : 'wood_lo'; // plank gap
  };
  I.box(0, 0, 1, 1, 0, 0.5625, {
    left: side(true),
    right: side(false),
    top: (u, v) => (px(u) <= 1 || px(v) <= 1 || px(u) >= 14 || px(v) >= 14 ? 'wood' : px(u) % 4 === 0 ? 'wood_lo' : 'wood_hi'),
  });
  return c;
}

/**
 * A house wall with a window on both visible faces; `boarded` nails planks
 * over the glass (the `barricade` action's result).
 */
function windowWall(boarded) {
  const { c, I } = blockTile();
  const face = (lit) => (a, z) => {
    const [A, Z] = [px(a), px(z)];
    if (A >= 4 && A <= 11 && Z >= 4 && Z <= 12) {
      if (A === 4 || A === 11 || Z === 4 || Z === 12) return lit ? 'wood' : 'wood_lo'; // frame
      if (boarded) {
        // Two planks across, each held by a nail at both ends.
        const plank = Z === 6 || Z === 7 ? 0 : Z === 9 || Z === 10 ? 1 : -1;
        if (plank >= 0) return (A === 5 || A === 10) && (Z === 6 || Z === 9) ? 'dark' : lit ? 'wood_hi' : 'wood';
        return 'outline';
      }
      if (A === 7 || A === 8 || Z === 8) return lit ? 'white' : 'white_lo'; // muntins
      return lit ? 'glass' : 'glass_lo';
    }
    if (Z % 4 === 3 || (A + (Math.floor(Z / 4) % 2) * 4) % 8 === 0) return lit ? 'white_lo' : 'khaki_lo'; // mortar
    return lit ? 'white' : 'white_lo';
  };
  I.box(0, 0, 1, 1, 0, 1, { left: face(true), right: face(false), top: (u, v) => (px(u) === 0 || px(v) === 0 ? 'white' : 'white_hi') });
  return c;
}

function wheel(a, z, ac) {
  const d = facePx(a, z, ac, 0.12);
  return d < 1.2 ? 'white_lo' : d < 3.6 ? 'dark' : null;
}

/** A wrecked car; `along` 'v' points it s (headlights on the left face), 'u' points it w. */
function car(along) {
  const { c, I } = blockTile();
  const spots = (x, y, base) => (hash(x, y, 21) < 0.05 ? 'rust_lo' : base);
  if (along === 'v') {
    I.box(0.1, 0, 0.9, 1, 0, 0.42, {
      left: (u, z, x, y) => {
        if (z < 0.12) return 'dark'; // bumper
        if (z > 0.22 && z < 0.32 && (Math.abs(u - 0.22) < 0.06 || Math.abs(u - 0.78) < 0.06)) return u < 0.5 ? 'paint' : 'asphalt_lo'; // headlights, one smashed
        if (z > 0.16 && z < 0.3 && u > 0.36 && u < 0.64) return frac(u * 12) < 0.5 ? 'dark' : 'asphalt'; // grille
        return spots(x, y, 'rust');
      },
      right: (v, z, x, y) => wheel(v, z, 0.2) ?? wheel(v, z, 0.82) ?? (z < 0.06 ? 'dark' : px(v) === 8 ? 'rust_lo' : spots(x, y, 'rust_lo')),
      top: (u, v, x, y) => (v > 0.94 ? 'rust' : spots(x, y, 'rust_hi')),
    });
    I.box(0.2, 0.28, 0.8, 0.74, 0.42, 0.74, {
      left: (u, z, x, y) => (u < 0.27 || u >= 0.73 || z >= 0.66 ? 'rust' : hash(x, y, 22) < 0.15 ? 'white_hi' : 'glass'), // windscreen, cracked
      right: (v, z) => (v < 0.34 || v >= 0.68 || z >= 0.66 || px(v) === 8 ? 'rust_lo' : 'glass_lo'),
      top: (u, v, x, y) => spots(x, y, 'rust_hi'),
    });
  } else {
    I.box(0, 0.1, 1, 0.9, 0, 0.42, {
      left: (u, z, x, y) => wheel(u, z, 0.2) ?? wheel(u, z, 0.8) ?? (z < 0.06 ? 'dark' : px(u) === 8 ? 'rust_lo' : spots(x, y, 'rust')),
      right: (v, z, x, y) => {
        if (z < 0.12) return 'dark'; // rear bumper
        if (z > 0.22 && z < 0.32 && (Math.abs(v - 0.22) < 0.07 || Math.abs(v - 0.78) < 0.07)) return 'red'; // tail lights
        return spots(x, y, 'rust_lo');
      },
      top: (u, v, x, y) => (u < 0.06 ? 'rust' : spots(x, y, 'rust_hi')),
    });
    I.box(0.26, 0.2, 0.72, 0.8, 0.42, 0.74, {
      left: (u, z) => (u < 0.32 || u >= 0.66 || z >= 0.66 || px(u) === 8 ? 'rust' : 'glass'),
      right: (v, z) => (v < 0.27 || v >= 0.73 || z >= 0.66 ? 'rust_lo' : 'glass_lo'),
      top: (u, v, x, y) => spots(x, y, 'rust_hi'),
    });
  }
  return c;
}

/**
 * Oriented furniture on a full-cell footprint: `front(a, z)` shades the
 * front face, `side(a, z, lit)` the others, `top(u, v)` the top. `facing`
 * 's' puts the front on the left (south) face; 'w' on the hidden west face,
 * so the visible faces are the side (left) and the back (right).
 */
function furniture(facing, h, { front, side, back = side, top }) {
  const { c, I } = blockTile();
  if (facing === 's') {
    I.box(0, 0, 1, 1, 0, h, { left: (u, z) => front(u, z, true), right: (v, z) => side(v, z, false), top: (u, v) => top(u, v) });
  } else {
    // Seen from the west the object's own axes swap: its front is at u = 0.
    I.box(0, 0, 1, 1, 0, h, { left: (u, z) => side(1 - u, z, true), right: (v, z) => back(1 - v, z, false), top: (u, v) => top(v, 1 - u) });
  }
  return c;
}

/** A kitchen stove (the `heat` station of the recipes): oven door in front, four burners on top. */
function stove() {
  const { c, I } = blockTile();
  I.box(0, 0, 1, 1, 0, 0.625, {
    left: (u, z) => {
      const [A, Z] = [px(u), px(z)];
      if (Z === 0) return 'dark';
      if (Z === 9 && (A === 4 || A === 8 || A === 12)) return 'dark'; // knobs
      if (A >= 3 && A <= 12 && Z >= 2 && Z <= 7) return A === 3 || A === 12 || Z === 2 || Z === 7 ? 'white_lo' : 'asphalt_lo'; // oven window
      return A === 0 || A === 15 || Z === 8 ? 'white_lo' : 'white';
    },
    right: (v, z) => (px(z) === 0 ? 'dark' : 'white_lo'),
    top: (u, v) => {
      const [U, V] = [px(u), px(v)];
      const ring = (cu, cv) => Math.max(Math.abs(U - cu), Math.abs(V - cv));
      const near = Math.min(ring(4, 4), ring(11, 4), ring(4, 11), ring(11, 11));
      if (near === 0) return ring(4, 11) === 0 ? 'red' : 'asphalt';
      if (near <= 2) return 'dark';
      return 'white_hi';
    },
  });
  return c;
}

const fridge = (f) =>
  furniture(f, 1, {
    front: (a, z) => {
      const [A, Z] = [px(a), px(z)];
      if (Z === 0) return 'dark';
      if (Z === 10 || A === 0 || A === 15) return 'white_lo'; // freezer door gap, edges
      if (A >= 12 && A <= 13 && ((Z >= 11 && Z <= 13) || (Z >= 4 && Z <= 8))) return 'dark'; // handles
      return 'white';
    },
    side: (a, z, lit) => (px(z) === 0 ? 'dark' : lit ? 'white' : 'white_lo'),
    back: (a, z) => {
      const [A, Z] = [px(a), px(z)];
      return Z === 0 || (Z % 2 === 0 && A >= 3 && A <= 12 && Z >= 2 && Z <= 13) ? 'dark' : 'white_lo'; // coils
    },
    top: () => 'white_hi',
  });

const cupboard = (f) =>
  furniture(f, 0.625, {
    front: (a, z) => {
      const [A, Z] = [px(a), px(z)];
      if (Z >= 9) return 'white'; // worktop edge
      if (Z === 0 || A === 8) return 'wood_dk'; // plinth, gap between the doors
      if (Z === 8 || A === 0 || A === 15) return 'wood_lo';
      if ((A === 6 || A === 10) && Z === 5) return 'white_hi'; // knobs
      return 'wood';
    },
    side: (a, z, lit) => (px(z) >= 9 ? (lit ? 'white' : 'white_lo') : px(z) === 0 ? 'wood_dk' : lit ? 'wood' : 'wood_lo'),
    top: (u, v) => (v > 0.94 ? 'white' : 'white_hi'),
  });

const cabinet = (f) =>
  furniture(f, 0.875, {
    front: (a, z) => {
      const [A, Z] = [px(a), px(z)];
      if (A === 0 || A === 15 || Z === 0 || Z >= 13 || Z === 6) return 'white_lo'; // frame, door gap
      if (Z >= 7 && Z <= 12 && A >= 2 && A <= 13) {
        // Mirror door with a red cross.
        if ((A >= 7 && A <= 8 && Z >= 8 && Z <= 11) || (Z >= 9 && Z <= 10 && A >= 5 && A <= 10)) return 'red';
        return 'glass';
      }
      return A === 12 && Z >= 3 && Z <= 4 ? 'dark' : 'white';
    },
    side: (a, z, lit) => (px(z) === 0 ? 'white_lo' : lit ? 'white' : 'white_lo'),
    top: () => 'white_hi',
  });

const dresser = (f) =>
  furniture(f, 0.75, {
    front: (a, z) => {
      const [A, Z] = [px(a), px(z)]; // rows: plinth, three drawers, top lip
      if (Z === 0 || Z === 4 || Z === 8) return 'wood_dk';
      if (A === 0 || A === 15 || Z >= 11) return 'wood_lo';
      if (A >= 7 && A <= 8 && (Z === 2 || Z === 6 || Z === 9)) return 'paint'; // brass handles
      return 'wood';
    },
    side: (a, z, lit) => (px(z) === 0 ? 'wood_dk' : lit ? 'wood' : 'wood_lo'),
    top: (u, v) => (v < 0.05 || v > 0.95 ? 'wood' : 'wood_hi'),
  });

/** A bed: headboard at the back, pillow then blanket toward the front (foot) end. */
function bed(facing) {
  const { c, I } = blockTile();
  const v0 = facing === 's';
  // Object space: `a` across the bed, `b` from head (0) to foot (1).
  const topAt = (a, b) => {
    if (b < 0.1) return 'wood_hi';
    if (b < 0.34) return a > 0.1 && a < 0.9 ? (b < 0.14 ? 'white' : 'white_hi') : 'white';
    if (Math.abs(b - 0.42) < 0.03) return 'white_hi'; // turned-down sheet
    return Math.abs(b - 0.82) < 0.05 ? 'purple' : 'cloth';
  };
  const H = 0.36;
  if (v0) {
    I.box(0, 0, 1, 1, 0, H, {
      left: (u, z) => (z < 0.1 ? 'wood_lo' : z < 0.18 ? 'wood' : 'cloth_lo'), // foot end
      right: (v, z) => (z < 0.1 ? 'wood_dk' : z < 0.18 ? 'wood_lo' : v < 0.1 ? 'wood_lo' : 'cloth_lo'),
      top: (u, v) => topAt(u, v),
    });
    I.box(0, 0, 1, 0.1, H, 0.66, { left: 'wood', right: 'wood_lo', top: 'wood_hi' }); // headboard
  } else {
    I.box(0, 0, 1, 1, 0, H, {
      left: (u, z) => (z < 0.1 ? 'wood_lo' : z < 0.18 ? 'wood' : u > 0.9 ? 'wood' : 'cloth_lo'),
      right: (v, z) => (z < 0.1 ? 'wood_dk' : 'wood_lo'), // headboard side
      top: (u, v) => topAt(v, 1 - u),
    });
    I.box(0.9, 0, 1, 1, H, 0.66, { left: 'wood', right: 'wood_lo', top: 'wood_hi' });
  }
  return c;
}

// ── Characters ────────────────────────────────────────────────────────────

const survivorKey = { H: 'wood_dk', h: 'outline', s: 'skin', S: 'skin_lo', k: 'outline', t: 'cloth', T: 'cloth_lo', p: 'khaki_lo', P: 'dark', f: 'dark', x: 'red', X: 'rust', y: 'khaki', Y: 'khaki_lo' };
const CAP = { 5: '......xxxx......', 6: '.....xxxxxX.....' };
const survivor = {
  outline: 'outline',
  key: survivorKey,
  under: {
    // Backpack peeking out behind the shoulders.
    se: { 11: '....YY....YY....' },
    s: { 11: '...........YY...', 12: '............Y...' },
  },
  over: {
    se: { ...CAP, 7: '.....XXXXXX.....', 11: '......y..y......', 12: '......y..y......' },
    s: { 5: '.....xxxx.......', 6: '....xxxxxX......', 7: '..XXXXXxxX......', 11: '.....y..y.......', 12: '.....y..y.......' },
    ne: { ...CAP, 7: '.....xxxXXXX....', 11: '....yyy.........', 12: '....yyY.........', 13: '....yyY.........', 14: '....YYY.........' },
    w: { 5: '.....xxxx.......', 6: '..XXxxxxxX......', 7: '....xxxxxX......', 11: '......yyyy......', 12: '......yyyYY.....', 13: '......yyyYY.....', 14: '......yyyYY.....', 15: '......YYYYY.....' },
    nw: { ...CAP, 7: '.....xxxxxX.....', 11: '......yyyy......', 12: '.....yyyyYY.....', 13: '.....yyyyYY.....', 14: '.....yyyyYY.....', 15: '.....YYYYYY.....' },
  },
};

const deadKey = { H: 'wood_dk', h: 'outline', s: 'zskin', S: 'zskin_lo', k: 'red', t: 'khaki', T: 'khaki_lo', p: 'cloth_lo', P: 'dark', f: 'dark', r: 'red', z: 'zskin' };
const shambler = {
  outline: 'outline',
  key: deadKey,
  armsForward: true,
  over: {
    // Torn shirts showing skin, and a blood stain.
    se: { 15: '.....tzt.zT.....', 12: '.......r........' },
    s: { 15: '.....tzt.zT.....', 13: '........r.......' },
    ne: { 15: '......zt.T......' },
    w: { 15: '.....tzt.zT.....' },
    nw: { 15: '.....tzt.zT.....', 13: '.........r......' },
  },
};

// ── Items ─────────────────────────────────────────────────────────────────

const K = {
  W: 'white_hi',
  w: 'white',
  L: 'white_lo',
  y: 'paint',
  o: 'wood_hi',
  r: 'red',
  R: 'rust',
  g: 'glass',
  G: 'glass_lo',
  b: 'cloth',
  B: 'cloth_lo',
  c: 'khaki',
  C: 'khaki_lo',
  d: 'dark',
  n: 'wood_lo',
  N: 'wood_dk',
  p: 'purple',
  a: 'asphalt_hi',
};

const ITEMS = {
  canned_beans: ['.wWWw.', 'wLLLLw', 'yyyyyo', 'yRRRyo', 'yyyyyo', 'wwwwwL'],
  crackers: ['....cccc..', '..ccccccCC', 'ccccrrccCC', 'CCCrrrrCC.', '..CCCCC...'],
  water_bottle: ['......gggg.', 'bb.gggGGGGg', 'bBgggWgggGg', '...ggGGGGG.'],
  soda: ['.LwwL.', 'rWwwrR', 'rWrrrR', 'rWWrrR', 'rrrrrR', '.LLLL.'],
  coffee: ['.wwww.', 'wWWWWL', 'nnnnnN', 'nyyynN', 'nnnnnN', 'NNNNNN'],
  bandage: ['..WWWW..', '.WwwwwL.', 'WwLLLwwL', 'WwLwLwwL', '.WwwwwwL', '..LLLL..'],
  alarm_clock: ['y......y', 'yy.yy.yy', '.yWWWWy.', 'yWWdWWWo', 'yWWddWWo', 'yWWWWWWo', '.yWWWWo.', '.d.oo.d.'],
  toaster: ['..LLLLLLL.', '.WdWWdWWL.', 'WwwwwwwwLL', 'WwwwwwwwLd', 'LLLLLLLLL.'],
  lamp: ['..yyyy..', '.yyyyyo.', 'yyyyyyoo', '...dd...', '...dd...', '...dd...', '.dddddd.'],
  magazine: ['....pppp...', '..pppWWpp..', 'ppprrpWWpp.', '.pppppppppL', '...LLwwwL..'],
  car_battery: ['.r.....dd.', '.dddddddd.', 'dddddddddd', 'aaaaaaaadd', 'ayyaaaaadd', 'aaaaaaaad.'],
  hammer: ['.dddd.....', 'ddaaddoooo', '.dd..onnnN', '.dd.......'],
  plank: ['.......ooon', '....ooooonN', '.oooooonnN.', 'oooonnnN...', 'nnnNN......'],
  hot_beans: ['..W..W.', '.W..W..', 'wLLLLw.', 'yRrRRyo', 'yyyyyo.', 'wwwwwL.'],
  rag: ['....bbbb..', '..bbBbbbB.', '.bbbbBBbbb', 'bBbbbbbBB.', '.BBbbBB...'],
  nails: ['.L....L.', '.a..L.a.', '.a..a.a.', '.L..a.L.', '.a....a.', '..L.a...', '..a.a...'],
};

export function images() {
  const furn = (name, draw) => ['s', 'w'].map((f) => ({ file: `${name}_${f}.svg`, canvas: draw(f), note: `block, facing ${f}` }));
  return [
    { file: 'road.svg', canvas: road(), note: 'flat tile' },
    { file: 'grass.svg', canvas: grass(), note: 'flat tile' },
    { file: 'glass.svg', canvas: glass(), note: 'flat tile' },
    { file: 'crate.svg', canvas: crate(), note: 'block' },
    { file: 'window.svg', canvas: windowWall(false), note: 'block' },
    { file: 'barricaded_window.svg', canvas: windowWall(true), note: 'block' },
    { file: 'stove.svg', canvas: stove(), note: 'block' },
    ...furn('car', (f) => car(f === 's' ? 'v' : 'u')),
    ...furn('bed', bed),
    ...furn('fridge', fridge),
    ...furn('cupboard', cupboard),
    ...furn('cabinet', cabinet),
    ...furn('dresser', dresser),
    ...FACINGS.map((f) => ({ file: `survivor_${f}.svg`, canvas: humanoid(f, survivor), note: `facing ${f}` })),
    ...FACINGS.map((f) => ({ file: `shambler_${f}.svg`, canvas: humanoid(f, shambler), note: `facing ${f}` })),
    ...FACINGS.map((f) => ({ file: `crawler_${f}.svg`, canvas: crawler(f, { outline: 'outline', key: deadKey }), note: `facing ${f}` })),
    ...Object.entries(ITEMS).map(([id, rows]) => ({ file: `${id}.svg`, canvas: item(rows, K, 'outline'), note: 'ground pile' })),
  ];
}
