import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HINT_ALPHABET, hintKey, hintLabels, hintLetter, matchHints } from '../src/web/hints.ts';

// ── Labels ──────────────────────────────────────────────────────────────────

const distinct = (labels: readonly string[]) => new Set(labels).size === labels.length;
const prefixFree = (labels: readonly string[]) => labels.every((a, i) => labels.every((b, j) => i === j || !b.startsWith(a)));

test('hintLabels: the alphabet, none and one', () => {
  assert.equal(HINT_ALPHABET, 'sadfjklewcmpgh');
  assert.equal(HINT_ALPHABET.length, 14);
  assert.deepEqual(hintLabels(0), []);
  assert.deepEqual(hintLabels(1), ['s']);
});

test('hintLabels: up to 14 targets get single letters, in alphabet order', () => {
  const labels = hintLabels(14);
  assert.equal(labels.length, 14);
  assert.ok(labels.every((l) => l.length === 1));
  assert.ok(distinct(labels));
  assert.deepEqual(labels, [...HINT_ALPHABET]);
  assert.deepEqual(hintLabels(3), ['s', 'a', 'd']);
});

test('hintLabels: 15 to 196 targets get two letters, distinct and none a prefix of another', () => {
  for (const n of [15, 196]) {
    const labels = hintLabels(n);
    assert.equal(labels.length, n);
    assert.ok(labels.every((l) => l.length === 2), `${n}: all two letters`);
    assert.ok(distinct(labels), `${n}: distinct`);
    assert.ok(prefixFree(labels), `${n}: prefix-free`);
    assert.ok(labels.every((l) => [...l].every((c) => HINT_ALPHABET.includes(c))), `${n}: alphabet letters only`);
  }
  assert.deepEqual(hintLabels(15).slice(0, 3), ['ss', 'sa', 'sd']);
  assert.equal(hintLabels(15)[14], 'as');
  assert.equal(hintLabels(196)[195], 'hh');
});

test('hintLabels: 197 targets need three letters', () => {
  const labels = hintLabels(197);
  assert.equal(labels.length, 197);
  assert.ok(labels.every((l) => l.length === 3));
  assert.ok(distinct(labels));
  assert.equal(labels[0], 'sss');
  assert.equal(labels[1], 'ssa');
});

test('hintLabels: a custom alphabet is honoured', () => {
  assert.deepEqual(hintLabels(2, 'ab'), ['a', 'b']);
  assert.deepEqual(hintLabels(3, 'ab'), ['aa', 'ab', 'ba']);
  assert.deepEqual(hintLabels(5, 'ab'), ['aaa', 'aab', 'aba', 'abb', 'baa']);
  assert.deepEqual(hintLabels(4, 'xyz'), ['xx', 'xy', 'xz', 'yx']);
});

// ── Matching ────────────────────────────────────────────────────────────────

test('matchHints: exact, partial (candidates in order), none, and the empty prefix matches everything', () => {
  const labels = ['ss', 'sa', 'sd', 'as', 'aa'];
  assert.deepEqual(matchHints(labels, 'sa'), { kind: 'match', index: 1 });
  assert.deepEqual(matchHints(labels, 'aa'), { kind: 'match', index: 4 });
  assert.deepEqual(matchHints(labels, 's'), { kind: 'partial', candidates: [0, 1, 2] });
  assert.deepEqual(matchHints(labels, 'a'), { kind: 'partial', candidates: [3, 4] });
  assert.deepEqual(matchHints(labels, 'd'), { kind: 'none' });
  assert.deepEqual(matchHints(labels, 'sx'), { kind: 'none' });
  assert.deepEqual(matchHints(labels, ''), { kind: 'partial', candidates: [0, 1, 2, 3, 4] });
  assert.deepEqual(matchHints(['s', 'a'], 's'), { kind: 'match', index: 0 });
  assert.deepEqual(matchHints([], ''), { kind: 'none' });
});

// ── Key reducer ─────────────────────────────────────────────────────────────

test('hintLetter: key letters, uppercase, physical codes for non-Latin keys, nothing else', () => {
  assert.equal(hintLetter('KeyS', 's'), 's');
  assert.equal(hintLetter('KeyS', 'S'), 's');
  assert.equal(hintLetter('KeyF', 'f'), 'f', 'f is a label letter');
  assert.equal(hintLetter('KeyS', 'ы'), 's', 'a non-Latin layout works by position');
  assert.equal(hintLetter('KeyQ', 'a'), 'a', 'the key wins over the code (AZERTY)');
  assert.equal(hintLetter('KeyQ', 'q'), null);
  assert.equal(hintLetter('KeyI', 'i'), null);
  assert.equal(hintLetter('Digit1', '1'), null);
  assert.equal(hintLetter('ShiftLeft', 'Shift'), null);
  assert.equal(hintLetter('KeyS', 's', 'xy'), null, 'a custom alphabet');
});

test('hintKey: a one-letter label activates with the Shift state of that press', () => {
  const labels = hintLabels(3); // s, a, d
  assert.deepEqual(hintKey(labels, '', 'KeyS', 's', false), { kind: 'activate', index: 0, shift: false });
  assert.deepEqual(hintKey(labels, '', 'KeyD', 'D', true), { kind: 'activate', index: 2, shift: true });
  assert.deepEqual(hintKey(labels, '', 'KeyA', 'a', false), { kind: 'activate', index: 1, shift: false });
});

test('hintKey: a two-letter label is partial after one letter and activates on the second, with only its Shift', () => {
  const labels = hintLabels(15); // ss, sa, sd, …, as
  const first = hintKey(labels, '', 'KeyS', 'S', true);
  assert.deepEqual(first, { kind: 'typed', typed: 's' }, 'Shift on the first letter is ignored');
  assert.deepEqual(hintKey(labels, 's', 'KeyA', 'a', false), { kind: 'activate', index: 1, shift: false });
  assert.deepEqual(hintKey(labels, 's', 'KeyA', 'A', true), { kind: 'activate', index: 1, shift: true });
  assert.deepEqual(hintKey(labels, '', 'KeyA', 'a', false), { kind: 'typed', typed: 'a' });
  assert.deepEqual(hintKey(labels, 'a', 'KeyS', 's', false), { kind: 'activate', index: 14, shift: false });
});

test('hintKey: uppercase keys and non-Latin keys with a Key<X> code match', () => {
  const labels = hintLabels(3);
  assert.deepEqual(hintKey(labels, '', 'KeyS', 'S', false), { kind: 'activate', index: 0, shift: false });
  assert.deepEqual(hintKey(labels, '', 'KeyS', 'ы', false), { kind: 'activate', index: 0, shift: false });
  assert.deepEqual(hintKey(hintLabels(15), '', 'KeyS', 'ы', false), { kind: 'typed', typed: 's' });
});

test('hintKey: a letter matching nothing is ignored and leaves typed as is', () => {
  const labels = hintLabels(3); // s, a, d
  assert.deepEqual(hintKey(labels, '', 'KeyF', 'f', false), { kind: 'ignore' });
  assert.deepEqual(hintKey(labels, '', 'KeyJ', 'j', true), { kind: 'ignore' });
  const two = hintLabels(15); // 'as' is the only label starting with 'a'
  assert.deepEqual(hintKey(two, 'a', 'KeyA', 'a', false), { kind: 'ignore' });
  assert.deepEqual(hintKey(two, 'a', 'KeyS', 's', false), { kind: 'activate', index: 14, shift: false });
});

test('hintKey: Backspace erases a letter and is stable on the empty prefix', () => {
  const labels = hintLabels(15);
  assert.deepEqual(hintKey(labels, 's', 'Backspace', 'Backspace', false), { kind: 'typed', typed: '' });
  assert.deepEqual(hintKey(labels, '', 'Backspace', 'Backspace', false), { kind: 'typed', typed: '' });
  assert.deepEqual(hintKey(hintLabels(197), 'ss', 'Backspace', 'Backspace', true), { kind: 'typed', typed: 's' });
});

test('hintKey: Escape cancels, ? passes, other keys are ignored', () => {
  const labels = hintLabels(15);
  assert.deepEqual(hintKey(labels, 's', 'Escape', 'Escape', false), { kind: 'cancel' });
  assert.deepEqual(hintKey(labels, '', 'Escape', 'Escape', false), { kind: 'cancel' });
  assert.deepEqual(hintKey(labels, 's', 'Slash', '?', true), { kind: 'pass' });
  for (const [code, key] of [
    ['Digit1', '1'],
    ['Numpad1', '1'],
    ['ArrowDown', 'ArrowDown'],
    ['Enter', 'Enter'],
    ['Tab', 'Tab'],
    ['KeyI', 'i'],
    ['KeyQ', 'q'],
    ['Space', ' '],
    ['ShiftLeft', 'Shift'],
    ['F5', 'F5'],
  ] as const) {
    assert.deepEqual(hintKey(labels, '', code, key, false), { kind: 'ignore' }, `${code} is ignored`);
    assert.deepEqual(hintKey(labels, 's', code, key, false), { kind: 'ignore' }, `${code} is ignored mid-label`);
  }
});

test('hintKey: a custom alphabet is honoured', () => {
  const labels = hintLabels(2, 'xy');
  assert.deepEqual(hintKey(labels, '', 'KeyX', 'x', false, 'xy'), { kind: 'activate', index: 0, shift: false });
  assert.deepEqual(hintKey(labels, '', 'KeyS', 's', false, 'xy'), { kind: 'ignore' });
});
