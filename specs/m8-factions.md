---
id: m8-factions
area: sim
priority: 40
depends_on: [m8-flags-quests]
description: M8 factions — a pack-defined `factions` domain (label, starting reputation, relations, hostile/friendly thresholds, named tiers), archetype `faction`, a world-level player reputation per faction, `in_faction`/`reputation`/`attitude`/`hostile`/`friendly` built-ins, a `reputation` effect with optional `witnessed` range and `spread` through relations, tier-change toasts, a Standing section in the journal, saves and overrides
---

# M8c — Factions and reputation

## Goal

In a noir town the police and the mob remember what you did. In a
western, the townsfolk and the gang take sides. M8 needs **groups of
NPCs that share an opinion of the player** and an opinion of each other,
so that:

- dialogues can be gated by standing (*The sergeant only trusts
  friends*);
- behaviors can turn on a hostile player (*the gang draws on sight*);
- crimes count only when **someone sees them**.

This spec adds **factions**:

- archetypes belong to one;
- the player has a **reputation** with each faction, as world state;
- factions have fixed **relations** with each other;
- expressions read **attitudes**;
- a `reputation` effect changes standing, optionally only when
  **witnessed** by a member and optionally **spreading** to allies and
  enemies.

Playable result (with a test fixture pack; shipped content comes in
`m8-social-games`): picking a lock in sight of a police officer drops
your *Police* standing from *Neutral* to *Wary*, a toast says so, the
journal's *Standing* section shows it, and the mob's opinion of you goes
up a little.

No engine code may be genre-specific.

## Acceptance Criteria

### Pack schema

1. **`factions`** is a new domain: a list with its own id space.

   | Field         | Type                      | Default  | Notes |
   |---------------|---------------------------|----------|-------|
   | `id`          | id                        | required | |
   | `label`       | string                    | required | e.g. `Police` |
   | `reputation`  | number in [-100, 100]     | `0`      | The player's starting standing |
   | `relations`   | map faction id → number in [-100, 100] | `{}` | How this faction regards others |
   | `hostile_below` | number                  | `-50`    | `hostile` threshold (AC 3) |
   | `friendly_from` | number                  | `50`     | `friendly` threshold; must be > `hostile_below` |
   | `tiers`       | list of `{ from: number, label }` | see below | Ascending `from`; the first must be `-100` |
   | `hidden`      | boolean                   | `false`  | Not shown in the journal's *Standing* section |

   - The default `tiers` are `Hostile` from -100, `Wary` from -50,
     `Neutral` from -10, `Liked` from 10 and `Trusted` from 50.
   - Relations need not be symmetric. A relation to the faction itself is
     a load error, since members always regard each other at `100`.
   - Unknown faction ids are load errors with *did you mean*.
2. **Archetypes** gain **`faction: <id>`** (default none). The player's
   archetype may have one too: `in_faction(player, "f")` reads it, but
   `attitude` ignores it (AC 3), so reputation alone decides how factions
   regard the player.

### Expressions

3. New built-ins. Faction ids are **string literals** resolved at load
   (an unknown id is a load error with *did you mean*). Entity arguments
   are entities, checked at load as for `can_see`.

   | Built-in | Value |
   |----------|-------|
   | `in_faction(e, "f")` | Whether `e`'s archetype belongs to `f`. Method form: `self.in_faction("f")` |
   | `reputation("f")` | The player's current standing with `f` |
   | `attitude(a, b)` | How `a` regards `b`, a number in [-100, 100] (rules below) |
   | `hostile(a, b)` | `attitude(a, b) < ` the regarding faction's `hostile_below` |
   | `friendly(a, b)` | `attitude(a, b) >= ` the regarding faction's `friendly_from` |

   **`attitude(a, b)`**, from `a`'s point of view:
   - `a` and `b` are the same entity: `100`;
   - `a` is an NPC without a faction: `0`;
   - `a` is an NPC of faction F and `b` is the **player**:
     `reputation(F)`;
   - `a` and `b` are NPCs of the same faction: `100`;
   - `a` is an NPC of F and `b` is an NPC of G: `F.relations[G]`, or `0`
     when unset (also `0` when `b` has no faction);
   - `a` is the **player** and `b` is an NPC of G: `reputation(G)`, so the
     player's view mirrors the faction's view of them. When `b` has no
     faction it is `0`.

   The **regarding faction** for the thresholds is `a`'s faction, or
   `b`'s when `a` is the player. With no faction on either side,
   `hostile` and `friendly` are false.

   The player's own `faction` plays no part in these rules.

### Effects and simulation

4. **State.**
   - The world holds one reputation value per faction (a `Float64Array`),
     initialised from `reputation` and clamped to [-100, 100] on every
     write.
   - It is part of `snapshot()` and `hash()`.
   - `in_faction` compiles to an archetype flag read, and `attitude` to
     at most two array reads.
5. **`reputation` effect**, valid in every effect list (systems, item
   uses, actions, recipes, quest stages and dialogue nodes and choices):

   ```yaml
   - { type: reputation, faction: police, delta: -15, witnessed: 8, spread: true }
   ```

   | Field       | Type                     | Default | Notes |
   |-------------|--------------------------|---------|-------|
   | `faction`   | faction id               | required | |
   | `delta`     | number or expression     | required | |
   | `witnessed` | number > 0 (tiles)       | none    | Apply only if a member sees the effect's `self` (below) |
   | `spread`    | boolean                  | `false` | Also change other factions through their relations (below) |

   - **Witnessed.** The effect applies only if at least one entity of
     that faction:
     - is not `self` and not the player;
     - is on `self`'s floor, within euclidean distance `witnessed` of
       `self`;
     - has `can_see(member, self)`.

     The search uses `entitiesNear` (id order, stopping at the first
     witness), so it costs nothing beyond the radius. In a dialogue,
     `self` is the player and the NPC being talked to counts as a
     witness like any other member.
   - **Spread.** After changing faction F by `delta`, every other
     faction G with a relation `G.relations[F] = r ≠ 0` changes by
     `delta × r / 100`, rounded to 2 decimals. This happens once and
     does not chain. Helping the police (+10) with the mob regarding the
     police at -80 changes the mob by -8.
   - The same `faction` written twice in one effect list applies twice.
     In a system, the effect runs once per matching entity, as for
     `add_var`.
6. **Events.**
   - A reputation change that moves a non-hidden faction into another
     **tier** appends `{ tick, kind: 'reputation', faction, from, to }`
     (tier labels) to `world.journalEvents` (from `m8-flags-quests`) and
     bumps `journalVersion`.
   - A change within a tier bumps only `journalVersion`, with no event.
7. **Query.** `world.journal()` gains `standing`: one item per non-hidden
   faction, in definition order, `{ faction, label, value, tier }`.
   `world.attitudeOf(entity)` returns, for a shell, `{ faction, label,
   tier, hostile, friendly }` toward the player, or null for an NPC
   without a faction. Both are pure.

### Saves and overrides

8. **Saves.**
   - The snapshot gains `reputation` (`{ qualified faction id: value }`).
   - Bump `SAVE_VERSION` past whatever the earlier M8 specs used, and
     keep the previous version readable: every faction takes its
     starting `reputation`.
   - An unknown faction in a save is a restore error with *did you
     mean*. A faction the packs define but the save lacks takes its
     starting value with a **warning**.
   - `assertRoundTrip` covers changed standings.
9. **Overrides.** `factions` take `override: true` and `remove: true`.
   `relations` and `tiers` are single fields, replaced whole. Removing a
   faction still named by an archetype, a relation, an expression or an
   effect is a load error naming the remover. Archetype `faction` is an
   ordinary patchable field, so a mod can enlist the town's residents.

### Shells

10. **Browser.**
    - The journal panel gains a **Standing** section: each faction's
      label, tier and a small bar from -100 to 100.
    - Tier events toast as `<Label>: <from> → <to>` (pure
      `journalToast`).
    - The hover tooltip of an NPC with a faction adds its tier, e.g.
      `Talk to Officer · Police (Wary)`. A hostile one shows the tier in
      the danger colour.
11. **Terminal.** The journal view gains the standing lines
    (`Police: Wary (-22)`), and tier events go to the message line.

### Tests and docs

12. Headless tests (fixture pack) cover:
    - **Loader:** every load error in AC 1–3 and 9.
    - **Attitude:** every row of the AC 3 rules, the thresholds and the
      regarding faction.
    - **Effects:** clamping; `witnessed` with a member in sight, out of
      range, behind an opaque edge, on another floor, and `self` being
      the only member; `spread` arithmetic and no chaining; and the
      per-entity semantics in systems.
    - **Integration:** a behavior that switches to `pursue` on
      `hostile(self, player) and can_see(self, player, 8)`; a dialogue
      choice gated by `reputation`; tier events and the `journal()`
      standing.
    - **Saves:** the round trip, the previous-version upgrade, restore
      errors and warnings.
    - **UI models:** the standing section, toasts and tooltip text.
    - **Guards:** determinism and the genre-word guard.
13. **Docs.**
    - `docs/packs.md` documents `factions`, archetype `faction` and the
      `reputation` effect.
    - `docs/expressions.md` documents the built-ins and the attitude
      table.
    - `docs/saves.md` documents the new version.
    - `VISION.md` §7 records the decisions:
      - membership is per archetype;
      - the player's standing is world state per faction;
      - relations are fixed data and can be asymmetric;
      - crimes count when a member sees them;
      - spread is one step and opt-in;
      - NPC-to-NPC hostility is readable but not yet acted upon.

## Out of Scope

- NPCs **finding** other NPCs to fight or flee from (a `nearest(...)`
  built-in or behavior targets other than an expression such as
  `player`). Attitudes between NPCs can be read but nothing seeks out
  enemies yet. This is the next step once combat is decided.
- Changing relations between factions at run time, per-entity
  reputation, and memory of individual crimes or witnesses who report
  later.
- Disguises, joining or leaving factions in play, and faction ranks for
  the player.
- Combat and aggression rules: packs build them from `hostile` in
  behaviors and systems.

## Design Notes

- Store each archetype's faction as an index (or -1) and keep a
  per-faction `Float64Array` of relations (an F×F matrix, with `NaN` or a
  flag for unset). The diagonal is unused because same-faction is `100`.
- `witnessed` should reuse `entitiesNear` and the existing `can_see`
  code. Precompute, per faction, whether any archetype belongs to it, so
  a faction without members short-circuits to "not witnessed".
- Spread iterates over a precomputed list of (G, r) pairs per F, with no
  allocation per effect.
- Rounding to 2 decimals keeps spread deterministic and readable. Use
  the same rounding helper as weights if one fits.

## Agent Notes

- Read these first:
  - `specs/m8-flags-quests.md` (journal events, `journal()`, toasts) and
    `specs/m8-dialogues.md` (dialogue effects), and their
    implementations if they are merged;
  - `docs/expressions.md` (`can_see`, entity arguments);
  - `src/core/sim/world.ts` (`entitiesNear`, effect running);
  - `src/web/hover-dom.ts` and `src/web/menu.ts` (tooltip text).
- This spec does not need `m8-dialogues` to be implemented. If it is
  not merged yet, skip the dialogue-specific test and note it in the
  report. The `reputation` effect in dialogues is then added by
  whichever spec lands second.
- Suggested order:
  1. defs and loader;
  2. world state and built-ins;
  3. the effect with `witnessed` and `spread`;
  4. events and queries;
  5. saves and overrides;
  6. shells;
  7. docs and VISION.
- Chromium is unavailable in the sandbox. Keep view logic in pure
  functions.
