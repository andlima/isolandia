/**
 * Mutable, fixed-tick simulation state built from a loaded Definition.
 * Deterministic: same definition + seed + intents ⇒ same state.
 */

import { clockAt, type ClockTime } from '../clock.ts';
import {
  DIALOGUE_END,
  EMPTY_TILE,
  populateCandidates,
  type ArchetypeDef,
  type BehaviorDef,
  type Definition,
  type DialogueChoiceDef,
  type DialogueDef,
  type EdgeSide,
  type EffectDef,
  type FactionDef,
  type MapDef,
  type MeasurementDef,
  type NumberTerm,
  type ReputationEffectDef,
  type SystemDef,
  REPUTATION_MAX,
  REPUTATION_MIN,
  tierOf,
} from '../definition.ts';
import { attitude, type ExprContext, type ExprEntity, type FactionTable } from '../expr/index.ts';
import { DEFAULT_FACING, facingOfStep, turnToward, type Facing } from '../facing.ts';
import { actionSource, ActivityRunner, isTimed, recipeSource, useSource, type Activity, type ActivitySource, type ActivityStage } from './activity.ts';
import { Pathfinder } from './astar.ts';
import { think, type ThinkEnv } from './behavior.ts';
import { add, countOf, createContainer, fits, GROUND_LABEL, remove, type Container, type ContainerKind } from './containers.ts';
import { edgeOfKey, Grid } from './grid.ts';
import { lineOfSight } from './sight.ts';
import { Rng } from './rng.ts';
import { restoreWorld, SAVE_VERSION } from './save.ts';

export interface Entity extends ExprEntity {
  readonly id: number;
  readonly archetype: ArchetypeDef;
  x: number;
  y: number;
  /** Floor. */
  z: number;
  /** Values indexed by measurement index (length = all measurements). */
  readonly m: Float64Array;
  /** Resolved max per measurement as of the last clamp (Infinity if unbounded). */
  readonly max: Float64Array;
  /** 1 at each measurement index of the archetype (shared per archetype). */
  readonly hasM: Uint8Array;
  /** Ticks until the entity may step again. */
  moveCooldown: number;
  /** Direction the entity faces; it turns toward a new direction before stepping. */
  facing: Facing;
  /** Tile the current (or last) step started from; equals (x, y, z) before any step. */
  fromX: number;
  fromY: number;
  fromZ: number;
  /**
   * World tick at which the current step starts showing: the value of
   * `world.tick` right after the tick that took the step. See `renderPosition`.
   */
  stepTick: number;
  /** Remaining path as cell indices (`(z * height + y) * width + x`), or null. */
  path: Int32Array | null;
  /** Index of the next cell of `path` to step onto. */
  pathPos: number;
  /** Action queued when the current path arrives (player only, from `GotoIntent.then`), or null. */
  then: Action | null;
  /** Active statuses, indexed by status index (1 = active). */
  readonly st: Uint8Array;
  /** The entity's inventory (from its archetype's `inventory`), or null. */
  readonly inv: Container | null;
  /** Pending movement intent, applied at the start of the next tick. */
  intent: Intent | null;
  /** Result of the entity's most recent goto intent (a new object each time). */
  lastGoto: GotoRecord | null;
  /** Spawn cell (fixed). */
  readonly homeX: number;
  readonly homeY: number;
  readonly homeZ: number;
  /** Behavior driving the entity (null for the player and archetypes without one). */
  readonly behavior: BehaviorDef | null;
  /** Current state index of `behavior`, or -1 without one. */
  state: number;
  /** Tick at which the current state was entered. */
  stateTick: number;
  /** Cell and tick of the goto the current state last issued (`pursue`/`home`); `planTick` -1 = none yet. */
  planX: number;
  planY: number;
  planZ: number;
  planTick: number;
  /** Cell and tick of the last heard noise (nearest within its tick); `heardTick` -1 = never. */
  heardX: number;
  heardY: number;
  heardZ: number;
  heardTick: number;
  /** In-progress timed action, item use or recipe, or null. */
  activity: Activity | null;
  /** Faction index of the archetype, or -1. */
  readonly faction: number;
  /** 1 per `once` system (by its `onceIndex`) that has fired for this entity; null when the stack has none. */
  readonly fired: Uint8Array | null;
}

/** A noise emitted this tick by a `noise` effect. */
export interface Noise {
  x: number;
  y: number;
  z: number;
  radius: number;
  /** Id of the emitting entity (it does not hear its own noise). */
  source: number;
}

/** Recorded when the pack's `start.defeat` or `start.victory` condition becomes true. */
export interface OutcomeRecord {
  readonly tick: number;
  readonly message: string;
}

/** Recorded when the pack's `start.defeat` condition becomes true. */
export type DefeatRecord = OutcomeRecord;
/** Recorded when the pack's `start.victory` condition becomes true. */
export type VictoryRecord = OutcomeRecord;

/**
 * One-tile move in a direction on the entity's floor (keyboard; never takes a
 * link); cancels any active path. The entity first turns toward the step (one
 * compass point per `ticks_per_turn` beat), with the intent pending meanwhile.
 */
export interface StepIntent {
  readonly kind: 'step';
  readonly dx: -1 | 0 | 1;
  readonly dy: -1 | 0 | 1;
  /**
   * Turn only (default false): when not already facing the step, the entity
   * turns toward it and the intent is consumed once it faces that way,
   * without stepping. When already facing it, it steps as usual. Used by the
   * browser keyboard so a tap in a new direction only turns.
   */
  readonly turnInPlace?: boolean;
}

/** Walk to a tile along an A* path computed at the start of the next tick. */
export interface GotoIntent {
  readonly kind: 'goto';
  readonly x: number;
  readonly y: number;
  /** Goal floor; defaults to the entity's floor when the goto is resolved. */
  readonly z?: number;
  /**
   * End on the walkable tile with the shortest path from which the goal is
   * in reach (8-adjacent with no non-walkable edge between, or the goal
   * itself, if walkable), e.g. to walk up to a fridge. Only the goal's own
   * floor counts.
   */
  readonly adjacent?: boolean;
  /**
   * The goal is the edge on this side of (x, y): end on whichever of the two
   * cells it separates has the shortest path (`adjacent` is ignored).
   */
  readonly side?: EdgeSide;
  /**
   * Player only: queued as an action when the path ends on its last cell
   * (at once when the path is empty); dropped when no path is found or the
   * path is cleared first.
   */
  readonly then?: Action;
}

export type Intent = StepIntent | GotoIntent;

/** Outcome of the latest goto intent, for shell feedback. */
export interface GotoRecord {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** False when the goal was blocked, out of bounds or unreachable. */
  readonly ok: boolean;
  /** Tick at which the goto was resolved. */
  readonly tick: number;
}

/** Container → player inventory. `count` defaults to the whole stack. */
export interface TakeAction {
  readonly kind: 'take';
  /** Container id (see `containersAt` / `reachableContainers`). */
  readonly container: number;
  /** Qualified item id. */
  readonly item: string;
  readonly count?: number;
}

/** Player inventory → container. */
export interface PutAction {
  readonly kind: 'put';
  readonly container: number;
  readonly item: string;
  readonly count?: number;
}

/** Player inventory → the ground pile on the player's cell (created if missing). */
export interface DropAction {
  readonly kind: 'drop';
  readonly item: string;
  readonly count?: number;
}

/** Run the item's `use` on the player, then remove `consume` units (at completion when timed). */
export interface UseAction {
  readonly kind: 'use';
  readonly item: string;
}

/**
 * Start a pack action (`actions` domain); `x`/`y` are required for tile
 * targets and forbidden for `self`. `z` (tile targets only) defaults to the
 * player's floor. With `side`, the target is the edge on that side of
 * (x, y) instead of the cell.
 */
export interface ActAction {
  readonly kind: 'act';
  /** Qualified action id. */
  readonly action: string;
  readonly x?: number;
  readonly y?: number;
  readonly z?: number;
  readonly side?: EdgeSide;
}

/**
 * Start a recipe (`recipes` domain). For a station recipe, `x`/`y` name the
 * station cell (omitted: the first matching cell in reach, row-major); they
 * are forbidden for recipes without a station. `z` defaults to the player's
 * floor.
 */
export interface CraftAction {
  readonly kind: 'craft';
  /** Qualified recipe id. */
  readonly recipe: string;
  readonly x?: number;
  readonly y?: number;
  readonly z?: number;
}

/**
 * Start a conversation with an NPC: an entity whose archetype has a
 * `dialogue`, in reach like a container. On success the world pauses (see
 * `world.conversation`).
 */
export interface TalkAction {
  readonly kind: 'talk';
  /** Entity id of the NPC. */
  readonly entity: number;
}

/** A player action, queued with `queueAction` and applied after the movement intents. */
export type Action = TakeAction | PutAction | DropAction | UseAction | ActAction | CraftAction | TalkAction;

export type ActionFailure =
  | 'out_of_reach'
  | 'too_heavy'
  | 'missing'
  | 'cannot_use'
  | 'no_inventory'
  | 'unknown_container'
  | 'unknown_action'
  | 'unknown_recipe'
  | 'invalid_target'
  | 'cannot_act'
  | 'occupied'
  | 'cancelled'
  | 'interrupted'
  | 'unreachable'
  | 'unknown_entity'
  | 'no_dialogue';

/** An item the player lacks for an action: its id and label, and how many more units are needed. */
export interface MissingItem {
  /** Qualified item id. */
  readonly item: string;
  readonly label: string;
  readonly count: number;
}

/** Outcome of the latest action, for shell feedback. */
export interface ActionRecord {
  readonly kind: Action['kind'];
  /** Qualified item id (take/put/drop/use); empty for `act`, `craft` and `talk`. */
  readonly item: string;
  /** Entity id of the NPC (`talk` only). */
  readonly entity?: number;
  /** Qualified action id (`act` only). */
  readonly action?: string;
  /** Qualified recipe id (`craft` only). */
  readonly recipe?: string;
  /** Edge side of an `act` that targeted an edge. */
  readonly side?: EdgeSide;
  /** Units moved (take/put/drop), consumed (use/act) or produced (craft). */
  readonly moved: number;
  /** Produced units that did not fit and went to the ground pile (`craft`, only when > 0). */
  readonly dropped?: number;
  readonly ok: boolean;
  /**
   * `start` when a timed activity starts (or fails to); `complete` when an
   * action is applied instantly or an activity ends (completed, cancelled,
   * interrupted, or failed its re-check).
   */
  readonly stage: ActivityStage;
  readonly reason?: ActionFailure;
  /** Tick at which the action was applied. */
  readonly tick: number;
}

/** An entry of `world.availableActions()`. */
export interface AvailableAction {
  readonly kind: 'act' | 'use';
  /** Qualified action id (`act`). */
  readonly action?: string;
  /** Qualified item id (`use`). */
  readonly item?: string;
  /** Target cell of a tile-targeted action. */
  readonly x?: number;
  readonly y?: number;
  readonly z?: number;
  /** The target is the edge on this side of the cell. */
  readonly side?: EdgeSide;
  readonly label: string;
  /** False when tools, consumed items, the inventory or `when` fail now. */
  readonly ok: boolean;
  readonly reason?: ActionFailure;
  /** Absent tools and consumed items (reason `missing`). */
  readonly missing?: readonly MissingItem[];
  /** The action's `unavailable` text (reason `cannot_act`, when the pack sets one). */
  readonly unavailable?: string;
}

/** An entry of `world.availableRecipes()`. */
export interface AvailableRecipe {
  /** Qualified recipe id. */
  readonly recipe: string;
  readonly label: string;
  readonly verb: string;
  readonly category: string;
  /** False when the station is out of reach, or items, the inventory or `when` fail now. */
  readonly ok: boolean;
  readonly reason?: ActionFailure;
  readonly missing?: readonly MissingItem[];
  /** The recipe's `unavailable` text (reason `cannot_act`, when the pack sets one). */
  readonly unavailable?: string;
  /** The chosen station cell in reach (station recipes). */
  readonly station?: { readonly x: number; readonly y: number; readonly z: number };
}

export type InteractionKind = 'talk' | 'act' | 'craft' | 'open' | 'take_all' | 'climb' | 'walk';

/** An entry of `world.interactionsAt(x, y, z)`. */
export interface Interaction {
  /** Stable within a query, e.g. `talk:4`, `act:t:board_up`, `craft:t:stew`, `open:3`, `take_all:3`, `climb:up`, `walk`. */
  readonly id: string;
  readonly label: string;
  readonly kind: InteractionKind;
  /** Whether it can be done (ignoring reach). */
  readonly ok: boolean;
  readonly reason?: ActionFailure;
  readonly missing?: readonly MissingItem[];
  readonly unavailable?: string;
  /** The action to queue: the `act` or `craft`, or the first `take` of a `take_all`. */
  readonly action?: Action;
  /** Every `take` of a `take_all`, in stack order. */
  readonly actions?: readonly Action[];
  /** Container id (`open`, `take_all`). */
  readonly container?: number;
  /** Entity id of the NPC (`talk`). */
  readonly entity?: number;
  /** The goto to the far end of the link (`climb`). */
  readonly intent?: GotoIntent;
  /** Whether the player can do it without walking. */
  readonly inReach: boolean;
  /** Sim seconds the `act` or `craft` would take if started now; absent when its duration expression fails. */
  readonly duration?: number;
  /** Items its completion consumes (`act`, `craft`; absent when none). Tools are not listed. */
  readonly uses?: readonly MissingItem[];
}

/** `world.activityProgress()`: what is being done and how far along it is. */
export interface ActivityProgress {
  readonly label: string;
  /** In [0, 1]. */
  readonly fraction: number;
}

/** A player status that turned on or off in the last stepped tick (`world.statusEvents`). */
export interface StatusEvent {
  readonly tick: number;
  /** Qualified status id. */
  readonly status: string;
  /** True when the status turned on, false when it turned off. */
  readonly entered: boolean;
}

/** A quest stage change, journal addition or standing tier change of the last stepped tick (`world.journalEvents`). */
export interface JournalEvent {
  readonly tick: number;
  readonly kind: 'stage' | 'entry' | 'reputation';
  /** Qualified quest id (`stage`). */
  readonly quest?: string;
  /** Stage id (`stage`). */
  readonly stage?: string;
  /** Qualified journal entry id (`entry`). */
  readonly entry?: string;
  /** Qualified faction id (`reputation`). */
  readonly faction?: string;
  /** Tier labels before and after the change (`reputation`). */
  readonly from?: string;
  readonly to?: string;
}

/** A faction of the journal's Standing section (`world.journal().standing`). */
export interface JournalStanding {
  /** Qualified faction id. */
  readonly faction: string;
  readonly label: string;
  /** The player's standing, in [-100, 100]. */
  readonly value: number;
  /** Tier label of `value`. */
  readonly tier: string;
}

/** `world.attitudeOf(entity)`: how an NPC's faction regards the player. */
export interface AttitudeView {
  /** Qualified faction id. */
  readonly faction: string;
  readonly label: string;
  readonly tier: string;
  readonly hostile: boolean;
  readonly friendly: boolean;
}

/** A quest of `world.journal()`. */
export interface JournalQuest {
  /** Qualified quest id. */
  readonly quest: string;
  readonly title: string;
  /** Current (or final) stage id. */
  readonly stage: string;
  /** The stage's journal text. */
  readonly text: string;
  readonly state: 'active' | 'success' | 'failure';
  /** Tick of the quest's last stage change. */
  readonly since: number;
}

/** An added entry of `world.journal()`. */
export interface JournalItem {
  /** Qualified journal entry id. */
  readonly entry: string;
  readonly text: string;
  readonly category: string;
  /** Tick at which it was added. */
  readonly tick: number;
}

/** `world.journal()`: what the journal shows (pure view model). */
export interface JournalView {
  /** Started quests that are not hidden, plus ended hidden ones: active first, then newest change first. */
  readonly quests: readonly JournalQuest[];
  /** Added entries, in the order added. */
  readonly entries: readonly JournalItem[];
  /** One item per faction that is not hidden, in definition order. */
  readonly standing: readonly JournalStanding[];
}

/** A started quest in a snapshot (ids qualified). */
export interface QuestSnapshot {
  quest: string;
  /** Stage id. */
  stage: string;
  /** Tick it entered that stage. */
  since: number;
  ended: boolean;
}

/** Deepest chain of stages entered by stage effects before it is treated as a pack mistake. */
export const MAX_QUEST_DEPTH = 8;

/** Most node entries without a player choice (a `next` loop) before a conversation ends with an error. */
export const MAX_DIALOGUE_ENTRIES = 32;

/** The open conversation (`world.conversation`): the world is paused until it ends. */
export interface Conversation {
  /** The NPC being talked to. */
  readonly npc: Entity;
  readonly dialogue: DialogueDef;
  /** Current node index. */
  node: number;
  /** Node entries since the last player choice (`next` choices do not count as one). */
  entries: number;
}

/** Why `choose` or `leaveConversation` failed. */
export type ConversationFailure =
  /** No conversation is open. */
  | 'no_conversation'
  /** The index is not one of the visible choices. */
  | 'invalid_choice'
  /** The choice's `when` is falsy. */
  | 'cannot_act'
  /** The player lacks items the choice consumes. */
  | 'missing'
  /** The node has `leave: false`. */
  | 'cannot_leave'
  /** The choice was applied, but entering its node passed `MAX_DIALOGUE_ENTRIES`: the conversation ended (see `error`). */
  | 'runtime_error';

/** Result of `world.choose` / `world.leaveConversation`. */
export interface ConversationRecord {
  readonly ok: boolean;
  readonly reason?: ConversationFailure;
  /** The pack mistake that ended the conversation (`runtime_error`). */
  readonly error?: string;
}

/** A visible choice of `world.conversationView()`. */
export interface ConversationChoice {
  readonly text: string;
  /** False when its `when` is falsy (with `unavailable`) or items it consumes are missing. */
  readonly ok: boolean;
  /** `cannot_act` (with `unavailable`) or `missing` (with `missing`). */
  readonly reason?: ActionFailure;
  readonly missing?: readonly MissingItem[];
  readonly unavailable?: string;
}

/** `world.conversationView()`: what the dialogue box shows (pure view model). */
export interface ConversationView {
  /** Entity id of the NPC. */
  readonly npc: number;
  /** The line's speaker: the NPC's or player's archetype label, or the node's `speaker` name. */
  readonly speaker: string;
  readonly text: string;
  /** Whether the player may leave (Escape) at this node. */
  readonly leave: boolean;
  /** The visible choices, in definition order (`choose(n)` indexes this list). */
  readonly choices: readonly ConversationChoice[];
}

/** The open conversation in a snapshot (ids qualified). */
export interface ConversationSnapshot {
  /** Entity id of the NPC. */
  npc: number;
  /** Qualified dialogue id. */
  dialogue: string;
  /** Node name. */
  node: string;
  /** Node entries since the last player choice. */
  entries: number;
}

/** An activity in a snapshot (ids qualified). */
export interface ActivitySnapshot {
  kind: 'act' | 'use' | 'craft';
  action?: string;
  item?: string;
  recipe?: string;
  x: number;
  y: number;
  z: number;
  /** The target is the edge on this side of the cell. */
  side?: EdgeSide;
  startTick: number;
  endTick: number;
}

export interface ContainerSnapshot {
  id: number;
  kind: ContainerKind;
  /** Cell of a tile container or ground pile. */
  cell?: [number, number, number];
  /** Owner entity id of an inventory. */
  owner?: number;
  /** Stacks as [qualified item id, count], in order. */
  stacks: [string, number][];
}

export interface EntitySnapshot {
  id: number;
  archetype: string;
  x: number;
  y: number;
  z: number;
  facing: Facing;
  fromX: number;
  fromY: number;
  fromZ: number;
  stepTick: number;
  moveCooldown: number;
  /** Remaining path cells as [x, y, z]. */
  path: [number, number, number][] | null;
  measurements: Record<string, number>;
  /** Active status ids, in definition order. */
  statuses: string[];
  intent: Intent | null;
  lastGoto: GotoRecord | null;
  home: [number, number, number];
  /** Current behavior state (name), when it was entered, and its last planned goto as [x, y, z, tick]. */
  behavior: { state: string; since: number; plan: [number, number, number, number] | null } | null;
  /** Last heard noise, or null if never. */
  heard: { x: number; y: number; z: number; tick: number } | null;
  activity: ActivitySnapshot | null;
  /** Action queued when the current path arrives. */
  then: Action | null;
  /** Qualified ids of the `once` systems that have fired for this entity, sorted; omitted when none. */
  fired?: string[];
}

export interface WorldSnapshot {
  tick: number;
  rng: number;
  /** World seed (the loot RNG derives from it). */
  seed: number;
  player: number;
  /** Next container id (ids are never reused). */
  nextContainer: number;
  /** Pending actions, in queue order. */
  actions: Action[];
  lastAction: ActionRecord | null;
  defeat: DefeatRecord | null;
  victory: VictoryRecord | null;
  entities: EntitySnapshot[];
  /** Every container, in id order. */
  containers: ContainerSnapshot[];
  /** Cells whose tile differs from the map, as [x, y, z, qualified tile id], in cell index order. */
  tiles: [number, number, number, string][];
  /**
   * Edges whose tile differs from the map, as [x, y, z, side, qualified tile
   * id or null for a removed edge], in cell index order (`n` before `w`).
   */
  edges: [number, number, number, EdgeSide, string | null][];
  /** Every var's value, by qualified id. */
  vars: Record<string, number>;
  /** Started quests, in definition order. */
  quests: QuestSnapshot[];
  /** Added journal entries, in the order added. */
  journal: { entry: string; tick: number }[];
  /** The open conversation, or null. */
  conversation: ConversationSnapshot | null;
  /** The chosen `once` choices, as [qualified dialogue id, choice id], sorted. */
  dialogueOnce: [string, string][];
  /** The player's standing with every faction, by qualified id. */
  reputation: Record<string, number>;
}

/** A world as a plain JSON-serializable object (`world.save()`, `World.restore`). */
export interface SaveFile {
  format: 'isolandia-save';
  version: typeof SAVE_VERSION;
  /** Loaded packs, in load order. */
  packs: { namespace: string; version: string }[];
  /** Qualified id of the start map, and its size. */
  map: { id: string; width: number; height: number; floors: number };
  state: WorldSnapshot;
}

/** Outcome of `World.restore`. */
export type RestoreResult = { ok: true; world: World; warnings: string[] } | { ok: false; errors: string[] };

/**
 * @internal What `save.ts` gets to rebuild a world in place of spawning,
 * container creation and loot rolls (see `World.restore`).
 */
export interface RestoreHost {
  readonly itemWeights: readonly number[];
  readonly actionSources: readonly ActivitySource[];
  readonly useSources: readonly (ActivitySource | null)[];
  readonly recipeSources: readonly ActivitySource[];
  /** Append an entity with spawn defaults and the given home and inventory; `driven` = run its archetype's behavior. */
  entity(archetype: ArchetypeDef, x: number, y: number, z: number, home: readonly [number, number, number], inv: Container | null, driven: boolean): Entity;
  /** Register a container (in id order). */
  container(c: Container): void;
  setNextContainer(n: number): void;
  setActions(actions: Action[]): void;
}

/** @internal Fills a world under construction from a save; returns its player. */
export type RestoreFn = (world: World, host: RestoreHost) => Entity;

/** FNV-1a 32-bit over a string, as 8 hex chars. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const NO_TAGS: ReadonlySet<string> = new Set();

/** Seed of the loot RNG: derived from the world seed, independent of `world.rng`. */
const LOOT_SALT = 0x6c6f6f74;
/** Seed of the populate RNG: derived from the world seed, independent of `world.rng` and loot. */
const POPULATE_SALT = 0x706f7075;

/** Side of a chunk of the entity index, in tiles. */
export const INDEX_CHUNK = 16;

/** A* work since the world was created, for benchmarks and tests (not state: not saved or hashed). */
export interface PathStats {
  /** Searches run (including those rejected on region labels). */
  searches: number;
  /** Searches that failed on region labels, without expanding a node. */
  regionRejects: number;
  /** Searches that stopped at their budget. */
  budgetHits: number;
  /** Nodes expanded, in total. */
  expanded: number;
  /** Most nodes expanded by one NPC search, and by one player search. */
  maxNpcExpanded: number;
  maxPlayerExpanded: number;
}

/** Order of [string, string] pairs: by the first, then the second (code units). */
function byPair(a: readonly [string, string], b: readonly [string, string]): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
}

/** `v` rounded to 2 decimals, halves away from zero (an epsilon absorbs float noise: -15 × 33.3 / 100 is -5). */
function round2(v: number): number {
  return (Math.sign(v) * Math.round(Math.abs(v) * 100 + 1e-7)) / 100;
}

/** 32-bit integer hash of two values (murmur3 finalizer). */
function mix(a: number, b: number): number {
  let h = Math.imul((a ^ b) >>> 0, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export class World {
  readonly grid: Grid;
  readonly entities: Entity[] = [];
  readonly player: Entity;
  readonly rng: Rng;
  tick = 0;
  /** Expression warnings (e.g. division by zero) with occurrence counts. */
  readonly warnings = new Map<string, number>();

  /** Set once the defeat condition holds; the world is frozen from then on. */
  defeat: DefeatRecord | null = null;
  /** Set once the victory condition holds (and defeat did not); the world is frozen from then on. */
  victory: VictoryRecord | null = null;
  /** Result of the most recent action (a new object each time). */
  lastAction: ActionRecord | null = null;
  /** Every container by id (tile containers, inventories, ground piles), in id order. */
  readonly containers = new Map<number, Container>();
  /** Bumped whenever any container's contents change or a pile appears/disappears (for renderers). */
  containerVersion = 0;
  /** World var values, by var index (clamped to each var's range on every write). */
  readonly vars: Float64Array;
  /** Current stage index per quest (-1 = not started); an ended quest keeps its final stage. */
  readonly questStage: Int32Array;
  /** Per quest: the tick it entered its current stage. */
  readonly questSince: Float64Array;
  /** Per quest: 0 = not ended, 1 = ended in success, 2 = ended in failure. */
  readonly questEnd: Uint8Array;
  /** 1 at each added journal entry index. */
  readonly journalHas: Uint8Array;
  /** Added journal entries (entry index, tick added), in the order added. */
  readonly journalLog: { readonly entry: number; readonly tick: number }[] = [];
  /** Bumped on every quest stage change and journal addition, so shells can re-render cheaply. */
  journalVersion = 0;
  /**
   * The stage changes and journal additions of the last stepped tick, in
   * order (for toasts; read right after `step`). Not state: not saved or hashed.
   */
  journalEvents: JournalEvent[] = [];
  /**
   * Every player action record of the last stepped tick (or conversation
   * input), in order; `lastAction` is the latest. Cleared with
   * `journalEvents`. Not state: not saved or hashed.
   */
  actionEvents: ActionRecord[] = [];
  /**
   * The player's statuses that turned on or off in the last stepped tick, in
   * definition order. Cleared with `journalEvents`. Not state: not saved or hashed.
   */
  statusEvents: StatusEvent[] = [];
  /**
   * The open conversation, or null. While it is open the world is paused:
   * `step()` is a no-op, queued intents and actions are ignored, and only
   * `choose` and `leaveConversation` change the world.
   */
  conversation: Conversation | null = null;
  /** Bumped when a conversation opens and on every `choose` / `leaveConversation`, so shells can re-render cheaply. */
  conversationVersion = 0;
  /** Per dialogue: the ids of its `once` choices already chosen (world-level). */
  readonly dialogueOnce: Set<string>[];
  /** The player's standing per faction index, clamped to [-100, 100] on every write. */
  readonly reputation: Float64Array;
  /** Standings (the same array as `reputation`), relations and thresholds as expressions read them. */
  readonly factionTable: FactionTable;

  private actions: Action[] = [];
  private nextContainerId = 0;
  /** Cell index → ids of the tile containers and ground piles on it, ascending. */
  private readonly cellContainers = new Map<number, number[]>();
  /** Room-set index per cell. */
  private readonly roomCell: Uint16Array;
  /** 1 at `set * roomTags.length + tag` when the room set has the tag. */
  private readonly roomHas: Uint8Array;
  private readonly itemWeights: readonly number[];
  private pathfinder: Pathfinder | null = null;
  /** Behavior think calls so far, for benchmarks and tests (not state: not saved or hashed). */
  thinkCalls = 0;
  /** A* work so far (see `PathStats`). */
  readonly pathStats: PathStats = { searches: 0, regionRejects: 0, budgetHits: 0, expanded: 0, maxNpcExpanded: 0, maxPlayerExpanded: 0 };
  /** Entity index: ids per (floor, 16×16 chunk), unordered. */
  private readonly buckets: number[][];
  private readonly chunkCols: number;
  private readonly chunksPerFloor: number;
  /** Bucket of each entity by id, as last indexed. */
  private readonly bucketOf: number[] = [];
  /** 1 at the ids of the entities dormant this tick (set at the start of `step`). */
  private dormant = new Uint8Array(0);
  /** Hearing scratch, by entity id: the stamp of the hearing pass that last touched it, its best distance², its noise. */
  private hearStamp = new Uint32Array(0);
  private hearBest = new Float64Array(0);
  private hearPick = new Int32Array(0);
  private hearGen = 0;
  private readonly hearIds: number[] = [];
  /** Noises emitted this tick, in emission order; reused (cleared, not reallocated). */
  private readonly pending: Noise[] = [];
  /** Number of valid entries of `pending`. */
  private pendingCount = 0;
  private readonly ctx: ExprContext;
  private readonly thinkEnv: ThinkEnv;
  private readonly tagSets: ReadonlySet<string>[];
  private readonly tileTagSets: ReadonlySet<string>[];
  /** Per archetype index: 1 at each measurement index the archetype has. */
  private readonly hasM: Uint8Array[];
  /** Per status: its `rates` term by measurement index (undefined = none). */
  private readonly statusRates: (NumberTerm | undefined)[][];
  /**
   * Per status, then per system: the `for` filter by archetype index, 1 = holds,
   * 0 = never, 2 = evaluate per entity (decided once when `for` is a tag test on `self`).
   */
  private readonly statusFor: Uint8Array[];
  private readonly systemFor: Uint8Array[];
  /** Systems run in the systems phase (periodic and `on: step`), in definition order. */
  private readonly tickSystems: readonly SystemDef[];
  /** `on: noise` systems, in definition order (run right after hearing). */
  private readonly noiseSystems: readonly SystemDef[];
  /** Number of `once` systems (the size of each entity's `fired` bits). */
  private readonly onceCount: number;
  /** Whether any activity source has an event interrupt (the hear sub-phase then checks activities). */
  private readonly hasEventInterrupts: boolean;
  /** First pending noise not yet heard: noises emitted after this tick's hear phase, carried to the next tick. */
  private pendingStart = 0;
  /** Scratch for the status update: next flags of every entity, row-major. */
  private statusNext = new Uint8Array(0);
  /** Activity source per action index. */
  private readonly actionSources: readonly ActivitySource[];
  /** Activity source per item index (null without a `use`). */
  private readonly useSources: readonly (ActivitySource | null)[];
  /** Activity source per recipe index. */
  private readonly recipeSources: readonly ActivitySource[];
  private readonly runner: ActivityRunner;
  /** Per quest: the tick of its last stage change during a quest phase (-1 = none), for one change per quest per phase. */
  private readonly questPhaseTick: Float64Array;
  private inQuestPhase = false;
  /** Stages being entered, outermost first (`quest:stage`), for the nesting guard. */
  private readonly questChain: string[] = [];
  /** Set once a conversation input emitted into a fresh noise list: the next `step` hears those noises instead of clearing them. */
  private noiseCarry = false;

  /**
   * `restore` (internal, see `World.restore`) replaces spawning, container
   * creation, loot rolls and the initial clamp and status update.
   */
  constructor(
    readonly def: Definition,
    readonly seed: number,
    restore?: RestoreFn,
  ) {
    const map = def.maps[def.start.map]!;
    this.grid = new Grid(map, def.tiles);
    this.rng = new Rng(seed);
    this.chunkCols = Math.ceil(map.width / INDEX_CHUNK);
    this.chunksPerFloor = this.chunkCols * Math.ceil(map.height / INDEX_CHUNK);
    this.buckets = Array.from({ length: this.chunksPerFloor * map.floors }, () => []);
    this.tagSets = def.archetypes.map((a) => new Set(a.tags));
    this.tileTagSets = def.tiles.map((t) => (t.tags.length ? new Set(t.tags) : NO_TAGS));
    const nm = def.measurements.length;
    this.hasM = def.archetypes.map((a) => {
      const has = new Uint8Array(nm);
      for (const idx of a.measurements) has[idx] = 1;
      return has;
    });
    const forTable = (forFn: unknown, forTag: string | null) =>
      Uint8Array.from(def.archetypes, (a) => (forFn === null ? 1 : forTag === null ? 2 : a.tags.includes(forTag) ? 1 : 0));
    this.statusFor = def.statuses.map((s) => forTable(s.forFn, s.forTag));
    this.systemFor = def.systems.map((s) => forTable(s.forFn, s.forTag));
    this.tickSystems = def.systems.filter((s) => s.on !== 'noise');
    this.noiseSystems = def.systems.filter((s) => s.on === 'noise');
    this.onceCount = def.systems.filter((s) => s.once).length;
    this.statusRates = def.statuses.map((s) => {
      const by = new Array<NumberTerm | undefined>(nm).fill(undefined);
      for (const r of s.rates) by[r.measurement] = r;
      return by;
    });

    const nt = def.roomTags.length;
    this.roomCell = Uint16Array.from(map.rooms.cellSet);
    this.roomHas = new Uint8Array(map.rooms.sets.length * nt);
    map.rooms.sets.forEach((set, k) => {
      for (const t of set) this.roomHas[k * nt + t] = 1;
    });
    this.itemWeights = def.items.map((i) => i.weight);
    this.actionSources = def.actions.map(actionSource);
    this.useSources = def.items.map(useSource);
    this.recipeSources = def.recipes.map(recipeSource);
    this.hasEventInterrupts = [...this.actionSources, ...this.useSources, ...this.recipeSources].some((s) => s?.interrupt?.kind === 'event');
    this.vars = Float64Array.from(def.vars, (v) => v.initial);
    this.questStage = new Int32Array(def.quests.length).fill(-1);
    this.questSince = new Float64Array(def.quests.length);
    this.questEnd = new Uint8Array(def.quests.length);
    this.questPhaseTick = new Float64Array(def.quests.length).fill(-1);
    this.journalHas = new Uint8Array(def.journal.length);
    this.dialogueOnce = def.dialogues.map(() => new Set<string>());
    const nf = def.factions.length;
    this.reputation = Float64Array.from(def.factions, (f) => f.reputation);
    const rel = new Float64Array(nf * nf);
    for (const f of def.factions) rel.set(f.relations, f.index * nf);
    this.factionTable = {
      n: nf,
      rep: this.reputation,
      rel,
      hostileBelow: Float64Array.from(def.factions, (f) => f.hostileBelow),
      friendlyFrom: Float64Array.from(def.factions, (f) => f.friendlyFrom),
    };

    if (restore) {
      this.player = restore(this, {
        itemWeights: this.itemWeights,
        actionSources: this.actionSources,
        useSources: this.useSources,
        recipeSources: this.recipeSources,
        entity: (a, x, y, z, home, inv, driven) => this.addEntity(a, x, y, z, home, inv, driven),
        container: (c) => (c.kind === 'inventory' ? this.containers.set(c.id, c) : this.addContainer(c)),
        setNextContainer: (n) => (this.nextContainerId = n),
        setActions: (a) => (this.actions = a),
      });
    } else {
      // Container ids: tile containers in cell index order (z-major, row-major), then inventories in entity order.
      for (let i = 0; i < map.cells.length; i++) {
        const t = map.cells[i]!;
        if (t === EMPTY_TILE) continue;
        const tile = def.tiles[t]!;
        if (!tile.container) continue;
        const { x, y, z } = this.grid.cellOf(i);
        this.addContainer(createContainer(this.nextContainerId++, 'tile', tile.container.capacity, { x, y, z, tile: tile.index }));
      }
      const start = map.playerStart!;
      this.player = this.spawn(def.archetypes[def.start.player]!, start.x, start.y, start.z, false);
      for (const s of map.spawns) this.spawn(def.archetypes[s.archetype]!, s.x, s.y, s.z);
      this.populate(map, seed);
      this.rollLoot(seed);
    }

    const world = this;
    this.ctx = {
      self: this.player,
      player: this.player,
      npc: null,
      tick: 0,
      ticksPerSecond: def.ticksPerSecond,
      clock: def.clock,
      random: () => world.rng.next(),
      tileIdAt: (x, y, z, side) => (side ? world.grid.edgeAt(x, y, z, side) : world.grid.tileAt(x, y, z))?.id ?? '',
      tileTagsAt: (x, y, z, side) => {
        const g = world.grid;
        const i = g.inBounds(x, y, z) ? g.index(x, y, z) : -1;
        const t = i < 0 ? EMPTY_TILE : side === 'n' ? g.edgeN[i]! : side === 'w' ? g.edgeW[i]! : g.cells[i]!;
        return t === EMPTY_TILE ? NO_TAGS : world.tileTagSets[t]!;
      },
      inRoom: (x, y, z, tag) => world.grid.inBounds(x, y, z) && world.roomHas[world.roomCell[world.grid.index(x, y, z)]! * nt + tag] === 1,
      los: (x0, y0, x1, y1, z0, z1) => lineOfSight(world.grid, x0, y0, x1, y1, z0, z1),
      warn: (msg) => world.warnings.set(msg, (world.warnings.get(msg) ?? 0) + 1),
      vars: this.vars,
      questStage: this.questStage,
      questEnd: this.questEnd,
      journalHas: this.journalHas,
      factions: this.factionTable,
    };
    this.thinkEnv = { grid: this.grid, rng: this.rng, ctx: this.ctx };
    this.runner = new ActivityRunner({
      grid: this.grid,
      tiles: def.tiles,
      ctx: this.ctx,
      entities: this.entities,
      ticksPerSecond: def.ticksPerSecond,
      runEffects: (e, effects, target) => this.runEffects(e, effects, target),
      removeItem: (inv, item, count) => remove(inv, item, count, this.itemWeights[item]!),
      giveItem: (e, item, count) => this.giveItem(e, item, count),
      record: (e, source, stage, ok, reason, moved, dropped, side) => this.recordActivity(e, source, stage, ok, reason, moved, dropped, side),
    });
    if (restore) {
      // Saved values and statuses stay as they are; only the resolved max is rebuilt.
      this.pure(() => {
        for (const e of this.entities) for (const idx of e.archetype.measurements) e.max[idx] = this.maxOf(e, def.measurements[idx]!);
      });
      return;
    }
    for (const e of this.entities) this.clamp(e);
    this.updateStatuses();
  }

  static create(def: Definition, seed: number): World {
    return new World(def, seed);
  }

  /**
   * Rebuild a world from a save made with the same packs: exact (same
   * snapshot, same future hashes), rolls nothing. Never throws; reports every
   * error found (see `docs/saves.md`).
   */
  static restore(def: Definition, save: unknown): RestoreResult {
    return restoreWorld(def, save);
  }

  /** The world as a save file (pure: `hash()`, the RNG and warnings are untouched). */
  save(): SaveFile {
    const map = this.def.maps[this.def.start.map]!;
    return {
      format: 'isolandia-save',
      version: SAVE_VERSION,
      packs: this.def.packs.map((p) => ({ namespace: p.namespace, version: p.version })),
      map: { id: map.id, width: map.width, height: map.height, floors: map.floors },
      state: this.snapshot(),
    };
  }

  /** Result of the player's most recent goto intent (a new object each time). */
  get lastGoto(): GotoRecord | null {
    return this.player.lastGoto;
  }

  get seconds(): number {
    return this.tick / this.def.ticksPerSecond;
  }

  /** In-game calendar time at the current tick. */
  get clock(): ClockTime {
    return clockAt(this.def.clock, this.tick, this.def.ticksPerSecond);
  }

  /** Add an entity; `driven` = run its archetype's behavior (false for the player). */
  private spawn(archetype: ArchetypeDef, x: number, y: number, z: number, driven = true): Entity {
    const id = this.entities.length;
    let inv: Container | null = null;
    if (archetype.inventory) {
      inv = createContainer(this.nextContainerId++, 'inventory', archetype.inventory.capacity, { owner: id });
      for (const s of archetype.inventory.items) add(inv, s.item, s.count, this.itemWeights[s.item]!);
      this.containers.set(inv.id, inv);
    }
    return this.addEntity(archetype, x, y, z, [x, y, z], inv, driven);
  }

  /** Append an entity with initial measurements and no state yet. */
  private addEntity(archetype: ArchetypeDef, x: number, y: number, z: number, home: readonly [number, number, number], inv: Container | null, driven: boolean): Entity {
    const id = this.entities.length;
    const m = new Float64Array(this.def.measurements.length);
    archetype.measurements.forEach((idx, k) => (m[idx] = archetype.initial[k]!));
    const max = new Float64Array(this.def.measurements.length).fill(Infinity);
    const behavior = driven && archetype.behavior !== null ? this.def.behaviors[archetype.behavior]! : null;
    const e: Entity = {
      id,
      archetype,
      x,
      y,
      z,
      m,
      max,
      hasM: this.hasM[archetype.index]!,
      tags: this.tagSets[archetype.index]!,
      moveCooldown: 0,
      facing: DEFAULT_FACING,
      fromX: x,
      fromY: y,
      fromZ: z,
      stepTick: 0,
      path: null,
      pathPos: 0,
      then: null,
      st: new Uint8Array(this.def.statuses.length),
      inv,
      intent: null,
      lastGoto: null,
      homeX: home[0],
      homeY: home[1],
      homeZ: home[2],
      behavior,
      state: behavior ? behavior.initial : -1,
      stateTick: 0,
      planX: 0,
      planY: 0,
      planZ: 0,
      planTick: -1,
      heardX: 0,
      heardY: 0,
      heardZ: 0,
      heardTick: -1,
      activity: null,
      faction: archetype.faction ?? -1,
      fired: this.onceCount > 0 ? new Uint8Array(this.onceCount) : null,
    };
    this.entities.push(e);
    this.bucketOf.push(-1);
    this.reindex(e);
    return e;
  }

  /**
   * Place `populate` entities after the explicit spawns: entry by entry, each
   * drawing `count` cells without replacement from its candidates (cells an
   * earlier entry took are skipped), with a dedicated RNG.
   */
  private populate(map: MapDef, seed: number): void {
    if (map.populate.length === 0) return;
    const rng = new Rng(mix(seed, POPULATE_SALT));
    const used = new Uint8Array(map.cells.length);
    for (const p of map.populate) {
      const free = populateCandidates(map, this.def.tiles, p).filter((i) => used[i] === 0);
      const n = Math.min(p.count, free.length); // the loader guarantees count ≤ free
      const archetype = this.def.archetypes[p.archetype]!;
      for (let k = 0; k < n; k++) {
        const j = k + Math.floor(rng.next() * (free.length - k));
        const cell = free[j]!;
        free[j] = free[k]!;
        free[k] = cell;
        used[cell] = 1;
        const { x, y, z } = this.grid.cellOf(cell);
        this.spawn(archetype, x, y, z);
      }
    }
  }

  // ── Entity index ────────────────────────────────────────────────────────

  /** Index bucket of a position (clamped into the map). */
  private bucketAt(x: number, y: number, z: number): number {
    const { width, height, floors } = this.grid;
    if (x >= 0 && y >= 0 && z >= 0 && x < width && y < height && z < floors) return z * this.chunksPerFloor + Math.floor(y / INDEX_CHUNK) * this.chunkCols + Math.floor(x / INDEX_CHUNK);
    const cx = Math.floor(Math.min(Math.max(x, 0), width - 1) / INDEX_CHUNK);
    const cy = Math.floor(Math.min(Math.max(y, 0), height - 1) / INDEX_CHUNK);
    const cz = Math.min(Math.max(z, 0), floors - 1);
    return cz * this.chunksPerFloor + cy * this.chunkCols + cx;
  }

  /** Move an entity to the index bucket of its position, if it changed chunk. */
  private reindex(e: Entity): void {
    const b = this.bucketAt(e.x, e.y, e.z);
    const old = this.bucketOf[e.id]!;
    if (b === old) return;
    if (old >= 0) {
      const ids = this.buckets[old]!;
      const k = ids.indexOf(e.id);
      ids[k] = ids[ids.length - 1]!;
      ids.pop();
    }
    this.buckets[b]!.push(e.id);
    this.bucketOf[e.id] = b;
  }

  /** Catch up with positions set from outside the simulation (cheap: one compare per entity). */
  private syncIndex(): void {
    for (const e of this.entities) this.reindex(e);
  }

  /**
   * Entities within Chebyshev distance `r` of (x, y), on floor `z` or on any
   * floor when `z` is omitted, in id order. Uses the chunk index.
   */
  entitiesNear(x: number, y: number, z: number | undefined, r: number): Entity[] {
    this.syncIndex();
    const out: Entity[] = [];
    if (!(r >= 0)) return out;
    const { width, height, floors } = this.grid;
    const cx0 = Math.floor(Math.max(0, x - r) / INDEX_CHUNK);
    const cx1 = Math.floor(Math.min(width - 1, x + r) / INDEX_CHUNK);
    const cy0 = Math.floor(Math.max(0, y - r) / INDEX_CHUNK);
    const cy1 = Math.floor(Math.min(height - 1, y + r) / INDEX_CHUNK);
    const z0 = z === undefined ? 0 : z;
    const z1 = z === undefined ? floors - 1 : z;
    for (let cz = z0; cz <= z1; cz++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          for (const id of this.buckets[cz * this.chunksPerFloor + cy * this.chunkCols + cx] ?? []) {
            const e = this.entities[id]!;
            if (Math.max(Math.abs(e.x - x), Math.abs(e.y - y)) <= r) out.push(e);
          }
        }
      }
    }
    return out.sort((a, b) => a.id - b.id);
  }

  // ── Dormancy ────────────────────────────────────────────────────────────

  /** Whether an NPC is beyond the active radius (Chebyshev on x, y, any floor) from the player now. Pure. */
  isDormant(e: Entity): boolean {
    const r = this.def.start.simulation.activeRadius;
    const p = this.player;
    return r !== null && e !== p && Math.max(Math.abs(e.x - p.x), Math.abs(e.y - p.y)) > r;
  }

  /** Entities that are not dormant now (the player included). Pure. */
  get activeCount(): number {
    let n = 0;
    for (const e of this.entities) if (!this.isDormant(e)) n++;
    return n;
  }

  /** Set `dormant` for this tick: one Chebyshev check per entity. */
  private markDormant(): void {
    const n = this.entities.length;
    if (this.dormant.length < n) this.dormant = new Uint8Array(n);
    const d = this.dormant;
    const r = this.def.start.simulation.activeRadius;
    if (r === null) {
      d.fill(0);
      return;
    }
    const { x, y } = this.player;
    for (const e of this.entities) d[e.id] = e !== this.player && Math.max(Math.abs(e.x - x), Math.abs(e.y - y)) > r ? 1 : 0;
  }

  // ── Containers ──────────────────────────────────────────────────────────

  private addContainer(c: Container): void {
    this.containers.set(c.id, c);
    const cell = this.grid.index(c.x, c.y, c.z);
    const ids = this.cellContainers.get(cell);
    if (ids) ids.push(c.id);
    else this.cellContainers.set(cell, [c.id]);
  }

  /** The ground pile on a cell, created if missing. */
  private groundPile(x: number, y: number, z: number): Container {
    let pile = this.containersAt(x, y, z).find((c) => c.kind === 'ground');
    if (!pile) {
      pile = createContainer(this.nextContainerId++, 'ground', Infinity, { x, y, z });
      this.addContainer(pile);
    }
    return pile;
  }

  /** Add `count` units to `e`'s inventory, as many as fit, and the rest to the ground pile on its cell; returns units dropped. */
  private giveItem(e: Entity, item: number, count: number): number {
    const weight = this.itemWeights[item]!;
    const fit = e.inv ? fits(e.inv, weight, count) : 0;
    if (fit > 0) add(e.inv!, item, fit, weight);
    const rest = count - fit;
    if (rest > 0) add(this.groundPile(e.x, e.y, e.z), item, rest, weight);
    return rest;
  }

  /** Remove a ground pile once it is empty. */
  private pruneGround(c: Container): void {
    if (c.kind !== 'ground' || c.stacks.length > 0) return;
    this.containers.delete(c.id);
    const cell = this.grid.index(c.x, c.y, c.z);
    const ids = this.cellContainers.get(cell)!;
    ids.splice(ids.indexOf(c.id), 1);
    if (ids.length === 0) this.cellContainers.delete(cell);
  }

  /** Tile containers and ground piles on a cell (floor `z`, default the player's), in id order. */
  containersAt(x: number, y: number, z: number = this.player.z): Container[] {
    if (!this.grid.inBounds(x, y, z)) return [];
    const ids = this.cellContainers.get(this.grid.index(x, y, z));
    return ids ? ids.map((id) => this.containers.get(id)!) : [];
  }

  /**
   * Every container the player can reach now (its cell or the 8 around it,
   * on its floor, with no non-walkable edge between: `Grid.reaches`), in id order.
   */
  reachableContainers(): Container[] {
    const { x, y, z } = this.player;
    const out: Container[] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (this.grid.reaches(x, y, z, x + dx, y + dy, z)) out.push(...this.containersAt(x + dx, y + dy, z));
    return out.sort((a, b) => a.id - b.id);
  }

  /** Room tag indices of a cell (floor `z`, default the player's; empty outside rooms or out of bounds). */
  roomTagsAt(x: number, y: number, z: number = this.player.z): readonly number[] {
    if (!this.grid.inBounds(x, y, z)) return [];
    return this.def.maps[this.def.start.map]!.rooms.sets[this.roomCell[this.grid.index(x, y, z)]!]!;
  }

  /** Fill tile containers from their distributions, with a dedicated RNG (never `this.rng`). */
  private rollLoot(seed: number): void {
    const def = this.def;
    if (def.distributions.length === 0) return;
    const rng = new Rng(mix(seed, LOOT_SALT));
    const chosen = new Map<number, number>(); // tile * sets + roomSet → table (-1 = none)
    const nsets = def.maps[def.start.map]!.rooms.sets.length;
    for (const c of this.containers.values()) {
      if (c.kind !== 'tile') break; // tile containers come first
      const set = this.roomCell[this.grid.index(c.x, c.y, c.z)]!;
      const key = c.tile * nsets + set;
      let table = chosen.get(key);
      if (table === undefined) {
        table = this.distributionFor(c.tile, set);
        chosen.set(key, table);
      }
      if (table >= 0) this.rollTable(table, c, rng);
    }
  }

  /** First most specific distribution: a matching `room` beats no `room`; ties go to the first. */
  private distributionFor(tile: number, set: number): number {
    const nt = this.def.roomTags.length;
    let fallback = -1;
    for (const d of this.def.distributions) {
      if (d.container !== tile) continue;
      if (d.room === null) {
        if (fallback < 0) fallback = d.table;
      } else if (this.roomHas[set * nt + d.room] === 1) return d.table;
    }
    return fallback;
  }

  private rollTable(t: number, c: Container, rng: Rng): void {
    const table = this.def.loot[t]!;
    const between = (lo: number, hi: number) => (lo === hi ? lo : lo + Math.floor(rng.next() * (hi - lo + 1)));
    const rolls = between(table.rollsMin, table.rollsMax);
    for (let r = 0; r < rolls; r++) {
      const pick = rng.next() * table.total;
      let k = 0;
      while (table.cumulative[k]! <= pick) k++;
      const e = table.entries[k]!;
      if (e.kind === 'item') {
        const weight = this.itemWeights[e.item]!;
        add(c, e.item, fits(c, weight, between(e.countMin, e.countMax)), weight);
      } else if (e.kind === 'table') this.rollTable(e.table, c, rng);
    }
  }

  /** Queue a player action (FIFO; applied after the movement intents). Ignored once the game has ended and while a conversation is open. */
  queueAction(action: Action): void {
    if (this.ended || this.conversation) return;
    this.actions.push(action);
  }

  /**
   * Queue an entity's next move (the player by default); the latest intent
   * wins until it is applied. Ignored once the game has ended and while a
   * conversation is open. Throws for an entity of another world.
   */
  queueIntent(intent: Intent, entity: Entity = this.player): void {
    if (this.entities[entity.id] !== entity) throw new Error(`entity ${entity.id} does not belong to this world`);
    if (intent.kind === 'goto' && intent.then && entity !== this.player) throw new Error(`only the player's goto may carry 'then' (entity ${entity.id})`);
    if (this.ended || this.conversation) return;
    if (intent.kind === 'step' && intent.dx === 0 && intent.dy === 0) return;
    entity.intent = intent;
  }

  /** True once the game has ended (defeat or victory): the world is frozen. */
  get ended(): boolean {
    return this.defeat !== null || this.victory !== null;
  }

  /** Goal tile of an entity's active path, or null. */
  pathGoal(e: Entity): { x: number; y: number; z: number } | null {
    if (!e.path || e.pathPos >= e.path.length) return null;
    return this.grid.cellOf(e.path[e.path.length - 1]!);
  }

  /** Bumped on every map edit (`set_tile`), so renderers can redraw changed cells. */
  get tileVersion(): number {
    return this.grid.version;
  }

  /** This tick's noises (after `step`, the last stepped tick's), in emission order. */
  get noises(): readonly Readonly<Noise>[] {
    return this.pending.slice(0, this.pendingCount);
  }

  /**
   * Advance exactly one tick (1 / ticksPerSecond seconds): mark dormant NPCs
   * (beyond the active radius: they neither think nor move this tick),
   * behaviors think (id order), every entity's movement intent (id order), player actions,
   * activity work (id order), drift, due systems, hearing, clamp, status
   * update, quests, defeat then victory check, `tick++`.
   * A no-op once the game has ended and while a conversation is open.
   */
  step(): void {
    if (this.ended || this.conversation) return;
    this.ctx.tick = this.tick;
    if (this.noiseCarry) {
      this.noiseCarry = false;
      if (this.pendingStart > 0) this.compactNoises();
    } else this.pendingCount = 0;
    this.pendingStart = 0;
    this.clearEvents();
    this.syncIndex();
    this.markDormant();
    this.think();
    const dormant = this.dormant;
    for (const e of this.entities) {
      if (dormant[e.id] === 1) continue;
      if (e.intent || e.path) this.applyIntent(e);
      else if (e.moveCooldown > 0) e.moveCooldown--;
    }
    if (this.actions.length > 0) this.applyActions();
    for (const e of this.entities) if (e.activity) this.runner.advance(e, this.tick);
    this.drift();
    this.runSystems();
    if (this.pendingCount > 0) {
      this.hear();
      this.afterHear();
    }
    for (const e of this.entities) this.clamp(e);
    this.updateStatuses();
    if (this.def.quests.length > 0) this.questPhase();
    this.checkOutcome();
    this.tick++;
  }

  /** Phase 0: each behavior-driven entity switches state at most once, then issues its activity's intent. */
  private think(): void {
    const env = this.thinkEnv;
    const dormant = this.dormant;
    for (const e of this.entities) {
      if (e.state < 0 || dormant[e.id] === 1) continue;
      think(e, env);
      this.thinkCalls++;
    }
  }

  /** Measurement drift: `rate` plus the `rates` of the statuses active now. */
  private drift(): void {
    const ms = this.def.measurements;
    const tps = this.def.ticksPerSecond;
    const ns = this.def.statuses.length;
    const ctx = this.ctx;
    for (const e of this.entities) {
      ctx.self = e;
      const m = e.m;
      let any = false;
      for (let k = 0; k < ns; k++) if (e.st[k] === 1) any = true;
      for (const idx of e.archetype.measurements) {
        const md = ms[idx]!;
        let d = md.rateFn ? Number(md.rateFn(ctx)) : md.rateConst;
        if (any) {
          for (let k = 0; k < ns; k++) {
            if (e.st[k] !== 1) continue;
            const r = this.statusRates[k]![idx];
            if (r) d += r.fn ? Number(r.fn(ctx)) : r.constant;
          }
        }
        if (d !== 0) m[idx] = m[idx]! + d / tps;
      }
    }
  }

  /**
   * Phase 3: the periodic systems due this tick and the `on: step` systems
   * (for every entity that landed on a cell this tick: `move` and `climb`
   * set its `stepTick` to `tick + 1`), in definition order, once per
   * matching entity.
   */
  private runSystems(): void {
    const t = this.tick + 1;
    for (const sys of this.tickSystems) {
      if (sys.on === 'step') {
        for (const e of this.entities) if (e.stepTick === t) this.fireSystem(sys, e);
      } else if (t % sys.period === 0) {
        for (const e of this.entities) this.fireSystem(sys, e);
      }
    }
  }

  /** Run `sys` for `e` when its `once` bit, `for` and `when` allow it; a `once` system then never fires for `e` again. */
  private fireSystem(sys: SystemDef, e: Entity): void {
    if (sys.once && e.fired![sys.onceIndex] === 1) return;
    const f = this.systemFor[sys.index]![e.archetype.index];
    if (f === 0) return;
    const ctx = this.ctx;
    ctx.self = e;
    if (f === 2 && !sys.forFn!(ctx)) return;
    if (sys.whenFn && !sys.whenFn(ctx)) return;
    if (sys.once) e.fired![sys.onceIndex] = 1;
    this.runEffects(e, sys.effects);
  }

  /**
   * Phase 4b, right after `hear()`: for the entities that heard a noise this
   * tick, in id order, the event interrupts of their activities, then the
   * `on: noise` systems (definition order, entity order). A noise emitted here
   * is not heard this tick: it is carried to the next tick's hear phase.
   */
  private afterHear(): void {
    const heardEnd = this.pendingCount;
    const ids = this.hearIds;
    if (this.hasEventInterrupts || this.noiseSystems.length > 0) {
      ids.sort((a, b) => a - b);
      const entities = this.entities;
      if (this.hasEventInterrupts) {
        for (const id of ids) {
          const e = entities[id]!;
          if (e.activity) this.runner.interruptOnNoise(e, this.tick);
        }
      }
      for (const sys of this.noiseSystems) for (const id of ids) this.fireSystem(sys, entities[id]!);
    }
    if (this.pendingCount > heardEnd) {
      this.pendingStart = heardEnd;
      this.noiseCarry = true;
    }
  }

  /** Move the carried noises (from `pendingStart`) to the front of the pending list. */
  private compactNoises(): void {
    const { pending, pendingStart } = this;
    const n = this.pendingCount - pendingStart;
    for (let i = 0; i < n; i++) {
      const carried = pending[pendingStart + i]!;
      pending[pendingStart + i] = pending[i]!;
      pending[i] = carried;
    }
    this.pendingCount = n;
    this.pendingStart = 0;
  }

  /**
   * Run effects on `e` (= `ctx.self`), in order; measurement effects skip
   * measurements it lacks. `set_tile` replaces the tile at `target`, or its
   * edge on `target.side`.
   */
  private runEffects(e: Entity, effects: readonly EffectDef[], target: { x: number; y: number; z: number; side: EdgeSide | null } | null = null): void {
    const ctx = this.ctx;
    const has = this.hasM[e.archetype.index]!;
    for (const eff of effects) {
      switch (eff.type) {
        case 'apply':
        case 'set': {
          const idx = eff.measurement;
          const t = eff.on === 'npc' ? (this.conversation?.npc ?? null) : e;
          if (!t || (t === e ? has : this.hasM[t.archetype.index]!)[idx] !== 1) continue;
          const v = eff.fn ? Number(eff.fn(ctx)) : eff.constant;
          t.m[idx] = eff.type === 'apply' ? t.m[idx]! + v : v;
          break;
        }
        case 'noise':
          this.emitNoise(e, eff.fn ? Number(eff.fn(ctx)) : eff.constant);
          break;
        case 'set_tile':
          if (target?.side) this.grid.setEdge(this.grid.index(target.x, target.y, target.z), target.side, eff.tile);
          else if (target) this.grid.setTile(this.grid.index(target.x, target.y, target.z), eff.tile);
          break;
        case 'set_var':
          this.writeVar(eff.var, eff.fn ? Number(eff.fn(ctx)) : eff.constant);
          break;
        case 'add_var':
          this.writeVar(eff.var, this.vars[eff.var]! + (eff.fn ? Number(eff.fn(ctx)) : eff.constant));
          break;
        case 'quest':
          this.enterStage(eff.quest, eff.stage);
          break;
        case 'journal':
          this.addEntry(eff.entry);
          break;
        case 'reputation':
          this.reputationEffect(e, eff);
          break;
      }
    }
  }

  /**
   * The `reputation` effect on `self` = `e`: skipped when `witnessed` is set
   * and no member sees `e`; then the faction changes by the term and, with
   * `spread`, every faction with a relation to it by `delta × r / 100`
   * (rounded to 2 decimals, one step).
   */
  private reputationEffect(e: Entity, eff: ReputationEffectDef): void {
    const f = eff.faction;
    if (eff.witnessed !== null && !this.witnessed(e, f, eff.witnessed)) return;
    const delta = eff.fn ? Number(eff.fn(this.ctx)) : eff.constant;
    if (!Number.isFinite(delta)) return;
    this.writeReputation(f, this.reputation[f]! + delta);
    if (!eff.spread) return;
    for (const t of this.def.factions[f]!.spread) this.writeReputation(t.faction, this.reputation[t.faction]! + round2((delta * t.relation) / 100));
  }

  /**
   * Whether an entity of faction `f` other than `e` and the player is on
   * `e`'s floor within euclidean distance `range` of it and can see it (id
   * order, stopping at the first member that sees it).
   */
  private witnessed(e: Entity, f: number, range: number): boolean {
    if (!this.def.factions[f]!.members) return false;
    const r2 = range * range;
    for (const m of this.entitiesNear(e.x, e.y, e.z, Math.floor(range))) {
      if (m === e || m === this.player || m.faction !== f) continue;
      const dx = m.x - e.x;
      const dy = m.y - e.y;
      if (dx * dx + dy * dy > r2) continue;
      if (lineOfSight(this.grid, m.x, m.y, e.x, e.y, m.z, e.z)) return true;
    }
    return false;
  }

  /**
   * Write a standing, clamped to [-100, 100]. A change bumps
   * `journalVersion`; one into another tier of a faction that is not hidden
   * also adds a `reputation` journal event.
   */
  private writeReputation(k: number, v: number): void {
    const old = this.reputation[k]!;
    const next = v < REPUTATION_MIN ? REPUTATION_MIN : v > REPUTATION_MAX ? REPUTATION_MAX : v;
    if (next === old) return;
    this.reputation[k] = next;
    this.journalVersion++;
    const f = this.def.factions[k]!;
    if (f.hidden) return;
    const from = tierOf(f, old);
    const to = tierOf(f, next);
    if (from !== to) this.journalEvents.push({ tick: this.tick, kind: 'reputation', faction: f.id, from, to });
  }

  /** Write a var, clamped to its range. */
  private writeVar(k: number, v: number): void {
    const d = this.def.vars[k]!;
    this.vars[k] = v < d.min ? d.min : v > d.max ? d.max : v;
  }

  /** Add a journal entry (a no-op when it is already there). */
  private addEntry(k: number): void {
    if (this.journalHas[k] === 1) return;
    this.journalHas[k] = 1;
    this.journalLog.push({ entry: k, tick: this.tick });
    this.journalVersion++;
    this.journalEvents.push({ tick: this.tick, kind: 'entry', entry: this.def.journal[k]!.id });
  }

  /**
   * Move quest `q` forward to stage `s` and run the stage's effects with
   * `self` = the player. A stage before or equal to the current one, or any
   * stage of an ended quest, is a no-op, as is a second change in the same
   * quest phase. Throws when stage effects nest more than `MAX_QUEST_DEPTH`
   * deep (a pack mistake).
   */
  private enterStage(q: number, s: number): void {
    if (this.questEnd[q] !== 0 || s <= this.questStage[q]!) return;
    if (this.inQuestPhase && this.questPhaseTick[q] === this.tick) return;
    const quest = this.def.quests[q]!;
    const stage = quest.stages[s]!;
    const chain = this.questChain;
    chain.push(`${quest.id}:${stage.name}`);
    try {
      if (chain.length > MAX_QUEST_DEPTH + 1) {
        throw new Error(`quest stages entered by effects nest more than ${MAX_QUEST_DEPTH} deep: ${chain.join(' → ')}`);
      }
      this.questStage[q] = s;
      this.questSince[q] = this.tick;
      this.questEnd[q] = stage.end === 'success' ? 1 : stage.end === 'failure' ? 2 : 0;
      if (this.inQuestPhase) this.questPhaseTick[q] = this.tick;
      this.journalVersion++;
      this.journalEvents.push({ tick: this.tick, kind: 'stage', quest: quest.id, stage: stage.name });
      if (stage.effects.length === 0) return;
      const ctx = this.ctx;
      const { self, target } = ctx;
      ctx.self = this.player;
      ctx.target = null;
      try {
        this.runEffects(this.player, stage.effects);
      } finally {
        ctx.self = self;
        ctx.target = target;
      }
    } finally {
      chain.pop();
    }
  }

  /**
   * Quest phase: quests in definition order; each not-ended quest enters the
   * last stage after its current one whose `when` holds (with `self` = the
   * player), skipping those in between. At most one change per quest; stage
   * effects run at once, so later quests see them.
   */
  private questPhase(): void {
    const ctx = this.ctx;
    ctx.self = this.player;
    ctx.target = null;
    const tick = this.tick;
    this.inQuestPhase = true;
    try {
      for (const q of this.def.quests) {
        const k = q.index;
        if (this.questEnd[k] !== 0 || this.questPhaseTick[k] === tick) continue;
        const cur = this.questStage[k]!;
        const watched = q.watched;
        for (let i = watched.length - 1; i >= 0; i--) {
          const s = watched[i]!;
          if (s <= cur) break;
          if (q.stages[s]!.whenFn!(ctx)) {
            this.enterStage(k, s);
            ctx.self = this.player;
            break;
          }
        }
      }
    } finally {
      this.inQuestPhase = false;
    }
  }

  /** Queue a noise at the source's cell; a radius ≤ 0 (or NaN) emits nothing. */
  private emitNoise(source: Entity, radius: number): void {
    if (!(radius > 0)) return;
    const n = this.pendingCount++;
    const slot = this.pending[n];
    if (slot) {
      slot.x = source.x;
      slot.y = source.y;
      slot.z = source.z;
      slot.radius = radius;
      slot.source = source.id;
    } else this.pending.push({ x: source.x, y: source.y, z: source.z, radius, source: source.id });
  }

  /**
   * Phase 4: every entity except the source hears a noise within its radius
   * (3D euclidean with one floor = one tile, inclusive, walls and floors
   * ignored) and keeps this tick's nearest one (ties: the earlier emission).
   * Each noise visits only the index chunks its radius reaches; the result is
   * the same as checking every (noise, entity) pair.
   */
  private hear(): void {
    const k = this.pendingCount;
    const noises = this.pending;
    const n = this.entities.length;
    if (this.hearStamp.length < n) {
      this.hearStamp = new Uint32Array(n);
      this.hearBest = new Float64Array(n);
      this.hearPick = new Int32Array(n);
    }
    const stamp = ++this.hearGen;
    const { hearStamp, hearBest, hearPick, hearIds, entities } = this;
    hearIds.length = 0;
    const { width, height, floors } = this.grid;
    for (let i = 0; i < k; i++) {
      const s = noises[i]!;
      const r2 = s.radius * s.radius;
      const r = Math.floor(s.radius);
      const cx0 = Math.floor(Math.max(0, s.x - r) / INDEX_CHUNK);
      const cx1 = Math.floor(Math.min(width - 1, s.x + r) / INDEX_CHUNK);
      const cy0 = Math.floor(Math.max(0, s.y - r) / INDEX_CHUNK);
      const cy1 = Math.floor(Math.min(height - 1, s.y + r) / INDEX_CHUNK);
      for (let cz = 0; cz < floors; cz++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          for (let cx = cx0; cx <= cx1; cx++) {
            for (const id of this.buckets[cz * this.chunksPerFloor + cy * this.chunkCols + cx]!) {
              if (id === s.source) continue;
              const e = entities[id]!;
              const dx = s.x - e.x;
              const dy = s.y - e.y;
              const dz = s.z - e.z;
              const d = dx * dx + dy * dy + dz * dz;
              if (d > r2) continue;
              if (hearStamp[id] !== stamp) {
                hearStamp[id] = stamp;
                hearIds.push(id);
              } else if (d >= hearBest[id]!) continue;
              hearBest[id] = d;
              hearPick[id] = i;
            }
          }
        }
      }
    }
    for (const id of hearIds) {
      const e = entities[id]!;
      const s = noises[hearPick[id]!]!;
      e.heardX = s.x;
      e.heardY = s.y;
      e.heardZ = s.z;
      e.heardTick = this.tick;
    }
  }

  /**
   * Enter/exit statuses. Every condition sees the flags as they were at the
   * start of the update (next flags go to a scratch buffer first), so the
   * definition order of statuses does not matter.
   */
  private updateStatuses(): void {
    const statuses = this.def.statuses;
    const ns = statuses.length;
    if (ns === 0) return;
    const ctx = this.ctx;
    const n = this.entities.length * ns;
    if (this.statusNext.length < n) this.statusNext = new Uint8Array(n);
    const next = this.statusNext;
    let o = 0;
    const pre = this.statusFor;
    for (const e of this.entities) {
      ctx.self = e;
      const a = e.archetype.index;
      for (let k = 0; k < ns; k++, o++) {
        const s = statuses[k]!;
        const f = pre[k]![a];
        if (f === 0 || (f === 2 && !s.forFn!(ctx))) next[o] = 0;
        else if (e.st[k] === 1) next[o] = s.untilFn(ctx) ? 0 : 1;
        else next[o] = s.whenFn(ctx) ? 1 : 0;
      }
    }
    o = 0;
    const player = this.player;
    for (const e of this.entities) {
      const st = e.st;
      if (e === player) {
        for (let k = 0; k < ns; k++, o++) {
          const v = next[o]!;
          if (st[k] !== v) this.statusEvents.push({ tick: this.tick, status: statuses[k]!.id, entered: v === 1 });
          st[k] = v;
        }
      } else for (let k = 0; k < ns; k++, o++) st[k] = next[o]!;
    }
  }

  /** Phase 7: defeat first; victory only when defeat did not trigger. */
  private checkOutcome(): void {
    const { defeat, victory } = this.def.start;
    if (!defeat && !victory) return;
    this.ctx.self = this.player;
    if (defeat && defeat.when(this.ctx)) this.defeat = { tick: this.tick, message: defeat.message };
    else if (victory && victory.when(this.ctx)) this.victory = { tick: this.tick, message: victory.message };
  }

  /** Whether an entity has a status (by qualified id). */
  hasStatus(e: Entity, statusId: string): boolean {
    const k = this.def.ids.statuses[statusId];
    return k !== undefined && e.st[k] === 1;
  }

  /**
   * Resolve an entity's pending intent (which cancels its activity), count
   * its cooldown down, then step or advance its path.
   */
  private applyIntent(p: Entity): void {
    const intent = p.intent;
    if (intent && p.activity) this.runner.end(p, 'cancelled');
    if (intent?.kind === 'goto') {
      p.intent = null;
      const pf = (this.pathfinder ??= new Pathfinder(this.grid));
      const z = intent.z ?? p.z;
      const sim = this.def.start.simulation;
      const isPlayer = p === this.player;
      const budget = isPlayer ? sim.playerPathBudget : sim.npcPathBudget;
      const path = intent.side
        ? pf.findPathToEdge(p.x, p.y, intent.x, intent.y, intent.side, p.z, z, budget)
        : intent.adjacent
          ? pf.findPathAdjacent(p.x, p.y, intent.x, intent.y, p.z, z, budget)
          : pf.findPath(p.x, p.y, intent.x, intent.y, p.z, z, budget);
      const st = this.pathStats;
      st.searches++;
      st.expanded += pf.lastExpanded;
      if (pf.lastRegionReject) st.regionRejects++;
      if (pf.lastBudgetHit) st.budgetHits++;
      if (isPlayer) st.maxPlayerExpanded = Math.max(st.maxPlayerExpanded, pf.lastExpanded);
      else st.maxNpcExpanded = Math.max(st.maxNpcExpanded, pf.lastExpanded);
      p.path = path && path.length > 0 ? path : null;
      p.pathPos = 0;
      p.lastGoto = { x: intent.x, y: intent.y, z, ok: path !== null, tick: this.tick };
      p.then = path ? (intent.then ?? null) : null;
      if (!path && intent.then) this.record(this.unreachable(intent.then));
      if (p.then && !p.path) this.arrive(p);
    } else if (intent?.kind === 'step') {
      p.path = null;
      p.then = null;
    }

    if (p.moveCooldown > 0) p.moveCooldown--;
    if (p.moveCooldown > 0) return;
    let dx: number;
    let dy: number;
    if (p.intent?.kind === 'step') ({ dx, dy } = p.intent);
    else if (p.path) {
      const next = this.grid.cellOf(p.path[p.pathPos]!);
      if (next.z !== p.z) {
        // A link step: no turn, facing unchanged.
        p.pathPos++;
        if (p.pathPos >= p.path.length) p.path = null;
        if (!this.climb(p, next.z - p.z)) {
          p.path = null;
          p.then = null;
        } else if (!p.path && p.then) this.arrive(p);
        return;
      }
      dx = next.x - p.x;
      dy = next.y - p.y;
    } else return;

    // Turn toward the step first; the intent and path stay pending meanwhile.
    // A turn-in-place intent is consumed, without a step, on the beat it faces `want`.
    const want = facingOfStep(dx, dy);
    if (want && p.facing !== want) {
      const turnOnly = p.intent?.kind === 'step' && p.intent.turnInPlace === true;
      if (p.archetype.ticksPerTurn > 0) {
        p.facing = turnToward(p.facing, want);
        p.moveCooldown = p.archetype.ticksPerTurn;
        if (turnOnly && p.facing === want) p.intent = null;
        return;
      }
      p.facing = want;
      if (turnOnly) {
        p.intent = null;
        return;
      }
    }

    if (p.intent?.kind === 'step') {
      p.intent = null;
      this.move(p, dx, dy);
    } else if (p.path) {
      p.pathPos++;
      if (p.pathPos >= p.path.length) p.path = null;
      if (!this.move(p, dx, dy)) {
        p.path = null;
        p.then = null;
      } else if (!p.path && p.then) this.arrive(p);
    }
  }

  /** The path is done: queue its `then` (applied in this tick's action step). */
  private arrive(p: Entity): void {
    this.actions.push(p.then!);
    p.then = null;
  }

  /** Record of a `then` dropped because its goto found no path. */
  private unreachable(a: Action): ActionRecord {
    return {
      kind: a.kind,
      item: a.kind === 'act' || a.kind === 'craft' || a.kind === 'talk' ? '' : a.item,
      ...(a.kind === 'talk' ? { entity: a.entity } : {}),
      ...(a.kind === 'act' ? { action: a.action } : {}),
      ...(a.kind === 'craft' ? { recipe: a.recipe } : {}),
      ...(a.kind === 'act' && a.side ? { side: a.side } : {}),
      moved: 0,
      ok: false,
      stage: 'complete',
      reason: 'unreachable',
      tick: this.tick,
    };
  }

  /** Each queued action first cancels the player's activity, then is applied (FIFO). */
  private applyActions(): void {
    const queue = this.actions;
    this.actions = [];
    this.ctx.tick = this.tick;
    for (const a of queue) {
      this.runner.end(this.player, 'cancelled');
      const r = this.applyAction(a);
      if (r) this.record(r);
    }
  }

  /** A player action record: the new `lastAction`, appended to `actionEvents`. */
  private record(r: ActionRecord): void {
    this.lastAction = r;
    this.actionEvents.push(r);
  }

  /** Record of an activity source's start or end (the player's becomes `lastAction`). */
  private recordActivity(e: Entity, s: ActivitySource, stage: ActivityStage, ok: boolean, reason: ActionFailure | null, moved: number, dropped: number, side: EdgeSide | null): void {
    if (ok && stage === 'complete') this.containerVersion++;
    if (e !== this.player) return;
    this.record({
      kind: s.kind,
      item: s.item >= 0 ? this.def.items[s.item]!.id : '',
      ...(s.action >= 0 ? { action: this.def.actions[s.action]!.id } : {}),
      ...(s.recipe >= 0 ? { recipe: this.def.recipes[s.recipe]!.id } : {}),
      ...(side ? { side } : {}),
      moved,
      ...(dropped > 0 ? { dropped } : {}),
      ok,
      stage,
      ...(reason ? { reason } : {}),
      tick: this.tick,
    });
  }

  /** Apply one action; `act`/`use`/`craft` that reach the activity runner record themselves (null). */
  private applyAction(a: Action): ActionRecord | null {
    const tick = this.tick;
    const p = this.player;
    const inv = p.inv;

    if (a.kind === 'talk') return this.talk(a);

    if (a.kind === 'act') {
      const side = a.side === 'n' || a.side === 'w' ? a.side : null;
      const fail = (reason: ActionFailure, stage: ActivityStage): ActionRecord => ({ kind: 'act', item: '', action: a.action, ...(side ? { side } : {}), moved: 0, ok: false, stage, reason, tick });
      const k = this.def.ids.actions[a.action];
      if (k === undefined) return fail('unknown_action', 'complete');
      const s = this.actionSources[k]!;
      const stage = isTimed(s) ? 'start' : 'complete';
      if (s.requires.length > 0 && !inv) return fail('no_inventory', stage);
      const hasXY = a.x !== undefined || a.y !== undefined || a.z !== undefined || a.side !== undefined;
      if (a.side !== undefined && !side) return fail('invalid_target', stage);
      if (s.filter ? !(Number.isInteger(a.x) && Number.isInteger(a.y) && (a.z === undefined || Number.isInteger(a.z))) : hasXY) return fail('invalid_target', stage);
      if (s.filter) this.runner.start(s, p, a.x!, a.y!, a.z ?? p.z, tick, side);
      else this.runner.start(s, p, p.x, p.y, p.z, tick);
      return null;
    }

    if (a.kind === 'craft') {
      const fail = (reason: ActionFailure, stage: ActivityStage): ActionRecord => ({ kind: 'craft', item: '', recipe: a.recipe, moved: 0, ok: false, stage, reason, tick });
      const k = this.def.ids.recipes[a.recipe];
      if (k === undefined) return fail('unknown_recipe', 'complete');
      const s = this.recipeSources[k]!;
      const stage = isTimed(s) ? 'start' : 'complete';
      if (!inv) return fail('no_inventory', stage);
      const hasXY = a.x !== undefined || a.y !== undefined || a.z !== undefined;
      if (!s.filter) {
        if (hasXY) return fail('invalid_target', stage);
        this.runner.start(s, p, p.x, p.y, p.z, tick);
        return null;
      }
      if (!hasXY) {
        const at = this.stationCell(s);
        if (!at) return fail('out_of_reach', stage);
        this.runner.start(s, p, at.x, at.y, at.z, tick);
        return null;
      }
      if (!(Number.isInteger(a.x) && Number.isInteger(a.y) && (a.z === undefined || Number.isInteger(a.z)))) return fail('invalid_target', stage);
      this.runner.start(s, p, a.x!, a.y!, a.z ?? p.z, tick);
      return null;
    }

    const fail = (reason: ActionFailure): ActionRecord => ({ kind: a.kind, item: a.item, moved: 0, ok: false, stage: 'complete', reason, tick });
    const done = (moved: number): ActionRecord => {
      this.containerVersion++;
      return { kind: a.kind, item: a.item, moved, ok: true, stage: 'complete', tick };
    };
    if (!inv) return fail('no_inventory');
    const item = this.def.ids.items[a.item];
    if (item === undefined) return fail('missing');
    const weight = this.itemWeights[item]!;
    const want = a.kind === 'use' || a.count === undefined ? Infinity : Math.floor(a.count);
    if (!(want >= 1)) return fail('missing');

    if (a.kind === 'use') {
      const s = this.useSources[item];
      if (countOf(inv, item) === 0) return fail('missing');
      if (!s) return fail('cannot_use');
      this.runner.start(s, p, p.x, p.y, p.z, tick);
      return null;
    }

    if (a.kind === 'drop') {
      const n = Math.min(want, countOf(inv, item));
      if (n === 0) return fail('missing');
      remove(inv, item, n, weight);
      add(this.groundPile(p.x, p.y, p.z), item, n, weight);
      return done(n);
    }

    const c = this.containers.get(a.container);
    if (!c || c.kind === 'inventory') return fail('unknown_container');
    if (!this.grid.reaches(p.x, p.y, p.z, c.x, c.y, c.z)) return fail('out_of_reach');
    const [from, to] = a.kind === 'take' ? [c, inv] : [inv, c];
    const have = Math.min(want, countOf(from, item));
    if (have === 0) return fail('missing');
    const n = fits(to, weight, have);
    if (n === 0) return fail('too_heavy');
    remove(from, item, n, weight);
    add(to, item, n, weight);
    this.pruneGround(c);
    return done(n);
  }

  // ── Conversations ───────────────────────────────────────────────────────

  /** Point the expression context at a conversation with `npc`: `self` and `player` are the player. */
  private bindTalk(npc: Entity): ExprContext {
    const ctx = this.ctx;
    ctx.self = this.player;
    ctx.target = null;
    ctx.npc = npc;
    return ctx;
  }

  /**
   * The `talk` action: checks `unknown_entity`, `no_dialogue`,
   * `out_of_reach` (container reach), then the dialogue's `when` and its
   * `start` list (`cannot_act`); then opens the conversation.
   */
  private talk(a: TalkAction): ActionRecord {
    const p = this.player;
    const record = (reason?: ActionFailure): ActionRecord => ({
      kind: 'talk',
      item: '',
      entity: a.entity,
      moved: 0,
      ok: !reason,
      stage: 'complete',
      ...(reason ? { reason } : {}),
      tick: this.tick,
    });
    const npc = Number.isInteger(a.entity) ? this.entities[a.entity] : undefined;
    if (!npc || npc === p) return record('unknown_entity');
    if (npc.archetype.dialogue === null) return record('no_dialogue');
    if (!this.grid.reaches(p.x, p.y, p.z, npc.x, npc.y, npc.z)) return record('out_of_reach');
    const dialogue = this.def.dialogues[npc.archetype.dialogue]!;
    const ctx = this.bindTalk(npc);
    if (dialogue.whenFn && !dialogue.whenFn(ctx)) return record('cannot_act');
    const opening = dialogue.start.find((s) => !s.whenFn || s.whenFn(ctx));
    if (!opening) return record('cannot_act');
    p.path = null;
    p.pathPos = 0;
    p.then = null;
    p.intent = null;
    npc.path = null;
    npc.pathPos = 0;
    npc.intent = null;
    const facing = facingOfStep(Math.sign(p.x - npc.x), Math.sign(p.y - npc.y));
    if (facing) npc.facing = facing;
    this.conversation = { npc, dialogue, node: opening.node, entries: 0 };
    this.conversationVersion++;
    this.enterNode(opening.node);
    return record();
  }

  /**
   * Enter node `k` of the open conversation and run its effects. Past
   * `MAX_DIALOGUE_ENTRIES` entries without a player choice, ends the
   * conversation instead and returns the error.
   */
  private enterNode(k: number): string | null {
    const c = this.conversation!;
    if (++c.entries > MAX_DIALOGUE_ENTRIES) {
      const from = c.dialogue.nodes[c.node]!.name;
      this.endConversation();
      return `dialogue '${c.dialogue.id}' entered more than ${MAX_DIALOGUE_ENTRIES} nodes without a player choice (a 'next' loop?), going from '${from}' to '${c.dialogue.nodes[k]!.name}'`;
    }
    c.node = k;
    const node = c.dialogue.nodes[k]!;
    if (node.effects.length > 0) {
      this.bindTalk(c.npc);
      this.runEffects(this.player, node.effects);
    }
    return null;
  }

  private endConversation(): void {
    this.conversation = null;
    this.ctx.npc = null;
  }

  /** Fresh per-tick event lists (`journalEvents`, `actionEvents`, `statusEvents`). */
  private clearEvents(): void {
    if (this.journalEvents.length > 0) this.journalEvents = [];
    if (this.actionEvents.length > 0) this.actionEvents = [];
    if (this.statusEvents.length > 0) this.statusEvents = [];
  }

  /** Before a conversation input changes the world: fresh journal events and noise list for shells and the next tick. */
  private beginInput(): void {
    this.conversationVersion++;
    this.ctx.tick = this.tick;
    this.clearEvents();
    if (!this.noiseCarry) {
      this.pendingCount = 0;
      this.noiseCarry = true;
    }
  }

  /** The visible choices of the open conversation's node with their verdicts (definition order). */
  private visibleChoices(c: Conversation): { choice: DialogueChoiceDef; verdict: ConversationChoice }[] {
    const ctx = this.bindTalk(c.npc);
    const once = this.dialogueOnce[c.dialogue.index]!;
    const inv = this.player.inv;
    const items = this.def.items;
    const out: { choice: DialogueChoiceDef; verdict: ConversationChoice }[] = [];
    for (const choice of c.dialogue.nodes[c.node]!.choices) {
      if (choice.once && once.has(choice.id)) continue;
      if (choice.whenFn && !choice.whenFn(ctx)) {
        if (choice.unavailable !== null) out.push({ choice, verdict: { text: choice.text, ok: false, reason: 'cannot_act', unavailable: choice.unavailable } });
        continue;
      }
      const missing: MissingItem[] = [];
      for (const r of choice.consume) {
        const lack = r.count - (inv ? countOf(inv, r.item) : 0);
        if (lack > 0) missing.push({ item: items[r.item]!.id, label: items[r.item]!.label, count: lack });
      }
      out.push({ choice, verdict: missing.length ? { text: choice.text, ok: false, reason: 'missing', missing } : { text: choice.text, ok: true } });
    }
    return out;
  }

  /**
   * Apply choice `n` of the open conversation's visible choices (as in
   * `conversationView`), synchronously: re-check `when` and `consume`, then
   * remove `consume`, add `give` (overflow to the ground pile at the
   * player's cell), run `effects`, record `once`, and enter the `to` node
   * (running its effects) or end the conversation. A failed check changes
   * nothing.
   */
  choose(n: number): ConversationRecord {
    const c = this.conversation;
    if (!c) return { ok: false, reason: 'no_conversation' };
    this.beginInput();
    // `when` is checked like the view checks it: `random` draws from a throwaway copy.
    const picked = Number.isInteger(n) ? this.pure(() => this.visibleChoices(c))[n] : undefined;
    if (!picked) return { ok: false, reason: 'invalid_choice' };
    if (!picked.verdict.ok) return { ok: false, reason: picked.verdict.reason === 'missing' ? 'missing' : 'cannot_act' };
    const choice = picked.choice;
    const p = this.player;
    for (const r of choice.consume) remove(p.inv!, r.item, r.count, this.itemWeights[r.item]!);
    for (const g of choice.give) this.giveItem(p, g.item, g.count);
    if (choice.consume.length > 0 || choice.give.length > 0) this.containerVersion++;
    if (choice.effects.length > 0) {
      this.bindTalk(c.npc);
      this.runEffects(p, choice.effects);
    }
    if (choice.once) this.dialogueOnce[c.dialogue.index]!.add(choice.id);
    if (!choice.auto) c.entries = 0;
    if (choice.to === DIALOGUE_END) {
      this.endConversation();
      return { ok: true };
    }
    const error = this.enterNode(choice.to);
    return error ? { ok: false, reason: 'runtime_error', error } : { ok: true };
  }

  /** End the open conversation, unless its node has `leave: false`. */
  leaveConversation(): ConversationRecord {
    const c = this.conversation;
    if (!c) return { ok: false, reason: 'no_conversation' };
    this.beginInput();
    if (!c.dialogue.nodes[c.node]!.leave) return { ok: false, reason: 'cannot_leave' };
    this.endConversation();
    return { ok: true };
  }

  /**
   * The open conversation as a view model, or null: the speaker, the text,
   * whether the player may leave, and the visible choices (hidden: a falsy
   * `when` without `unavailable`, or a `once` choice already chosen).
   * Pure: draws no RNG and does not change `hash()`.
   */
  conversationView(): ConversationView | null {
    const c = this.conversation;
    if (!c) return null;
    return this.pure(() => {
      const node = c.dialogue.nodes[c.node]!;
      const s = node.speaker;
      const speaker = s.kind === 'name' ? s.name : s.kind === 'npc' ? c.npc.archetype.label : this.player.archetype.label;
      const choices = this.visibleChoices(c).map((v) => v.verdict);
      return { npc: c.npc.id, speaker, text: node.text, leave: node.leave, choices };
    });
  }

  /** The `talk` interaction with `npc` (inside `pure`): `ok` from its dialogue's `when`. */
  private talkInteraction(npc: Entity): Interaction {
    const p = this.player;
    const d = this.def.dialogues[npc.archetype.dialogue!]!;
    const ok = !d.whenFn || !!d.whenFn(this.bindTalk(npc));
    const base = {
      id: `talk:${npc.id}`,
      label: `Talk to ${npc.archetype.label}`,
      kind: 'talk' as const,
      action: { kind: 'talk' as const, entity: npc.id },
      entity: npc.id,
      inReach: this.grid.reaches(p.x, p.y, p.z, npc.x, npc.y, npc.z),
    };
    return ok ? { ...base, ok: true } : { ...base, ok: false, reason: 'cannot_act', ...(d.unavailable ? { unavailable: d.unavailable } : {}) };
  }

  /** Take one step on the entity's floor if allowed (the caller has already turned to face it); records the step for rendering. */
  private move(e: Entity, dx: number, dy: number): boolean {
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || !this.grid.canStep(e.x, e.y, dx, dy, e.z)) return false;
    e.fromX = e.x;
    e.fromY = e.y;
    e.fromZ = e.z;
    e.stepTick = this.tick + 1;
    e.x += dx;
    e.y += dy;
    e.moveCooldown = e.archetype.ticksPerStep;
    this.reindex(e);
    return true;
  }

  /** Cross the link at the entity's cell one floor in direction `dz` if it is open: one step, no turn. */
  private climb(e: Entity, dz: number): boolean {
    if ((dz !== 1 && dz !== -1) || this.grid.link(this.grid.index(e.x, e.y, e.z), dz) < 0) return false;
    e.fromX = e.x;
    e.fromY = e.y;
    e.fromZ = e.z;
    e.stepTick = this.tick + 1;
    e.z += dz;
    e.moveCooldown = e.archetype.ticksPerStep;
    this.reindex(e);
    return true;
  }

  /**
   * The goto that crosses the link at the player's cell one floor in
   * direction `dz` (for the climb keys), or null when there is none.
   */
  climbIntent(dz: 1 | -1): GotoIntent | null {
    const p = this.player;
    if (this.grid.link(this.grid.index(p.x, p.y, p.z), dz) < 0) return null;
    return { kind: 'goto', x: p.x, y: p.y, z: p.z + dz };
  }

  /** Resolved max of a measurement for an entity (Infinity if unbounded). */
  maxOf(e: Entity, md: MeasurementDef): number {
    if (!md.maxFn) return md.maxConst;
    this.ctx.self = e;
    return Number(md.maxFn(this.ctx));
  }

  /**
   * A status's `rates` on an entity's measurements, evaluated now (expression
   * rates for that entity at the current tick); rates on measurements the
   * entity lacks are skipped. Pure: draws no RNG and does not change `hash()`.
   */
  statusRatesOf(e: Entity, status: number): { measurement: number; rate: number }[] {
    const has = this.hasM[e.archetype.index]!;
    return this.pure(() => {
      this.ctx.self = e;
      return this.def.statuses[status]!.rates
        .filter((r) => has[r.measurement] === 1)
        .map((r) => ({ measurement: r.measurement, rate: r.fn ? Number(r.fn(this.ctx)) : r.constant }));
    });
  }

  private clamp(e: Entity): void {
    const ms = this.def.measurements;
    for (const idx of e.archetype.measurements) {
      const md = ms[idx]!;
      let v = e.m[idx]!;
      const max = this.maxOf(e, md);
      e.max[idx] = max;
      if (v > max) v = max;
      if (v < md.min) v = md.min;
      e.m[idx] = v;
    }
  }

  /** Measurement value by qualified id (undefined if the entity lacks it). */
  value(e: Entity, measurementId: string): number | undefined {
    const idx = this.def.ids.measurements[measurementId];
    if (idx === undefined || !e.archetype.measurements.includes(idx)) return undefined;
    return e.m[idx];
  }

  snapshot(): WorldSnapshot {
    const ms = this.def.measurements;
    const items = this.def.items;
    return {
      tick: this.tick,
      rng: this.rng.state,
      seed: this.seed,
      player: this.player.id,
      nextContainer: this.nextContainerId,
      actions: [...this.actions],
      lastAction: this.lastAction,
      defeat: this.defeat,
      victory: this.victory,
      entities: this.entities.map((e) => ({
        id: e.id,
        archetype: e.archetype.id,
        x: e.x,
        y: e.y,
        z: e.z,
        facing: e.facing,
        fromX: e.fromX,
        fromY: e.fromY,
        fromZ: e.fromZ,
        stepTick: e.stepTick,
        moveCooldown: e.moveCooldown,
        path: e.path ? [...e.path.subarray(e.pathPos)].map((i) => this.cellTriple(i)) : null,
        measurements: Object.fromEntries(e.archetype.measurements.map((idx) => [ms[idx]!.id, e.m[idx]!])),
        statuses: this.def.statuses.filter((s) => e.st[s.index] === 1).map((s) => s.id),
        intent: e.intent,
        lastGoto: e.lastGoto,
        home: [e.homeX, e.homeY, e.homeZ],
        behavior: e.behavior
          ? { state: e.behavior.states[e.state]!.name, since: e.stateTick, plan: e.planTick >= 0 ? [e.planX, e.planY, e.planZ, e.planTick] : null }
          : null,
        heard: e.heardTick >= 0 ? { x: e.heardX, y: e.heardY, z: e.heardZ, tick: e.heardTick } : null,
        activity: e.activity ? this.activitySnapshot(e.activity) : null,
        then: e.then,
        ...this.firedSnapshot(e),
      })),
      containers: [...this.containers.values()].map((c) => {
        const out: ContainerSnapshot = { id: c.id, kind: c.kind, stacks: c.stacks.map((s): [string, number] => [items[s.item]!.id, s.count]) };
        if (c.kind === 'inventory') out.owner = c.owner;
        else out.cell = [c.x, c.y, c.z];
        return out;
      }),
      tiles: [...this.grid.changed].sort((a, b) => a[0] - b[0]).map(([i, t]): [number, number, number, string] => [...this.cellTriple(i), this.def.tiles[t]!.id]),
      edges: [...this.grid.changedEdges]
        .sort((a, b) => a[0] - b[0])
        .map(([key, t]): [number, number, number, EdgeSide, string | null] => {
          const { i, side } = edgeOfKey(key);
          return [...this.cellTriple(i), side, t === EMPTY_TILE ? null : this.def.tiles[t]!.id];
        }),
      vars: Object.fromEntries(this.def.vars.map((v) => [v.id, this.vars[v.index]!])),
      quests: this.def.quests
        .filter((q) => this.questStage[q.index]! >= 0)
        .map((q) => ({ quest: q.id, stage: q.stages[this.questStage[q.index]!]!.name, since: this.questSince[q.index]!, ended: this.questEnd[q.index] !== 0 })),
      journal: this.journalLog.map((j) => ({ entry: this.def.journal[j.entry]!.id, tick: j.tick })),
      conversation: this.conversation
        ? { npc: this.conversation.npc.id, dialogue: this.conversation.dialogue.id, node: this.conversation.dialogue.nodes[this.conversation.node]!.name, entries: this.conversation.entries }
        : null,
      dialogueOnce: this.def.dialogues.flatMap((d) => [...this.dialogueOnce[d.index]!].map((id): [string, string] => [d.id, id])).sort(byPair),
      reputation: Object.fromEntries(this.def.factions.map((f) => [f.id, this.reputation[f.index]!])),
    };
  }

  /**
   * The journal as a view model: the started quests that are not hidden,
   * plus the ended hidden ones (active first, then newest change first;
   * definition order breaks ties), and the added entries in the order added.
   * Pure: draws no RNG and does not change `hash()`.
   */
  journal(): JournalView {
    const quests: JournalQuest[] = [];
    for (const q of this.def.quests) {
      const s = this.questStage[q.index]!;
      const end = this.questEnd[q.index]!;
      if (s < 0 || (q.hidden && end === 0)) continue;
      const stage = q.stages[s]!;
      quests.push({ quest: q.id, title: q.title, stage: stage.name, text: stage.journal, state: end === 1 ? 'success' : end === 2 ? 'failure' : 'active', since: this.questSince[q.index]! });
    }
    quests.sort((a, b) => Number(b.state === 'active') - Number(a.state === 'active') || b.since - a.since);
    const entries = this.journalLog.map((j): JournalItem => {
      const e = this.def.journal[j.entry]!;
      return { entry: e.id, text: e.text, category: e.category, tick: j.tick };
    });
    const standing = this.def.factions
      .filter((f) => !f.hidden)
      .map((f): JournalStanding => {
        const value = this.reputation[f.index]!;
        return { faction: f.id, label: f.label, value, tier: tierOf(f, value) };
      });
    return { quests, entries, standing };
  }

  /**
   * How an NPC's faction regards the player: its label, the tier of the
   * player's standing, and whether it is hostile or friendly. Null for the
   * player and for an NPC without a faction. Pure.
   */
  attitudeOf(entity: Entity): AttitudeView | null {
    if (entity === this.player || entity.faction < 0) return null;
    const f: FactionDef = this.def.factions[entity.faction]!;
    const v = attitude(this.factionTable, this.player, entity, this.player);
    return { faction: f.id, label: f.label, tier: tierOf(f, v), hostile: v < f.hostileBelow, friendly: v >= f.friendlyFrom };
  }

  /** [x, y, z] of a cell index. */
  private cellTriple(i: number): [number, number, number] {
    const { x, y, z } = this.grid.cellOf(i);
    return [x, y, z];
  }

  /** `{ fired: [...] }` for the `once` systems that have fired for `e` (sorted by qualified id), or `{}` when none. */
  private firedSnapshot(e: Entity): { fired?: string[] } {
    if (!e.fired) return {};
    const ids: string[] = [];
    for (const s of this.def.systems) if (s.once && e.fired[s.onceIndex] === 1) ids.push(s.id);
    return ids.length > 0 ? { fired: ids.sort() } : {};
  }

  private activitySnapshot(a: Activity): ActivitySnapshot {
    const s = a.source;
    return {
      kind: s.kind,
      ...(s.action >= 0 ? { action: this.def.actions[s.action]!.id } : {}),
      ...(s.item >= 0 ? { item: this.def.items[s.item]!.id } : {}),
      ...(s.recipe >= 0 ? { recipe: this.def.recipes[s.recipe]!.id } : {}),
      x: a.x,
      y: a.y,
      z: a.z,
      ...(a.side ? { side: a.side } : {}),
      startTick: a.startTick,
      endTick: a.endTick,
    };
  }

  /**
   * Run a query without side effects: `random` draws from a throwaway copy
   * of the RNG and warnings are dropped, so `hash()` never changes.
   */
  private pure<T>(fn: () => T): T {
    const ctx = this.ctx;
    const { random, warn } = ctx;
    const rng = new Rng(this.rng.state);
    ctx.random = () => rng.next();
    ctx.warn = () => {};
    ctx.tick = this.tick;
    try {
      return fn();
    } finally {
      ctx.random = random;
      ctx.warn = warn;
    }
  }

  /** `ok`, `reason`, `missing` and `unavailable` of a source checked for the player on (x, y, z) (its edge on `side`). */
  private verdict(s: ActivitySource, x: number, y: number, z: number, skipReach: boolean, side: EdgeSide | null = null): Pick<AvailableAction, 'ok' | 'reason' | 'missing' | 'unavailable'> {
    const p = this.player;
    const reason = this.runner.check(s, p, x, y, z, skipReach, side);
    if (!reason) return { ok: true };
    if (reason === 'missing') {
      const items = this.def.items;
      const missing: MissingItem[] = [];
      for (const r of s.requires) {
        const lack = r.count - countOf(p.inv!, r.item);
        if (lack > 0) missing.push({ item: items[r.item]!.id, label: items[r.item]!.label, count: lack });
      }
      return { ok: false, reason, missing };
    }
    const unavailable =
      reason !== 'cannot_act' ? null : s.action >= 0 ? this.def.actions[s.action]!.unavailable : s.recipe >= 0 ? this.def.recipes[s.recipe]!.unavailable : null;
    return unavailable ? { ok: false, reason, unavailable } : { ok: false, reason };
  }

  /** `duration` and `uses` of a source for the player on (x, y, z) (its edge on `side`; inside `pure`). */
  private details(s: ActivitySource, x: number, y: number, z: number, side: EdgeSide | null = null): Pick<Interaction, 'duration' | 'uses'> {
    const out: { duration?: number; uses?: MissingItem[] } = {};
    const ticks = this.runner.durationTicks(s, this.player, x, y, z, side);
    if (ticks !== null) out.duration = ticks / this.def.ticksPerSecond;
    if (s.consume.length > 0) {
      const items = this.def.items;
      out.uses = s.consume.map((c) => ({ item: items[c.item]!.id, label: items[c.item]!.label, count: c.count }));
    }
    return out;
  }

  /**
   * Everything the player could start now: every `self` action, every tile
   * action on each matching cell in reach (on the player's floor, row-major)
   * and then on each matching edge in reach (`edgesInReach` order), then each
   * inventory stack with a `use`. Entries that match but fail on items, the
   * inventory or `when` are included with `ok: false`. Pure: `random` in a
   * `when` draws from a throwaway copy of the RNG, so `hash()` never changes.
   */
  availableActions(): AvailableAction[] {
    const p = this.player;
    return this.pure(() => {
      const out: AvailableAction[] = [];
      for (const s of this.actionSources) {
        if (s.filter) continue;
        out.push({ kind: 'act', action: this.def.actions[s.action]!.id, label: s.label, ...this.verdict(s, p.x, p.y, p.z, false) });
      }
      const z = p.z;
      for (const s of this.actionSources) {
        if (!s.filter) continue;
        for (let y = p.y - 1; y <= p.y + 1; y++) {
          for (let x = p.x - 1; x <= p.x + 1; x++) {
            if (!this.matches(s, x, y, z)) continue;
            const v = this.verdict(s, x, y, z, false);
            if (v.reason === 'out_of_reach' || v.reason === 'invalid_target') continue;
            out.push({ kind: 'act', action: this.def.actions[s.action]!.id, x, y, z, label: s.label, ...v });
          }
        }
        for (const [x, y, side] of this.edgesInReach()) {
          if (!this.matches(s, x, y, z, side)) continue;
          const v = this.verdict(s, x, y, z, false, side);
          if (v.reason === 'out_of_reach' || v.reason === 'invalid_target') continue;
          out.push({ kind: 'act', action: this.def.actions[s.action]!.id, x, y, z, side, label: s.label, ...v });
        }
      }
      for (const st of p.inv?.stacks ?? []) {
        const s = this.useSources[st.item];
        if (s) out.push({ kind: 'use', item: this.def.items[st.item]!.id, label: s.label, ...this.verdict(s, p.x, p.y, p.z, false) });
      }
      return out;
    });
  }

  /** Whether (x, y, z) is in bounds and holds a tile (or an edge on `side`) matching a tile-targeted source's filter. */
  private matches(s: ActivitySource, x: number, y: number, z: number, side: EdgeSide | null = null): boolean {
    const { grid } = this;
    if (!grid.inBounds(x, y, z)) return false;
    const i = grid.index(x, y, z);
    const t = side === 'n' ? grid.edgeN[i]! : side === 'w' ? grid.edgeW[i]! : grid.cells[i]!;
    return t !== EMPTY_TILE && s.filter![t] === 1;
  }

  /**
   * The edges the player can reach (in bounds), as [x, y, side]: the four
   * sides of its cell — north (`n` of its cell), west (`w` of its cell),
   * east (`w` of the cell to its right), south (`n` of the cell below).
   */
  edgesInReach(): [number, number, EdgeSide][] {
    const { x, y, z } = this.player;
    const g = this.grid;
    const out: [number, number, EdgeSide][] = [
      [x, y, 'n'],
      [x, y, 'w'],
      [x + 1, y, 'w'],
      [x, y + 1, 'n'],
    ];
    return out.filter(([ex, ey]) => g.inBounds(ex, ey, z));
  }

  /** First cell in the player's reach (its floor, row-major, `Grid.reaches`) matching a station source's filter, or null. */
  private stationCell(s: ActivitySource): { x: number; y: number; z: number } | null {
    const p = this.player;
    for (let y = p.y - 1; y <= p.y + 1; y++) {
      for (let x = p.x - 1; x <= p.x + 1; x++) {
        if (this.matches(s, x, y, p.z) && this.grid.reaches(p.x, p.y, p.z, x, y, p.z)) return { x, y, z: p.z };
      }
    }
    return null;
  }

  /**
   * Every recipe, in definition order, for the crafting panel. A station
   * recipe is checked at its first matching cell in reach (row-major, as
   * `station`); with none it is `ok: false, reason: 'out_of_reach'`. Pure,
   * like `availableActions`.
   */
  availableRecipes(): AvailableRecipe[] {
    const p = this.player;
    return this.pure(() =>
      this.recipeSources.map((s): AvailableRecipe => {
        const r = this.def.recipes[s.recipe]!;
        const base = { recipe: r.id, label: r.label, verb: r.verb, category: r.category };
        if (!s.filter) return { ...base, ...this.verdict(s, p.x, p.y, p.z, false) };
        const at = this.stationCell(s);
        if (!at) return { ...base, ok: false, reason: p.inv ? 'out_of_reach' : 'no_inventory' };
        return { ...base, ...this.verdict(s, at.x, at.y, at.z, false), station: at };
      }),
    );
  }

  /**
   * What the player can choose at a cell (floor `z`, default the player's),
   * ignoring reach: first a `talk` per NPC with a dialogue on the cell (id
   * order; `ok` from the dialogue's `when`), then the tile actions whose filter matches the cell's tile
   * (definition order), the recipes whose station matches it (definition
   * order), `open` and (when not empty) `take_all` per container on the
   * cell, `Go up` / `Go down` when the cell has an open link that way, the
   * `self` actions on the player's own cell, then `walk` on any other
   * walkable cell. `[]` out of bounds or once the game has ended. `act` and
   * `craft` entries carry their `duration` and `uses`. Pure, like
   * `availableActions`.
   *
   * With `side`, the target is the edge on that side of the cell: only the
   * tile actions whose filter matches its tile (`[]` where there is no
   * edge), in reach from either cell it separates.
   */
  interactionsAt(x: number, y: number, z: number = this.player.z, side: EdgeSide | null = null): Interaction[] {
    const { grid, player: p } = this;
    if (!grid.inBounds(x, y, z) || this.ended) return [];
    if (side) return this.edgeInteractions(x, y, z, side);
    const inReach = grid.reaches(p.x, p.y, p.z, x, y, z);
    const own = x === p.x && y === p.y && z === p.z;
    return this.pure(() => {
      const out: Interaction[] = [];
      for (const e of this.entitiesNear(x, y, z, 0)) if (e !== p && e.archetype.dialogue !== null) out.push(this.talkInteraction(e));
      const tile = grid.cells[grid.index(x, y, z)]!;
      if (tile !== EMPTY_TILE) {
        for (const s of this.actionSources) {
          if (!s.filter || s.filter[tile] !== 1) continue;
          const id = this.def.actions[s.action]!.id;
          out.push({ id: `act:${id}`, label: s.label, kind: 'act', ...this.verdict(s, x, y, z, true), action: { kind: 'act', action: id, x, y, z }, inReach, ...this.details(s, x, y, z) });
        }
        for (const s of this.recipeSources) {
          if (!s.filter || s.filter[tile] !== 1) continue;
          const id = this.def.recipes[s.recipe]!.id;
          out.push({ id: `craft:${id}`, label: s.label, kind: 'craft', ...this.verdict(s, x, y, z, true), action: { kind: 'craft', recipe: id, x, y, z }, inReach, ...this.details(s, x, y, z) });
        }
      }
      for (const c of this.containersAt(x, y, z)) {
        const label = c.kind === 'tile' ? this.def.tiles[c.tile]!.label : GROUND_LABEL;
        out.push({ id: `open:${c.id}`, label: `Open ${label}`, kind: 'open', ok: true, container: c.id, inReach });
        if (c.stacks.length === 0) continue;
        const actions = c.stacks.map((st): Action => ({ kind: 'take', container: c.id, item: this.def.items[st.item]!.id }));
        const inv = p.inv;
        const reason: ActionFailure | null = !inv ? 'no_inventory' : c.stacks.some((st) => fits(inv, this.itemWeights[st.item]!, 1) > 0) ? null : 'too_heavy';
        const base = { id: `take_all:${c.id}`, label: `Take all from ${label}`, kind: 'take_all' as const, action: actions[0]!, actions, container: c.id, inReach };
        out.push(reason ? { ...base, ok: false, reason } : { ...base, ok: true });
      }
      const i = grid.index(x, y, z);
      for (const dz of [1, -1] as const) {
        if (grid.link(i, dz) < 0) continue;
        const intent: GotoIntent = { kind: 'goto', x, y, z: z + dz };
        out.push({ id: dz > 0 ? 'climb:up' : 'climb:down', label: dz > 0 ? 'Go up' : 'Go down', kind: 'climb', ok: true, intent, inReach: false });
      }
      if (own) {
        for (const s of this.actionSources) {
          if (s.filter) continue;
          const id = this.def.actions[s.action]!.id;
          out.push({ id: `act:${id}`, label: s.label, kind: 'act', ...this.verdict(s, x, y, z, true), action: { kind: 'act', action: id }, inReach: true, ...this.details(s, x, y, z) });
        }
      } else if (grid.walkable(x, y, z)) {
        out.push({ id: 'walk', label: 'Walk here', kind: 'walk', ok: true, inReach: false });
      }
      return out;
    });
  }

  /** `interactionsAt` for the edge on `side` of (x, y, z) (in bounds, game not ended). */
  private edgeInteractions(x: number, y: number, z: number, side: EdgeSide): Interaction[] {
    const { grid, player: p } = this;
    const i = grid.index(x, y, z);
    const tile = side === 'n' ? grid.edgeN[i]! : grid.edgeW[i]!;
    if (tile === EMPTY_TILE) return [];
    const inReach = grid.reachesEdge(p.x, p.y, p.z, x, y, z, side);
    return this.pure(() => {
      const out: Interaction[] = [];
      for (const s of this.actionSources) {
        if (!s.filter || s.filter[tile] !== 1) continue;
        const id = this.def.actions[s.action]!.id;
        out.push({
          id: `act:${id}`,
          label: s.label,
          kind: 'act',
          ...this.verdict(s, x, y, z, true, side),
          action: { kind: 'act', action: id, x, y, z, side },
          inReach,
          ...this.details(s, x, y, z, side),
        });
      }
      return out;
    });
  }

  /**
   * The intent a shell should queue to do `action`, or null when it is
   * already in reach or needs none (`self` acts, recipes without a station
   * or cell, `use`, `drop`, and actions on unknown targets: the shell queues
   * those directly). Otherwise a goto to the target cell (adjacent when it
   * is not walkable; next to the edge for an edge target; next to the NPC's
   * current cell for a `talk`) that queues the action on arrival. An NPC
   * that moves away meanwhile is not followed: the talk then fails with
   * `out_of_reach`.
   */
  approachIntent(action: Action): GotoIntent | null {
    const p = this.player;
    if (action.kind === 'talk') {
      const npc = Number.isInteger(action.entity) ? this.entities[action.entity] : undefined;
      if (!npc || npc === p || npc.archetype.dialogue === null || this.grid.reaches(p.x, p.y, p.z, npc.x, npc.y, npc.z)) return null;
      return { kind: 'goto', x: npc.x, y: npc.y, z: npc.z, adjacent: true, then: action };
    }
    let x: number;
    let y: number;
    let z: number;
    if (action.kind === 'act' && action.side && Number.isInteger(action.x) && Number.isInteger(action.y)) {
      const s = this.actionSources[this.def.ids.actions[action.action] ?? -1];
      if (!s?.filter) return null;
      z = action.z ?? p.z;
      if (this.grid.reachesEdge(p.x, p.y, p.z, action.x!, action.y!, z, action.side)) return null;
      return { kind: 'goto', x: action.x!, y: action.y!, z, side: action.side, then: action };
    }
    if (action.kind === 'take' || action.kind === 'put') {
      const c = this.containers.get(action.container);
      if (!c || c.kind === 'inventory') return null;
      ({ x, y, z } = c);
    } else if (action.kind === 'act' || action.kind === 'craft') {
      const s = action.kind === 'act' ? this.actionSources[this.def.ids.actions[action.action] ?? -1] : this.recipeSources[this.def.ids.recipes[action.recipe] ?? -1];
      if (!s?.filter || !Number.isInteger(action.x) || !Number.isInteger(action.y)) return null;
      x = action.x!;
      y = action.y!;
      z = action.z ?? p.z;
    } else return null;
    if (this.grid.reaches(p.x, p.y, p.z, x, y, z)) return null;
    return { kind: 'goto', x, y, z, adjacent: !this.grid.walkable(x, y, z), then: action };
  }

  /** The entity's activity (the player's by default): its progress text and how far along it is, or null. */
  activityProgress(e: Entity = this.player): ActivityProgress | null {
    const fraction = ActivityRunner.fraction(e, this.tick);
    return fraction === null ? null : { label: e.activity!.source.progress, fraction };
  }

  hash(): string {
    return fnv1a(JSON.stringify(this.snapshot()));
  }
}
