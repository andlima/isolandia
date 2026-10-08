---
id: ux-time-controls
area: web
priority: 40
depends_on: [ux-hud]
description: UX — shell-level pause and game speed (1×/2×/4×/8×) in browser and terminal — P / Pause key and +/- keys, clickable controls on the HUD clock card, paused indicator, optional auto-pause while windows are open, clicks and menus still usable while paused; a pure pacing module shared by both shells
---

# UX — Pause and time speed

## Goal

The world always runs at 1× (the pack's `ticks_per_second`). The only
pause is an open conversation. You can't stop to think in the middle of a
horde, and you can't skip a quiet night faster than real time. Survival
games of this kind (Project Zomboid) rely on both.

This spec adds **pause** and **speed** controls to both shells. They are
purely a shell concern: the simulation still advances one fixed tick at a
time, deterministically. The only thing that changes is how many ticks a
shell asks for per second of wall time.

Playable result: in `town+zombie`, press `P`. The clock card shows
**Paused**, NPCs freeze, and you can still pan, hover, open the context
menu and choose *Barricade*. The action starts when you press `P` again.
Press `+` three times and the card shows **8×**: the clock races and
hunger climbs visibly. Press `-` to slow back down. On a phone, tap the
⏸ and ⏩ buttons on the clock card. In the terminal, `p` pauses and `+`
/ `-` change speed, and the help line shows `PAUSED` or `4×`.

## Acceptance Criteria

### Pacing module (pure)

1. A small pure module (e.g. `src/core/pace.ts`, with no DOM or Node
   APIs) holds `{ paused: boolean, speed: 1 | 2 | 4 | 8 }`, with
   `togglePause()`, `faster()`, `slower()` (both clamp at the ends),
   `setSpeed(n)` and a `label` (`Paused`, `1×`, `2×`, …). Both shells use
   it.
2. **Browser loop.** `FixedTickLoop` takes the speed into account: at
   speed `s` it runs `s` times as many ticks per wall second, and its
   per-frame cap scales to `5 × s`. While paused it runs no ticks and
   keeps `alpha` frozen, so sprites don't jitter. Changing speed or
   unpausing doesn't produce a burst of catch-up ticks: the accumulator
   is reset, or carried over proportionally.
3. **Terminal loop.** The wall-time pacing in `runTerminal`
   (`startMs`/`startTick`) restarts on every pause, unpause and speed
   change, so the terminal also has no catch-up burst. The catch-up cap
   per interval scales with the speed.
4. Pause and speed are **not** world state. They are never saved, never
   hashed, and don't affect determinism: the same inputs at the same
   ticks give the same world at any speed. A load keeps the current pause
   and speed.

### Controls

5. **Browser keys.**
   - `P` and the `Pause` key toggle pause.
   - `+` / `=` and the numpad `+` go faster; `-` and the numpad `-` go
     slower.
   - These keys work while the transfer window, crafting panel, journal
     or Game panel is open. They are ignored while the context menu or
     the dialogue box captures keys. (A conversation already pauses the
     world, and pressing `P` during one does nothing.)
6. **Clock card.** The HUD clock card (from `ux-hud`) gains a ⏸/▶ button
   and a speed button that cycles `1× → 2× → 4× → 8× → 1×`. Both are
   real buttons, so they are usable by touch and keyboard. While paused
   the card shows **Paused** prominently and the canvas gets a subtle
   dim or desaturation (visual only).
7. **Terminal keys.** `p` toggles pause, and `+` / `=` / `-` change
   speed. None of these keys move in the terminal today, so check that
   they stay free. The help line shows `PAUSED` or the speed when not
   1×, before the sim status.

### Behaviour while paused

8. While paused:
   - **Map interaction still works.** Clicks, Shift-clicks, the context
     menu, the transfer window buttons and Craft buttons queue intents
     and actions as usual (`world.queue…`), and they apply on the first
     tick after unpausing.
   - **Movement keys are ignored**: no steps or turns are queued, and
     holding `W` while paused does nothing, even after unpausing, until
     the key is pressed again.
   - Hover tooltips, the camera, `Space` recenter, zoom and the panels
     work.
   - The journal toast timer and the last-action line freeze with the
     world, because they are tick-based. Wall-clock timers such as the
     save message may keep running.
9. **Auto-pause option.** The Game panel gets a checkbox **Pause while
   windows are open** (default off), stored in `localStorage` under
   one key, with storage errors ignored as for saves. When it is on, the
   world is paused while the transfer window, crafting panel, journal or
   Game panel is open. This pause is separate from the manual one:
   closing the window resumes only if the player didn't press `P` in
   between. The clock card shows **Paused** in both cases.
10. The end of the game (defeat or victory) shows neither **Paused** nor
    a speed. The controls stay clickable but have no effect, since the
    world no longer steps.

### Tests and docs

11. Headless tests:
    - the pacing module's transitions and clamping;
    - `FixedTickLoop` at speeds 1/2/4/8 (ticks per simulated second of
      wall time, the cap, no burst after unpausing or after a speed
      change, `alpha` frozen while paused);
    - two worlds fed the same queued actions at the same ticks, one
      stepped through the loop at 1× and one at 8×, end with the same
      `world.hash()`;
    - the terminal key handling for `p`, `+` and `-`;
    - the auto-pause state machine (manual pause, window pause, both).
12. Docs:
    - `docs/ui.md` gets a **Time** section (pause, speeds, clock-card
      buttons, auto-pause option, what works while paused) and the new
      keys in the Keys table, plus the terminal keys;
    - `VISION.md` §7 records the decision that pause and speed belong to
      the shell, are never saved, and come in four speeds.

## Out of Scope

- "Sleep until morning" or other actions that skip time inside the sim.
- Automatically dropping back to 1× when danger appears (a hostile NPC
  is seen, or damage is taken). A later spec can build that on top of
  the same module.
- Slow motion (speeds below 1×).
- Multiplayer or any synchronised time.

## Design Notes

- Current code: `FixedTickLoop` in `src/web/loop.ts`, the frame loop in
  `src/web/main.ts` (`loop.advance(...)`, key handling around the
  `captureKey` callback), and `runTerminal` in `src/ascii/terminal.ts`
  (the `setInterval` with `startMs` / `startTick`).
- At 8× the city costs about 80 ticks/s × 0.26 ms, well within budget
  (`docs/perf.md`). If the F3 perf line shows dropped time
  (`droppedMs`), the sim slows down instead of spiralling, as today.
- The dialogue pause is world state (`world.conversation`) and stays as
  it is. This spec only adds shell pauses on top of it.

## Agent Notes

- Read `docs/ui.md` and `src/web/main.ts` first. Several features rely
  on per-frame hooks (hover recompute, toast timers), so check each one
  while paused.
- `Space` stays recenter. Don't move it to pause.
