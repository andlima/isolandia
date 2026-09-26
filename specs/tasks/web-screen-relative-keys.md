---
id: web-screen-relative-keys
area: web
priority: 40
depends_on: []
description: Make WASD/arrow/numpad movement in the web iso view screen-relative (W = straight up on screen) instead of grid-relative
---

# Screen-relative movement keys in the web iso view

## Goal

In the browser's isometric view, the movement keys currently map to **grid**
directions, so `W` moves the player map-north, which looks like up-right on
screen. That doesn't match what the player sees. Change the web bindings so
directions follow the **screen**: `W`/↑/numpad 8 moves straight up the
monitor, `D`/→/numpad 6 moves right, and so on. Only the web shell changes.
The sim and the terminal stay as they are.

## Acceptance Criteria

1. In the web view, WASD, the arrow keys and the numpad are all
   screen-relative. Each key has a screen direction (sx, sy), with sx ∈
   {-1,0,1} rightwards and sy ∈ {-1,0,1} downwards:
   - `KeyW`, `ArrowUp`, `Numpad8` → (0,-1); `KeyS`, `ArrowDown`, `Numpad2` → (0,1)
   - `KeyA`, `ArrowLeft`, `Numpad4` → (-1,0); `KeyD`, `ArrowRight`, `Numpad6` → (1,0)
   - `Numpad7` → (-1,-1), `Numpad9` → (1,-1), `Numpad1` → (-1,1), `Numpad3` → (1,1)
2. Held keys are summed in **screen** space and then converted to a grid
   step with `dx = sign(sx + sy)` and `dy = sign(sy - sx)`. This is the
   inverse of the 2:1 projection in `src/iso/projection.ts`. The results are:

   | Screen | Grid step (dx, dy) |
   |---|---|
   | up (W) | (-1,-1) |
   | right (D) | (1,-1) |
   | down (S) | (1,1) |
   | left (A) | (-1,1) |
   | up-right (W+D / Numpad9) | (0,-1) |
   | up-left (W+A / Numpad7) | (-1,0) |
   | down-right (S+D / Numpad3) | (1,0) |
   | down-left (S+A / Numpad1) | (0,1) |

   Opposing keys cancel (for example `A`+`D` → no movement), as they do
   today.
3. `heldDirection` in `src/web/keys.ts`, or its replacement, still returns
   `{ dx, dy } | null` in **grid** units, so `src/web/input.ts` keeps queueing
   an ordinary `step` intent. The sim and the intent format stay unchanged.
4. A blocked step is still just rejected by the sim. This covers a walled
   target and the existing no-corner-cutting rule for diagonals. Nothing new
   is added: no fallback, no sliding.
5. The terminal/ASCII bindings (`src/ascii/terminal.ts`) stay grid-aligned
   and unchanged.
6. The `keys` test in `test/web.test.ts` is updated to assert the new
   mapping. It must cover each of W/A/S/D, at least two two-key diagonals, an
   arrow key, a numpad diagonal, the opposing-keys cancel, and non-movement
   keys → null.
7. Docs are updated. The controls row in `docs/iso.md` should say movement
   is screen-relative (`W` = up on screen) and stop claiming "same bindings
   as the terminal". The doc comment in `src/web/keys.ts` gets the same
   update. The HUD help text in `src/web/hud.ts` can stay as it is unless
   its wording turns out to be wrong.
8. `npm run typecheck` and `npm test` pass.

## Out of Scope

- Changes to the sim, including any wall-sliding or fallback to orthogonal
  components when a diagonal is blocked.
- Camera rotation, or letting the user choose between grid-relative and
  screen-relative keys.
- Terminal key bindings.
- Speed differences between grid-diagonal and orthogonal steps.

## Design Notes

- Keep `MOVE_KEYS` keyed by `KeyboardEvent.code`, but store **screen**
  vectors, then convert once in `heldDirection`. `input.ts` only uses
  `MOVE_KEYS` to test membership and `heldDirection` to compute the step, so
  it should need no logic changes.
- Check: screen (1,-1) (up-right) → dx = sign(0) = 0, dy = sign(-2) = -1 →
  grid (0,-1), i.e. map-north. That matches `worldToIso(0,-1) = (+32,-16)`,
  which is up-right on screen.

## Agent Notes

Read `src/web/keys.ts`, `src/web/input.ts`, `src/iso/projection.ts`
(`worldToIso`), the `keys` test in `test/web.test.ts`, and the Controls
section of `docs/iso.md`. This is a small, self-contained change.
