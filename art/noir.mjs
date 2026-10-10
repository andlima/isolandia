// noir: the people of Elm Street, in the town's palette (art/town.mjs) plus
// police navy, a fixer's grey, a widow's plum and a neighbour's cream. Every
// character is told apart by hat, coat or dress: a peaked cap and badge for
// the police, a fedora and trench coat for the Family, dresses for the women.

import { humanoid, FACINGS } from './characters.mjs';
import { palette as town } from './town.mjs';

export const palette = {
  ...town,
  navy: '#34446e',
  navy_lo: '#242f4e',
  grey: '#8a8c98',
  grey_lo: '#62646f',
  plum: '#5e3652',
  plum_lo: '#40243a',
  cream: '#e6dcc2',
};

/** A peaked cap (x crown, X peak) with a badge (w) on the front, per facing; the resident's cap shape. */
const CAP = {
  se: { 5: '......xxxx......', 6: '.....xxwxxX.....', 7: '.....XXXXXX.....' },
  s: { 5: '.....xxxx.......', 6: '....xxxwxX......', 7: '..XXXXXxxX......' },
  ne: { 5: '......xxxx......', 6: '.....xxxxxX.....', 7: '.....xxxXXXX....' },
  w: { 5: '.....xxxx.......', 6: '..XXxxxxxX......', 7: '....xxxxxX......' },
  nw: { 5: '......xxxx......', 6: '.....xxxxxX.....', 7: '.....xxxxxX.....' },
};

/** A fedora: a tall crown (x) and a wide brim (X) over the hairline. */
const FEDORA = {
  se: { 4: '......xxxx......', 5: '.....xxxxxx.....', 6: '.....xxxxxx.....', 7: '...XXXXXXXXXX...' },
  s: { 4: '.....xxxx.......', 5: '....xxxxxx......', 6: '....xxxxxx......', 7: '..XXXXXXXXX.....' },
  ne: { 4: '......xxxx......', 5: '.....xxxxxx.....', 6: '.....xxxxxx.....', 7: '...XXXXXXXXXX...' },
  w: { 4: '.....xxxx.......', 5: '....xxxxxx......', 6: '....xxxxxx......', 7: '..XXXXXXXXXX....' },
  nw: { 4: '......xxxx......', 5: '.....xxxxxx.....', 6: '.....xxxxxx.....', 7: '...XXXXXXXXXX...' },
};

/** A long coat: the skirt of the coat (t/T) covers the hips, rows 16–17. */
const COAT = {
  se: { 16: '....tttttTTT....', 17: '....tttttTTT....' },
  s: { 16: '....tttttTT.....', 17: '....tttttTT.....' },
  ne: { 16: '.....ttttTT.....', 17: '.....ttttTT.....' },
  w: { 16: '....tttttTT.....', 17: '....tttttTT.....' },
  nw: { 16: '....tttttTTT....', 17: '....tttttTTT....' },
};

/** A dress (d/D) from the waist to the ankles, rows 16–20. */
const DRESS = {
  se: { 16: '....ddddddDD....', 17: '....ddddddDD....', 18: '...dddddddDDD...', 19: '...dddddddDDD...', 20: '...dddddddDDD...' },
  s: { 16: '....ddddddD.....', 17: '....ddddddD.....', 18: '...dddddddDD....', 19: '...dddddddDD....', 20: '...dddddddDD....' },
  ne: { 16: '.....dddddD.....', 17: '.....dddddD.....', 18: '....ddddddDD....', 19: '....ddddddDD....', 20: '....ddddddDD....' },
  w: { 16: '....ddddddD.....', 17: '....ddddddD.....', 18: '...dddddddDD....', 19: '...dddddddDD....', 20: '...dddddddDD....' },
  nw: { 16: '....ddddddDD....', 17: '....ddddddDD....', 18: '...dddddddDDD...', 19: '...dddddddDDD...', 20: '...dddddddDDD...' },
};

/** Merge per-facing overlay sets (later ones win on the same row). */
const layers = (...sets) => Object.fromEntries(FACINGS.map((f) => [f, Object.assign({}, ...sets.map((s) => s[f] ?? {}))]));

const base = { h: 'outline', k: 'outline', s: 'skin', S: 'skin_lo', f: 'dark' };

// Sgt. Hale: a dark greatcoat and a peaked cap with a badge; grey at the temples.
const hale = {
  outline: 'outline',
  key: { ...base, H: 'white_lo', t: 'dark', T: 'outline', p: 'dark', P: 'outline', x: 'navy', X: 'navy_lo', w: 'paint' },
  over: layers(COAT, CAP),
};

// The officer on the beat: navy uniform, cap and badge.
const officer = {
  outline: 'outline',
  key: { ...base, H: 'wood_dk', t: 'navy', T: 'navy_lo', p: 'navy_lo', P: 'outline', x: 'navy', X: 'navy_lo', w: 'paint' },
  over: layers(CAP, { se: { 11: '........w.......' }, s: { 11: '.......w........' } }),
};

// Mrs. Vane: a plum dress, black hair, a string of pearls.
const widow = {
  outline: 'outline',
  key: { ...base, H: 'outline', t: 'plum', T: 'plum_lo', p: 'plum', P: 'plum_lo', d: 'plum', D: 'plum_lo', w: 'white_hi' },
  over: layers(DRESS, { se: { 11: '......w.ww......' }, s: { 11: '.....w.ww.......' } }),
};

// Mr. Pike, the lodger: shirtsleeves and suspenders, a sallow look.
const pike = {
  outline: 'outline',
  key: { ...base, H: 'wood_dk', t: 'white', T: 'white_lo', p: 'khaki_lo', P: 'dark', d: 'dark' },
  over: {
    se: { 11: '......d..d......', 12: '......d..d......', 13: '......d..d......', 14: '......d..d......' },
    s: { 11: '.....d..d.......', 12: '.....d..d.......', 13: '.....d..d.......', 14: '.....d..d.......' },
    ne: { 11: '.......d........', 12: '.......d........', 13: '.......d........', 14: '.......d........' },
    w: { 11: '.....d..d.......', 12: '.....d..d.......', 13: '.....d..d.......', 14: '.....d..d.......' },
    nw: { 11: '......d..d......', 12: '......d..d......', 13: '......d..d......', 14: '......d..d......' },
  },
};

// Dot, the neighbour: a cream cardigan over a rust skirt, fair hair in a bun.
const dot = {
  outline: 'outline',
  key: { ...base, H: 'wood_hi', t: 'cream', T: 'white_lo', p: 'rust', P: 'rust_lo', d: 'rust', D: 'rust_lo' },
  over: layers(DRESS, { w: { 6: '.......HH.......' }, nw: { 6: '.......HH.......' } }),
};

// Mickey the Fixer: grey trench coat, fedora, dark trousers.
const mickey = {
  outline: 'outline',
  key: { ...base, H: 'dark', t: 'grey', T: 'grey_lo', p: 'dark', P: 'outline', x: 'grey_lo', X: 'dark' },
  over: layers(COAT, FEDORA),
};

const PEOPLE = { hale, officer, widow, pike, dot, mickey };

export function images() {
  return Object.entries(PEOPLE).flatMap(([id, look]) => FACINGS.map((f) => ({ file: `${id}_${f}.svg`, canvas: humanoid(f, look), note: `facing ${f}` })));
}
