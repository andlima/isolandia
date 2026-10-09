---
id: m8-dialogues
area: sim
priority: 40
depends_on: [m8-flags-quests]
description: "M8 dialogues — a pack-defined `dialogues` domain (conditional entry nodes, nodes with speaker/text/effects, choices with when/unavailable/consume/give/effects/once/to), archetype `dialogue`, a `talk` action and *Talk to* interaction with walk-then-talk, a paused world while a conversation is open (`choose`/`leaveConversation`), an `npc` scope and `on: npc` effects, conversation in saves, a browser dialogue box and a terminal conversation view"
---

# M8b — Dialogues

## Goal

M8 needs NPCs you can **talk to**: witnesses in a noir mystery, an
outlaw calling you out in a western. Today the player can only act on
tiles, containers and themselves. NPCs are moved by behaviors but cannot
be addressed.

This spec adds **dialogues**: declarative conversation trees attached to
archetypes. A conversation is started with a new `talk` action, and the
**world is paused** while it is open, as in most RPGs. A choice can:

- be gated by expressions;
- cost or give items;
- run effects on the player or on the NPC, including the `m8-flags-quests`
  effects, so conversations set vars, advance quests and add clues to the
  journal.

Playable result (with a test fixture pack; shipped content comes in
`m8-social-games`): right-click an NPC and pick *Talk to Barkeep*. The
character walks up, the world freezes and a dialogue box shows the
barkeep's line and numbered answers. One answer, *Pay for the
information (2× Coin)*, is greyed out until you hold the coins.

No engine code may be genre-specific.

## Acceptance Criteria

### Pack schema

1. **`dialogues`** is a new domain: a list with its own id space.

   | Field         | Type       | Default  | Notes |
   |---------------|------------|----------|-------|
   | `id`          | id         | required | |
   | `when`        | expression | `true`   | Whether the NPC will talk at all |
   | `unavailable` | string     | none     | Shown when `when` is falsy, e.g. `He ignores you` |
   | `start`       | node name, or list of `{ when?, node }` | required | The first entry whose `when` is truthy (no `when` = always) picks the opening node. Falling off the end of the list is a runtime failure (AC 6), so a list should end with an entry without `when` |
   | `nodes`       | mapping name → node | required | Non-empty; names match `[a-z][a-z0-9_]*` |

   A **node**:

   | Field     | Type              | Default  | Notes |
   |-----------|-------------------|----------|-------|
   | `speaker` | `npc`, `player` or a string | `npc` | `npc` shows the NPC's archetype label, `player` the player's |
   | `text`    | string            | required | Non-empty |
   | `effects` | list              | `[]`     | Run each time the node is entered |
   | `choices` | list              | none     | At most 9 |
   | `next`    | node name or `end` | none    | Shorthand for a single choice `{ text: Continue, to: <next> }` |
   | `leave`   | boolean           | `true`   | `false` forbids leaving with Escape at this node |

   A node has `choices` or `next`, but not both. A node with neither ends
   the conversation with a single synthesized choice, *Leave*.

   A **choice**:

   | Field         | Type                      | Default  | Notes |
   |---------------|---------------------------|----------|-------|
   | `text`        | string                    | required | |
   | `to`          | node name or `end`        | required | |
   | `when`        | expression                | `true`   | |
   | `unavailable` | string                    | none     | When `when` is falsy: with this text the choice is shown disabled; without it the choice is hidden |
   | `consume`     | map item id → integer ≥ 1 | `{}`     | Removed from the player when chosen; missing items disable the choice (`Needs: 2× Coin`) |
   | `give`        | map item id → integer ≥ 1 | `{}`     | Added to the player when chosen; overflow goes to the ground pile at the player's cell, as for recipes |
   | `effects`     | list                      | `[]`     | Run when chosen, after `consume` and `give` |
   | `once`        | boolean                   | `false`  | Once chosen, the choice is hidden for good. This is world-level, not per NPC entity |
   | `id`          | name                      | none     | Required when `once` is true; unique within the dialogue (saves record it) |

   Load errors:
   - unknown fields;
   - a `to`/`next`/`start` that names no node of the dialogue;
   - unknown item ids (with *did you mean*);
   - an item in both `consume` and `give`;
   - more than 9 choices.

   A node that no `start` entry, `to` or `next` reaches is a **warning**.
2. **Archetypes** gain **`dialogue: <id>`** (default none). Giving the
   player's archetype a dialogue is allowed but has no effect.
3. **The `npc` scope.**
   - In every expression of a dialogue (`when`, effect values), `self`
     and `player` are the player and the new scope name **`npc`** is the
     NPC being talked to. `npc` is a load error in every other
     expression.
   - The **effects** of nodes and choices are the effects of
     [systems](../docs/packs.md#systems) plus `set_var`, `add_var`,
     `quest` and `journal` from `m8-flags-quests`.
   - `apply` and `set` take an optional **`on: npc`** (default `on:
     self`) to change the NPC's measurement instead. An `on` field
     outside dialogues is a load error.
   - A `noise` is emitted at the player's cell.
   - Effects run in order, at once.

### Simulation

4. **Talking.** A new action kind, `{ kind: 'talk', entity: <id> }`, is
   queued with `world.queueAction` and applied in the action phase. Its
   checks, in order:
   1. `unknown_entity` (new reason): no such entity, or it is the player;
   2. `no_dialogue` (new reason): its archetype has no dialogue;
   3. `out_of_reach`: not on the player's floor within Chebyshev 1 with
      no non-walkable edge between them (the reach of containers);
   4. `cannot_act`: the dialogue's `when` is falsy (with `unavailable`).

   On success the world **opens a conversation**:
   - the player's activity, path and pending intents are cancelled, as
     when queueing any action;
   - the NPC's path and pending intent are cleared, and it turns to face
     the player. Its facing changes at once, with no turn beat;
   - the opening node is picked (AC 1) and entered, running its effects.

   `ActionRecord` gets `kind: 'talk'` and the entity id. The rest of that
   tick runs normally.
5. **Paused world.** While `world.conversation` is not null:
   - `step()` is a no-op, exactly as after an outcome: the tick does not
     advance, and queued intents and actions are ignored;
   - only `choose` and `leaveConversation` change the world:
     - **`world.choose(n)`** (`n` is the index into the node's
       **visible** choices, from AC 7) applies a choice synchronously.
       It re-checks `when` and `consume` (a disabled or out-of-range
       index returns a failure and changes nothing), then removes
       `consume`, adds `give`, runs `effects`, records `once`, and
       enters the `to` node (running its effects) or ends the
       conversation on `end`;
     - **`world.leaveConversation()`** ends it, unless the current node
       has `leave: false` (it then returns a failure);
   - both return a record `{ ok, reason? }` and bump
     `world.conversationVersion`;
   - effects that draw from the world RNG (`random`, `roll`) do so in
     choice order, so a replay of the same inputs is identical.

   Outcome checks, statuses and the quest phase of `m8-flags-quests` run
   in `step()`, so a defeat or quest stage caused by a choice takes
   effect on the first tick after the conversation ends. `quest` and
   `journal` effects apply at once and show in the journal immediately.
6. **Failures.** If the opening `start` list matches nothing, the talk
   fails with `cannot_act` and no conversation opens. A choice whose `to`
   node would exceed **32 node entries without a player choice** (a
   `next` loop) ends the conversation with a runtime error in the
   record. This guards against pack mistakes.
7. **Query.** `world.conversationView()` returns null, or a pure view
   model:
   - `{ npc, speaker, text, leave, choices }`;
   - each choice is `{ text, ok, reason?, missing?, unavailable? }`;
   - hidden choices (falsy `when` without `unavailable`, or `once`
     already chosen) are omitted, and the visible ones keep their
     definition order.

   It draws no RNG and does not change `hash()`.
8. **Interactions.**
   - `world.interactionsAt(x, y, z)` gains, **first**, one **`talk`**
     entry per non-player entity with a dialogue on that cell, in id
     order: label `Talk to <archetype label>`, `ok`/`unavailable` from
     the dialogue's `when`, and `inReach` from AC 4's reach.
   - `InteractionKind` gains `'talk'`.
   - `world.approachIntent({ kind: 'talk', entity })` returns a goto
     next to the entity's **current** cell with the talk as its `then`.
     If the NPC has moved out of reach by arrival, the talk fails with
     `out_of_reach` as usual, and `actionText` reads `<Label> is not
     close enough.` Following a moving NPC is out of scope.
9. **Saves.**
   - The snapshot gains:
     - `conversation`: null, or `{ npc, dialogue, node, entries }`, by
       entity id, qualified dialogue id and node name (`entries` is the
       AC 6 counter);
     - `dialogueOnce`: the chosen `once` choices, as `[qualified
       dialogue id, choice id]`, sorted.
   - A save made mid-conversation restores into the same open
     conversation.
   - Bump `SAVE_VERSION` (to 5 if `m8-flags-quests` made it 4) and keep
     the previous version readable, with no conversation and no `once`
     records.
   - Unknown dialogue, node or choice ids are restore errors with *did
     you mean*.
   - `assertRoundTrip` covers a world saved mid-conversation.
10. **Overrides.** `dialogues` take `override: true` and `remove: true`.
    `nodes` is one field, so an override replaces the whole tree, while
    `when`/`unavailable`/`start` can be patched alone. Archetype
    `dialogue` is an ordinary patchable field.

### Shells

11. **Browser dialogue box.**
    - While a conversation is open, a box at the bottom of the screen
      shows:
      - the speaker's name;
      - the text;
      - the visible choices, numbered `1`–`9`. Disabled ones are greyed
        out with the `reasonText` hint underneath (`Needs: 2× Coin`, a
        choice's `unavailable` text).
    - Keys:
      - `1`–`9`, clicks or taps choose;
      - arrows and `Enter` move and choose;
      - `Enter` alone picks a single enabled choice;
      - `Escape` leaves (when `leave` is true; otherwise the box shakes
        briefly or shows `You can't walk away now.`).
    - While the box is open, map clicks, movement keys, the context menu
      and the transfer window are disabled. The journal (`J`) and the
      game panel (`O`, saving) still open on top.
    - The box is a pure function of `conversationView()`
      (`src/web/dialogue.ts` model, a thin DOM layer), and re-renders
      when `conversationVersion` changes.
12. **Click and hover.**
    - `clickPlan` treats an enabled **Talk** as the safe default, ahead
      of *Open*: clicking an NPC you can talk to walks up and talks.
    - Hover on such an NPC shows `Talk to <label>`. A disabled Talk shows
      its `unavailable` text in the tooltip, and a click opens the menu.
    - `docs/ui.md` documents the box and the keys.
13. **Terminal.**
    - The `x` list includes the `talk` entries for NPCs in reach.
    - While a conversation is open, the screen shows the speaker, the
      text and the numbered visible choices (disabled ones with their
      hint). Digits choose and `Escape` leaves; movement keys do
      nothing.

### Tests and docs

14. Headless tests (with a small fixture pack under `test/`) cover:
    - **Loader:** every load error and warning in AC 1–3, and `npc` and
      `on` outside dialogues.
    - **Talk checks:** each failure reason, the reach across a wall
      edge, and the NPC facing.
    - **Pause:** `step()` is a no-op while open; the tick, NPC positions
      and `hash()` are unchanged by steps; `choose` and
      `leaveConversation` semantics, including `leave: false`.
    - **Choices:** visibility (hidden, disabled), `consume`/`give` with
      overflow to the ground, `once`, `on: npc` effects, RNG order, the
      `next` loop guard, and `start` selection.
    - **Integration:** a choice that adds a journal entry and moves a
      quest, and a defeat caused by a choice taking effect on the next
      tick.
    - **Walk-then-talk:** arrival, and the NPC moving away.
    - **Saves:** the mid-conversation round trip, the previous-version
      upgrade and restore errors.
    - **UI models:** the dialogue box, `clickPlan` with Talk, and the
      terminal view.
    - **Guards:** determinism and the genre-word guard.
15. **Docs.**
    - `docs/packs.md` documents `dialogues`, archetype `dialogue`, the
      `talk` action and its reasons, the pause, `npc`/`on: npc`, and how
      dialogue effects relate to the tick (AC 5).
    - `docs/expressions.md` documents `npc`.
    - `docs/saves.md` documents the new version.
    - `VISION.md` §7 records the decisions:
      - dialogues are trees on archetypes;
      - the world pauses while one is open, and choices are synchronous
        inputs;
      - `once` is world-level;
      - NPCs are reached like containers and are not followed.

## Out of Scope

- NPCs starting conversations themselves (barks, being hailed), and
  ambient lines over NPCs' heads.
- Real-time conversations, and conversations interrupted by danger.
- Following an NPC that walks away, and talking across floors or at a
  distance.
- Text templating, portraits, voice and typewriter effects.
- Skill checks as a special field (use `when` with measurements, or
  `roll` in effects and a var), and barter or shop screens.
- NPC-to-NPC conversations.
- Factions and reputation (`m8-factions`) and the shipped noir and
  western content (`m8-social-games`).

## Design Notes

- Treat the conversation as world state, with `choose` and
  `leaveConversation` as input methods, like `queueAction`, but applied
  synchronously because nothing else moves. Do not create an activity
  for it: activities run inside ticks, and the world is not ticking.
- Compile each dialogue to arrays: nodes by index, choices with
  compiled `when`, item lists and effect lists. Resolve node names to
  indices at load. Save the names, not the indices.
- Reuse the recipe completion code for `consume`/`give` and overflow
  rather than duplicating it.
- `npc` is one more slot on the expression context, set only while
  dialogue expressions run. Validate its use at compile time by passing
  the allowed scope names per expression site.
- The NPC facing change goes through the facing helpers so snapshots stay
  consistent. Do not add a turn delay.

## Agent Notes

- Read these first:
  - `specs/m8-flags-quests.md` (and its implementation);
  - `specs/m5-context-menu.md` and `specs/ux-smart-click.md`;
  - `src/web/menu.ts` (`clickPlan`), `src/core/hud.ts` (`reasonText`,
    `actionText`);
  - `src/core/sim/world.ts` (`interactionsAt`, `approachIntent`, the
    action phase);
  - `src/core/sim/save.ts`.
- Suggested order:
  1. defs and loader;
  2. the `npc` scope and `on: npc`;
  3. the `talk` action and opening a conversation;
  4. pause, `choose` and `leaveConversation`;
  5. the view and interactions;
  6. saves and overrides;
  7. the browser box, click and hover, and the terminal;
  8. docs and VISION.
- Chromium is unavailable in the sandbox. Keep the dialogue box logic in
  pure functions.
