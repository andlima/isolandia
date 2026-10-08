---
id: ux-message-log
area: web
priority: 40
depends_on: [ux-hud]
description: UX — a message log of recent events in both shells — the player's action results, statuses gained and lost, journal/quest/standing events, defeat/victory and shell notes — from new per-tick world.actionEvents/statusEvents plus journalEvents, a pure logLines formatter, a fading recent-lines strip and an expandable history (M) in the browser, and an M history screen in the terminal
---

# UX — Message log

## Goal

Feedback is scattered and short-lived. The HUD shows one `lastAction`
line for 3 s, and when two actions finish in the same tick, only the last
one is visible. Journal toasts disappear after 4 s. Gaining or losing
**Hungry** produces no message at all: the status line just changes.
Defeat shows a banner. There is nowhere to look back and see what just
happened.

This spec adds a **message log**. The core reports what happened to the
player each tick, a pure formatter turns those reports into lines, and
both shells keep the last 100 lines. The browser shows the newest few
lines fading out at the bottom left, plus a history panel. The terminal
shows the newest line on the message line, plus a history screen.

Playable result: in `town+zombie`, take all from a fridge. The log reads
`Took 2 Canned beans` and `Took 1 Water bottle` as two lines. Hours
later, `You are now Hungry.` appears in red, and after eating,
`Ate Crackers` and then `You are no longer Hungry.` Starting the zombie
quest logs `Journal: Find the radio: …`. Press `M` to open the full
history and scroll back through the day's events, each with its `Day 1
14:05` time.

## Acceptance Criteria

### Core events (per tick)

1. `World` gains two per-tick lists, cleared at the start of every
   `step` and before each conversation input, exactly like
   `journalEvents`:
   - **`actionEvents: ActionRecord[]`**: every player action record
     produced this tick (or by this conversation input), in order.
     `lastAction` keeps its meaning (the latest record).
   - **`statusEvents: { tick, status, entered: boolean }[]`**: the
     player's statuses that turned on or off in `updateStatuses` this
     tick, in definition order. NPC statuses are not reported.
   Neither list is saved or hashed (same as `journalEvents`).
2. Status definitions accept optional texts `hud.enter` / `hud.exit`
   (they extend the `hud` block from `ux-hud`). The defaults are `You are
   now <Label>.` and `You are no longer <Label>.`. Either text can be set
   to an empty string to stay silent.
3. The bundled packs give a few statuses flavourful texts, for example
   `std-needs` hungry: `Your stomach growls.` / `You feel fed.`, and a
   vampire status that makes sense in its genre.

### Formatter (pure)

4. **`logLines(world): LogLine[]`** in `src/core/log.ts`, called right
   after a step (or a conversation input), turns that tick's events into
   lines `{ tick, clock, text, tone: 'info' | 'good' | 'bad' }`, in this
   order:
   - action results, using the existing `actionText`. Records with `stage`
     `complete` are logged, as are `start` records that failed. A
     successful `start` (an activity beginning) isn't logged, because the
     activity bar already shows it. Failures and interrupted or cancelled
     activities get tone `bad`;
   - journal events, using the existing `journalToast` / `standingToast`
     texts, one line per event (no `(+N)` folding);
   - status events, with tone from the status's `hud.tone` on entering
     and `good` when a `bad`-toned status ends;
   - defeat and victory, using the outcome text, on the tick they happen.
   An `unreachable` goto result (`You can't get there.`) is logged once,
   even when it repeats on several ticks.
5. Shells may add their own **notes** (`Saved to slot 2`, `Load failed:
   …`, storage errors) through the same `LogLine` shape with tone `info`
   or `bad`.

### Log buffer

6. A shell-side ring buffer keeps the **last 100 lines**. Consecutive
   identical texts collapse into one line with a count (`Too heavy (×3)`).
   The log isn't saved. A load clears it and adds the note `Loaded Day N
   HH:MM`.

### Browser

7. **Recent strip** (bottom left, above the Crafting/Game buttons): the
   newest **5** lines, oldest at the top, each fading out about 8 s after
   it arrived (wall time). Tone colours: info is default, good is green,
   bad is red. It takes no pointer events. It replaces the HUD's
   last-action line, which is removed from the overlay (the field stays
   in `HudModel` for the terminal's HUD lines). The journal toast stays
   as it is.
8. **History panel**: `M` (and a **Log [M]** button next to Crafting /
   Game) toggles a scrollable panel listing all buffered lines with their
   `Day D HH:MM`, newest at the bottom, scrolled to the bottom on open.
   It follows the existing panel rules: `Escape` or the × button closes
   it, and opening it closes the transfer window like the other panels
   do. While it is open the recent strip is hidden.
9. `H` hides the strip along with the HUD. The history panel ignores `H`.
10. Re-rendering follows the usual rule: re-render only when the buffer's
    version changes, and use one CSS transition for the fades.

### Terminal

11. The message line (where `say` writes today) shows the newest log
    line for 4 s, as journal toasts and save messages do today. They now
    go through the log, so they also land in the history.
12. `M` (uppercase; lowercase `m` stays free) shows the last lines that
    fit the screen as text, each prefixed with `HH:MM`, until any key,
    just like `J` shows the journal. The help line lists `M: log`.

### Tests and docs

13. Headless tests:
    - `actionEvents` holds every record of a tick (two takes in one tick
      give two records) and is cleared on the next step;
    - `statusEvents` for enter and exit with hysteresis (`until`), NPC
      statuses excluded;
    - `logLines` order and tones, the default and custom texts, and
      silence via an empty text;
    - collapsing duplicates in the ring buffer, and the 100-line cap;
    - `unreachable` logged once;
    - zombie and vampire runs in which a quest event, a status event and
      an action land in the log.
14. Docs:
    - `docs/ui.md` gets a **Message log** section (strip, history, `M`,
      tones, what is logged) and the `M` key in the Keys table and the
      terminal notes;
    - `docs/packs.md` documents `hud.enter` / `hud.exit` on statuses.

## Out of Scope

- Combat or damage numbers, and NPC-to-NPC events (`Zombie hits
  survivor`). Only the player's own events are logged.
- Filtering, searching or exporting the log.
- Saving the log with the game.
- Pack-authored arbitrary log messages (a `log` effect). That is a
  natural follow-up once the event plumbing exists.

## Design Notes

- Current code: `journalEvents` handling in `World.step` and before
  conversation inputs (`src/core/sim/world.ts`, the "fresh journal
  events" helper), `lastAction` assignments (search for `this.lastAction
  =`), `updateStatuses`, `actionText` in `src/core/hud.ts`,
  `journalToast` / `standingToast` in `src/core/journal.ts`, and the
  terminal `say` / `journalMessage` in `src/ascii/terminal.ts`.
- `updateStatuses` copies `next` into `e.st`. For the player, compare
  the old and new flag before the copy to emit events. Keep the hot loop
  free of allocations for NPCs.
- The strip and the panel live in a new `src/web/log-dom.ts`. The ring
  buffer is plain TypeScript and is shared with the terminal.

## Agent Notes

- Read `docs/ui.md` (Journal, toasts) and the `ux-hud` spec first.
  `ux-hud` adds the status `hud` block that this spec extends.
- Make sure the per-tick lists are cleared in exactly the same places as
  `journalEvents`. A stale list would log the same event twice.
