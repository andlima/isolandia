---
id: m8-social-games
area: content
priority: 40
depends_on: [m8-flags-quests, m8-dialogues, m8-factions]
description: "M8 playable result — two new mods of the `town` base game built only from YAML, assets and the M8 primitives: `noir` (a night-time murder mystery in the old town block, with suspects to question, clues as journal entries, a witnessed crime, police/mob standing and an accusation that wins or loses) and `western` (High Noon, with aim/nerve measurements, target practice, favours that win the town over, a hostile gang and a duel settled by dialogue and a roll, talked down or bribed), with scenario tests and M8 marked done"
---

# M8d — A noir mystery and a western duel

## Goal

M8's playable result is *a short noir mystery / a wild-west duel*. By the
two-genre rule, both are built **only from pack data** on top of the
primitives from `m8-flags-quests`, `m8-dialogues` and `m8-factions`:
vars, quests, journal, dialogues, factions and reputation.

Like `zombie` and `vampire`, both are **mods of the genre-free `town`**
(`m7-town-base`). They reuse the city map, furniture, food and needs, and
add people, a story, a clock and a goal.

- **`noir`** — *Death on Elm Street*. It is night in the old town block.
  A resident lies dead upstairs. The player:
  - questions the widow, the lodger, a neighbour and a mob fixer;
  - searches the house for clues;
  - minds the police patrol;
  - names the killer to the sergeant before dawn.
- **`western`** — *High Noon*. Black Jack's gang rides in at noon to
  call the player out. The morning is for getting ready:
  - practise on bottles;
  - win the town over with favours;
  - steady the nerves.

  At noon the player faces Black Jack on the main street and draws,
  talks him down or pays him off.

If either game needs engine code, that is a finding. Report it with
`needs-input` rather than adding genre-specific engine code. Small,
**generic** fixes to the M8 primitives are fine if they are documented
and tested.

## Acceptance Criteria

### Shared

1. Two new packs, `packs/noir/` (namespace `noir`) and `packs/western/`
   (namespace `wst`):
   - `kind: mod`, `depends: [std, town]`, with a one-line `description`;
   - both are listed by the stack catalog and selectable on the title
     screen and from the CLI (`npm run play -- --stack town,noir`), as
     the existing mods are;
   - each loads alone on `town` with **no warnings**.
2. NPCs are placed with **`spawns`** in a `town:town_center` override
   (the part is placed once in the city), plus the `town:store` part
   where needed. Positions must be walkable, inside the right rooms and
   reachable from the player's start. If a story needs its own room tag
   (`crime_scene`, `saloon`), the override restates the part's existing
   `rooms` and adds it. Keep the existing tags intact so `town` loot
   still distributes the same way.
3. Every new archetype and item has **pixel-art sprites** following
   `docs/art.md` (characters 32×48 with 8-way directions where they
   move, or a 4-way set with mirroring), drawn by the existing art
   generator and passing `test/art.test.ts`. Each character is told
   apart by silhouette or palette: hat, coat, badge, dress.
4. Each mod overrides:
   - `start`: the defeat and victory messages, and the player's label;
   - `clock`: its start time;
   - `lighting`: a mood (noir: cold, desaturated blue-grey nights;
     western: a warm, bleached noon).
5. Story text is short (one to three sentences per node) and fits the
   genre. No engine code or shared pack data contains genre words. The
   genre-word guard gains `noir`/`western` vocabulary (`detective`,
   `sheriff`, `outlaw`, `revolver`, …) for `src/`.

### `noir` — Death on Elm Street

6. **Setting.**
   - `clock` starts at **21:00** on day 1.
   - The victim's house is the north-east `town_center` house with the
     upstairs bedroom, tagged `crime_scene`. The player starts on the
     road outside, as *Detective*.
7. **Factions.**
   - `police`: starting reputation 20 (*Liked*).
   - `mob`: starting reputation -20 (*Wary*); it regards the police at
     -80 and the police regard it at -80, so `spread` moves them
     against each other.
   - `neighbours` (hidden): the witnesses, for dialogue gating.
8. **People** (unique archetypes, each with a dialogue):
   - **Sgt. Hale** (police) waits at the house door. He gives the case
     (quest start) and hears the accusation.
   - **Officer** (police) patrols the block with a `wander` behavior
     around his home, `radius` about 10. He is the witness for the
     crime in AC 10.
   - **The widow, Mrs. Vane**, in the kitchen downstairs.
   - **The lodger, Mr. Pike**, in his room. He is the **killer**.
   - **Dot, the neighbour**, in the house across the road.
   - **Mickey the Fixer** (mob), outside a store. He talks only if mob
     standing is at least *Neutral*, or for a bribe. Paying him uses
     `reputation` with `spread`, so the police notice.
9. **Clues.** Clues are **journal entries** (category `Clues`), found in
   three ways:
   - **dialogue** (Dot saw a light upstairs at ten; Mickey says the
     victim owed the lodger money; the widow's alibi);
   - **searching** furniture in the crime scene, with a tile action
     `search` on the town's `dresser`/`cabinet`/`bed` tiles:
     - limited to cells in `crime_scene` by `when`;
     - one clue per piece of furniture, never twice (`in_journal`);
     - `unavailable` text `Nothing more here`;
   - **one contradiction**: asking Pike about the light (needs Dot's
     clue) adds *Pike lied about being out all night*.

   There are at least five clues. At least one points at a wrong
   suspect, as a red herring.
10. **A witnessed crime.** A tile action `force_drawer` on a locked
    `cabinet` in the crime scene yields a key clue faster, but carries
    `{ type: reputation, faction: police, delta: -30, witnessed: 8,
    spread: true }`. Done in sight of the patrolling officer, it drops
    police standing (and raises the mob's through `spread`). When the
    police are **Hostile**, Hale refuses to hear an accusation, which
    fails the case at dawn.
11. **Quest `elm_street`.** Stages:
    - *Talk to the sergeant*;
    - *Question the household*: entered once the widow and the lodger
      have been spoken to (vars set by their dialogues);
    - *Name the killer*: entered once at least three clues are known;
    - **success** `solved`: Pike is accused, with the two clues that
      prove it;
    - **failure** `wrong_man`: someone else is accused;
    - **failure** `cold_case`: dawn (06:00, day 2) arrives before an
      accusation.

    The accusation choices in Hale's dialogue are gated by `when`, with
    `unavailable` text such as `You need more than a hunch` when the
    clues against that suspect are missing.
12. **Ending.**
    - `start.victory`: `quest_succeeded("elm_street")`.
    - `start.defeat`: `quest_failed("elm_street") or self.hp <= 0`,
      with a single message such as *The case is closed.* The failed
      stage's journal text (and its toast) tells which ending it was.
    - A direct solve takes about half of the night. Tune the walking
      distances and the dawn deadline so that is true.

### `western` — High Noon

13. **Setting.**
    - `clock` starts at **06:00** on day 1. Noon is the duel.
    - The `town_center` road is *Main Street*. The `town:store` part
      nearest the centre is the **saloon** (room tag `saloon`).
    - The player is the *Stranger*, starting with 10 `coin`. New items:
      `coin`, `bullet`, `whiskey` and `revolver`.
14. **Measurements** (pack `wst`, on the player archetype through an
    override):
    - `aim`: 0–100, starts at 20;
    - `nerve`: 0–100, starts at 50.

    A status `tipsy` (from `whiskey`) adds nerve and removes aim while
    active, using `rates` and a timer measurement or a var.
15. **Factions.**
    - `townsfolk`: starts at 0.
    - `law`: starts at 10; regards the gang at -100.
    - `gang`: starts at **-60**, so it is *Hostile* from the start;
      regards the townsfolk at -50 and the law at -100.
16. **People.**
    - **Sheriff Cobb** (law) gives the quest and a `revolver` (a tool,
      via dialogue `give`). He will not fight for the Stranger.
    - **Doc**, **the bartender** in the saloon and **the kid**
      (townsfolk). Each gives one favour through dialogue:
      - the doc wants a `bandage` (`consume`);
      - the bartender sells `whiskey` for `coin`;
      - the kid wants the player's `crackers`.

      Each favour gives `townsfolk` +20 with `spread`, and 10 `coin`
      (`give`). Whiskey costs 5.
    - **Two gang riders** (gang) arrive at about 10:00. They stand at
      the edge of Main Street (spawned there; a behavior keeps them idle
      until `world.hour >= 10`). While `hostile(self, player) and
      can_see(self, player, 8)`, they `pursue` the player. A system
      takes `nerve` from a player standing next to a hostile rider.
    - **Black Jack** (gang) waits at the far end of Main Street until
      noon, then walks to the middle (his `home`) and stays.
17. **Practice.**
    - A tile action `shoot_bottles` targets the town's `crate` tiles in
      yards:
      - tools `[revolver]`, consume `{ bullet: 3 }`, duration about 8;
      - effects `aim +6` (only while `aim < 70`) and a `noise` with a
        large radius;
      - `{ type: reputation, faction: townsfolk, delta: -5, witnessed:
        10 }`, because folks dislike the racket.
    - `bullet`s come from the sheriff and from town loot (a
      `distributions` addition through the mod).
18. **Quest `high_noon`.** Stages:
    - *See the sheriff*;
    - *Get ready*;
    - *Face Black Jack on Main Street*: `when: world.hour >= 12`;
    - **success** `won`, `talked_down` or `paid_off`;
    - **failure** `shot` or `coward`. `coward` is entered when it is
      past 12:30 and the player has not spoken to Black Jack.
19. **The duel**, in Black Jack's dialogue at noon. The opening node
    offers three ways out:
    - *Go for your gun* (needs the `revolver` through `when`, with
      `unavailable` text `You're unarmed`). Its effects set a var `draw`
      to `roll(1, 100) + self.aim / 2 + self.nerve / 4`, and it leads to
      a **draw** node with `leave: false`, so the roll cannot be dodged
      by leaving and talking again. That node shows two choices with the
      same text (*Fire!*) and mutually exclusive `when`s (`var("draw") >=
      75` → `won`, otherwise → `shot`), so exactly one is visible;
    - *Talk him down*: `when: reputation("townsfolk") >= 50` (*Trusted*;
      "the whole street is watching"), → `talked_down`;
    - *Pay him off*: `consume: { coin: 30 }`, → `paid_off`.

    Each of these choices moves the quest with a `quest` effect. Before
    noon, his dialogue is a short taunt that sets nothing.

    The roll uses the world RNG, so a seed and the same inputs give the
    same result.
20. **Ending.**
    - `start.victory`: `quest_succeeded("high_noon")`.
    - `start.defeat`: `quest_failed("high_noon") or self.hp <= 0`.
    - Preparing well matters: with `aim` at 70 and `nerve` at 60, the
      draw wins for about 90% of seeds; with no practice, about 30%.
      Tune the formula, but keep those odds.

### Tests and docs

21. Headless scenario tests (scripted inputs and a fixed seed, in the
    style of `test/scenario.test.ts`):
    - **noir:**
      - a direct solve: talk to Hale, the household and Dot, search
        two pieces of furniture, ask Pike about the light, accuse Pike,
        then victory;
      - a wrong accusation, then defeat;
      - waiting until dawn, then defeat;
      - `force_drawer` in sight of the officer lowers police standing
        and raises the mob's, while out of sight it does not.
    - **western:**
      - practise to `aim` ≥ 70, do the favours, wait for noon and duel.
        Check that the outcome follows the visible choice and that the
        same seed gives the same outcome;
      - talk him down with *Trusted* townsfolk;
      - pay him off;
      - the coward path;
      - a hostile rider pursues and drains `nerve`.
    - Both mods load alone without warnings. `town,zombie,noir`-style
      mixes are **not** required to make sense, but must still load
      (warnings allowed).
    - Reachability: every NPC spawn and every clue cell is reachable
      from the player's start.
    - The art, determinism and genre-word guard tests pass.
22. **Docs.**
    - `docs/packs.md` "Shipped packs" lists `noir` and `western`. The
      worked examples gain a short section on building a story from
      vars, quests, dialogues and factions, using `noir` as the example.
    - `README.md` mentions the two new stacks.
    - `VISION.md`:
      - §5 marks **M8 done**;
      - §7 records what the two games taught. Note which patterns both
        repeated (candidates for a stdpack, e.g. a "named NPC who waits
        at home and talks" behavior, or an accusation pattern) and what
        felt awkward in YAML;
      - §8 points to **M9** (sandboxed script hooks).

## Out of Scope

- Combat. The duel is dialogue and a roll; gang riders only crowd the
  player and drain nerve. The combat question stays open.
- NPCs walking schedules, sleeping or reacting to the murder in real
  time, and NPCs fighting each other.
- Voice, portraits, cutscenes, music and new map parts. Reuse the town
  parts. A new part is allowed only if a story cannot be told without
  one; justify it in the report.
- Multiple cases, random culprits or generated mysteries.
- Balancing the mods against `hardship`.

## Design Notes

- Write the stories as data first (who knows what, which clue proves
  what), then as YAML. Keep a short comment block at the top of each
  pack's quest file that explains the solution and the intended flow,
  for future modders and reviewers.
- Prefer vars named for facts (`talked_widow`, `pike_lied`) over
  counters. Use `in_journal` for clues so the journal stays the single
  source of truth.
- If two choices with the same text and exclusive `when`s turn out to be
  awkward, record it in VISION §7 as an argument for conditional `to`
  (a candidate engine primitive). Do not add it in this spec.
- The `town_center` override replaces `spawns` (and `rooms`, if
  restated) whole. Copy the existing rooms exactly and add a test that
  `town` loot in that part is unchanged by the mod.

## Agent Notes

- Read these first:
  - `specs/m8-flags-quests.md`, `specs/m8-dialogues.md`,
    `specs/m8-factions.md` and the docs they produced;
  - `specs/m7-town-base.md`, `packs/zombie/` and `packs/vampire/` (how a
    mod overrides `town`);
  - `packs/town/maps/README.md` (where the houses and rooms are);
  - `docs/art.md` and the art generator script.
- Suggested order:
  1. `noir` data without art: dialogues, clues, quest, scenario test;
  2. `western` data and scenario tests;
  3. tuning (deadline, duel odds), with a quick Monte Carlo over seeds
     in a test;
  4. art;
  5. docs and VISION.
- Chromium is unavailable in the sandbox. Rely on the headless
  scenarios. Describe in the report what a human should click through
  in the browser.
