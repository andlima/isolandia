// western: the town of High Noon, in the town's palette (art/town.mjs) plus
// leather and tan. Hats tell the men apart: the sheriff's tan hat and star,
// the doc's narrow black one, the riders' brown brims, Black Jack all in
// black; the bartender wears an apron and the kid a cap. The items (coin,
// bullet, whiskey, revolver) are small ground piles.

import { humanoid, item, FACINGS } from './characters.mjs';
import { palette as town } from './town.mjs';

export const palette = {
  ...town,
  tan: '#d2b282',
  tan_lo: '#a88a58',
  leather: '#6e4a2c',
  leather_lo: '#4a3220',
};

/** A wide-brimmed hat (x crown, X brim) over the hairline. */
const HAT = {
  se: { 4: '......xxxx......', 5: '.....xxxxxx.....', 6: '.....xxxxxx.....', 7: '..XXXXXXXXXXXX..' },
  s: { 4: '.....xxxx.......', 5: '....xxxxxx......', 6: '....xxxxxx......', 7: '.XXXXXXXXXXX....' },
  ne: { 4: '......xxxx......', 5: '.....xxxxxx.....', 6: '.....xxxxxx.....', 7: '..XXXXXXXXXXXX..' },
  w: { 4: '.....xxxx.......', 5: '....xxxxxx......', 6: '....xxxxxx......', 7: '.XXXXXXXXXXX....' },
  nw: { 4: '......xxxx......', 5: '.....xxxxxx.....', 6: '.....xxxxxx.....', 7: '..XXXXXXXXXXXX..' },
};

/** A narrow hat: a tall crown and a short brim. */
const NARROW_HAT = {
  se: { 3: '......xxxx......', 4: '......xxxx......', 5: '......xxxx......', 6: '......xxxx......', 7: '....XXXXXXXX....' },
  s: { 3: '.....xxxx.......', 4: '.....xxxx.......', 5: '.....xxxx.......', 6: '.....xxxx.......', 7: '...XXXXXXXX.....' },
  ne: { 3: '......xxxx......', 4: '......xxxx......', 5: '......xxxx......', 6: '......xxxx......', 7: '....XXXXXXXX....' },
  w: { 3: '.....xxxx.......', 4: '.....xxxx.......', 5: '.....xxxx.......', 6: '.....xxxx.......', 7: '...XXXXXXXX.....' },
  nw: { 3: '......xxxx......', 4: '......xxxx......', 5: '......xxxx......', 6: '......xxxx......', 7: '....XXXXXXXX....' },
};

/** A flat cap (x) with a peak (X). */
const CAP = {
  se: { 5: '......xxxx......', 6: '.....xxxxxX.....', 7: '.....XXXXXX.....' },
  s: { 5: '.....xxxx.......', 6: '....xxxxxX......', 7: '..XXXXXxxX......' },
  ne: { 5: '......xxxx......', 6: '.....xxxxxX.....', 7: '.....xxxXXXX....' },
  w: { 5: '.....xxxx.......', 6: '..XXxxxxxX......', 7: '....xxxxxX......' },
  nw: { 5: '......xxxx......', 6: '.....xxxxxX.....', 7: '.....xxxxxX.....' },
};

/** A vest (v/V) open over the shirt, rows 11–15. */
const VEST = {
  se: { 11: '.....vv..VV.....', 12: '.....vv..VV.....', 13: '.....vv..VV.....', 14: '.....vv..VV.....', 15: '.....vv..VV.....' },
  s: { 11: '.....vv..V......', 12: '.....vv..V......', 13: '.....vv..V......', 14: '.....vv..V......', 15: '.....vv..V......' },
  ne: { 11: '......v..V......', 12: '......v..V......', 13: '......v..V......', 14: '......v..V......', 15: '......v..V......' },
  w: { 11: '.....vvvvV......', 12: '.....vvvvV......', 13: '.....vvvvV......', 14: '.....vvvvV......', 15: '.....vvvvV......' },
  nw: { 11: '.....vvvvVV.....', 12: '.....vvvvVV.....', 13: '.....vvvvVV.....', 14: '.....vvvvVV.....', 15: '.....vvvvVV.....' },
};

/** A long duster coat: its skirt (t/T) covers the hips, rows 16–18. */
const DUSTER = {
  se: { 16: '....tttttTTT....', 17: '....tttttTTT....', 18: '....tttttTTT....' },
  s: { 16: '....tttttTT.....', 17: '....tttttTT.....', 18: '....tttttTT.....' },
  ne: { 16: '.....ttttTT.....', 17: '.....ttttTT.....', 18: '.....ttttTT.....' },
  w: { 16: '....tttttTT.....', 17: '....tttttTT.....', 18: '....tttttTT.....' },
  nw: { 16: '....tttttTTT....', 17: '....tttttTTT....', 18: '....tttttTTT....' },
};

/** An apron (a) from the chest to the knees, rows 12–18. */
const APRON = {
  se: { 12: '......aaaa......', 13: '......aaaa......', 14: '......aaaa......', 15: '......aaaa......', 16: '.....aaaaaa.....', 17: '.....aaaaaa.....', 18: '.....aaaaaa.....' },
  s: { 12: '.....aaaa.......', 13: '.....aaaa.......', 14: '.....aaaa.......', 15: '.....aaaa.......', 16: '.....aaaaa......', 17: '.....aaaaa......', 18: '.....aaaaa......' },
  ne: { 12: '......aaa.......', 13: '......aaa.......', 14: '......aaa.......', 15: '......aaa.......', 16: '......aaa.......', 17: '......aaa.......', 18: '......aaa.......' },
};

/** A bandana (r) at the neck. */
const BANDANA = {
  se: { 10: '.....rrrrrr.....' },
  s: { 10: '....rrrrrr......' },
  ne: { 10: '.....rrrrrr.....' },
  w: { 10: '....rrrrrr......' },
  nw: { 10: '.....rrrrrr.....' },
};

const layers = (...sets) => Object.fromEntries(FACINGS.map((f) => [f, Object.assign({}, ...sets.map((s) => s[f] ?? {}))]));

const base = { h: 'outline', k: 'outline', s: 'skin', S: 'skin_lo', f: 'leather_lo' };

// Sheriff Cobb: tan hat, khaki shirt, leather vest and a brass star.
const sheriff = {
  outline: 'outline',
  key: { ...base, H: 'wood_dk', t: 'khaki', T: 'khaki_lo', p: 'cloth_lo', P: 'dark', x: 'tan', X: 'tan_lo', v: 'leather', V: 'leather_lo', w: 'paint' },
  over: layers(VEST, HAT, { se: { 12: '.....vvw.VV.....' }, s: { 12: '.....vw..V......' } }),
};

// Doc: a black frock coat, a white shirt front, grey hair under a narrow hat.
const doc = {
  outline: 'outline',
  key: { ...base, H: 'white_lo', t: 'dark', T: 'outline', p: 'dark', P: 'outline', x: 'dark', X: 'outline', w: 'white' },
  over: layers(DUSTER, NARROW_HAT, { se: { 11: '.......ww.......', 12: '.......ww.......' }, s: { 11: '......ww........', 12: '......ww........' } }),
};

// The bartender: white shirt, red bow tie, a long apron, a dark moustache.
const bartender = {
  outline: 'outline',
  key: { ...base, H: 'dark', t: 'white', T: 'white_lo', p: 'dark', P: 'outline', a: 'white_hi', r: 'red', m: 'outline' },
  over: layers(APRON, { se: { 10: '......mSSm......', 11: '.......rr.......' }, s: { 10: '.....mmS........', 11: '......rr........' }, ne: { 10: '.......Sm.......' } }),
};

// The kid: a rust cap, a blue shirt, short khaki trousers over bare shins.
const kid = {
  outline: 'outline',
  key: { ...base, H: 'wood_hi', t: 'cloth', T: 'cloth_lo', p: 'khaki', P: 'khaki_lo', x: 'rust', X: 'rust_lo' },
  over: layers(CAP, {
    se: { 19: '.....ss..SS.....', 20: '.....ss..SS.....' },
    s: { 19: '....ss...SS.....', 20: '....ss...SS.....' },
    ne: { 19: '.....ss...SS....', 20: '....ss.....SS...' },
    w: { 19: '.....ss..SS.....', 20: '.....ss..SS.....' },
    nw: { 19: '.....ss..SS.....', 20: '.....ss..SS.....' },
  }),
};

// A gang rider: brown duster and hat, red bandana.
const rider = {
  outline: 'outline',
  key: { ...base, H: 'wood_dk', t: 'wood_lo', T: 'wood_dk', p: 'dark', P: 'outline', x: 'leather', X: 'leather_lo', r: 'red' },
  over: layers(DUSTER, BANDANA, HAT),
};

// Black Jack: black from hat to boots, a red bandana and a brass buckle.
const black_jack = {
  outline: 'outline',
  key: { ...base, H: 'outline', t: 'dark', T: 'outline', p: 'dark', P: 'outline', x: 'dark', X: 'outline', r: 'red', w: 'paint' },
  over: layers(DUSTER, BANDANA, HAT, { se: { 15: '.....tt.wTT.....' }, s: { 15: '.....ttw.T......' } }),
};

const PEOPLE = { sheriff, doc, bartender, kid, rider, black_jack };

// ── Items ─────────────────────────────────────────────────────────────────

const K = { y: 'paint', Y: 'white_hi', o: 'wood_hi', n: 'wood_lo', N: 'wood_dk', d: 'dark', D: 'outline', g: 'glass', L: 'white_lo', l: 'leather', r: 'red' };

const ITEMS = {
  coin: ['..yyyy..', '.yYyyyo.', 'yYyyyyoo', 'yyyyyyoo', 'yyyyyyoo', '.yyyyoo.', '..oooo..'],
  bullet: ['..dd...', '.ydd...', 'yyyd..d', '.yyyyyd', '...yyyy', '.....y.'],
  whiskey: ['...dd...', '...nn...', '...nn...', '..nnnn..', '.nnNNnn.', '.nyyynn.', '.nyyynn.', '.nnNNnn.', '..nnnn..'],
  revolver: ['DDDDDDDd..', 'DdddddDDDd', '.....DddDd', '.....Dlll.', '......lll.', '......ll..'],
};

export function images() {
  return [
    ...Object.entries(PEOPLE).flatMap(([id, look]) => FACINGS.map((f) => ({ file: `${id}_${f}.svg`, canvas: humanoid(f, look), note: `facing ${f}` }))),
    ...Object.entries(ITEMS).map(([id, rows]) => ({ file: `${id}.svg`, canvas: item(rows, K, 'outline'), note: 'ground pile' })),
  ];
}
