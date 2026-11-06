---
id: keyboard-hints
area: web
priority: 40
depends_on: []
description: "Vimium-style key hints in the browser shell: `F` labels every enabled button of the open windows (transfer window, crafting panel, Game panel, log history) with a short home-row letter label; typing a label presses that button, Shift on its last letter moves one unit of a stack. A pure, tested `src/web/hints.ts` (labels, matching, key reducer) and a thin DOM layer; the context menu, dialogue box and pause menu keep their own keys."
---

# Key hints for the open windows

## Goal

The transfer window is mouse-only today: `Tab` is the inventory toggle, so
browser focus traversal never reaches its rows, and no other key does
anything inside it. The crafting panel and the Game panel have no keys at
all. The context menu and the dialogue box do have keys, but `1`–`9` caps
them at nine options.

This task adds **key hints** in the style of the Vimium browser extension:
pressing `F` while a window is open labels every enabled button in it with
a one- or two-letter label drawn from the home row; typing the label
presses the button. Any number of options becomes reachable with two or
three keystrokes, without a cursor, and the existing keys keep working
(you can still walk with the transfer window open, since hint mode is only
on while the labels show). One generic layer serves every window, so a
future panel gets hints for free.

## Acceptance Criteria

### Pure module (`src/web/hints.ts`, no DOM types, tested headless)

1. **Alphabet.** `HINT_ALPHABET = 'sadfjklewcmpgh'` (Vimium's default:
   home row first, then nearby letters). It is exported so tests and the
   docs can name it.
2. **Labels.** `hintLabels(n, alphabet = HINT_ALPHABET): string[]` returns
   `n` distinct lowercase labels, all of the **same length** `L`, where `L`
   is the smallest with `alphabet.length ** L >= n` (and `L = 1` for
   `n <= 1`). With 14 or fewer targets every label is a single letter; from
   15 to 196, two letters; three beyond that. Labels are assigned in
   alphabet order (`s`, `a`, `d`, …; then `ss`, `sa`, `sd`, …), so the
   first targets get the easiest letters. `hintLabels(0)` is `[]`.
3. **Matching.** `matchHints(labels, typed)` returns
   `{ kind: 'match', index }` when `typed` equals a label,
   `{ kind: 'partial', candidates }` (the indices whose label starts with
   `typed`, in order, non-empty) otherwise, and `{ kind: 'none' }` when
   nothing starts with `typed`. `typed = ''` is a partial match of every
   label.
4. **Key reducer.** `hintKey(labels, typed, code, key, shift)` is a pure
   function of the current state and a key press that returns one of:
   - `{ kind: 'typed', typed }`: a hint letter was appended and the result is
     still partial; or `Backspace` removed the last letter (`typed` may be
     `''` again; `Backspace` on `''` stays `''`).
   - `{ kind: 'activate', index, shift }`: the appended letter completed a
     label. `shift` is the Shift state **of that last key press**; Shift on
     earlier letters is ignored.
   - `{ kind: 'cancel' }`: `Escape`.
   - `{ kind: 'pass' }`: the key is `?` (it must reach the shell and open
     the controls overlay, as everywhere else).
   - `{ kind: 'ignore' }`: any other key (digits, arrows, `Enter`, `Tab`,
     `I`, movement letters not in the alphabet, a letter that would make
     `typed` match nothing). Ignored keys are **consumed** while hint mode
     is on; they never move the player or toggle a window.

   A key press is a hint letter when `key.toLowerCase()` is one character
   of the alphabet, or else when `code` is `Key<X>` and `x` is in the
   alphabet (so a keyboard layout without Latin letters still works by
   physical position; Caps Lock does not matter). `F` is **not** special
   once hints show: `f` is a label letter. Uppercase `key` values (Shift
   held) match their lowercase label letter.

### DOM layer (`src/web/hints-dom.ts`, class `KeyHints`)

5. **Targets.** When shown, the layer collects every `<button>` that is not
   `disabled` and is visible (a non-empty bounding rect) inside the open
   **window roots**: `#transfer`, `#crafting`, `#game` and `#log` (the log
   history panel; only its `×` qualifies). Roots are looked up by id at
   that moment, so a world replaced by a load (which rebuilds `#transfer`
   and `#crafting`) needs no re-wiring. Buttons outside the roots (the HUD's
   `Crafting [C]`, `Journal [J]`, `Log [M]`, `Game [O]`, `Help [?]`
   buttons) are never labelled. Targets are ordered by root in the order
   above, then document order, so the transfer window's tabs, *Take all*,
   container stacks, *Put all* and inventory rows read top to bottom with
   the easiest letters first.
6. **Chips.** Each target gets a chip in a `#hints` layer appended to
   `document.body`: `position: fixed`, `pointer-events: none`, `z-index`
   above every `.panel` (they use 4–10) and below the pause menu and the
   controls overlay (20, 21), placed at the target's top-left corner from
   `getBoundingClientRect()`, clipped to the viewport. A chip shows the
   label in **uppercase**, small monospace bold, dark text on a light
   background with a 1 px border and a 3 px radius (the styles live in
   `index.html` with the other UI CSS). As letters are typed, chips whose
   label does not start with the typed prefix are hidden and the typed
   prefix of the rest is rendered dimmer (a `<span class="typed">`).
7. **Lifecycle.**
   - `show()` collects targets and labels them with `hintLabels`; with
     **no target** it does nothing (so `F` with nothing open is a no-op).
   - `key(code, key, shift, repeat)` returns whether the key was consumed:
     `false` when hints are not shown or the reducer says `pass`; otherwise
     `true` after applying the reducer. An auto-repeat (`repeat`) is
     consumed and ignored, so a held letter types once.
   - `activate` dispatches a synthetic click on the target,
     `new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey:
     shift, detail: 1 })`, then hides. `detail: 1` matters: the transfer
     window ignores `detail === 0` clicks (it handles keyboard `Enter`
     itself). A transfer row thus moves the whole stack, or **one unit**
     with Shift on the last letter, exactly as click / Shift + click; a
     *Use*, *Drop*, *Take all*, *Put all*, tab, *Craft*, *Save*, *Load*,
     *Delete*, *Export*, *Import*, *Title screen* or `×` button does what
     clicking it does.
   - Hints hide on `cancel`, after `activate`, on `pass` (`?` is opening
     the overlay), on any `pointerdown` anywhere (a window-level capture
     listener), and when the target set becomes empty (its window closed,
     e.g. the shown container left reach and the transfer window hid).
   - While shown, the layer keeps chips in place: it re-collects targets and
     positions on a `MutationObserver` over the roots (child list,
     attributes, subtree) and on window `scroll` (capture) and `resize`
     events; checking once per animation frame instead is acceptable, as
     hint mode is short-lived. When the **set of target elements changes**
     (a stack was moved, a tab switched, the panel re-rendered), labels are
     recomputed from scratch and `typed` is cleared; a change of positions
     only moves the chips.
   - `dispose()` removes the layer and listeners (not needed per world,
     since roots are looked up by id; the layer lives for the page).

### Shell wiring

8. **Binding.** `BINDINGS` (`src/web/bindings.ts`) gains, in the *Windows*
   section after `log`:
   - `{ id: 'hints', keys: ['F'], label: 'Key hints: label the buttons of the open windows, type a label to press one', section: 'Windows', codes: ['KeyF'] }`;
   - a new `BindingContext` `'hints'` with `CONTEXT_TITLES.hints = 'While key hints show'`
     and two context rows: `{ id: 'hints_choose', keys: ['letters'], label: 'Type a label to press that button (Shift on the last letter: one unit of a stack)', section: 'Windows', context: 'hints' }`
     and `{ id: 'hints_keys', keys: ['Backspace', 'Escape'], label: 'Erase a letter, cancel', section: 'Windows', context: 'hints' }`.
   The controls overlay (`helpView`) shows the new group under its heading
   with no code change beyond the table; the existing `test/help.test.ts`
   checks (unique ids, a `switch` case per key binding, the docs table)
   must pass.
9. **Dispatch.** `main.ts` creates one `KeyHints` per page (next to `help`
   and `pauseMenu`, not inside `session`). `case 'hints'`: show hints
   unless the context menu or the dialogue box is open (they have their
   own keys; `F` then does nothing). The capture chain becomes
   `help.key(...) || pauseMenu.key(...) || (bindingFor(code, key) !== 'help' && (session.menu.key(code) || session.dialogue.key(code) || hints.key(code, key, shift, repeat)))`,
   so the overlay and the pause menu still take every key, `?` still
   reaches the shell, and hint mode captures everything else while on.
   `Input.captureKey` gains the `shift` and `repeat` arguments
   (`ev.shiftKey`, `ev.repeat`); the existing consumers ignore them. A
   consumed key is `preventDefault`ed as today, so `Backspace` never
   navigates and `Tab` never moves focus while hints show.
10. **`Escape` priority.** `Escape` in hint mode only cancels the hints
    (consumed by the chain before `escapeTarget` sees it); the window stays
    open. `escapeTarget` itself is unchanged.
11. **Nothing else changes.** Movement, `I`/`Tab`, the transfer window's
    `Enter` / `Shift + Enter` on a focused row, the context menu's and the
    dialogue box's `1`–`9` and arrows, the pause menu, the sim, saves and
    the terminal shell are untouched. Hint mode does not pause the world.

### Tests, verification, docs

12. **Tests** (`node:test`, headless) in a new `test/hints.test.ts`:
    - `hintLabels`: 0, 1, 14 (all single letters, distinct, in alphabet
      order), 15 and 196 (all two letters, distinct, none a prefix of
      another), 197 (three letters); a custom alphabet is honoured.
    - `matchHints`: exact, partial (with candidate indices in order), none,
      and `''` as everything.
    - `hintKey`: typing a full one-letter label activates with `shift`
      false and true; a two-letter label is partial after one letter and
      activates on the second with the second key's Shift only; an
      uppercase `key` matches; `code` `KeyS` with a non-Latin `key`
      matches; a letter that matches nothing is `ignore`d and leaves
      `typed` as is; `Backspace` erases and is `''`-stable; `Escape`
      cancels; `?` passes; `Digit1`, `ArrowDown`, `Enter`, `Tab`, `KeyI`
      are `ignore`d.
    - `test/help.test.ts` passes as is (it will check the new binding's
      `switch` case and the docs table rows automatically).
13. **`npm test`, `npm run typecheck`, `npm run build` pass** (the
    `.spec.toml` gates). `npm run smoke` is reported as not runnable in the
    sandbox if Chromium cannot start there, not as passing.
14. **Docs.**
    - `docs/ui.md`: the *Transfer window* section gets a **Keyboard**
      bullet (hints via `F`, Shift on the last letter for one unit, that
      `Tab` is the inventory toggle so focus traversal is not the way in);
      the *Crafting panel* and *Saving and loading* sections each get one
      sentence pointing at `F`; the *Controls and pause menu* section lists
      the new context group; a short **Key hints** subsection (under
      *Controls and pause menu* or next to the transfer window) describes
      the alphabet, label length rule, which buttons are labelled, the
      cancel rules and the pure/DOM split (`hints.ts` / `hints-dom.ts`).
      The **Keys** table gets rows for `F`, and for `letters`,
      `Backspace` and `Escape` in hint mode (the docs test matches the
      `keys` strings literally, backticks stripped).
    - `src/web/bindings.ts` and `src/web/input.ts` doc comments mention
      the hint layer where they describe the capture chain.

## Out of Scope

- Arrow-key or `Tab` navigation inside the transfer window, crafting or
  Game panel; selection highlighting there.
- Hints for the context menu, the dialogue box, the pause menu, the
  controls overlay, the title screen / pack picker, or the HUD buttons;
  replacing or extending the `1`–`9` digits beyond nine rows.
- An always-on mode (labels shown whenever a window is open), a
  configurable alphabet or trigger key, mixed-length (prefix-free) labels,
  or hints for links and non-button controls (the Game panel's checkbox
  and file input).
- Touch, the terminal/ASCII shell, the sim, saves.
- Pausing the world while hints show.

## Design Notes

- **Why a trigger key, not always-on labels.** The transfer window is meant
  to stay open while you walk (its tabs follow reach, and it sits below
  the middle of the screen so it never covers the player). Always-on
  letter hints would collide with WASD. A short modal hint mode, entered
  with `F` as in Vimium, keeps every existing key and makes the collision
  moot: while labels show, letters are labels; the moment you act or
  cancel, they are keys again.
- **Why uniform label length.** Vimium hands out prefix-free labels of
  mixed length so most targets keep a single letter. Uniform length is
  simpler to compute, test and read, and a window with more than 14
  buttons is already a two-letter situation for part of its rows. It can
  be revisited without touching the DOM layer: only `hintLabels` changes.
- **Why `f` stays a letter in hint mode.** Vimium behaves the same way;
  `Escape` is the cancel. Removing `f` from the alphabet to make `F` a
  toggle would also shrink the single-letter range.
- **Why a synthetic click.** Every window already turns a click into the
  right action (`TransferWindow.activate` reads `data-move` / `data-one` /
  `data-actions` and honours Shift; `Panels.onClick` runs `data-actions`;
  `GamePanel` reads `data-command` / `data-slot`). Dispatching a click with
  `detail: 1` and `shiftKey` reuses all of that, needs no new protocol
  between panels and the hint layer, and keeps "what a label does" equal
  to "what a click does" by construction. The file input behind *Import*
  still opens, because a keydown handler counts as user activation.
- **Why roots by id.** `session` (the world, panels, menu, dialogue) is
  rebuilt on load; `game` and `logView` are not. Querying
  `#transfer, #crafting, #game, #log` when `F` is pressed avoids threading
  the panels through the hint layer and surviving the swap.
- **Capture chain.** `captureKey` already runs before `bindingFor`, so a
  consumed letter never reaches `MOVE_KEYS`; `keyup` still calls
  `moves.up(code)`, which is harmless. Keep hints inside the
  `bindingFor(code, key) !== 'help'` guard so `?` behaves as it does over
  the menu and the dialogue.
- **Chip layout.** `position: fixed` chips over `getBoundingClientRect()`
  are correct whatever the panel's own positioning and scrolling; a
  `MutationObserver` on the roots plus `scroll` (capture, since panes
  scroll internally) and `resize` is enough. The transfer window
  re-renders by `replaceChildren` only when its view JSON changes, so the
  target set is stable while nothing happens in the world.
- **Styling.** Start from `.menu-key` (`index.html` ≈ line 294) for size
  and font; use dark text on a light chip so labels pop over the dark
  panels. Hidden chips use the `hidden` attribute; no animation.

## Agent Notes

- Read first: `AGENTS.md`, this spec, `docs/ui.md` (*Transfer window*,
  *Controls and pause menu*, *Keys*), `src/web/bindings.ts`,
  `src/web/input.ts` (the `keydown` listener), `src/web/main.ts` (the
  `captureKey` line and the `key: (id) => switch` block; `test/help.test.ts`
  parses that block with a regex, so keep its shape),
  `src/web/transfer-dom.ts` (`activate`, the `detail === 0` guard, the
  `data-*` attributes), `src/web/panels.ts` (`Panels.onClick`),
  `src/web/game-panel.ts`, `src/web/log-dom.ts`, `src/web/help-dom.ts`
  (`HelpOverlay.key`, `PauseMenu.key` for the capture style),
  `src/web/menu.ts` (`shortcutOf`, `moveSelection` as the pure-helper
  pattern), `test/help.test.ts`, `test/interaction.test.ts` (how the menu's
  pure key helpers are tested).
- Order: `hints.ts` + `test/hints.test.ts` → `hints-dom.ts` + CSS →
  `bindings.ts` rows and context → `input.ts` `captureKey` arguments →
  `main.ts` wiring → docs table and prose → `npm test`, `npm run
  typecheck`, `npm run build`.
- There is no jsdom; the DOM layer is not unit-tested. Keep every decision
  (labels, matching, what a key does) in `hints.ts` so the DOM class is a
  thin shell.
- Chromium cannot start in the sandboxed shell, so `npm run smoke` fails
  for that reason; say so in the report instead of retrying.
- Frontmatter note: the `description` is quoted because it contains `: `.
