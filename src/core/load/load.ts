/**
 * Pack loader pipeline:
 *   parse YAML → collect raw entries per pack → qualify ids → symbol table →
 *   resolve references → compile expressions → freeze.
 * Every stage reports into one ErrorSink; nothing is returned unless the
 * whole set of packs is valid.
 */

import { DEFAULT_CLOCK, parseTimeOfDay, type ClockDef } from '../clock.ts';
import {
  TICKS_PER_SECOND,
  secondsToTicks,
  type ActionDef,
  type ArchetypeDef,
  type AssetDef,
  type AssetImage,
  type ActivityKind,
  type BehaviorDef,
  type BehaviorStateDef,
  type ContainerSpec,
  DIALOGUE_END,
  type DialogueChoiceDef,
  type DialogueDef,
  type DialogueNodeDef,
  type DialogueSpeaker,
  type DialogueStartDef,
  EMPTY_TILE,
  MAX_DIALOGUE_CHOICES,
  type OutcomeDef,
  type DistributionDef,
  type DurationDef,
  type InventorySpec,
  type ItemCount,
  type ItemDef,
  type ItemUseDef,
  type JournalEntryDef,
  type QuestDef,
  type QuestStageDef,
  type VarDef,
  type LootEntryDef,
  type LootTableDef,
  type Definition,
  type EffectDef,
  type LightingDef,
  type MapDef,
  type MeasurementDef,
  type NumberTerm,
  type PackInfo,
  type PopulateDef,
  populateCandidates,
  DEFAULT_SIMULATION,
  type SimulationDef,
  type RecipeDef,
  type RoomDef,
  type RoomsDef,
  type SpawnDef,
  type StatusDef,
  type StatusRate,
  type SystemDef,
  type TileDef,
  type TileFilterDef,
  type TintKeyframe,
  type TransitionDef,
} from '../definition.ts';
import { CARDINALS, FACINGS, MIRROR, facingTable, isDiagonal, isFacing, type Facing } from '../facing.ts';
import { compileSource, isPointType, nearMiss, type Compiled, type CompiledExpr } from '../expr/index.ts';
import { at, ErrorSink, formatPath, lineOf, PackLoadError, type LoadError, type Src } from './errors.ts';
import { ID_RE, isObject, parsePack, type Json, type ListDomain, type PackSource, type RawPack } from './pack.ts';
import { applyPatches, type Defined, type LoadedPack, type Merged } from './patch.ts';
import { SymbolTable, type Scope } from './resolve.ts';
import { normalizePath, readTiledMap, type TiledMap } from './tiled.ts';
import { Fields } from './validate.ts';

export type LoadResult =
  | { ok: true; definition: Definition; warnings: readonly LoadError[] }
  | { ok: false; errors: readonly LoadError[]; warnings: readonly LoadError[] };

const DEFAULT_TICKS_PER_STEP = 2;
const DEFAULT_TICKS_PER_TURN = 1;
const DEFAULT_ANCHOR: readonly [number, number] = [0.5, 1];
const ASSET_EXT_RE = /\.(svg|png)$/;
const ASCII_MAP_FIELDS = ['legend', 'rows', 'floors', 'rooms', 'edges'] as const;
/** Fields only a composite map takes (`rooms` and `populate` are shared). */
const COMPOSITE_MAP_FIELDS = ['size', 'fill', 'parts', 'player'] as const;
const MAP_FIELDS = ['id', 'tiled', ...ASCII_MAP_FIELDS, ...COMPOSITE_MAP_FIELDS, 'populate', 'spawns'];
const isComposite = (v: { [k: string]: unknown }): boolean => COMPOSITE_MAP_FIELDS.some((k) => v[k] !== undefined);
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_EVERY = 1 / TICKS_PER_SECOND;
const DEFAULT_DEFEAT_MESSAGE = 'Game over';
const DEFAULT_VICTORY_MESSAGE = 'Victory';
const EFFECT_FIELDS: Record<EffectDef['type'], string> = {
  apply: 'delta',
  set: 'value',
  noise: 'radius',
  set_tile: 'tile',
  set_var: 'value',
  add_var: 'delta',
  quest: 'stage',
  journal: 'entry',
};
const DEFAULT_JOURNAL_CATEGORY = 'Notes';
const QUEST_ENDS = ['success', 'failure'] as const;
const NO_DURATION: DurationDef = { ticks: 0, fn: null };
const DEFAULT_USE_LABEL = 'Use';
const DEFAULT_RECIPE_VERB = 'Craft';
const DEFAULT_RECIPE_CATEGORY = 'General';
const NPC_SPEAKER: DialogueSpeaker = { kind: 'npc' };
/** The choice a node without `choices` or `next` gets: it ends the conversation. */
const LEAVE_CHOICE: DialogueChoiceDef = { text: 'Leave', to: DIALOGUE_END, whenFn: null, unavailable: null, consume: [], give: [], effects: [], once: false, id: '', auto: false };
const CONTINUE_TEXT = 'Continue';
const ACTIVITIES: readonly ActivityKind[] = ['idle', 'wander', 'pursue', 'flee', 'home', 'investigate'];
const DEFAULT_REPATH = 1;
const always = (): boolean => true;

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

class Loader {
  readonly sink = new ErrorSink();
  readonly symbols = new SymbolTable();
  defined!: Record<ListDomain, Defined[]>;
  packs: LoadedPack[] = [];
  /** The merged singletons (null when no pack defines them). */
  private singletons!: { start: Merged | null; clock: Merged | null; lighting: Merged | null };
  private patches: Definition['patches'] = [];
  /** Per map index: the read Tiled map, null after an error, undefined for ASCII maps. */
  private readonly tiledMaps: (TiledMap | null | undefined)[] = [];
  /** Every room tag used by a map, in first-seen order (collected before any expression compiles). */
  roomTags: string[] = [];
  /** Source of each resolved loot entry, per table (parallel to `LootTableDef.entries`). */
  private readonly lootEntrySrc: Src[][] = [];
  /** Built tiles (for `set_tile` checks), set before any effect list is read. */
  private tileDefs: readonly TileDef[] = [];
  /** Stage ids per quest index, read from the (merged) entries before any expression compiles. */
  private stageNames: string[][] = [];
  /** Quest indices that some `quest` effect names (a quest without `when` stages needs one). */
  private readonly questTargets = new Set<number>();
  /** Set while a dialogue is read: `npc` and `on: npc` are only valid there. */
  private inDialogue = false;

  run(sources: readonly PackSource[]): LoadResult {
    this.parsePacks(sources);
    this.applyPatches();
    this.readTiledMaps();
    this.collectRoomTags();
    this.collectStageNames();
    const measurements = this.defined.measurements.map((d) => this.measurement(d));
    const assets = this.defined.assets.map((d) => this.asset(d));
    const items = this.defined.items.map((d) => this.item(d));
    const tiles = this.defined.tiles.map((d) => this.tile(d));
    this.tileDefs = tiles;
    const archetypes = this.defined.archetypes.map((d) => this.archetype(d, measurements, items));
    // Composites read their parts, so every plain map is built first.
    const maps: MapDef[] = [];
    for (const d of this.defined.maps) if (!isComposite(d.entry.value)) maps[d.index] = this.map(d);
    for (const d of this.defined.maps) if (isComposite(d.entry.value)) maps[d.index] = this.compositeMap(d, maps);
    const loot = this.defined.loot.map((d) => this.lootTable(d));
    this.checkLootCycles(loot);
    const distributions = this.distributions(tiles, loot, items);
    const statuses = this.defined.statuses.map((d) => this.status(d));
    const systems = this.defined.systems.map((d) => this.system(d));
    const behaviors = this.defined.behaviors.map((d) => this.behavior(d));
    const actions = this.defined.actions.map((d) => this.action(d, tiles));
    const recipes = this.defined.recipes.map((d) => this.recipe(d, tiles));
    const vars = this.defined.vars.map((d) => this.worldVar(d));
    const journal = this.defined.journal.map((d) => this.journalEntry(d));
    const quests = this.defined.quests.map((d) => this.quest(d));
    const dialogues = this.defined.dialogues.map((d) => this.dialogue(d, items));
    const start = this.start(maps);
    this.checkQuestStarts(quests);
    const clock = this.clock();
    const lighting = this.lighting();
    this.checkKinds();
    const warnings = this.sink.warnings;
    if (this.sink.count > 0 || !start) return { ok: false, errors: this.sink.errors, warnings };

    const ids = (list: readonly { id: string; index: number }[]) => Object.fromEntries(list.map((d) => [d.id, d.index]));
    const definition: Definition = {
      ticksPerSecond: TICKS_PER_SECOND,
      packs: this.packs.map(
        ({ raw }): PackInfo => ({
          namespace: raw.namespace,
          name: raw.name,
          version: raw.version,
          kind: raw.kind,
          description: raw.description,
          depends: raw.depends.map((d) => d.ns),
        }),
      ),
      measurements,
      assets,
      tiles,
      archetypes,
      maps,
      systems,
      statuses,
      items,
      loot,
      behaviors,
      actions,
      recipes,
      vars,
      quests,
      journal,
      dialogues,
      distributions,
      roomTags: this.roomTags,
      start,
      clock,
      lighting,
      patches: this.patches,
      ids: {
        measurements: ids(measurements),
        assets: ids(assets),
        tiles: ids(tiles),
        archetypes: ids(archetypes),
        maps: ids(maps),
        systems: ids(systems),
        statuses: ids(statuses),
        items: ids(items),
        loot: ids(loot),
        behaviors: ids(behaviors),
        actions: ids(actions),
        recipes: ids(recipes),
        vars: ids(vars),
        quests: ids(quests),
        journal: ids(journal),
        dialogues: ids(dialogues),
      },
    };
    return { ok: true, definition: deepFreeze(definition), warnings };
  }

  // ── Stage 1: packs and depends ──────────────────────────────────────────

  private parsePacks(sources: readonly PackSource[]): void {
    const seen = new Set<string>();
    const closures = new Map<string, ReadonlySet<string>>();
    for (const source of sources) {
      const raw = parsePack(source, this.sink);
      if (!raw) continue;
      if (seen.has(raw.namespace)) {
        this.sink.add({ source: raw.manifest, path: ['namespace'] }, `namespace '${raw.namespace}' is already loaded by an earlier pack`);
        continue;
      }
      const depends: string[] = [];
      for (const d of raw.depends) {
        if (d.ns === raw.namespace) this.sink.add(d.src, `pack '${raw.namespace}' cannot depend on itself`);
        else if (!seen.has(d.ns)) {
          this.sink.add(d.src, `unmet dependency: pack '${raw.namespace}' depends on '${d.ns}', which must be loaded before it`);
        } else depends.push(d.ns);
      }
      seen.add(raw.namespace);
      const closure = new Set(depends.flatMap((d) => [d, ...closures.get(d)!]));
      closures.set(raw.namespace, closure);
      this.packs.push({ raw, scope: { namespace: raw.namespace, depends }, closure });
    }
  }

  /**
   * Manifest `kind` against the stack: a `game` defines a base `start` (not
   * an override), a `mod` depends on something. Libraries are not checked.
   */
  private checkKinds(): void {
    for (const { raw } of this.packs) {
      const kind = { source: raw.manifest, path: ['kind'] };
      if (raw.kind === 'game' && !raw.starts.some((s) => s.value['override'] !== true)) {
        this.sink.add(kind, `pack '${raw.namespace}' is a game but defines no base 'start' (map + player); make it a 'mod' or 'library', or add a 'start'`);
      }
      if (raw.kind === 'mod' && raw.depends.length === 0) {
        this.sink.add(kind, `pack '${raw.namespace}' is a mod but has no 'depends'; list the packs it modifies, or make it a 'library'`);
      }
    }
  }

  // ── Stage 2: qualify and register ids, apply mods' patches ──────────────

  private applyPatches(): void {
    const { defined, start, clock, lighting, patches } = applyPatches(this.packs, this.symbols, this.sink);
    this.defined = defined;
    this.singletons = { start, clock, lighting };
    this.patches = patches;
  }

  /** Fields of a (possibly merged) entry: each top-level field located at the entry that wrote it. */
  private fields(d: Merged, allowed: readonly string[], what: string): Fields {
    return new Fields(this.sink, d.entry.src, d.entry.value, allowed, what, (k) => d.srcOf(k));
  }

  /** The pack whose files a path in field `key` of `d` is relative to. */
  private packOf(d: Merged, key: string): RawPack {
    const ns = d.scopeOf(key).namespace;
    return this.packs.find((p) => p.scope.namespace === ns)!.raw;
  }

  // ── Expressions ─────────────────────────────────────────────────────────

  /**
   * Compile a numeric (or boolean) expression; reports and returns null on
   * error. `what` names the expected result in the type error.
   */
  private expr(source: string, scope: Scope, src: Src, what = 'a number'): { fn: Compiled; constant?: number; selfTag?: string } | null {
    const expr = this.compile(source, scope, src);
    if (!expr) return null;
    if (expr.type !== 'number' && expr.type !== 'boolean' && expr.type !== 'any') {
      this.sink.add(src, `expression "${source}" must produce ${what}, got ${expr.type}`);
      return null;
    }
    return expr;
  }

  /** Compile an expression of any type; reports and returns null on error. */
  private compile(source: string, scope: Scope, src: Src): CompiledExpr | null {
    const resolver = (kind: 'measurement' | 'status' | 'item' | 'action' | 'var' | 'journal entry' | 'quest') => (ref: string) => {
      const r = this.symbols.resolve(kind, ref, scope);
      return 'error' in r ? r : { index: r.index };
    };
    const { expr, errors, syntax } = compileSource(source, {
      resolveMeasurement: resolver('measurement'),
      resolveStatus: resolver('status'),
      resolveItem: resolver('item'),
      resolveRoomTag: (tag) => this.roomTag(tag),
      resolveAction: resolver('action'),
      resolveVar: resolver('var'),
      resolveEntry: resolver('journal entry'),
      resolveQuest: resolver('quest'),
      resolveStage: (q, stage) => this.stage(q, stage),
      npc: this.inDialogue,
    });
    if (errors.length) {
      for (const e of errors) this.sink.add(src, `${syntax ? 'expression syntax error' : 'expression error'} in "${source}": ${e.message}`);
      return null;
    }
    return expr;
  }

  /**
   * A condition field (`for`/`when`/`until`/`defeat.when`/`victory.when`): an expression or
   * a boolean literal. Returns undefined when absent, null after an error.
   */
  private condition(f: Fields, key: string, scope: Scope, required = false): Compiled | null | undefined {
    const c = this.conditionExpr(f, key, scope, required);
    return c ? c.fn : c;
  }

  /** Like `condition`, keeping the compiled expression's metadata (`selfTag`). */
  private conditionExpr(f: Fields, key: string, scope: Scope, required = false): { fn: Compiled; selfTag?: string } | null | undefined {
    const v = f.raw(key);
    if (v === undefined || v === null) {
      if (required) f.present(key);
      return required ? null : undefined;
    }
    if (typeof v === 'boolean') return { fn: () => v };
    if (typeof v !== 'string') {
      this.sink.add(f.at(key), `field '${key}' must be an expression (string) or true/false`);
      return null;
    }
    return this.expr(v, scope, f.at(key), 'a boolean or a number') ?? null;
  }

  /** A number or numeric expression, folded to a constant when possible; null after an error. */
  private numberTerm(v: Json | undefined, key: string, scope: Scope, src: Src): NumberTerm | null {
    if (typeof v === 'number' && Number.isFinite(v)) return { constant: v, fn: null };
    if (typeof v === 'string') {
      const e = this.expr(v, scope, src);
      if (!e) return null;
      return e.constant !== undefined ? { constant: e.constant, fn: null } : { constant: 0, fn: e.fn };
    }
    this.sink.add(src, `field '${key}' must be a number or an expression`);
    return null;
  }

  /** Validate a tag list (archetype or tile). */
  private tags(f: Fields): string[] {
    const tags = f.stringList('tags');
    tags.forEach((t, i) => {
      if (!ID_RE.test(t)) this.sink.add(f.at('tags', i), `invalid tag '${t}': tags must match [a-z][a-z0-9_]*`);
    });
    return tags;
  }

  // ── Stage 3: build definitions ──────────────────────────────────────────

  private measurement(d: Defined): MeasurementDef {
    const f = this.fields(d, ['id', 'label', 'min', 'max', 'initial', 'rate'], 'measurement');
    const label = f.string('label') ?? d.id;
    const min = f.number('min', false) ?? 0;
    const initial = f.number('initial') ?? min;

    let maxConst = Infinity;
    let maxFn: Compiled | null = null;
    const max = f.raw('max');
    if (typeof max === 'number') maxConst = max;
    else if (typeof max === 'string') {
      if (/^([a-z][a-z0-9_]*:)?[a-z][a-z0-9_]*$/.test(max) && !['self', 'player', 'tile', 'world'].includes(max)) {
        // A bare measurement reference means "this entity's value of it".
        const r = this.symbols.ref('measurement', max, d.scopeOf('max'), f.at('max'), this.sink);
        if (r) {
          if (r.index === d.index) this.sink.add(f.at('max'), `measurement '${d.id}' cannot be its own max`);
          const idx = r.index;
          maxFn = (c) => c.self.m[idx]!;
        }
      } else {
        const e = this.expr(max, d.scopeOf('max'), f.at('max'));
        if (e?.constant !== undefined) maxConst = e.constant;
        else if (e) maxFn = e.fn;
      }
    } else if (max !== undefined && max !== null) {
      this.sink.add(f.at('max'), `field 'max' must be a number, a measurement id or an expression`);
    }
    if (maxConst < min) this.sink.add(f.at('max'), `max (${maxConst}) is less than min (${min})`);

    let rateConst = 0;
    let rateFn: Compiled | null = null;
    const rate = f.raw('rate');
    if (typeof rate === 'number') rateConst = rate;
    else if (typeof rate === 'string') {
      const e = this.expr(rate, d.scopeOf('rate'), f.at('rate'));
      if (e?.constant !== undefined) rateConst = e.constant;
      else if (e) rateFn = e.fn;
    } else if (rate !== undefined && rate !== null) {
      this.sink.add(f.at('rate'), `field 'rate' must be a number or an expression`);
    }

    return { id: d.id, index: d.index, label, min, maxConst, maxFn, initial, rateConst, rateFn };
  }

  private asset(d: Defined): AssetDef {
    const f = this.fields(d, ['id', 'file', 'anchor', 'directions'], 'asset');
    // The image paths are relative to the files of the pack that wrote them.
    const pack = this.packOf(d, d.entry.value['directions'] !== undefined && d.entry.value['directions'] !== null ? 'directions' : 'file');
    const anchor = this.anchor(f.raw('anchor'), f.at('anchor')) ?? DEFAULT_ANCHOR;
    const single = (file: string): AssetDef => ({
      id: d.id,
      index: d.index,
      pack: pack.namespace,
      images: [{ file, anchor }],
      ways: 1,
      byFacing: FACINGS.map(() => ({ image: 0, mirrored: false })),
    });
    if (!f.has('directions')) {
      if (!f.has('file')) {
        this.sink.add(f.src, `missing required field 'file' (or 'directions')`);
        return single('');
      }
      return single(this.assetFile(f.string('file') ?? '', f.at('file'), pack));
    }
    if (f.has('file')) {
      this.sink.add(f.src, `asset has both 'file' and 'directions'; use one or the other`);
      return single('');
    }
    const dirs = f.mapping('directions');
    if (!dirs) return single('');
    const images: AssetImage[] = [];
    const listed = new Map<Facing, number>();
    for (const [key, value] of Object.entries(dirs)) {
      const src = f.at('directions', key);
      if (!isFacing(key)) {
        const s = nearMiss(key, FACINGS);
        this.sink.add(src, `unknown direction '${key}'${s ? ` (did you mean '${s}'?)` : ''}; expected one of ${FACINGS.join(', ')}`);
        continue;
      }
      let file: string;
      let own = anchor;
      if (typeof value === 'string') file = this.assetFile(value, src, pack);
      else if (isObject(value)) {
        const df = new Fields(this.sink, src, value, ['file', 'anchor'], 'direction');
        file = this.assetFile(df.string('file') ?? '', df.at('file'), pack);
        own = this.anchor(df.raw('anchor'), df.at('anchor')) ?? anchor;
      } else {
        this.sink.add(src, `direction '${key}' must be a file path or a mapping like { file: a.svg, anchor: [0.5, 1] }`);
        continue;
      }
      let i = images.findIndex((im) => im.file === file && im.anchor[0] === own[0] && im.anchor[1] === own[1]);
      if (i < 0) i = images.push({ file, anchor: own }) - 1;
      listed.set(key, i);
    }
    if (Object.keys(dirs).length === 0) {
      this.sink.add(f.at('directions'), `'directions' must list at least one direction`);
      return single('');
    }
    const { byFacing, missing } = facingTable(listed);
    const ways = [...listed.keys()].some(isDiagonal) ? 8 : 4;
    if (listed.size > 0 && missing.length) {
      this.sink.add(
        f.at('directions'),
        `incomplete ${ways}-way directions: cannot produce ${missing.join(', ')} (a missing direction is drawn as its mirror partner: ${missing
          .map((m) => `${m}↔${MIRROR[m]}`)
          .join(', ')})`,
      );
    }
    if (images.length === 0) return single('');
    return { id: d.id, index: d.index, pack: pack.namespace, images, ways, byFacing };
  }

  /** Validates an asset file path (exists in the pack, `.svg`/`.png`); returns it normalized. */
  private assetFile(raw: string, src: Src, pack: RawPack): string {
    if (!raw) return raw;
    const file = raw.replace(/^\.\//, '');
    if (!ASSET_EXT_RE.test(file)) {
      this.sink.add(src, `unsupported asset file '${file}': must end in .svg or .png`);
    } else if (!pack.otherFiles.has(file)) {
      const base = file.slice(file.lastIndexOf('/') + 1);
      const s = nearMiss(file, pack.otherFiles) ?? [...pack.otherFiles].find((p) => p.endsWith(`/${base}`) || p === base) ?? null;
      this.sink.add(src, `asset file '${file}' not found in pack '${pack.namespace}'${s ? ` (did you mean '${s}'?)` : ''}`);
    }
    return file;
  }

  /** Optional `anchor` pair; undefined when absent or invalid (reported). */
  private anchor(a: Json | undefined, src: Src): readonly [number, number] | undefined {
    if (a === undefined || a === null) return undefined;
    if (!Array.isArray(a) || a.length !== 2 || !a.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      this.sink.add(src, `field 'anchor' must be a pair of numbers [ax, ay], got ${JSON.stringify(a)}`);
    } else if (!a.every((v) => (v as number) >= 0 && (v as number) <= 1)) {
      this.sink.add(src, `anchor ${JSON.stringify(a)} is out of range: both values must be in [0, 1]`);
    } else return [a[0] as number, a[1] as number];
    return undefined;
  }

  /** Optional `sprite` asset reference → asset index or null. */
  private sprite(f: Fields, d: Defined): number | null {
    if (!f.has('sprite')) return null;
    return this.symbols.ref('asset', f.raw('sprite'), d.scopeOf('sprite'), f.at('sprite'), this.sink)?.index ?? null;
  }

  private tile(d: Defined): TileDef {
    const f = this.fields(d, ['id', 'label', 'glyph', 'color', 'walkable', 'raised', 'opaque', 'sprite', 'tags', 'container', 'climb', 'edge'], 'tile');
    const walkable = f.boolean('walkable') ?? false;
    const edge = f.boolean('edge', false) ?? false;
    if (edge) {
      for (const k of ['container', 'climb'] as const) {
        if (f.has(k)) this.sink.add(f.at(k), `an edge tile ('edge: true') cannot take '${k}': edges are thin walls between cells, not cells`);
      }
    }
    if (d.index >= EMPTY_TILE) this.sink.add(d.entry.src, `too many tiles: at most ${EMPTY_TILE} tiles can be loaded`);
    let climb: TileDef['climb'] = null;
    const rawClimb = f.string('climb', false);
    if (rawClimb !== undefined) {
      if (rawClimb !== 'up' && rawClimb !== 'down') this.sink.add(f.at('climb'), `field 'climb' must be 'up' or 'down', got ${JSON.stringify(rawClimb)}`);
      else if (f.has('walkable') && walkable === false) this.sink.add(f.at('climb'), `a 'climb' tile must be walkable (set 'walkable: true')`);
      else if (walkable) climb = rawClimb;
    }
    let container: ContainerSpec | null = null;
    const c = f.mapping('container');
    if (c) {
      const cf = new Fields(this.sink, f.at('container'), c, ['capacity'], 'container');
      const capacity = this.weight(cf, 'capacity');
      if (capacity !== undefined) container = { capacity };
    }
    return {
      id: d.id,
      index: d.index,
      label: f.string('label') ?? d.id,
      glyph: f.glyph() ?? '?',
      color: f.color() ?? 'white',
      walkable,
      raised: f.boolean('raised', false) ?? !walkable,
      opaque: f.boolean('opaque', false) ?? !walkable,
      sprite: this.sprite(f, d),
      tags: this.tags(f),
      container: edge ? null : container,
      climb: edge ? null : climb,
      edge,
    };
  }

  /** A required weight or capacity (number ≥ 0), rounded to integer hundredths. */
  private weight(f: Fields, key: string): number | undefined {
    const v = f.number(key);
    if (v === undefined) return undefined;
    if (v < 0) {
      this.sink.add(f.at(key), `field '${key}' must be a number ≥ 0, got ${v}`);
      return undefined;
    }
    return Math.round(v * 100);
  }

  private item(d: Defined): ItemDef {
    const f = this.fields(d, ['id', 'label', 'glyph', 'color', 'weight', 'tags', 'sprite', 'use'], 'item');
    const label = f.string('label') ?? d.id;
    const glyph = f.glyph() ?? '?';
    const color = f.color() ?? 'white';
    const weight = this.weight(f, 'weight') ?? 0;
    const tags = this.tags(f);
    const sprite = this.sprite(f, d);
    let use: ItemUseDef | null = null;
    const u = f.mapping('use');
    if (u) {
      const uf = new Fields(this.sink, f.at('use'), u, ['label', 'when', 'effects', 'consume', 'duration', 'interrupt'], 'use');
      const useLabel = uf.string('label', false) ?? DEFAULT_USE_LABEL;
      const whenFn = this.condition(uf, 'when', d.scopeOf('use')) ?? null;
      const effects = this.effects(uf, d.scopeOf('use'));
      let consume = 1;
      const cv = uf.raw('consume');
      if (cv !== undefined && cv !== null) {
        if (typeof cv !== 'number' || !Number.isInteger(cv) || cv < 0) {
          this.sink.add(uf.at('consume'), `field 'consume' must be a non-negative integer, got ${JSON.stringify(cv)}`);
        } else consume = cv;
      }
      const duration = this.duration(uf, d.scopeOf('use'));
      const interruptFn = this.condition(uf, 'interrupt', d.scopeOf('use')) ?? null;
      use = { label: useLabel, whenFn, effects, consume, duration, interruptFn };
    }
    return { id: d.id, index: d.index, label, glyph, color, weight, tags, sprite, use };
  }

  private archetype(d: Defined, measurements: readonly MeasurementDef[], items: readonly ItemDef[]): ArchetypeDef {
    const f = this.fields(
      d,
      ['id', 'label', 'glyph', 'color', 'tags', 'measurements', 'initial', 'ticks_per_step', 'ticks_per_turn', 'sprite', 'inventory', 'behavior', 'dialogue'],
      'archetype',
    );
    const label = f.string('label') ?? d.id;
    const glyph = f.glyph() ?? '?';
    const color = f.color() ?? 'white';
    const tags = this.tags(f);

    const indices: number[] = [];
    (f.list('measurements') ?? []).forEach((ref, i) => {
      const r = this.symbols.ref('measurement', ref, d.scopeOf('measurements'), f.at('measurements', i), this.sink);
      if (!r) return;
      if (indices.includes(r.index)) this.sink.add(f.at('measurements', i), `measurement '${r.id}' is listed twice`);
      else indices.push(r.index);
    });
    indices.sort((a, b) => a - b);

    const initial = indices.map((i) => measurements[i]!.initial);
    const overrides = f.mapping('initial');
    for (const [ref, value] of Object.entries(overrides ?? {})) {
      const src = f.at('initial', ref);
      const r = this.symbols.ref('measurement', ref, d.scopeOf('initial'), src, this.sink);
      if (!r) continue;
      const k = indices.indexOf(r.index);
      if (k < 0) this.sink.add(src, `initial override for '${r.id}', which is not in this archetype's measurements`);
      else if (typeof value !== 'number') this.sink.add(src, `initial override must be a number`);
      else initial[k] = value;
    }

    let ticksPerStep = f.number('ticks_per_step', false) ?? DEFAULT_TICKS_PER_STEP;
    if (!Number.isInteger(ticksPerStep) || ticksPerStep < 1) {
      this.sink.add(f.at('ticks_per_step'), `field 'ticks_per_step' must be a positive integer`);
      ticksPerStep = DEFAULT_TICKS_PER_STEP;
    }
    let ticksPerTurn = f.number('ticks_per_turn', false) ?? DEFAULT_TICKS_PER_TURN;
    if (!Number.isInteger(ticksPerTurn) || ticksPerTurn < 0) {
      this.sink.add(f.at('ticks_per_turn'), `field 'ticks_per_turn' must be a non-negative integer`);
      ticksPerTurn = DEFAULT_TICKS_PER_TURN;
    }
    const sprite = this.sprite(f, d);
    const inventory = this.inventory(f, d, items);
    const behavior = f.has('behavior') ? (this.symbols.ref('behavior', f.raw('behavior'), d.scopeOf('behavior'), f.at('behavior'), this.sink)?.index ?? null) : null;
    const dialogue = f.has('dialogue') ? (this.symbols.ref('dialogue', f.raw('dialogue'), d.scopeOf('dialogue'), f.at('dialogue'), this.sink)?.index ?? null) : null;
    return { id: d.id, index: d.index, label, glyph, color, tags, measurements: indices, initial, ticksPerStep, ticksPerTurn, sprite, inventory, behavior, dialogue };
  }

  private inventory(f: Fields, d: Defined, items: readonly ItemDef[]): InventorySpec | null {
    const raw = f.mapping('inventory');
    if (!raw) return null;
    const inf = new Fields(this.sink, f.at('inventory'), raw, ['capacity', 'items'], 'inventory');
    const capacity = this.weight(inf, 'capacity');
    const start: ItemCount[] = [];
    let total = 0;
    for (const [ref, value] of Object.entries(inf.mapping('items') ?? {})) {
      const src = inf.at('items', ref);
      const r = this.symbols.ref('item', ref, d.scopeOf('inventory'), src, this.sink);
      if (!r) continue;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        this.sink.add(src, `starting item count must be a positive integer, got ${JSON.stringify(value)}`);
        continue;
      }
      if (start.some((s) => s.item === r.index)) {
        this.sink.add(src, `item '${r.id}' is listed twice`);
        continue;
      }
      start.push({ item: r.index, count: value });
      total += (items[r.index]?.weight ?? 0) * value;
    }
    if (capacity === undefined) return null;
    if (total > capacity) {
      this.sink.add(inf.at('items'), `starting inventory weighs ${total / 100}, over its capacity of ${capacity / 100}`);
    }
    return { capacity, items: start };
  }

  /**
   * Read every `maps[].tiled` file up front: room tags must be known before
   * expressions compile, and tile/archetype ids are already defined.
   */
  private readTiledMaps(): void {
    for (const d of this.defined.maps) {
      const v = d.entry.value;
      if (v['tiled'] === undefined || isComposite(v)) continue;
      this.tiledMaps[d.index] = null;
      const src = at(d.srcOf('tiled'), 'tiled');
      const mixed = ASCII_MAP_FIELDS.filter((k) => v[k] !== undefined);
      if (mixed.length) {
        this.sink.add(src, `a map takes either the ASCII fields (legend, rows or floors, rooms) or 'tiled', not both (remove ${mixed.map((k) => `'${k}'`).join(', ')})`);
        continue;
      }
      const raw = v['tiled'];
      if (typeof raw !== 'string') {
        this.sink.add(src, `field 'tiled' must be a path to a Tiled .tmj file (relative to the pack root)`);
        continue;
      }
      if (/\.tmx$/i.test(raw)) {
        this.sink.add(src, `'${raw}' is a TMX (XML) map: save the map as JSON in Tiled (File → Export As… → JSON map files) and reference the .tmj`);
        continue;
      }
      const pack = this.packOf(d, 'tiled');
      const path = normalizePath(raw);
      if (path === null || !path.endsWith('.tmj') || pack.tiledFiles[path] === undefined) {
        const known = Object.keys(pack.tiledFiles).filter((k) => k.endsWith('.tmj'));
        const s = nearMiss(path ?? raw, known);
        const what = path !== null && !path.endsWith('.tmj') ? `must be a Tiled JSON map (.tmj), got '${raw}'` : `Tiled map '${raw}' not found in pack '${pack.namespace}'`;
        this.sink.add(src, `${what}${s ? ` (did you mean '${s}'?)` : ''}`);
        continue;
      }
      const { map, problems } = readTiledMap({
        files: pack.tiledFiles,
        path,
        tile: (ref) => this.symbols.resolve('tile', ref, d.scopeOf('tiled')),
        archetype: (ref) => this.symbols.resolve('archetype', ref, d.scopeOf('tiled')),
        // Tiles are built after the Tiled maps are read: read `edge` from the (merged) tile entry.
        isEdge: (t) => this.defined.tiles[t]?.entry.value['edge'] === true,
      });
      const line = lineOf(src.source, src.path);
      const from = `in map '${d.id}', from ${src.source.file}${line !== undefined ? `:${line}` : ''} ${formatPath(src.path)}`;
      for (const p of problems) this.sink.raw({ pack: pack.namespace, file: p.file, path: p.path, message: `${p.message} [${from}]` });
      this.tiledMaps[d.index] = map;
    }
  }

  private map(d: Defined): MapDef {
    const tiled = this.tiledMaps[d.index];
    if (tiled !== undefined) {
      const f = this.fields(d, MAP_FIELDS, 'map');
      if (!tiled) return this.emptyMap(d);
      const rects = tiled.rooms.map((r) => ({ x: r.x, y: r.y, z: r.z, w: r.w, h: r.h, tags: [...new Set(r.tags.map((t) => this.roomTags.indexOf(t)))].sort((a, b) => a - b) }));
      const { width, height, floors, cells, edgeN, edgeW, facings, spawns, playerStart } = tiled;
      this.checkLinks(cells, width, height, floors, () => f.at('tiled'));
      const map: MapDef = {
        id: d.id,
        index: d.index,
        width,
        height,
        floors,
        cells,
        edgeN,
        edgeW,
        facings,
        spawns,
        playerStart,
        rooms: this.roomSets(rects, width, height, floors),
        populate: [],
        composite: false,
      };
      return this.withPopulate(this.withSpawns(map, f, d.scopeOf('spawns')), f, d.scopeOf('populate'));
    }
    const before = this.sink.count;
    const f = this.fields(d, MAP_FIELDS, 'map');

    interface Legend {
      tile: number;
      spawn: number | null;
      player: boolean;
      facing: Facing | null;
    }
    const legend = new Map<string, Legend>();
    const rawLegend = f.mapping('legend', true);
    for (const [ch, value] of Object.entries(rawLegend ?? {})) {
      const src = f.at('legend', ch);
      if ([...ch].length !== 1) {
        this.sink.add(src, `legend keys must be single characters, got ${JSON.stringify(ch)}`);
        continue;
      }
      if (!isObject(value)) {
        this.sink.add(src, `legend entry must be a mapping like { tile: floor }`);
        continue;
      }
      const lf = new Fields(this.sink, src, value, ['tile', 'spawn', 'player', 'facing'], 'legend');
      const tile = lf.has('tile') ? this.symbols.ref('tile', value['tile'], d.scopeOf('legend'), lf.at('tile'), this.sink) : lf.string('tile');
      const spawn = lf.has('spawn') ? this.symbols.ref('archetype', value['spawn'], d.scopeOf('legend'), lf.at('spawn'), this.sink) : null;
      const player = lf.boolean('player', false) ?? false;
      let facing: Facing | null = null;
      const rawFacing = lf.has('facing') ? value['facing'] : undefined;
      if (rawFacing !== undefined) {
        if (typeof rawFacing === 'string' && CARDINALS.includes(rawFacing as Facing)) facing = rawFacing as Facing;
        else {
          const diag = isFacing(rawFacing) ? ` (tiles face one of the 4 diamond sides; diagonals are not allowed)` : '';
          this.sink.add(lf.at('facing'), `legend 'facing' must be one of ${CARDINALS.join(', ')}, got ${JSON.stringify(rawFacing)}${diag}`);
        }
      }
      if (tile && typeof tile === 'object') legend.set(ch, { tile: tile.index, spawn: spawn?.index ?? null, player, facing });
      else legend.set(ch, { tile: -1, spawn: null, player, facing });
    }
    // A space is an empty cell unless the legend defines it.
    if (!legend.has(' ')) legend.set(' ', { tile: EMPTY_TILE, spawn: null, player: false, facing: null });

    // Floors: `rows` (one floor) or `floors: [{ rows }]`, index = z. Each entry: the rows, their source path, and
    // whether they use the double-resolution `edges: true` notation (a floor's own `edges`, else the map's).
    const layers: { rows: Json[] | undefined; edges: boolean; at: (...more: (string | number)[]) => Src }[] = [];
    const mapEdges = f.boolean('edges', false) ?? false;
    if (f.has('rows') && f.has('floors')) this.sink.add(f.at('floors'), `a map takes either 'rows' (one floor) or 'floors', not both`);
    if (f.has('floors')) {
      const list = f.list('floors');
      if (list && list.length === 0) this.sink.add(f.at('floors'), `map must have at least one floor`);
      (list ?? []).forEach((raw, z) => {
        const src = f.at('floors', z);
        if (!isObject(raw)) {
          this.sink.add(src, `floors must be mappings like { rows: [...] }`);
          layers.push({ rows: undefined, edges: mapEdges, at: (...more) => at(src, ...more) });
          return;
        }
        const ff = new Fields(this.sink, src, raw, ['rows', 'edges'], 'floor');
        const rows = ff.list('rows');
        if (!rows && !ff.has('rows')) ff.string('rows'); // reports "missing required field"
        layers.push({ rows, edges: ff.boolean('edges', false) ?? mapEdges, at: (...more) => ff.at('rows', ...more) });
      });
    } else {
      const rows = f.list('rows');
      if (!rows && !f.has('rows')) f.string('rows'); // reports "missing required field"
      layers.push({ rows, edges: mapEdges, at: (...more) => f.at('rows', ...more) });
    }
    // Map size from floor 0: its rows, or (edges) the cells between its 2·h + 1 rows of 2·w + 1 characters.
    const rows0 = layers[0]?.rows;
    const edges0 = layers[0]?.edges ?? false;
    const len0 = rows0 && typeof rows0[0] === 'string' ? [...rows0[0]].length : 0;
    const width = edges0 ? Math.max(0, (len0 - 1) >> 1) : len0;
    const height = rows0 ? (edges0 ? Math.max(0, (rows0.length - 1) >> 1) : rows0.length) : 0;
    const floors = Math.max(1, layers.length);
    const area = width * height;
    const cells: number[] = new Array<number>(area * floors).fill(0);
    const edgeN: number[] = new Array<number>(area * floors).fill(EMPTY_TILE);
    const edgeW: number[] = new Array<number>(area * floors).fill(EMPTY_TILE);
    const facings: (Facing | null)[] = new Array<Facing | null>(area * floors).fill(null);
    const spawns: SpawnDef[] = [];
    let playerStart: { x: number; y: number; z: number } | null = null;
    const missing = new Set<string>();
    const multi = f.has('floors');
    const where = (y: number, x: number, z: number) => (multi ? `floor ${z}, row ${y}, column ${x}` : `row ${y}, column ${x}`);
    const tileId = (t: number) => this.tileDefs[t]!.id;
    const isEdge = (t: number) => t !== EMPTY_TILE && t >= 0 && this.tileDefs[t]?.edge === true;

    if (edges0 && rows0 && rows0.length > 0 && (rows0.length % 2 === 0 || len0 % 2 === 0)) {
      this.sink.add(
        layers[0]!.at(),
        `a map with 'edges: true' needs an odd number of rows and of columns (2·height + 1 rows of 2·width + 1 characters), got ${rows0.length} rows of ${len0}`,
      );
    }
    layers.forEach(({ rows, edges, at: rowAt }, z) => {
      if (!rows) return;
      if (rows.length === 0) {
        this.sink.add(rowAt(), `map must have at least one row`);
        return;
      }
      const wantRows = edges ? 2 * height + 1 : height;
      const wantCols = edges ? 2 * width + 1 : width;
      if (z > 0 && rows.length !== wantRows) {
        const what = edges ? `2·${height} + 1 for the ${height} rows of floor 0, as floor ${z} uses 'edges: true'` : edges0 ? `the ${height} rows of floor 0` : `the rows of floor 0`;
        this.sink.add(rowAt(), `floor ${z} has ${rows.length} rows, expected ${wantRows} (${what}): all floors must have the same size`);
        return;
      }
      rows.forEach((row, r) => {
        const src = rowAt(r);
        if (typeof row !== 'string') {
          this.sink.add(src, `map rows must be strings`);
          return;
        }
        const chars = [...row];
        if (chars.length !== wantCols) {
          const of = multi ? `row 0 of floor 0` : `row 0`;
          this.sink.add(src, `ragged map rows: row ${r} has length ${chars.length}, expected ${wantCols} (${z > 0 && edges !== edges0 ? `2·${width} + 1 for floor ${z}'s 'edges: true'` : `the length of ${of}`})`);
          return;
        }
        chars.forEach((ch, c) => {
          // Edges notation: cells at odd (row, column), `n` edges at (even, odd), `w` edges at (odd, even), vertices ignored.
          let x = c;
          let y = r;
          let side: 'n' | 'w' | null = null;
          if (edges) {
            const oddR = r % 2 === 1;
            const oddC = c % 2 === 1;
            if (!oddR && !oddC) return;
            x = oddC ? (c - 1) >> 1 : c >> 1;
            y = oddR ? (r - 1) >> 1 : r >> 1;
            if (!oddR) side = 'n';
            else if (!oddC) side = 'w';
            // The south and east borders of the map need no edges.
            if (x >= width || y >= height) return;
            if (side && ch === ' ') return; // no edge
          }
          const l = legend.get(ch);
          if (!l) {
            if (!missing.has(ch)) {
              missing.add(ch);
              this.sink.add(src, `map character '${ch}' (${where(r, c, z)}) is not in the legend`);
            }
            return;
          }
          const i = (z * height + y) * width + x;
          const pos = side ? `${where(r, c, z)}: the ${side === 'n' ? 'north' : 'west'} edge of cell (${x}, ${y})` : edges ? `${where(r, c, z)}: cell (${x}, ${y})` : where(r, c, z);
          if (side) {
            if (l.spawn !== null || l.player) this.sink.add(src, `map character '${ch}' (${pos}) has a ${l.player ? 'player start' : 'spawn'}: only cell positions (odd row and column) take them`);
            else if (l.tile >= 0 && !isEdge(l.tile)) {
              this.sink.add(src, `map character '${ch}' (${pos}) is '${tileId(l.tile)}', which is not an edge tile: edge positions take edge tiles (walls, doors, windows, fences) or a space`);
            } else if (l.tile >= 0) (side === 'n' ? edgeN : edgeW)[i] = l.tile;
            return;
          }
          if (isEdge(l.tile)) {
            const hint = edges
              ? `cell positions (odd row and column) take the other tiles; put it on an edge position`
              : `edge tiles go on the edges between cells: set 'edges: true' and use the double-resolution rows, or convert the map with 'npm run map:edges' (docs/packs.md#edge-walls)`;
            this.sink.add(src, `map character '${ch}' (${pos}) is '${tileId(l.tile)}', an edge tile: ${hint}`);
            return;
          }
          cells[i] = l.tile;
          facings[i] = l.facing;
          if (l.spawn !== null) spawns.push({ x, y, z, archetype: l.spawn });
          if (l.player) {
            if (playerStart) this.sink.add(src, `map has more than one player start cell (another at ${playerStart.x},${playerStart.y}${multi ? `,${playerStart.z}` : ''})`);
            else playerStart = { x, y, z };
          }
        });
      });
    });
    const rowSrc = (i: number) => {
      const z = Math.floor(i / area);
      const y = Math.floor(i / width) % height;
      return layers[z]!.at(layers[z]!.edges ? 2 * y + 1 : y);
    };
    if (this.sink.count === before) this.checkLinks(cells, width, height, floors, rowSrc);
    const rooms = this.roomSets(this.roomRects(f, width, height, floors), width, height, floors);
    const map: MapDef = { id: d.id, index: d.index, width, height, floors, cells, edgeN, edgeW, facings, spawns, playerStart, rooms, populate: [], composite: false };
    return this.sink.count === before ? this.withPopulate(this.withSpawns(map, f, d.scopeOf('spawns')), f, d.scopeOf('populate')) : map;
  }

  private emptyMap(d: Defined, composite = false): MapDef {
    return { id: d.id, index: d.index, width: 0, height: 0, floors: 1, cells: [], edgeN: [], edgeW: [], facings: [], spawns: [], playerStart: null, rooms: this.roomSets([], 0, 0, 1), populate: [], composite };
  }

  /**
   * `map` with its YAML `spawns` entries added to the spawns of its cells or
   * Tiled objects, all ordered by floor, then row-major (stable: a cell's
   * map spawn comes before a YAML one).
   */
  private withSpawns(map: MapDef, f: Fields, scope: Scope): MapDef {
    const list = f.list('spawns');
    if (!list) return map;
    const extra: SpawnDef[] = [];
    list.forEach((raw, k) => {
      const src = f.at('spawns', k);
      if (!isObject(raw)) {
        this.sink.add(src, `spawns entries must be mappings like { archetype: guard, at: [x, y] }`);
        return;
      }
      const sf = new Fields(this.sink, src, raw, ['archetype', 'at'], 'spawn');
      const arch = sf.has('archetype') ? this.symbols.ref('archetype', sf.raw('archetype'), scope, sf.at('archetype'), this.sink) : sf.string('archetype');
      const pos = sf.raw('at');
      if (pos === undefined || pos === null) {
        sf.present('at');
        return;
      }
      if (!Array.isArray(pos) || ![2, 3].includes(pos.length) || !pos.every((v) => typeof v === 'number' && Number.isInteger(v))) {
        this.sink.add(sf.at('at'), `field 'at' must be [x, y] or [x, y, z], integers, got ${JSON.stringify(pos)}`);
        return;
      }
      const [x, y, z = 0] = pos as number[];
      if (x! < 0 || y! < 0 || z < 0 || x! >= map.width || y! >= map.height || z >= map.floors) {
        this.sink.add(sf.at('at'), `spawn ${JSON.stringify(pos)} is outside the map (${map.width}×${map.height}, ${map.floors} floor${map.floors === 1 ? '' : 's'})`);
        return;
      }
      if (map.cells[(z * map.height + y!) * map.width + x!] === EMPTY_TILE) {
        this.sink.add(sf.at('at'), `spawn ${JSON.stringify(pos)} is on an empty cell`);
        return;
      }
      if (arch && typeof arch === 'object') extra.push({ x: x!, y: y!, z, archetype: arch.index });
    });
    if (!extra.length) return map;
    const spawns = [...map.spawns, ...extra].sort((a, b) => a.z - b.z || a.y - b.y || a.x - b.x);
    return { ...map, spawns };
  }

  /** `map` with its own `populate` entries read and checked against its cells. */
  private withPopulate(map: MapDef, f: Fields, scope: Scope): MapDef {
    const own = this.populateEntries(f, scope, map.width, map.height, map.floors);
    if (!own.length) return map;
    const populate = own.map((o) => o.def);
    const out = { ...map, populate };
    this.checkPopulate(out, own.map((o) => o.src));
    return out;
  }

  /**
   * A composite map: part maps copied in at their `at` (cells and edges),
   * `fill` on the uncovered floor-0 cells (no edges), the parts' spawns,
   * rooms and populate entries offset, then the composite's own `rooms`,
   * `populate` and `player`.
   */
  private compositeMap(d: Defined, maps: readonly MapDef[]): MapDef {
    const before = this.sink.count;
    const f = this.fields(d, MAP_FIELDS, 'map');
    const mixed = ['tiled', 'legend', 'rows', 'floors'].filter((k) => f.has(k));
    if (f.has('spawns')) this.sink.add(f.at('spawns'), `a composite map cannot take 'spawns': add them to a part map, or use 'populate' with a one-cell rect`);
    if (mixed.length) {
      this.sink.add(f.at(mixed[0]!), `a composite map (${COMPOSITE_MAP_FIELDS.join(', ')}) cannot also take ASCII or Tiled fields (remove ${mixed.map((k) => `'${k}'`).join(', ')})`);
      return this.emptyMap(d, true);
    }
    const size = f.raw('size');
    const intList = (v: Json | undefined, n: number[]): v is number[] => Array.isArray(v) && n.includes(v.length) && v.every((x) => typeof x === 'number' && Number.isInteger(x));
    if (!f.present('size')) return this.emptyMap(d, true);
    if (!intList(size, [2]) || size[0]! < 1 || size[1]! < 1) {
      this.sink.add(f.at('size'), `field 'size' must be [width, height], two integers ≥ 1, got ${JSON.stringify(size)}`);
      return this.emptyMap(d, true);
    }
    const [width, height] = size as [number, number];

    interface Placed {
      map: MapDef;
      x: number;
      y: number;
      src: Src;
    }
    const placed: Placed[] = [];
    (f.list('parts') ?? []).forEach((raw, k) => {
      const src = f.at('parts', k);
      if (!isObject(raw)) {
        this.sink.add(src, `parts must be mappings like { map: house, at: [x, y] }`);
        return;
      }
      const pf = new Fields(this.sink, src, raw, ['map', 'at'], 'part');
      const ref = pf.has('map') ? this.symbols.ref('map', pf.raw('map'), d.scopeOf('parts'), pf.at('map'), this.sink) : pf.string('map');
      const pos = pf.raw('at');
      let ok = true;
      if (pos === undefined || pos === null) ok = pf.present('at');
      else if (!intList(pos, [2])) {
        this.sink.add(pf.at('at'), `field 'at' must be [x, y], two integers, got ${JSON.stringify(pos)}`);
        ok = false;
      }
      if (!ref || typeof ref !== 'object' || !ok) return;
      if (isComposite(this.defined.maps[ref.index]!.entry.value)) {
        this.sink.add(pf.at('map'), `part ${k} is '${ref.id}', a composite map: composites cannot be nested`);
        return;
      }
      const map = maps[ref.index]!;
      if (map.width === 0) return; // already reported
      const [x, y] = pos as [number, number];
      if (x < 0 || y < 0 || x + map.width > width || y + map.height > height) {
        this.sink.add(pf.at('at'), `part ${k} ('${map.id}', ${map.width}×${map.height}) at [${x}, ${y}] lies outside the map (size ${width}×${height})`);
        return;
      }
      placed.push({ map, x, y, src });
    });
    // Overlaps: every part covers its whole rectangle on floor 0 at least.
    const index = (p: Placed) => p.src.path[p.src.path.length - 1];
    for (let a = 0; a < placed.length; a++) {
      for (let b = a + 1; b < placed.length; b++) {
        const pa = placed[a]!;
        const pb = placed[b]!;
        const x0 = Math.max(pa.x, pb.x);
        const y0 = Math.max(pa.y, pb.y);
        if (x0 < Math.min(pa.x + pa.map.width, pb.x + pb.map.width) && y0 < Math.min(pa.y + pa.map.height, pb.y + pb.map.height)) {
          this.sink.add(pb.src, `parts ${index(pa)} ('${pa.map.id}') and ${index(pb)} ('${pb.map.id}') overlap, first at (${x0}, ${y0})`);
        }
      }
    }
    if (this.sink.count !== before) return this.emptyMap(d, true);

    const floors = Math.max(1, ...placed.map((p) => p.map.floors));
    const area = width * height;
    const cells = new Array<number>(area * floors).fill(EMPTY_TILE);
    const edgeN = new Array<number>(area * floors).fill(EMPTY_TILE);
    const edgeW = new Array<number>(area * floors).fill(EMPTY_TILE);
    const facings = new Array<Facing | null>(area * floors).fill(null);
    const covered = new Uint8Array(area);
    const spawns: SpawnDef[] = [];
    const rects: RoomDef[] = [];
    const populate: PopulateDef[] = [];
    const popSrc: Src[] = [];
    for (const p of placed) {
      const m = p.map;
      for (let z = 0; z < m.floors; z++) {
        for (let y = 0; y < m.height; y++) {
          for (let x = 0; x < m.width; x++) {
            const from = (z * m.height + y) * m.width + x;
            const to = (z * height + p.y + y) * width + p.x + x;
            cells[to] = m.cells[from]!;
            edgeN[to] = m.edgeN[from]!;
            edgeW[to] = m.edgeW[from]!;
            facings[to] = m.facings[from] ?? null;
            if (z === 0) covered[(p.y + y) * width + p.x + x] = 1;
          }
        }
      }
      for (const s of m.spawns) spawns.push({ x: s.x + p.x, y: s.y + p.y, z: s.z, archetype: s.archetype });
      for (const r of m.rooms.rects) rects.push({ ...r, x: r.x + p.x, y: r.y + p.y });
      for (const e of m.populate) {
        populate.push({ ...e, x: e.x + p.x, y: e.y + p.y });
        popSrc.push(p.src);
      }
    }
    const uncovered = covered.indexOf(0);
    if (uncovered >= 0) {
      const fill = f.has('fill') ? this.symbols.ref('tile', f.raw('fill'), d.scopeOf('fill'), f.at('fill'), this.sink) : null;
      if (!f.has('fill')) {
        const n = covered.reduce((a, c) => a + (c ? 0 : 1), 0);
        this.sink.add(d.entry.src, `missing required field 'fill': ${n} floor-0 cell${n === 1 ? ' is' : 's are'} not covered by any part (first at (${uncovered % width}, ${Math.floor(uncovered / width)}))`);
      } else if (fill) {
        if (this.tileDefs[fill.index]?.edge) this.sink.add(f.at('fill'), `'fill' cannot be '${fill.id}': it is an edge tile, and 'fill' covers cells`);
        else for (let i = 0; i < area; i++) if (!covered[i]) cells[i] = fill.index;
      }
    } else if (f.has('fill')) this.symbols.ref('tile', f.raw('fill'), d.scopeOf('fill'), f.at('fill'), this.sink);

    let playerStart: { x: number; y: number; z: number } | null = null;
    if (f.has('player')) {
      const v = f.raw('player');
      if (!intList(v, [2, 3])) this.sink.add(f.at('player'), `field 'player' must be [x, y] or [x, y, z], integers, got ${JSON.stringify(v)}`);
      else {
        const [x, y, z = 0] = v;
        const t = x! >= 0 && y! >= 0 && z >= 0 && x! < width && y! < height && z < floors ? cells[(z * height + y!) * width + x!]! : undefined;
        if (t === undefined) this.sink.add(f.at('player'), `player start ${JSON.stringify(v)} is outside the map (${width}×${height}, ${floors} floor${floors === 1 ? '' : 's'})`);
        else if (t === EMPTY_TILE && z === 0 && !f.has('fill')) {
          // Already reported as a missing fill.
        } else if (t === EMPTY_TILE || !this.tileDefs[t]!.walkable) {
          this.sink.add(f.at('player'), `player start ${JSON.stringify(v)} is on ${t === EMPTY_TILE ? 'an empty cell' : `'${this.tileDefs[t]!.id}' (not walkable)`}`);
        } else playerStart = { x: x!, y: y!, z };
      }
    }
    rects.push(...this.roomRects(f, width, height, floors));
    if (this.sink.count === before) this.checkLinks(cells, width, height, floors, () => d.entry.src);
    const map: MapDef = {
      id: d.id,
      index: d.index,
      width,
      height,
      floors,
      cells,
      edgeN,
      edgeW,
      facings,
      spawns,
      playerStart,
      rooms: this.roomSets(rects, width, height, floors),
      populate: [],
      composite: true,
    };
    const own = this.populateEntries(f, d.scopeOf('populate'), width, height, floors);
    const out = { ...map, populate: [...populate, ...own.map((o) => o.def)] };
    if (this.sink.count !== before) return this.emptyMap(d, true); // reported; keeps `start` quiet
    // A part with an unresolved tile was reported where it is defined; its cells cannot be checked.
    if (cells.some((t) => t !== EMPTY_TILE && !this.tileDefs[t])) return out;
    this.checkPopulate(out, [...popSrc, ...own.map((o) => o.src)]);
    return out;
  }

  /** A map's own `populate` entries (rects in its coordinates); invalid entries are reported and skipped. */
  private populateEntries(f: Fields, scope: Scope, width: number, height: number, floors: number): { def: PopulateDef; src: Src }[] {
    const out: { def: PopulateDef; src: Src }[] = [];
    (f.list('populate') ?? []).forEach((raw, k) => {
      const src = f.at('populate', k);
      if (!isObject(raw)) {
        this.sink.add(src, `populate entries must be mappings like { archetype: guard, count: 10 }`);
        return;
      }
      const pf = new Fields(this.sink, src, raw, ['archetype', 'count', 'rect', 'floor', 'room'], 'populate');
      const arch = pf.has('archetype') ? this.symbols.ref('archetype', pf.raw('archetype'), scope, pf.at('archetype'), this.sink) : pf.string('archetype');
      let ok = !!arch && typeof arch === 'object';
      const count = pf.raw('count');
      if (count === undefined || count === null) ok = pf.present('count') && ok;
      else if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
        this.sink.add(pf.at('count'), `field 'count' must be an integer ≥ 1, got ${JSON.stringify(count)}`);
        ok = false;
      }
      let rect = [0, 0, width, height];
      if (pf.has('rect')) {
        const r = pf.raw('rect');
        if (!Array.isArray(r) || r.length !== 4 || !r.every((v) => typeof v === 'number' && Number.isInteger(v))) {
          this.sink.add(pf.at('rect'), `field 'rect' must be four integers [x, y, w, h], got ${JSON.stringify(r)}`);
          ok = false;
        } else if ((r[2] as number) < 1 || (r[3] as number) < 1) {
          this.sink.add(pf.at('rect'), `populate rect ${JSON.stringify(r)} is empty: w and h must be ≥ 1`);
          ok = false;
        } else if ((r[0] as number) < 0 || (r[1] as number) < 0 || (r[0] as number) + (r[2] as number) > width || (r[1] as number) + (r[3] as number) > height) {
          this.sink.add(pf.at('rect'), `populate rect ${JSON.stringify(r)} is out of bounds: the map is ${width}×${height}`);
          ok = false;
        } else rect = r as number[];
      }
      let z = 0;
      if (pf.has('floor')) {
        const v = pf.raw('floor');
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v >= floors) {
          this.sink.add(pf.at('floor'), `populate 'floor' must be an existing floor (0${floors > 1 ? `–${floors - 1}` : ''}), got ${JSON.stringify(v)}`);
          ok = false;
        } else z = v;
      }
      let room: number | null = null;
      if (pf.has('room')) {
        const v = pf.raw('room');
        const r = typeof v === 'string' ? this.roomTag(v) : { error: `field 'room' must be a room tag (string), got ${JSON.stringify(v)}` };
        if ('error' in r) {
          this.sink.add(pf.at('room'), r.error);
          ok = false;
        } else room = r.index;
      }
      if (!ok) return;
      const [x, y, w, h] = rect as [number, number, number, number];
      out.push({ def: { archetype: (arch as { index: number }).index, count: count as number, x, y, w, h, z, room }, src });
    });
    return out;
  }

  /**
   * Each populate entry's `count` must fit its candidate cells, minus the
   * cells earlier entries may take from them (cells are never reused), so the
   * number placed never depends on the seed.
   */
  private checkPopulate(map: MapDef, srcs: readonly Src[]): void {
    const cands = map.populate.map((p) => populateCandidates(map, this.tileDefs, p));
    const mark = new Int32Array(map.cells.length).fill(-1);
    map.populate.forEach((p, k) => {
      const mine = cands[k]!;
      for (const i of mine) mark[i] = k;
      let taken = 0;
      for (let j = 0; j < k; j++) {
        const q = map.populate[j]!;
        if (q.z !== p.z || q.x >= p.x + p.w || p.x >= q.x + q.w || q.y >= p.y + p.h || p.y >= q.y + q.h) continue;
        let shared = 0;
        for (const i of cands[j]!) if (mark[i] === k) shared++;
        taken += Math.min(q.count, shared);
      }
      const what = `populate count ${p.count} of '${this.defined.archetypes[p.archetype]!.id}' in '${map.id}'`;
      if (p.count > mine.length) {
        this.sink.add(srcs[k]!, `${what} is more than its ${mine.length} candidate cell${mine.length === 1 ? '' : 's'} (walkable, no container, not the player start, in its rect, floor and room)`);
      } else if (p.count > mine.length - taken) {
        this.sink.add(srcs[k]!, `${what} may not fit: earlier entries can take ${taken} of its ${mine.length} candidate cells`);
      }
    });
  }

  /**
   * Links: a `climb` cell's far cell (same x, y one floor up or down) must be
   * inside the map and walkable in the map data. `src` gives where to report
   * a problem with cell `i`.
   */
  private checkLinks(cells: readonly number[], width: number, height: number, floors: number, src: (i: number) => Src): void {
    const area = width * height;
    const name = (x: number, y: number, z: number) => `(${x}, ${y}, floor ${z})`;
    for (let i = 0; i < cells.length; i++) {
      const t = cells[i]!;
      const tile = t === EMPTY_TILE ? undefined : this.tileDefs[t];
      if (!tile?.climb) continue;
      const x = i % width;
      const y = Math.floor(i / width) % height;
      const z = Math.floor(i / area);
      const dz = tile.climb === 'up' ? 1 : -1;
      const what = `'${tile.id}' at ${name(x, y, z)} climbs ${tile.climb} to ${name(x, y, z + dz)}`;
      if (z + dz < 0 || z + dz >= floors) {
        this.sink.add(src(i), `${what}, which is outside the map (it has ${floors} floor${floors === 1 ? '' : 's'})`);
        continue;
      }
      const far = cells[i + dz * area]!;
      const farTile = far === EMPTY_TILE ? undefined : this.tileDefs[far];
      if (!farTile?.walkable) this.sink.add(src(i), `${what}, which is ${farTile ? `'${farTile.id}' (not walkable)` : 'an empty cell'}`);
    }
  }

  /** Room tags from every raw map, so expressions and distributions can resolve them. */
  private collectRoomTags(): void {
    const seen = new Set<string>();
    const add = (t: unknown): void => {
      if (typeof t === 'string' && ID_RE.test(t) && !seen.has(t)) {
        seen.add(t);
        this.roomTags.push(t);
      }
    };
    for (const d of this.defined.maps) {
      const tiled = this.tiledMaps[d.index];
      if (tiled) for (const r of tiled.rooms) r.tags.forEach(add);
      const rooms = d.entry.value['rooms'];
      if (!Array.isArray(rooms)) continue;
      for (const room of rooms) {
        const tags = isObject(room) ? room['tags'] : null;
        if (Array.isArray(tags)) tags.forEach(add);
      }
    }
  }

  private roomTag(tag: string): { index: number } | { error: string } {
    const index = this.roomTags.indexOf(tag);
    if (index >= 0) return { index };
    const s = nearMiss(tag, this.roomTags);
    return { error: `unknown room tag '${tag}'${s ? ` (did you mean '${s}'?)` : ''}` };
  }

  /** Validated `rooms` rects of a map entry. */
  private roomRects(f: Fields, width: number, height: number, floors: number): RoomDef[] {
    const rects: RoomDef[] = [];
    (f.list('rooms') ?? []).forEach((raw, i) => {
      const src = f.at('rooms', i);
      if (!isObject(raw)) {
        this.sink.add(src, `rooms must be mappings like { rect: [x, y, w, h], tags: [kitchen] }`);
        return;
      }
      const rf = new Fields(this.sink, src, raw, ['rect', 'tags', 'floor'], 'room');
      let z = 0;
      if (rf.has('floor')) {
        const v = rf.raw('floor');
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v >= floors) {
          this.sink.add(rf.at('floor'), `room 'floor' must be an existing floor (0${floors > 1 ? `–${floors - 1}` : ''}), got ${JSON.stringify(v)}`);
          return;
        }
        z = v;
      }
      const rect = rf.raw('rect');
      let ok = true;
      if (rect === undefined || rect === null) ok = rf.present('rect');
      else if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((v) => typeof v === 'number' && Number.isInteger(v))) {
        this.sink.add(rf.at('rect'), `field 'rect' must be four integers [x, y, w, h], got ${JSON.stringify(rect)}`);
        ok = false;
      }
      const tags = this.tags(rf);
      if (!rf.has('tags') || tags.length === 0) {
        this.sink.add(rf.has('tags') ? rf.at('tags') : src, `room 'tags' must list at least one tag`);
        ok = false;
      }
      if (!ok) return;
      const [x, y, w, h] = rect as number[];
      if (w! < 1 || h! < 1) {
        this.sink.add(rf.at('rect'), `room rect ${JSON.stringify(rect)} is empty: w and h must be ≥ 1`);
        return;
      }
      if (x! < 0 || y! < 0 || x! + w! > width || y! + h! > height) {
        this.sink.add(rf.at('rect'), `room rect ${JSON.stringify(rect)} is out of bounds: the map is ${width}×${height}`);
        return;
      }
      const idx = [...new Set(tags.map((t) => this.roomTags.indexOf(t)).filter((k) => k >= 0))].sort((a, b) => a - b);
      rects.push({ x: x!, y: y!, z, w: w!, h: h!, tags: idx });
    });
    return rects;
  }

  /** Per-cell room tag sets for validated rects (shared by ASCII and Tiled maps). */
  private roomSets(rects: RoomDef[], width: number, height: number, floors: number): RoomsDef {
    const n = width * height * floors;
    const sets: number[][] = [[]];
    const keys = new Map<string, number>([['', 0]]);
    const cellSet = new Array<number>(n).fill(0);
    if (rects.length) {
      const perCell: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
      for (const r of rects) {
        const base = r.z * width * height;
        for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) for (const t of r.tags) perCell[base + y * width + x]!.add(t);
      }
      perCell.forEach((tags, i) => {
        const list = [...tags].sort((a, b) => a - b);
        const key = list.join(',');
        let k = keys.get(key);
        if (k === undefined) {
          k = sets.length;
          keys.set(key, k);
          sets.push(list);
        }
        cellSet[i] = k;
      });
    }
    return { rects, sets, cellSet };
  }

  // ── Loot ────────────────────────────────────────────────────────────────

  /** An integer or an inclusive `[min, max]` range, each ≥ `lo`; null after an error. */
  private range(v: Json | undefined, key: string, lo: number, src: Src): [number, number] | null {
    const int = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= lo;
    if (int(v)) return [v, v];
    if (Array.isArray(v) && v.length === 2 && int(v[0]) && int(v[1]) && v[0] <= v[1]) return [v[0], v[1]];
    this.sink.add(src, `field '${key}' must be an integer ≥ ${lo} or a range [min, max] with ${lo} ≤ min ≤ max, got ${JSON.stringify(v)}`);
    return null;
  }

  private lootTable(d: Defined): LootTableDef {
    const f = this.fields(d, ['id', 'rolls', 'entries'], 'loot table');
    let rolls: [number, number] = [1, 1];
    if (f.has('rolls')) rolls = this.range(f.raw('rolls'), 'rolls', 0, f.at('rolls')) ?? rolls;
    const entries: LootEntryDef[] = [];
    const srcs: Src[] = (this.lootEntrySrc[d.index] = []);
    const list = f.list('entries');
    if (!list) {
      if (!f.has('entries')) f.present('entries');
    } else if (list.length === 0) this.sink.add(f.at('entries'), `field 'entries' must list at least one entry`);
    (list ?? []).forEach((raw, i) => {
      const src = f.at('entries', i);
      if (!isObject(raw)) {
        this.sink.add(src, `loot entries must be mappings like { item: bandage, weight: 2 }`);
        return;
      }
      const ef = new Fields(this.sink, src, raw, ['item', 'table', 'nothing', 'weight', 'count'], 'loot entry');
      const kinds = (['item', 'table', 'nothing'] as const).filter((k) => ef.has(k));
      if (kinds.length !== 1) {
        this.sink.add(src, `a loot entry must have exactly one of 'item', 'table' or 'nothing: true'${kinds.length ? `, got ${kinds.join(' and ')}` : ''}`);
        return;
      }
      let weight = 1;
      const wv = ef.raw('weight');
      if (wv !== undefined && wv !== null) {
        if (typeof wv !== 'number' || !Number.isInteger(wv) || wv < 1) {
          this.sink.add(ef.at('weight'), `loot entry weight must be a positive integer, got ${JSON.stringify(wv)}`);
          return;
        }
        weight = wv;
      }
      const kind = kinds[0]!;
      const push = (e: LootEntryDef) => {
        entries.push(e);
        srcs.push(src);
      };
      if (kind !== 'item' && ef.has('count')) {
        this.sink.add(ef.at('count'), `'count' is only allowed on 'item' entries`);
        return;
      }
      if (kind === 'nothing') {
        if (ef.raw('nothing') !== true) {
          this.sink.add(ef.at('nothing'), `field 'nothing' must be true`);
          return;
        }
        push({ kind, weight });
      } else if (kind === 'table') {
        const r = this.symbols.ref('loot', ef.raw('table'), d.scopeOf('entries'), ef.at('table'), this.sink);
        if (r) push({ kind, table: r.index, weight });
      } else {
        const r = this.symbols.ref('item', ef.raw('item'), d.scopeOf('entries'), ef.at('item'), this.sink);
        const count = ef.has('count') ? this.range(ef.raw('count'), 'count', 1, ef.at('count')) : [1, 1];
        if (r && count) push({ kind, item: r.index, weight, countMin: count[0], countMax: count[1] });
      }
    });
    const cumulative: number[] = [];
    let total = 0;
    for (const e of entries) cumulative.push((total += e.weight));
    return { id: d.id, index: d.index, rollsMin: rolls[0], rollsMax: rolls[1], entries, cumulative, total };
  }

  /** Report every nested-table cycle once, at the entry that closes it. */
  private checkLootCycles(loot: readonly LootTableDef[]): void {
    const state = new Uint8Array(loot.length); // 0 new, 1 on stack, 2 done
    const visit = (t: number, stack: number[]): void => {
      state[t] = 1;
      stack.push(t);
      loot[t]!.entries.forEach((e, i) => {
        if (e.kind !== 'table') return;
        if (state[e.table] === 1) {
          const cycle = [...stack.slice(stack.indexOf(e.table)), e.table].map((k) => loot[k]!.id);
          this.sink.add(this.lootEntrySrc[t]![i]!, `loot table cycle: ${cycle.join(' → ')}`);
        } else if (state[e.table] === 0) visit(e.table, stack);
      });
      stack.pop();
      state[t] = 2;
    };
    for (let t = 0; t < loot.length; t++) if (state[t] === 0) visit(t, []);
  }

  /** Maximum total weight (hundredths) a table can produce; tables on a cycle count as 0. */
  private lootMaxWeight(loot: readonly LootTableDef[], items: readonly ItemDef[], t: number, seen = new Set<number>()): number {
    if (seen.has(t)) return 0;
    seen.add(t);
    const table = loot[t]!;
    let best = 0;
    for (const e of table.entries) {
      const w = e.kind === 'item' ? items[e.item]!.weight * e.countMax : e.kind === 'table' ? this.lootMaxWeight(loot, items, e.table, seen) : 0;
      if (w > best) best = w;
    }
    seen.delete(t);
    return best * table.rollsMax;
  }

  private distributions(tiles: readonly TileDef[], loot: readonly LootTableDef[], items: readonly ItemDef[]): DistributionDef[] {
    const out: DistributionDef[] = [];
    for (const { raw, scope } of this.packs) {
      for (const entry of raw.distributions) {
        const f = new Fields(this.sink, entry.src, entry.value, ['container', 'room', 'table'], 'distribution');
        const tile = f.present('container') ? this.symbols.ref('tile', f.raw('container'), scope, f.at('container'), this.sink) : null;
        const table = f.present('table') ? this.symbols.ref('loot', f.raw('table'), scope, f.at('table'), this.sink) : null;
        let room: number | null = null;
        let ok = true;
        if (f.has('room')) {
          const v = f.raw('room');
          const r = typeof v === 'string' ? this.roomTag(v) : { error: `expected a room tag (string), got ${JSON.stringify(v)}` };
          if ('error' in r) {
            this.sink.add(f.at('room'), r.error);
            ok = false;
          } else room = r.index;
        }
        if (!tile || !table || !ok) continue;
        const spec = tiles[tile.index]!.container;
        if (!spec) {
          this.sink.add(f.at('container'), `tile '${tile.id}' has no 'container', so loot cannot be distributed to it`);
          continue;
        }
        const max = loot[table.index] ? this.lootMaxWeight(loot, items, table.index) : 0;
        if (max > spec.capacity) {
          this.sink.warn(
            f.at('table'),
            `loot table '${table.id}' can produce up to ${max / 100} weight, over the capacity of '${tile.id}' (${spec.capacity / 100}); items that do not fit are dropped`,
          );
        }
        out.push({ container: tile.index, room, table: table.index });
      }
    }
    return out;
  }

  private status(d: Defined): StatusDef {
    const f = this.fields(d, ['id', 'label', 'for', 'when', 'until', 'rates'], 'status');
    const label = f.string('label') ?? d.id;
    const forExpr = this.conditionExpr(f, 'for', d.scopeOf('for'));
    const forFn = forExpr?.fn ?? null;
    const forTag = forExpr?.selfTag ?? null;
    const whenFn = this.condition(f, 'when', d.scopeOf('when'), true) ?? always;
    const untilFn = this.condition(f, 'until', d.scopeOf('until')) ?? ((c) => !whenFn(c));
    const rates: StatusRate[] = [];
    for (const [ref, value] of Object.entries(f.mapping('rates') ?? {})) {
      const src = f.at('rates', ref);
      const r = this.symbols.ref('measurement', ref, d.scopeOf('rates'), src, this.sink);
      const term = this.numberTerm(value, `rates.${ref}`, d.scopeOf('rates'), src);
      if (!r || !term) continue;
      if (rates.some((x) => x.measurement === r.index)) this.sink.add(src, `rate for measurement '${r.id}' is listed twice`);
      else rates.push({ measurement: r.index, ...term });
    }
    return { id: d.id, index: d.index, label, forFn, forTag, whenFn, untilFn, rates };
  }

  private system(d: Defined): SystemDef {
    const f = this.fields(d, ['id', 'every', 'for', 'when', 'effects'], 'system');
    let every = f.number('every', false) ?? DEFAULT_EVERY;
    const period = this.ticks(f, 'every', every) ?? Math.max(1, Math.round(every * TICKS_PER_SECOND));
    if (every <= 0) every = DEFAULT_EVERY;
    const forExpr = this.conditionExpr(f, 'for', d.scopeOf('for'));
    const forFn = forExpr?.fn ?? null;
    const forTag = forExpr?.selfTag ?? null;
    const whenFn = this.condition(f, 'when', d.scopeOf('when')) ?? null;

    const effects = this.effects(f, d.scopeOf('effects'));
    return { id: d.id, index: d.index, every, period, forFn, forTag, whenFn, effects };
  }

  /** Sim seconds (> 0, a whole number of ticks) → ticks; reports and returns null otherwise. */
  private ticks(f: Fields, key: string, seconds: number): number | null {
    const ticks = seconds * TICKS_PER_SECOND;
    const n = Math.round(ticks);
    if (seconds <= 0) {
      this.sink.add(f.at(key), `field '${key}' must be a number of sim seconds > 0, got ${seconds}`);
      return null;
    }
    if (Math.abs(ticks - n) > 1e-6 || n < 1) {
      this.sink.add(f.at(key), `field '${key}' must be a whole number of ticks (a multiple of ${DEFAULT_EVERY} s), got ${seconds}`);
      return null;
    }
    return n;
  }

  // ── Behaviors ───────────────────────────────────────────────────────────

  private behavior(d: Defined): BehaviorDef {
    const f = this.fields(d, ['id', 'initial', 'states'], 'behavior');
    const raw = f.mapping('states', true);
    const names = Object.keys(raw ?? {});
    if (raw && names.length === 0) this.sink.add(f.at('states'), `field 'states' must define at least one state`);
    for (const name of names) {
      if (!ID_RE.test(name)) this.sink.add(f.at('states', name), `invalid state name '${name}': state names must match [a-z][a-z0-9_]*`);
    }
    const stateRef = (v: Json | undefined, src: Src): number => {
      if (typeof v !== 'string') {
        this.sink.add(src, `expected a state name (string), got ${JSON.stringify(v)}`);
        return 0;
      }
      const k = names.indexOf(v);
      if (k >= 0) return k;
      const s = nearMiss(v, names);
      this.sink.add(src, `unknown state '${v}' in behavior '${d.id}'${s ? ` (did you mean '${s}'?)` : ''}`);
      return 0;
    };
    const initial = f.present('initial') ? stateRef(f.raw('initial'), f.at('initial')) : 0;
    const states = names.map((name, index) => this.behaviorState(f.at('states', name), raw![name], name, index, d.scopeOf('states'), stateRef));
    return { id: d.id, index: d.index, initial, states };
  }

  private behaviorState(
    src: Src,
    raw: Json | undefined,
    name: string,
    index: number,
    scope: Scope,
    stateRef: (v: Json | undefined, src: Src) => number,
  ): BehaviorStateDef {
    const state: BehaviorStateDef = { name, index, activity: 'idle', target: null, radius: null, repath: DEFAULT_REPATH * TICKS_PER_SECOND, on: [], timeout: null, done: null };
    if (!isObject(raw)) {
      this.sink.add(src, `a state must be a mapping like { do: wander, on: [...] }`);
      return state;
    }
    const f = new Fields(this.sink, src, raw, ['do', 'target', 'radius', 'repath', 'on', 'timeout', 'done'], 'state');
    let activity: ActivityKind = 'idle';
    const doRaw = f.string('do');
    if (doRaw !== undefined) {
      if ((ACTIVITIES as readonly string[]).includes(doRaw)) activity = doRaw as ActivityKind;
      else {
        const s = nearMiss(doRaw, ACTIVITIES);
        this.sink.add(f.at('do'), `unknown activity '${doRaw}'${s ? ` (did you mean '${s}'?)` : ''}; expected one of ${ACTIVITIES.join(', ')}`);
      }
    }
    /** Whether `key` is absent or allowed for this activity; reports a misplaced field. */
    const onlyFor = (key: string, kinds: readonly ActivityKind[]): boolean => {
      if (!f.has(key) || kinds.includes(activity)) return true;
      this.sink.add(f.at(key), `field '${key}' is only allowed on ${kinds.map((k) => `'${k}'`).join('/')} states, not '${activity}'`);
      return false;
    };

    let target: Compiled | null = null;
    const needsTarget = activity === 'pursue' || activity === 'flee';
    if (onlyFor('target', ['pursue', 'flee'])) {
      if (needsTarget && !f.has('target')) f.present('target');
      else if (f.has('target')) {
        const v = f.string('target');
        const e = v === undefined ? null : this.compile(v, scope, f.at('target'));
        if (e && !isPointType(e.type)) this.sink.add(f.at('target'), `target "${v}" must be an entity or a tile, got ${e.type}`);
        else if (e) target = e.fn;
      }
    }

    let radius: number | null = null;
    if (onlyFor('radius', ['wander']) && f.has('radius')) {
      const v = f.raw('radius');
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
        this.sink.add(f.at('radius'), `field 'radius' must be an integer ≥ 0, got ${JSON.stringify(v)}`);
      } else radius = v;
    }

    let repath = state.repath;
    if (onlyFor('repath', ['pursue', 'investigate']) && f.has('repath')) {
      const v = f.number('repath');
      if (v !== undefined) repath = this.ticks(f, 'repath', v) ?? repath;
    }

    const on: TransitionDef[] = [];
    (f.list('on') ?? []).forEach((t, i) => {
      const tsrc = f.at('on', i);
      if (!isObject(t)) {
        this.sink.add(tsrc, `transitions must be mappings like { when: 'self.has_status("alert")', to: chase }`);
        return;
      }
      const tf = new Fields(this.sink, tsrc, t, ['when', 'to'], 'transition');
      const when = this.condition(tf, 'when', scope, true);
      const to = tf.present('to') ? stateRef(tf.raw('to'), tf.at('to')) : -1;
      if (when && to >= 0) on.push({ when, to });
    });

    let timeout: BehaviorStateDef['timeout'] = null;
    const traw = f.mapping('timeout');
    if (traw) {
      const tf = new Fields(this.sink, f.at('timeout'), traw, ['after', 'to'], 'timeout');
      const after = tf.number('after');
      const afterTicks = after === undefined ? null : this.ticks(tf, 'after', after);
      const to = tf.present('to') ? stateRef(tf.raw('to'), tf.at('to')) : -1;
      if (afterTicks !== null && to >= 0) timeout = { afterTicks, to };
    }

    const done = onlyFor('done', ['home', 'investigate']) && f.has('done') ? stateRef(f.raw('done'), f.at('done')) : null;
    return { name, index, activity, target, radius, repath, on, timeout, done };
  }

  /**
   * An `effects` list (`apply`/`set`/`noise` on `self`), required and
   * non-empty unless `optional`. `set_tile` is only allowed with `setTile`
   * (the effects of tile-targeted actions).
   */
  private effects(f: Fields, scope: Scope, opts: { optional?: boolean; setTile?: boolean } = {}): EffectDef[] {
    const effects: EffectDef[] = [];
    const list = f.list('effects');
    if (!list) {
      if (!opts.optional && !f.has('effects')) f.present('effects');
    } else if (list.length === 0 && !opts.optional) {
      this.sink.add(f.at('effects'), `field 'effects' must list at least one effect`);
    }
    (list ?? []).forEach((raw, i) => {
      const src = f.at('effects', i);
      if (!isObject(raw)) {
        this.sink.add(src, `effects must be mappings like { type: apply, measurement: energy, delta: -1 }`);
        return;
      }
      const type = raw['type'];
      if (typeof type !== 'string' || !(type in EFFECT_FIELDS)) {
        if (type === undefined || type === null) this.sink.add(src, `missing required field 'type'`);
        else {
          const s = typeof type === 'string' ? nearMiss(type, Object.keys(EFFECT_FIELDS)) : null;
          this.sink.add(
            at(src, 'type'),
            `unknown effect type ${JSON.stringify(type)}${s ? ` (did you mean '${s}'?)` : ''}; expected one of ${Object.keys(EFFECT_FIELDS).join(', ')}`,
          );
        }
        return;
      }
      const t = type as EffectDef['type'];
      const valueKey = EFFECT_FIELDS[t];
      if (t === 'set_tile') {
        const sf = new Fields(this.sink, src, raw, ['type', 'tile'], `'set_tile' effect`);
        if (!opts.setTile) {
          this.sink.add(at(src, 'type'), `'set_tile' effects are only allowed in the effects of tile-targeted actions`);
          return;
        }
        const r = sf.present('tile') ? this.symbols.ref('tile', sf.raw('tile'), scope, sf.at('tile'), this.sink) : null;
        if (!r) return;
        if (this.tileDefs[r.index]?.container) {
          this.sink.add(sf.at('tile'), `set_tile cannot place tile '${r.id}': it has a 'container' (container identity never changes)`);
          return;
        }
        effects.push({ type: t, tile: r.index });
        return;
      }
      if (t === 'set_var' || t === 'add_var') {
        const vf = new Fields(this.sink, src, raw, ['type', 'var', valueKey], `'${t}' effect`);
        const v = vf.present('var') ? this.symbols.ref('var', vf.raw('var'), scope, vf.at('var'), this.sink) : null;
        const term = vf.present(valueKey) ? this.numberTerm(vf.raw(valueKey), valueKey, scope, vf.at(valueKey)) : null;
        if (v && term) effects.push({ type: t, var: v.index, ...term });
        return;
      }
      if (t === 'quest') {
        const qf = new Fields(this.sink, src, raw, ['type', 'quest', 'stage'], `'quest' effect`);
        const q = qf.present('quest') ? this.symbols.ref('quest', qf.raw('quest'), scope, qf.at('quest'), this.sink) : null;
        const hasStage = qf.present('stage');
        if (!q) return;
        this.questTargets.add(q.index);
        if (!hasStage) return;
        const stage = qf.raw('stage');
        if (typeof stage !== 'string') {
          this.sink.add(qf.at('stage'), `expected a stage id (string), got ${JSON.stringify(stage)}`);
          return;
        }
        const r = this.stage(q.index, stage);
        if ('error' in r) this.sink.add(qf.at('stage'), r.error);
        else effects.push({ type: t, quest: q.index, stage: r.index });
        return;
      }
      if (t === 'journal') {
        const jf = new Fields(this.sink, src, raw, ['type', 'entry'], `'journal' effect`);
        const r = jf.present('entry') ? this.symbols.ref('journal entry', jf.raw('entry'), scope, jf.at('entry'), this.sink) : null;
        if (r) effects.push({ type: t, entry: r.index });
        return;
      }
      if (t === 'noise') {
        const nf = new Fields(this.sink, src, raw, ['type', valueKey], `'noise' effect`);
        const term = nf.present(valueKey) ? this.numberTerm(nf.raw(valueKey), valueKey, scope, nf.at(valueKey)) : null;
        if (term) effects.push({ type: t, ...term });
        return;
      }
      const ef = new Fields(this.sink, src, raw, ['type', 'measurement', valueKey, 'on'], `'${t}' effect`);
      const m = ef.present('measurement') ? this.symbols.ref('measurement', ef.raw('measurement'), scope, ef.at('measurement'), this.sink) : null;
      const term = ef.present(valueKey) ? this.numberTerm(ef.raw(valueKey), valueKey, scope, ef.at(valueKey)) : null;
      const on = ef.raw('on');
      let onNpc = false;
      if (on !== undefined && on !== null) {
        if (!this.inDialogue) this.sink.add(ef.at('on'), `field 'on' is only allowed in the effects of dialogues`);
        else if (on === 'npc') onNpc = true;
        else if (on !== 'self') this.sink.add(ef.at('on'), `field 'on' must be 'self' or 'npc', got ${JSON.stringify(on)}`);
      }
      if (m && term) effects.push({ type: t, measurement: m.index, ...term, ...(onNpc ? { on: 'npc' as const } : {}) });
    });
    return effects;
  }

  // ── Vars, journal and quests ──────────────────────────────────────────

  /** Stage ids of every quest, from the raw (merged) entries: `quest` effects and `quest_reached` resolve against them. */
  private collectStageNames(): void {
    this.stageNames = this.defined.quests.map((d) => {
      const stages = d.entry.value['stages'];
      return Array.isArray(stages) ? stages.map((s) => (isObject(s) && typeof s['id'] === 'string' ? s['id'] : '')) : [];
    });
  }

  /** A stage id of quest `q` → its stage index, or an error with a did-you-mean. */
  private stage(q: number, name: string): { index: number } | { error: string } {
    const names = this.stageNames[q] ?? [];
    const k = names.indexOf(name);
    if (k >= 0 && name !== '') return { index: k };
    const s = nearMiss(name, names.filter((n) => n !== ''));
    return { error: `unknown stage '${name}' of quest '${this.defined.quests[q]?.id}'${s ? ` (did you mean '${s}'?)` : ''}` };
  }

  private worldVar(d: Defined): VarDef {
    const f = this.fields(d, ['id', 'label', 'initial', 'min', 'max'], 'var');
    const label = f.string('label', false) ?? d.id;
    const min = f.number('min', false) ?? -Infinity;
    const max = f.number('max', false) ?? Infinity;
    let initial = 0;
    const iv = f.raw('initial');
    if (typeof iv === 'boolean') initial = iv ? 1 : 0;
    else if (typeof iv === 'number' && Number.isFinite(iv)) initial = iv;
    else if (iv !== undefined && iv !== null) this.sink.add(f.at('initial'), `field 'initial' must be a number or true/false, got ${JSON.stringify(iv)}`);
    if (min > max) this.sink.add(f.at('max'), `max (${max}) is less than min (${min})`);
    else if (initial < min || initial > max) this.sink.add(f.has('initial') ? f.at('initial') : f.src, `initial (${initial}) is outside [${min}, ${max}]`);
    return { id: d.id, index: d.index, label, initial, min, max };
  }

  private journalEntry(d: Defined): JournalEntryDef {
    const f = this.fields(d, ['id', 'text', 'category'], 'journal entry');
    const text = f.string('text') ?? '';
    if (f.has('text') && text.trim() === '') this.sink.add(f.at('text'), `field 'text' must not be empty`);
    const category = f.string('category', false) ?? DEFAULT_JOURNAL_CATEGORY;
    return { id: d.id, index: d.index, text, category };
  }

  private quest(d: Defined): QuestDef {
    const f = this.fields(d, ['id', 'title', 'hidden', 'stages'], 'quest');
    const title = f.string('title') ?? d.id;
    const hidden = f.boolean('hidden', false) ?? false;
    const list = f.list('stages');
    if (!list) {
      if (!f.has('stages')) f.present('stages');
    } else if (list.length === 0) this.sink.add(f.at('stages'), `field 'stages' must list at least one stage`);
    const scope = d.scopeOf('stages');
    const seen = new Set<string>();
    const stages: QuestStageDef[] = (list ?? []).map((raw, index) => {
      const src = f.at('stages', index);
      const stage: QuestStageDef = { name: '', index, journal: '', whenFn: null, end: null, effects: [] };
      if (!isObject(raw)) {
        this.sink.add(src, `stages must be mappings like { id: started, journal: "…", when: "true" }`);
        return stage;
      }
      const sf = new Fields(this.sink, src, raw, ['id', 'journal', 'when', 'end', 'effects'], 'stage');
      const name = sf.string('id') ?? '';
      if (sf.has('id') && typeof raw['id'] === 'string') {
        if (!ID_RE.test(name)) this.sink.add(sf.at('id'), `invalid stage id '${name}': stage ids must match [a-z][a-z0-9_]*`);
        else if (seen.has(name)) this.sink.add(sf.at('id'), `duplicate stage id '${name}' in quest '${d.id}'`);
        seen.add(name);
      }
      const journal = sf.string('journal') ?? '';
      const whenFn = this.condition(sf, 'when', scope) ?? null;
      let end: QuestStageDef['end'] = null;
      const ev = sf.raw('end');
      if (ev !== undefined && ev !== null) {
        if (typeof ev === 'string' && (QUEST_ENDS as readonly string[]).includes(ev)) end = ev as QuestStageDef['end'];
        else this.sink.add(sf.at('end'), `field 'end' must be 'success' or 'failure', got ${JSON.stringify(ev)}`);
      }
      const effects = this.effects(sf, scope, { optional: true });
      return { name, index, journal, whenFn, end, effects };
    });
    const watched = stages.filter((s) => s.whenFn !== null).map((s) => s.index);
    return { id: d.id, index: d.index, title, hidden, stages, watched };
  }

  /** A quest that no `when` and no `quest` effect can ever start is a pack mistake. */
  private checkQuestStarts(quests: readonly QuestDef[]): void {
    for (const q of quests) {
      if (q.stages.length === 0 || q.watched.length > 0 || this.questTargets.has(q.index)) continue;
      const d = this.defined.quests[q.index]!;
      this.sink.add(at(d.srcOf('stages'), 'stages'), `quest '${q.id}' can never start: none of its stages has a 'when', and no 'quest' effect names it`);
    }
  }

  // ── Dialogues ───────────────────────────────────────────────────────────

  /** A dialogue: its expressions see `npc` and its measurement effects take `on: npc`. */
  private dialogue(d: Defined, items: readonly ItemDef[]): DialogueDef {
    this.inDialogue = true;
    try {
      return this.readDialogue(d, items);
    } finally {
      this.inDialogue = false;
    }
  }

  private readDialogue(d: Defined, items: readonly ItemDef[]): DialogueDef {
    const f = this.fields(d, ['id', 'when', 'unavailable', 'start', 'nodes'], 'dialogue');
    const whenFn = this.condition(f, 'when', d.scopeOf('when')) ?? null;
    const unavailable = f.string('unavailable', false) ?? null;
    const rawNodes = f.mapping('nodes', true);
    const names = Object.keys(rawNodes ?? {});
    if (rawNodes && names.length === 0) this.sink.add(f.at('nodes'), `field 'nodes' must define at least one node`);
    for (const n of names) {
      if (n === 'end') this.sink.add(f.at('nodes', n), `node name 'end' is reserved: 'to: end' ends the conversation`);
      else if (!ID_RE.test(n)) this.sink.add(f.at('nodes', n), `invalid node name '${n}': node names must match [a-z][a-z0-9_]*`);
    }
    const reached = new Uint8Array(names.length);
    const ref = (v: Json | undefined, src: Src, allowEnd: boolean): number | null => {
      const k = this.nodeRef(v, names, src, d.id, allowEnd);
      if (k !== null && k >= 0) reached[k] = 1;
      return k;
    };

    const start: DialogueStartDef[] = [];
    const sv = f.raw('start');
    const startScope = d.scopeOf('start');
    if (sv === undefined || sv === null) f.present('start');
    else if (typeof sv === 'string') {
      const k = ref(sv, f.at('start'), false);
      if (k !== null) start.push({ whenFn: null, node: k });
    } else if (Array.isArray(sv)) {
      if (sv.length === 0) this.sink.add(f.at('start'), `field 'start' must list at least one entry`);
      sv.forEach((raw, i) => {
        const src = f.at('start', i);
        if (!isObject(raw)) return void this.sink.add(src, `start entries must be mappings like { when: "…", node: greeting }`);
        const sf = new Fields(this.sink, src, raw, ['when', 'node'], 'start entry');
        const when = this.condition(sf, 'when', startScope);
        const k = sf.present('node') ? ref(sf.raw('node'), sf.at('node'), false) : null;
        if (k !== null && when !== null) start.push({ whenFn: when ?? null, node: k });
      });
    } else this.sink.add(f.at('start'), `field 'start' must be a node name or a list of { when?, node }`);

    const scope = d.scopeOf('nodes');
    const choiceIds = new Set<string>();
    const nodes = names.map((name, index): DialogueNodeDef => {
      const raw = rawNodes![name];
      const src = f.at('nodes', name);
      const node: DialogueNodeDef = { name, index, speaker: NPC_SPEAKER, text: '', effects: [], choices: [LEAVE_CHOICE], leave: true };
      if (!isObject(raw)) {
        this.sink.add(src, `nodes must be mappings like { text: "…", choices: [{ text: "…", to: end }] }`);
        return node;
      }
      const nf = new Fields(this.sink, src, raw, ['speaker', 'text', 'effects', 'choices', 'next', 'leave'], 'dialogue node');
      const sp = nf.string('speaker', false);
      const speaker: DialogueSpeaker = sp === undefined || sp === 'npc' ? NPC_SPEAKER : sp === 'player' ? { kind: 'player' } : { kind: 'name', name: sp };
      const text = nf.string('text') ?? '';
      if (nf.has('text') && text.trim() === '') this.sink.add(nf.at('text'), `field 'text' must not be empty`);
      const effects = this.effects(nf, scope, { optional: true });
      const leave = nf.boolean('leave', false) ?? true;
      let choices: DialogueChoiceDef[] = [LEAVE_CHOICE];
      const list = nf.list('choices');
      if (nf.has('choices') && nf.has('next')) this.sink.add(nf.at('next'), `node '${name}' has both 'choices' and 'next'; use one`);
      if (list) {
        if (list.length === 0) this.sink.add(nf.at('choices'), `field 'choices' must list at least one choice`);
        else if (list.length > MAX_DIALOGUE_CHOICES) this.sink.add(nf.at('choices'), `node '${name}' has ${list.length} choices; at most ${MAX_DIALOGUE_CHOICES} are allowed`);
        if (list.length > 0) choices = list.map((c, i) => this.dialogueChoice(c, nf.at('choices', i), (v, s) => ref(v, s, true), scope, choiceIds, items));
      } else if (nf.has('next')) {
        const to = ref(nf.raw('next'), nf.at('next'), true);
        choices = [{ ...LEAVE_CHOICE, text: CONTINUE_TEXT, to: to ?? DIALOGUE_END, auto: true }];
      }
      return { name, index, speaker, text, effects, choices, leave };
    });
    names.forEach((name, k) => {
      if (reached[k] === 0 && rawNodes) this.sink.warn(f.at('nodes', name), `node '${name}' of dialogue '${d.id}' is never reached: no 'start', 'to' or 'next' names it`);
    });
    return { id: d.id, index: d.index, whenFn, unavailable, start, nodes };
  }

  /** A node reference (`start`, `to`, `next`): a node name of the dialogue, or `end` where allowed; null after reporting. */
  private nodeRef(v: Json | undefined, names: readonly string[], src: Src, dialogue: string, allowEnd: boolean): number | null {
    if (typeof v !== 'string') {
      this.sink.add(src, `expected a node name${allowEnd ? ` or 'end'` : ''}, got ${JSON.stringify(v)}`);
      return null;
    }
    if (allowEnd && v === 'end') return DIALOGUE_END;
    const k = names.indexOf(v);
    if (k >= 0 && v !== 'end') return k;
    const s = nearMiss(v, allowEnd ? [...names, 'end'] : names);
    this.sink.add(src, `unknown node '${v}' of dialogue '${dialogue}'${s ? ` (did you mean '${s}'?)` : ''}`);
    return null;
  }

  private dialogueChoice(
    raw: Json,
    src: Src,
    ref: (v: Json | undefined, src: Src) => number | null,
    scope: Scope,
    ids: Set<string>,
    items: readonly ItemDef[],
  ): DialogueChoiceDef {
    if (!isObject(raw)) {
      this.sink.add(src, `choices must be mappings like { text: "…", to: end }`);
      return LEAVE_CHOICE;
    }
    const cf = new Fields(this.sink, src, raw, ['text', 'to', 'when', 'unavailable', 'consume', 'give', 'effects', 'once', 'id'], 'choice');
    const text = cf.string('text') ?? '';
    const to = cf.present('to') ? ref(cf.raw('to'), cf.at('to')) : null;
    const whenFn = this.condition(cf, 'when', scope) ?? null;
    const unavailable = cf.string('unavailable', false) ?? null;
    const consume = this.itemCounts(cf, 'consume', scope, 'consumed');
    const give = this.itemCounts(cf, 'give', scope, 'given');
    for (const g of give) {
      if (consume.some((c) => c.item === g.item)) this.sink.add(cf.at('give'), `item '${items[g.item]!.id}' is both consumed and given; list it in 'consume' or 'give', not both`);
    }
    const effects = this.effects(cf, scope, { optional: true });
    const once = cf.boolean('once', false) ?? false;
    const id = cf.string('id', false) ?? '';
    if (cf.has('id') && typeof raw['id'] === 'string') {
      if (!ID_RE.test(id)) this.sink.add(cf.at('id'), `invalid choice id '${id}': choice ids must match [a-z][a-z0-9_]*`);
      else if (ids.has(id)) this.sink.add(cf.at('id'), `duplicate choice id '${id}' in this dialogue`);
      ids.add(id);
    }
    if (once && !cf.has('id')) this.sink.add(cf.at('once'), `a 'once' choice needs an 'id' (saves record it)`);
    return { text, to: to ?? DIALOGUE_END, whenFn, unavailable, consume, give, effects, once, id, auto: false };
  }

  // ── Actions ─────────────────────────────────────────────────────────────

  /** Optional `duration` (sim seconds ≥ 0, a whole number of ticks, or an expression). */
  private duration(f: Fields, scope: Scope): DurationDef {
    const v = f.raw('duration');
    if (v === undefined || v === null) return NO_DURATION;
    if (typeof v === 'number') {
      if (!Number.isFinite(v) || v < 0) {
        this.sink.add(f.at('duration'), `field 'duration' must be a number of sim seconds ≥ 0, got ${v}`);
        return NO_DURATION;
      }
      if (v === 0) return NO_DURATION;
      return { ticks: this.ticks(f, 'duration', v) ?? 0, fn: null };
    }
    if (typeof v === 'string') {
      const e = this.expr(v, scope, f.at('duration'));
      if (!e) return NO_DURATION;
      return e.constant !== undefined ? { ticks: secondsToTicks(e.constant), fn: null } : { ticks: 0, fn: e.fn };
    }
    this.sink.add(f.at('duration'), `field 'duration' must be a number or an expression`);
    return NO_DURATION;
  }

  /** A tile filter `{ tiles?, tags? }` (at least one non-empty list); null after an error. */
  private tileFilter(v: Json, src: Src, scope: Scope, tiles: readonly TileDef[]): TileFilterDef | null {
    if (!isObject(v)) {
      this.sink.add(src, `a tile filter must be a mapping like { tiles: [door] } or { tags: [glass] }, got ${JSON.stringify(v)}`);
      return null;
    }
    const f = new Fields(this.sink, src, v, ['tiles', 'tags'], 'tile filter');
    const listed = f.list('tiles') ?? [];
    const indices: number[] = [];
    listed.forEach((ref, i) => {
      const r = this.symbols.ref('tile', ref, scope, f.at('tiles', i), this.sink);
      if (r && !indices.includes(r.index)) indices.push(r.index);
    });
    const tags = this.tags(f);
    const known = new Set(tiles.flatMap((t) => t.tags));
    tags.forEach((t, i) => {
      if (!ID_RE.test(t) || known.has(t)) return;
      const s = nearMiss(t, known);
      this.sink.warn(f.at('tags', i), `no tile carries the tag '${t}'${s ? ` (did you mean '${s}'?)` : ''}, so it never matches`);
    });
    if (listed.length === 0 && tags.length === 0) {
      this.sink.add(src, `a tile filter needs a non-empty 'tiles' or 'tags' list`);
      return null;
    }
    const match = tiles.map((t) => (indices.includes(t.index) || t.tags.some((g) => tags.includes(g)) ? 1 : 0));
    return { tiles: indices, tags, match };
  }

  /** `tools`: a list of item ids, each listed once; `accept` may reject one (after reporting). */
  private tools(f: Fields, scope: Scope, accept?: (item: number, src: Src, id: string) => boolean): number[] {
    const tools: number[] = [];
    (f.list('tools') ?? []).forEach((ref, i) => {
      const r = this.symbols.ref('item', ref, scope, f.at('tools', i), this.sink);
      if (!r) return;
      if (tools.includes(r.index)) this.sink.add(f.at('tools', i), `tool '${r.id}' is listed twice`);
      else if (!accept || accept(r.index, f.at('tools', i), r.id)) tools.push(r.index);
    });
    return tools;
  }

  /**
   * A map of item id → integer count ≥ 1 (`consume`, `produce`), in written
   * order; `required` makes it a required, non-empty field.
   */
  private itemCounts(f: Fields, key: string, scope: Scope, what: string, required = false): ItemCount[] {
    const out: ItemCount[] = [];
    const raw = f.mapping(key);
    if (required && !raw) {
      if (!f.has(key)) f.present(key);
    } else if (required && Object.keys(raw!).length === 0) {
      this.sink.add(f.at(key), `field '${key}' must list at least one item`);
    }
    for (const [ref, value] of Object.entries(raw ?? {})) {
      const src = f.at(key, ref);
      const r = this.symbols.ref('item', ref, scope, src, this.sink);
      if (!r) continue;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        this.sink.add(src, `${what} count must be an integer ≥ 1, got ${JSON.stringify(value)}`);
        continue;
      }
      if (out.some((c) => c.item === r.index)) this.sink.add(src, `item '${r.id}' is listed twice`);
      else out.push({ item: r.index, count: value });
    }
    return out;
  }

  private action(d: Defined, tiles: readonly TileDef[]): ActionDef {
    const f = this.fields(
      d,
      ['id', 'label', 'progress', 'target', 'when', 'unavailable', 'tools', 'consume', 'duration', 'interrupt', 'effects'],
      'action',
    );
    const label = f.string('label') ?? d.id;
    const progress = f.string('progress', false) ?? label;

    let target: TileFilterDef | null = null;
    let tileTarget = false;
    const tv = f.raw('target');
    if (tv === undefined || tv === null) f.present('target');
    else if (typeof tv === 'string' || typeof tv !== 'object' || Array.isArray(tv)) {
      if (tv !== 'self') this.sink.add(f.at('target'), `field 'target' must be 'self' or a tile filter like { tiles: [door] }, got ${JSON.stringify(tv)}`);
    } else {
      tileTarget = true;
      target = this.tileFilter(tv, f.at('target'), d.scopeOf('target'), tiles);
    }

    const whenFn = this.condition(f, 'when', d.scopeOf('when')) ?? null;
    const unavailable = f.string('unavailable', false) ?? null;
    const tools = this.tools(f, d.scopeOf('tools'));
    const consume = this.itemCounts(f, 'consume', d.scopeOf('consume'), 'consumed');
    const rawConsume = f.raw('consume');
    const duration = this.duration(f, d.scopeOf('duration'));
    const interruptFn = this.condition(f, 'interrupt', d.scopeOf('interrupt')) ?? null;
    const effects = this.effects(f, d.scopeOf('effects'), { optional: true, setTile: tileTarget });
    if (target) this.checkSetTileKinds(f, target, effects, tiles);
    const rawEffects = f.raw('effects');
    if ((!Array.isArray(rawEffects) || rawEffects.length === 0) && !(isObject(rawConsume) && Object.keys(rawConsume).length > 0)) {
      this.sink.add(f.src, `action '${d.id}' does nothing: it needs 'effects' or 'consume'`);
    }
    return { id: d.id, index: d.index, label, progress, target, whenFn, unavailable, tools, consume, duration, interruptFn, effects };
  }

  /**
   * `set_tile` on an edge target places an edge tile, and on a cell a cell
   * tile: an action whose target matches edge tiles may only place edge
   * tiles, and one matching cell tiles only cell tiles.
   */
  private checkSetTileKinds(f: Fields, target: TileFilterDef, effects: readonly EffectDef[], tiles: readonly TileDef[]): void {
    const matched = tiles.filter((t) => target.match[t.index] === 1);
    const edges = matched.filter((t) => t.edge);
    const cells = matched.filter((t) => !t.edge);
    const list = (ts: readonly TileDef[]) => ts.slice(0, 3).map((t) => `'${t.id}'`).join(', ') + (ts.length > 3 ? ', …' : '');
    for (const e of effects) {
      if (e.type !== 'set_tile') continue;
      const placed = tiles[e.tile]!;
      if (placed.edge && cells.length) {
        this.sink.add(f.at('effects'), `set_tile places '${placed.id}', an edge tile, but the target also matches cell tiles (${list(cells)}): an edge tile only replaces an edge`);
      } else if (!placed.edge && edges.length) {
        this.sink.add(f.at('effects'), `set_tile places '${placed.id}', a cell tile, but the target matches edge tiles (${list(edges)}): an edge only takes an edge tile ('edge: true')`);
      }
    }
  }

  // ── Recipes ─────────────────────────────────────────────────────────────

  private recipe(d: Defined, tiles: readonly TileDef[]): RecipeDef {
    const f = this.fields(
      d,
      ['id', 'label', 'verb', 'category', 'consume', 'tools', 'produce', 'station', 'when', 'unavailable', 'duration', 'interrupt', 'effects', 'progress'],
      'recipe',
    );
    const label = f.string('label') ?? d.id;
    const verb = f.string('verb', false) ?? DEFAULT_RECIPE_VERB;
    const category = f.string('category', false) ?? DEFAULT_RECIPE_CATEGORY;
    const progress = f.string('progress', false) ?? `${verb}: ${label}`;
    const consume = this.itemCounts(f, 'consume', d.scopeOf('consume'), 'consumed', true);
    const produce = this.itemCounts(f, 'produce', d.scopeOf('produce'), 'produced', true);
    const tools = this.tools(f, d.scopeOf('tools'), (item, src, id) => {
      if (!consume.some((c) => c.item === item)) return true;
      this.sink.add(src, `item '${id}' is both consumed and a tool; list it in 'consume' or 'tools', not both`);
      return false;
    });
    const sv = f.raw('station');
    const station = sv === undefined || sv === null ? null : this.tileFilter(sv, f.at('station'), d.scopeOf('station'), tiles);
    const edgeStations = station ? tiles.filter((t) => t.edge && station.match[t.index] === 1) : [];
    if (edgeStations.length) {
      const ids = edgeStations.map((t) => `'${t.id}'`).join(', ');
      this.sink.warn(f.at('station'), `station matches edge tile${edgeStations.length === 1 ? '' : 's'} ${ids}: stations are cells, so ${edgeStations.length === 1 ? 'it' : 'they'} never match`);
    }
    const whenFn = this.condition(f, 'when', d.scopeOf('when')) ?? null;
    const unavailable = f.string('unavailable', false) ?? null;
    const duration = this.duration(f, d.scopeOf('duration'));
    const interruptFn = this.condition(f, 'interrupt', d.scopeOf('interrupt')) ?? null;
    const effects = this.effects(f, d.scopeOf('effects'), { optional: true });
    return { id: d.id, index: d.index, label, verb, category, progress, tools, consume, produce, station, whenFn, unavailable, duration, interruptFn, effects };
  }

  /** `start.defeat` / `start.victory`: `{ when, message? }`. */
  private outcome(f: Fields, key: 'defeat' | 'victory', scope: Scope, defaultMessage: string): OutcomeDef | null {
    const raw = f.mapping(key);
    if (!raw) return null;
    const df = new Fields(this.sink, f.at(key), raw, ['when', 'message'], key);
    const when = this.condition(df, 'when', scope, true);
    const message = df.string('message', false) ?? defaultMessage;
    return when ? { when, message } : null;
  }

  private start(maps: readonly MapDef[]): Definition['start'] | null {
    const d = this.singletons.start;
    if (!d) {
      const last = this.packs[this.packs.length - 1];
      if (last) {
        this.sink.add({ source: last.raw.manifest, path: [] }, `no 'start' defined: exactly one loaded pack must define 'start' (map + player)`);
      } else if (this.sink.count === 0) {
        this.sink.raw({ pack: '', file: '', path: '', message: 'no packs loaded' });
      }
      return null;
    }
    const f = this.fields(d, ['map', 'player', 'defeat', 'victory', 'simulation'], 'start');
    const simulation = this.simulation(f);
    const defeat = this.outcome(f, 'defeat', d.scopeOf('defeat'), DEFAULT_DEFEAT_MESSAGE);
    const victory = this.outcome(f, 'victory', d.scopeOf('victory'), DEFAULT_VICTORY_MESSAGE);
    const map = f.has('map') ? this.symbols.ref('map', f.raw('map'), d.scopeOf('map'), f.at('map'), this.sink) : f.string('map');
    const player = f.has('player') ? this.symbols.ref('archetype', f.raw('player'), d.scopeOf('player'), f.at('player'), this.sink) : f.string('player');
    if (!map || typeof map !== 'object' || !player || typeof player !== 'object') return null;
    const m = maps[map.index];
    if (m && !m.playerStart) {
      const tiled = this.tiledMaps[map.index];
      // A Tiled map that failed to read has already been reported.
      if (tiled !== null && !(m.composite && m.width === 0)) {
        const how = m.composite ? `a 'player' field on the composite map` : tiled ? `a 'player' object in the Tiled map` : `a legend entry with 'player: true'`;
        this.sink.add(f.at('map'), `start map '${map.id}' has no player start cell (${how})`);
      }
      return null;
    }
    return { map: map.index, player: player.index, defeat, victory, simulation };
  }

  /** `start.simulation`: optional scale settings, defaults otherwise. */
  private simulation(f: Fields): SimulationDef {
    const raw = f.mapping('simulation');
    if (!raw) return DEFAULT_SIMULATION;
    const sf = new Fields(this.sink, f.at('simulation'), raw, ['active_radius', 'npc_path_budget', 'player_path_budget'], 'simulation');
    const int = (key: string, min: number, fallback: number, none = false): number | null => {
      const v = sf.raw(key);
      if (v === undefined || v === null) return fallback;
      if (none && v === 'none') return null;
      if (typeof v === 'number' && Number.isInteger(v) && v >= min) return v;
      this.sink.add(sf.at(key), `field '${key}' must be an integer ≥ ${min}${none ? ` or 'none'` : ''}, got ${JSON.stringify(v)}`);
      return fallback;
    };
    return {
      activeRadius: int('active_radius', 0, DEFAULT_SIMULATION.activeRadius!, true),
      npcPathBudget: int('npc_path_budget', 1, DEFAULT_SIMULATION.npcPathBudget)!,
      playerPathBudget: int('player_path_budget', 1, DEFAULT_SIMULATION.playerPathBudget)!,
    };
  }

  private clock(): ClockDef {
    const d = this.singletons.clock;
    if (!d) return DEFAULT_CLOCK;
    const f = this.fields(d, ['day_length', 'start', 'dawn', 'dusk'], 'clock');
    let dayLength = f.number('day_length', false) ?? DEFAULT_CLOCK.dayLength;
    if (dayLength <= 0) {
      this.sink.add(f.at('day_length'), `field 'day_length' must be a number of seconds > 0, got ${dayLength}`);
      dayLength = DEFAULT_CLOCK.dayLength;
    }
    const time = (key: 'start' | 'dawn' | 'dusk'): number => {
      const v = f.raw(key);
      if (v === undefined || v === null) return DEFAULT_CLOCK[key];
      const m = typeof v === 'string' ? parseTimeOfDay(v) : null;
      if (m === null) {
        this.sink.add(f.at(key), `field '${key}' must be a time "HH:MM" (00:00–23:59), got ${JSON.stringify(v)}`);
        return DEFAULT_CLOCK[key];
      }
      return m;
    };
    const start = time('start');
    const dawn = time('dawn');
    const dusk = time('dusk');
    if (dawn >= dusk) {
      this.sink.add(f.has('dawn') ? f.at('dawn') : f.at('dusk'), `dawn must be before dusk (daylight cannot wrap past midnight)`);
    }
    return { dayLength, start, dawn, dusk };
  }

  private lighting(): LightingDef | null {
    const d = this.singletons.lighting;
    if (!d) return null;
    const f = this.fields(d, ['tint'], 'lighting');
    const list = f.list('tint');
    if (!list) {
      if (!f.has('tint')) f.present('tint');
      return null;
    }
    if (list.length === 0) {
      this.sink.add(f.at('tint'), `field 'tint' must list at least one keyframe`);
      return null;
    }
    const tint: TintKeyframe[] = [];
    list.forEach((raw, i) => {
      const src = f.at('tint', i);
      if (!isObject(raw)) {
        this.sink.add(src, `tint keyframes must be mappings like { at: "07:00", color: "#ffffff" }`);
        return;
      }
      const kf = new Fields(this.sink, src, raw, ['at', 'color'], 'tint keyframe');
      const atStr = kf.string('at');
      const colorStr = kf.string('color');
      const minutes = atStr === undefined ? null : parseTimeOfDay(atStr);
      const colorOk = colorStr !== undefined && HEX_COLOR_RE.test(colorStr);
      if (atStr !== undefined && minutes === null) {
        this.sink.add(kf.at('at'), `field 'at' must be a time "HH:MM" (00:00–23:59), got ${JSON.stringify(atStr)}`);
      }
      if (colorStr !== undefined && !colorOk) {
        this.sink.add(kf.at('color'), `field 'color' must be a '#rrggbb' colour, got ${JSON.stringify(colorStr)}`);
      }
      if (minutes === null || !colorOk) return;
      if (tint.some((k) => k.at === minutes)) {
        this.sink.add(kf.at('at'), `duplicate tint keyframe time '${atStr}'`);
        return;
      }
      tint.push({ at: minutes, color: parseInt(colorStr.slice(1), 16) });
    });
    tint.sort((a, b) => a.at - b.at);
    return tint.length ? { tint } : null;
  }
}

/**
 * Load an ordered list of packs. Each pack's `depends` must be satisfied by
 * an earlier pack in the list. All errors are collected before failing.
 */
export function loadPacks(sources: readonly PackSource[]): LoadResult {
  return new Loader().run(sources);
}

/** Like loadPacks, but throws a PackLoadError listing every error. */
export function loadPacksOrThrow(sources: readonly PackSource[]): Definition {
  const r = loadPacks(sources);
  if (!r.ok) throw new PackLoadError(r.errors);
  return r.definition;
}
