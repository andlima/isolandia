// zombie: the dead that rise in the town, in the town's palette (art/town.mjs)
// plus their skin.

import { crawler, humanoid, FACINGS } from './characters.mjs';
import { palette as town } from './town.mjs';

export const palette = {
  ...town,
  zskin: '#9cc47a',
  zskin_lo: '#6a9a4c',
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

export function images() {
  return [
    ...FACINGS.map((f) => ({ file: `shambler_${f}.svg`, canvas: humanoid(f, shambler), note: `facing ${f}` })),
    ...FACINGS.map((f) => ({ file: `crawler_${f}.svg`, canvas: crawler(f, { outline: 'outline', key: deadKey }), note: `facing ${f}` })),
  ];
}
