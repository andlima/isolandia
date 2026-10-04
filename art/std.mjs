// std: genre-neutral floor, wall, door and an everyday person.

import { humanoid, FACINGS } from './characters.mjs';
import { blockTile, flatTile, hash, px } from './lib.mjs';

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

function wall() {
  const { c, I } = blockTile();
  I.box(0, 0, 1, 1, 0, 1, {
    left: (u, z, x, y) => bricks(u, z, x, y, 'stone', 'mortar', 'stone_lo', 2),
    right: (v, z, x, y) => bricks(v, z, x, y, 'stone_lo', 'mortar', 'mortar', 3),
    top: (u, v, x, y) => (px(u) === 0 || px(v) === 0 ? 'stone' : hash(x, y, 4) < 0.05 ? 'stone' : 'stone_hi'),
  });
  return c;
}

/** A wooden door in a stone frame on a side face (`a` along the face, `z` up). */
function doorFace(a, z, lit) {
  const [A, Z] = [px(a), px(z)];
  if (A <= 2 || A >= 13 || Z >= 13) return lit ? 'stone' : 'stone_lo'; // frame
  if (A === 3 || Z === 12) return 'mortar'; // reveal, in shadow
  if (A === 11 && Z === 6) return 'brass'; // knob
  if (A === 6 || A === 9) return lit ? 'wood_lo' : 'wood_dk'; // plank gaps
  return lit ? (A < 6 ? 'wood_hi' : 'wood') : 'wood_lo';
}

function door() {
  const { c, I } = blockTile();
  I.box(0, 0, 1, 1, 0, 1, {
    left: (u, z) => doorFace(u, z, true),
    right: (v, z) => doorFace(v, z, false),
    top: (u, v) => (px(u) === 0 || px(v) === 0 ? 'stone' : 'stone_hi'),
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
    { file: 'wall.svg', canvas: wall(), note: 'block' },
    { file: 'door.svg', canvas: door(), note: 'block: a door on each visible face' },
    ...FACINGS.map((f) => ({ file: `humanoid_${f}.svg`, canvas: humanoid(f, person), note: `facing ${f}` })),
  ];
}
