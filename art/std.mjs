// std: genre-neutral floor, wall, door, stairs and landing, and an everyday person.

import { humanoid, FACINGS } from './characters.mjs';
import { blockTile, edgeTile, ET, flatTile, hash, px, slab } from './lib.mjs';

export const palette = {
  outline: '#2a2420',
  shadow: ['#000000', 0.3],
  floor_hi: '#c4bcac',
  floor: '#b0a898',
  floor_lo: '#968e7f',
  stone_hi: '#e4ded2',
  stone: '#c6beae',
  stone_lo: '#9c9484',
  mortar: '#857d6e',
  wood_hi: '#c08a4e',
  wood: '#9c6a38',
  wood_lo: '#744c26',
  wood_dk: '#553619',
  brass: '#e0c060',
  skin: '#eab48c',
  skin_lo: '#c88c68',
  hair: '#5a3c24',
  shirt: '#5f86b8',
  shirt_lo: '#46689a',
  pants: '#55576a',
  pants_lo: '#3e404e',
  shoes: '#4a3a2e',
};

/** Square floor slabs, two per tile edge, with a seam on their north-west edges. */
function floor() {
  const { c, I } = flatTile();
  I.top(0, 0, 1, 1, 0, (u, v, x, y) => {
    const [U, V] = [px(u) % 8, px(v) % 8];
    if (U === 0 || V === 0) return 'floor_lo';
    if (U === 1 || V === 1) return 'floor_hi';
    return hash(x, y, 1) < 0.06 ? 'floor_lo' : 'floor';
  });
  return c;
}

/** Brick courses on a side face: `a` runs along the face, `z` up (4 art px per course). */
export function bricks(a, z, x, y, face, mortar, spot, seed = 0) {
  const [A, Z] = [px(a), px(z)];
  if (Z % 4 === 3) return mortar;
  if ((A + (Math.floor(Z / 4) % 2) * 4) % 8 === 0) return mortar;
  return hash(x, y, seed) < 0.05 ? spot : face;
}

/** A thin brick wall on a cell's edge. */
function wall() {
  const { c, I } = edgeTile();
  slab(I, {
    face: (u, z, x, y) => bricks(u, z, x, y, 'stone', 'mortar', 'stone_lo', 2),
    end: (v, z) => (px(z) % 4 === 3 ? 'mortar' : 'stone_lo'),
    top: (u, v, x, y) => (hash(x, y, 4) < 0.1 ? 'stone' : 'stone_hi'),
  });
  return c;
}

/** A stone door frame on a cell's edge: two posts and a lintel round an open doorway you see through. */
function door() {
  const { c, I } = edgeTile();
  const stone = (u, z, x, y) => bricks(u, z, x, y, 'stone', 'mortar', 'stone_lo', 5);
  // Back to front (left post, lintel, right post), so nearer parts cover farther ones.
  I.box(-ET, -ET, 0.16, ET, 0, 1, { left: stone, right: 'mortar', top: 'stone_hi' });
  I.box(0.16, -ET, 0.84, ET, 0.8, 1, { left: (u, z) => (px(z) === 12 ? 'mortar' : 'stone'), right: 'stone_lo', top: 'stone_hi' });
  I.box(0.84, -ET, 1 + ET, ET, 0, 1, { left: stone, right: 'stone_lo', top: 'stone_hi' });
  // A worn wooden threshold across the doorway.
  I.box(0.16, -ET, 0.84, ET, 0, 0.04, { left: 'wood_lo', right: 'wood_dk', top: 'wood_hi' });
  return c;
}

/** Steps of a staircase block. */
const STEPS = 4;

/**
 * A wooden staircase filling its cell, rising toward its facing: drawn `s`
 * it climbs toward the south (screen-left) face, so the stepped profile
 * shows on the right face; drawn `w` it climbs toward the hidden west face,
 * so the risers face the camera on the right. `n` and `e` are the mirrors.
 */
function stairs(facing) {
  const { c, I } = blockTile();
  const tread = (along) => (u, v) => (px(along(u, v)) % 4 === 3 ? 'wood' : 'wood_hi'); // nosing at each step's front edge
  for (let k = 0; k < STEPS; k++) {
    // Back to front: farther steps first, so nearer ones cover them.
    if (facing === 's') {
      I.box(0, k / STEPS, 1, (k + 1) / STEPS, 0, (k + 1) / STEPS, {
        left: (u, z) => (px(u) === 0 || px(u) === 15 || px(z) === 0 || px(z) === 15 ? 'wood_lo' : 'wood'), // the top step's stringer panel
        right: (v, z) => (px(z) === 0 || px(v) % 4 === 0 ? 'wood_dk' : 'wood_lo'),
        top: tread((u, v) => 1 - v),
      });
    } else {
      I.box(k / STEPS, 0, (k + 1) / STEPS, 1, 0, (STEPS - k) / STEPS, {
        left: (u, z) => (px(z) === 0 || px(u) % 4 === 3 ? 'wood_lo' : 'wood'),
        right: (v, z) => (px(z) % 4 === 3 ? 'wood_dk' : 'wood_lo'),
        top: tread((u) => u),
      });
    }
  }
  return c;
}

/** The floor at the top of the stairs: boards with a worn edge. */
function landing() {
  const { c, I } = flatTile();
  I.top(0, 0, 1, 1, 0, (u, v, x, y) => {
    const [U, V] = [px(u), px(v)];
    if (U === 0 || V === 0 || U === 15 || V === 15) return 'wood_lo';
    if (V % 4 === 3) return 'wood_lo'; // gaps between boards
    return hash(x, y, 7) < 0.06 ? 'wood' : 'wood_hi';
  });
  return c;
}

const person = {
  outline: 'outline',
  key: { H: 'hair', h: 'outline', s: 'skin', S: 'skin_lo', k: 'outline', t: 'shirt', T: 'shirt_lo', p: 'pants', P: 'pants_lo', f: 'shoes' },
};

export function images() {
  return [
    { file: 'floor.svg', canvas: floor(), note: 'flat tile' },
    { file: 'wall.svg', canvas: wall(), note: 'edge' },
    { file: 'door.svg', canvas: door(), note: 'edge: an open doorway in a stone frame' },
    ...['s', 'w'].map((f) => ({ file: `stairs_${f}.svg`, canvas: stairs(f), note: `block, rising toward ${f}` })),
    { file: 'landing.svg', canvas: landing(), note: 'flat tile' },
    ...FACINGS.map((f) => ({ file: `humanoid_${f}.svg`, canvas: humanoid(f, person), note: `facing ${f}` })),
  ];
}
