/**
 * Key hints, the pure part (no DOM types): `F` labels every enabled button
 * of the open windows with a short home-row label, typing the label presses
 * the button, as in the Vimium browser extension. `hintLabels` hands out
 * the labels, `matchHints` compares what was typed with them and `hintKey`
 * says what one key press does to the hint state. `hints-dom.ts` collects
 * the buttons, draws the chips and dispatches the click.
 */

/** Vimium's default alphabet: the home row first, then nearby letters. */
export const HINT_ALPHABET = 'sadfjklewcmpgh';

/**
 * `n` distinct lowercase labels of one length `L`, the smallest with
 * `alphabet.length ** L >= n` (`L = 1` for `n <= 1`): with 14 or fewer
 * targets every label is a single letter, from 15 to 196 two letters, three
 * beyond. Labels run in alphabet order (`s`, `a`, `d`, …; `ss`, `sa`, …),
 * so the first targets get the easiest letters. `hintLabels(0)` is `[]`.
 */
export function hintLabels(n: number, alphabet: string = HINT_ALPHABET): string[] {
  if (n <= 0) return [];
  const base = alphabet.length;
  if (base < 2 && n > 1) throw new RangeError('hintLabels: the alphabet needs at least two letters');
  let len = 1;
  while (base ** len < n) len++;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    let label = '';
    let k = i;
    for (let j = 0; j < len; j++) {
      label = alphabet[k % base] + label;
      k = Math.floor(k / base);
    }
    out.push(label);
  }
  return out;
}

export type HintMatch =
  /** `typed` is exactly the label at `index`. */
  | { readonly kind: 'match'; readonly index: number }
  /** The labels that start with `typed` (non-empty, in order). */
  | { readonly kind: 'partial'; readonly candidates: readonly number[] }
  /** Nothing starts with `typed`. */
  | { readonly kind: 'none' };

/** Compare `typed` with the labels; `''` is a partial match of every label. */
export function matchHints(labels: readonly string[], typed: string): HintMatch {
  const index = labels.indexOf(typed);
  if (index >= 0) return { kind: 'match', index };
  const candidates: number[] = [];
  labels.forEach((l, i) => {
    if (l.startsWith(typed)) candidates.push(i);
  });
  return candidates.length ? { kind: 'partial', candidates } : { kind: 'none' };
}

export type HintKeyResult =
  /** A letter was appended (still partial) or `Backspace` removed one (`typed` may be `''`; `Backspace` on `''` stays `''`). */
  | { readonly kind: 'typed'; readonly typed: string }
  /** The letter completed a label; `shift` is the Shift state of that last key press only. */
  | { readonly kind: 'activate'; readonly index: number; readonly shift: boolean }
  /** `Escape`. */
  | { readonly kind: 'cancel' }
  /** `?`: must reach the shell and open the controls overlay. */
  | { readonly kind: 'pass' }
  /** Any other key: consumed and dropped while hints show. */
  | { readonly kind: 'ignore' };

/**
 * The hint letter of a key press, or null: `key.toLowerCase()` when it is
 * one letter of the alphabet (so an uppercase `key` with Shift held matches),
 * else the letter of a `Key<X>` code (a layout without Latin letters works by
 * physical position; Caps Lock does not matter).
 */
export function hintLetter(code: string, key: string, alphabet: string = HINT_ALPHABET): string | null {
  const k = key.toLowerCase();
  if (k.length === 1 && alphabet.includes(k)) return k;
  const m = /^Key([A-Z])$/.exec(code);
  if (m) {
    const c = m[1]!.toLowerCase();
    if (alphabet.includes(c)) return c;
  }
  return null;
}

/**
 * What a key press does while hints show, given the labels and what was
 * typed so far. `?` passes, `Escape` cancels, `Backspace` erases, a hint
 * letter that keeps a partial match is typed and one that completes a label
 * activates it (with `shift` of this press); everything else, including a
 * letter that would match nothing, is ignored. `f` is a plain label letter
 * here: `F` is not special once hints show.
 */
export function hintKey(labels: readonly string[], typed: string, code: string, key: string, shift: boolean, alphabet: string = HINT_ALPHABET): HintKeyResult {
  if (key === '?') return { kind: 'pass' };
  if (code === 'Escape') return { kind: 'cancel' };
  if (code === 'Backspace') return { kind: 'typed', typed: typed.slice(0, -1) };
  const letter = hintLetter(code, key, alphabet);
  if (letter === null) return { kind: 'ignore' };
  const next = typed + letter;
  const m = matchHints(labels, next);
  if (m.kind === 'match') return { kind: 'activate', index: m.index, shift };
  if (m.kind === 'partial') return { kind: 'typed', typed: next };
  return { kind: 'ignore' };
}
