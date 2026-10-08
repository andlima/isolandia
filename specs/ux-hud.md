---
id: ux-hud
area: web
priority: 40
depends_on: []
description: UX — replace the browser's <pre> text HUD with a styled overlay built from hudModel — clock/day-night/floor card, measurement bars coloured by pack-declared warn/danger levels, status chips with tone and tooltip, carrying weight bar, compact narrow layout; optional `hud` hints on measurements and statuses, also used to colour the terminal HUD
---

# UX — Graphical HUD

## Goal

The browser HUD is a `<pre>` block of text lines (`Time: Day 1 08:00
(tick 0)`, `Hunger: 23.4/100`, `Status: Hungry, Burdened`, …). It is the
same text the terminal prints. It is hard to scan, and it can't show
whether `Hunger: 70` is fine or dangerous, because the engine has no idea
whether a high hunger value is good or bad.

This spec turns it into a **styled overlay**: a clock card, one bar per
measurement coloured by how bad it is, chips for statuses, and a weight
bar. Packs get a small optional `hud` hint that says which direction is
bad and where the warning levels are. The terminal uses the same levels to
colour its lines.

Playable result: start `town+zombie`. The top-left card shows `Day 1 ·
08:00` with a sun icon. Under it are bars for Health (green, full),
Hunger, Thirst and Fatigue (green, low). Wait a few in-game hours and the
Hunger bar turns amber, then red, and a red **Hungry** chip appears.
Hover the chip to read *Losing health while hungry* and `Health −0.2/s`.
Pick up a heavy stack and the carrying bar fills and turns amber near
capacity, and a **Burdened** chip appears. In the terminal, the `Hunger:`
line is printed in yellow, then red.

## Acceptance Criteria

### Pack hints

1. **Measurements** accept an optional `hud` block:
   ```yaml
   - id: hunger
     label: Hunger
     max: 100
     hud: { bad: high, warn: 50, danger: 75 }
   - id: hp
     hud: { bad: low, warn: 50, danger: 25 }
   ```
   - `bad: high | low` says which direction is bad. When `bad` is absent
     the measurement is neutral and has no levels.
   - `warn` and `danger` are absolute values. Each defaults to a fraction
     of the range `[min, max]`: 50 % and 75 % of the way toward the bad
     end. With an unbounded or per-entity `max`, the defaults use the
     entity's current max, and a measurement with no finite max has no
     default levels.
   - `hide: true` keeps the measurement out of the HUD in both shells.
   - Load-time validation rejects unknown keys and a `warn`/`danger`
     order that contradicts `bad`: for `high`, `warn ≤ danger`; for
     `low`, `warn ≥ danger`. It also rejects `warn`/`danger` without
     `bad`.
2. **Statuses** accept an optional `hud` block: `{ tone: bad | good |
   neutral, description: "…" }`. `tone` defaults to `neutral`.
   `description` is free text shown in the tooltip.
3. The hints are plain definition data. Overrides (`m7-overrides`) can
   patch them like any other field, and they are neither saved nor
   hashed.
4. The bundled packs declare hints: `std` (hp: bad low), `std-needs`
   (hunger, thirst, fatigue: bad high; hungry, thirsty, exhausted,
   burdened: tone bad, with one-line descriptions), and the statuses of
   `zombie`, `vampire`, `town` and `garden` (a tone, plus a description
   where the effect isn't obvious from the label).

### Model (core, pure)

5. `HudMeasurement` gains `fraction` (in [0, 1] of `[min, max]`, or null
   when max is not finite), `level: 'ok' | 'warn' | 'danger' | null`
   (null when neutral) and `bad: 'high' | 'low' | null`. Hidden
   measurements are left out of `measurements`.
6. `HudModel` gains `statusChips: { id, label, tone, description, rates
   }[]` for the player's active statuses in definition order. `rates` is
   display text built from the status's rates on the player's
   measurements (`Health −0.2/s`, `Fatigue +0.1/s`), using measurement
   labels and one decimal. Expression rates are evaluated for the player
   at the current tick.
7. `HudModel` gains `isDay: boolean` (the `world.is_day` value) and the
   inventory gains `fraction` (weight / capacity, clamped to [0, 1]) and
   `level` (`warn` at ≥ 80 %, `danger` at ≥ 100 %).
8. `hudLines` and the existing text fields stay as they are, so the
   terminal layout doesn't change.

### Browser overlay (DOM)

9. The `<pre id="hud">` is replaced by an overlay drawn from the pure
   **`hudView(model)`** in `src/web/hud.ts`, which returns a plain object
   with no DOM types:
   - **Clock card** (top left): `Day D · HH:MM`, a sun or moon icon from
     `isDay`, and a `Floor N` chip on multi-floor maps. The tick number
     is no longer shown, except in the F3 perf line.
   - **Measurement rows**: label, a bar for `fraction`, and the value
     (`23` or `23/100`, rounded to whole numbers). The bar colour comes
     from `level`: green for ok, amber for warn, red for danger, and a
     neutral grey-blue when `level` is null. A measurement with no finite
     max shows its value only. A `danger` row pulses gently, and the
     pulse is disabled under `prefers-reduced-motion`.
   - **Status chips** under the bars, coloured by tone (bad red, good
     green, neutral grey). Hovering a chip (mouse and pen) or tapping it
     (touch) shows a tooltip with the label, description and rates.
   - **Carrying bar** (when the player has an inventory): `Carrying
     w/cap` with a bar coloured by the inventory `level`.
   - **Nearby**: the existing `Nearby:` text as one muted line, cut with
     `…` when too long.
   - The **last action** line, activity bar, defeat and victory banners,
     journal toast and perf line keep their current behaviour and
     positions.
10. **Layout.** The overlay is at most ~240 px wide at the top left, has
    a translucent background, and doesn't take pointer events except on
    chips. Below 560 px of viewport width it becomes compact: bars without
    labels but with a 2–3 letter abbreviation (the first letters of the
    label), and the chips wrap. Nothing overlaps the Journal button or
    the top-right controls.
11. **Updates.** The DOM re-renders only when the `hudView` JSON
    changes. Values are rounded so that a drifting measurement doesn't
    rebuild the DOM every tick (bars move in whole percent steps).
12. `H` still toggles the whole overlay (and hover tooltips), as today.

### Terminal

13. The terminal prints each measurement line in yellow at `warn` and red
    at `danger`, and the `Status:` line in red when any active status has
    tone `bad`. Nothing else in the terminal changes.

### Tests and docs

14. Headless tests:
    - the hint defaults (50/75 % toward the bad end for both directions)
      and explicit values;
    - validation errors (unknown key, contradictory order, levels without
      `bad`);
    - `hide`;
    - `level` transitions as a measurement drifts;
    - chip `rates` text for a constant and an expression rate;
    - the inventory `level`;
    - `hudView` for zombie and vampire worlds (a snapshot of the view
      object is fine).
15. Docs:
    - `docs/packs.md` documents the measurement and status `hud` blocks;
    - `docs/ui.md` describes the overlay (card, bars and colours, chips
      and tooltips, carrying bar, compact layout) in place of "HUD text";
    - the Keys table entry for `H` says "Toggle the HUD".

## Out of Scope

- Icons per measurement or status (`hud.icon` can come later, with
  art).
- A minimap, a compass or an objective marker.
- A player portrait, or bars over NPCs' heads.
- Moving the last-action line into a log (`ux-message-log`).
- Pause and speed controls (`ux-time-controls`).
- Changing the terminal layout beyond colouring.

## Design Notes

- Current code: `hudModel` / `hudLines` in `src/core/hud.ts`, the `Hud`
  class in `src/web/hud.ts`, the `#hud` CSS in `index.html`, and
  measurement/status loading in `src/core/load/` (look for how
  `StatusDef` and `MeasurementDef` are built).
- `world.is_day` already exists in the expression context. Read it the
  same way the lighting code does instead of recomputing it from the
  clock.
- Keep the pure/DOM split used by `transferView` and `dialogueBox`. The
  view function is what the tests target.
- Status rates are `StatusRate` entries on `StatusDef`. A rate on a
  measurement the player doesn't have is skipped in `rates`.

## Agent Notes

- Read `docs/ui.md`, the `std-needs` pack and `src/core/hud.ts` first.
- Check the overlay at 360 px width and with the transfer window open:
  the HUD is top-left and the window is bottom-right, so they must not
  overlap.
- Run `npm run smoke` if it is available, to make sure the page still
  boots for every bundled stack.
