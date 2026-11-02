/**
 * The Pixi scene for a World:
 *
 *   root (camera transform)
 *     floor z (one per map floor, raised by z × FLOOR_H; hidden above the view floor)
 *       ground   — flat tiles, one container per built 16×16 render chunk
 *       markers  — hover outline, path target outline, unreachable flash, context-menu target
 *       objects  — one container per diagonal (x + y); edge slabs, raised
 *                  tiles, ground piles and entities, depth-sorted inside
 *                  their diagonal only (see `depth.ts`)
 *
 * Floors draw in order (floor 0 ground, floor 0 objects, floor 1 ground, …),
 * so a floor sits on top of the walls below it. Empty cells draw nothing.
 * Floors above the view floor (the player's, see `cutaway.ts`) are cut away
 * by hiding their container, and raised blocks and edges just in front of
 * the player on the view floor fade.
 *
 * Edge tiles (walls, doors, windows, fences) are thin slabs on a cell's `n`
 * (top-right) or `w` (top-left) diamond side, anchored on its top vertex;
 * the `w` image is the mirrored `n` one (`TextureBank.edge`).
 *
 * Chunks are built lazily (see `chunks.ts`): a chunk's ground and raised
 * blocks and edges are created the first time it is visible or one chunk away from a
 * visible one, kept in an LRU, and destroyed once more than
 * `MAX_BUILT_CHUNKS` are built. Entity and ground-pile sprites exist only
 * while their cell is in a built, visible chunk: created when they enter one,
 * destroyed when they leave.
 *
 * Lighting is per sprite (see `lights.ts`): every tile, block, edge, pile
 * and entity sprite in a visible built chunk carries its cell's tint, the
 * pack's day/night tint (the ambient) lifted toward the colour of the local
 * lights that reach the cell; the ground and object containers stay white
 * and markers are never tinted. Each built chunk keeps a lightmap, recomputed
 * when it is built, when the map changes, when an entity light changes cell
 * near it or when a flickering light in its reach changes slot; its sprite
 * tints are rewritten only when the ambient changed, its lightmap changed or
 * it just became visible, so a still noon scene costs nothing.
 *
 * Entities show their simulation facing (`facingOf`) and, mid-step, a frame
 * of their asset's walk cycle chosen from the step progress (`walkFrame`; a
 * cycle spans two steps, the stride parity flipping each time `stepTick`
 * changes). A sprite's texture, anchor and mirroring are swapped only when
 * its pose (shown facing, frame) changes. Tiles face their cell's legend
 * `facing`.
 *
 * Map edits (`world.tileVersion`) rebuild the built chunks whose cells or
 * edges changed; an unbuilt chunk picks its edits up when it is first built.
 *
 * Only a bucket whose contents moved gets re-sorted (Pixi sorts a
 * `sortableChildren` container only when one of its children's zIndex
 * changed), so a still scene costs no sorting at all.
 */

import { Container, Sprite } from 'pixi.js';
import {
  EDGE_SIDES,
  edgeKey,
  facingOf,
  renderPosition,
  stepProgress,
  walkFrame,
  type Container as Pile,
  type EdgeSide,
  type Entity,
  type Facing,
  type LightDef,
  type World,
} from '../core/index.ts';
import { CHUNK, chunkBounds, chunkCount, chunkKeyOf, chunkLayout, chunkOf, chunksInView, ChunkLru, inShownChunk, MAX_BUILT_CHUNKS, spriteDiff, type ChunkLayout } from './chunks.ts';
import { FADE_ALPHA, fadeCells, floorVisible, viewFloor } from './cutaway.ts';
import { depthKey, diagonalOf, Layer } from './depth.ts';
import { drawOrder, spriteBounds, type HitMask } from './hit.ts';
import { chunksInReach, computeChunkLight, entitySourceId, flickerSlot, litTint, newChunkLightmap, tileSources, type ChunkLightmap, type LightSource } from './lights.ts';
import { pickTarget, type Drawn, type PickSource, type PickTarget } from './pick.ts';
import { edgeAnchorIso, FLOOR_H, groundCentreIso, tileAnchorIso, viewIsoBounds, type Bounds, type CameraState } from './projection.ts';
import type { AnchoredTexture, FacedTexture, TextureBank } from './textures.ts';
import { sceneTint } from './tint.ts';

export { CHUNK, MAX_BUILT_CHUNKS };
/** Iso-space margin so tall sprites at the viewport edge are not culled early. */
const CULL_MARGIN = 96;
const FLASH_MS = 600;
const TARGET_COLOR = 0xffd23f;
const INVALID_COLOR = 0xff3355;
const MENU_COLOR = 0xffffff;
const HOVER_COLOR = 0x8fd3ff;
const HOVER_ALPHA = 0.55;

/** A tinted sprite of a chunk: the cell it stands on and, for an edge slab, the other cell it separates (or -1). */
interface Tinted {
  readonly s: Sprite;
  readonly x: number;
  readonly y: number;
  readonly x2: number;
  readonly y2: number;
  /** The tint last written. */
  tint: number;
}

/** A built chunk. */
interface Chunk {
  readonly cx: number;
  readonly cy: number;
  readonly z: number;
  readonly ground: Container;
  /** Raised block and edge sprites (in the object buckets). */
  blocks: Sprite[];
  visible: boolean;
  /** Every tile, block and edge sprite of the chunk, for the tints. */
  tinted: Tinted[];
  /** The chunk's light (see `lights.ts`). */
  readonly light: ChunkLightmap;
  /** Tile sources within reach of the chunk, as of `lightVersion`. */
  tileLights: LightSource[];
  /** The lightmap must be recomputed. */
  lightDirty: boolean;
  /** The sprite tints must be rewritten (the lightmap changed, or the chunk just became visible). */
  tintStale: boolean;
  /** The ambient tint the sprite tints were last written with (-1: never). */
  tintAmbient: number;
}

/** An entity light's cell as of the last frame, with its reusable source record. */
interface EntityLight {
  readonly source: LightSource;
  /** Whether the entity was seen this frame. */
  seen: boolean;
}

/** The display containers of one floor. */
interface FloorView {
  readonly root: Container;
  readonly ground: Container;
  readonly markers: Container;
  readonly objects: Container;
  /** One per diagonal (x + y). */
  readonly buckets: Container[];
}

/** A sprite's pick candidate, updated in place as the sprite moves or changes texture. */
interface Pick {
  bounds: Bounds;
  mask: HitMask;
  mirrored: boolean;
  order: number;
  target: PickTarget;
  floor: number;
}

interface PileView {
  readonly sprite: Sprite;
  readonly pick: Pick;
  /** The pile's cell. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Item index shown (the pile's first stack). */
  item: number;
  /** The tint last written. */
  tint: number;
}

interface EntityView {
  readonly entity: Entity;
  readonly sprite: Sprite;
  readonly pick: Pick;
  /** Floor and diagonal of the bucket the sprite is in. */
  floor: number;
  bucket: number;
  /** Facing derived last frame (`facingOf`). */
  facing: Facing;
  /** Facing the sprite shows (after snapping to a 4-way asset). */
  shown: Facing;
  /** Walk frame the sprite shows, or -1 for the standing image. */
  frame: number;
  /** Frames in the archetype's walk cycle (0: no walk animation, always standing). */
  frames: number;
  /** The entity's `stepTick` last seen; a change means a new step began. */
  stepTick: number;
  /** Which step of a two-step cycle the current step is (renderer-only state, flips every step). */
  stride: 0 | 1;
  /** The tint last written. */
  tint: number;
}

export interface SceneStats {
  /** Chunks built now (≤ `MAX_BUILT_CHUNKS` unless more are needed at once). */
  builtChunks: number;
  visibleChunks: number;
  totalChunks: number;
  /** Entities drawn on a visible floor. */
  visibleEntities: number;
  /** Live entity and ground-pile sprites. */
  sprites: number;
  /** Light sources (tile and entity) that reached at least one built chunk this frame. */
  lights: number;
  /** Built chunks with a non-empty lightmap. */
  litChunks: number;
}

function sprite(t: AnchoredTexture): Sprite {
  const s = new Sprite(t.texture);
  apply(s, t);
  return s;
}

/** Texture, anchor and mirroring (a flip around the anchor spot). */
function apply(s: Sprite, t: AnchoredTexture): void {
  s.texture = t.texture;
  s.anchor.set(t.anchorX, t.anchorY);
  s.scale.x = t.mirrored ? -1 : 1;
}

/** Pick candidate of a sprite drawn on floor `floor`, with its current texture and position. */
function pickOf(s: Sprite, mask: HitMask, floor: number, order: number, target: PickTarget): Pick {
  const pick: Pick = { bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 }, mask, mirrored: false, order, target, floor };
  place(pick, s, mask);
  return pick;
}

/** Refresh a candidate's bounds, mask and mirroring from its sprite (bounds in scene iso, floor offset included). */
function place(pick: Pick, s: Sprite, mask: HitMask): void {
  pick.mask = mask;
  pick.mirrored = s.scale.x < 0;
  spriteBounds(s.x, s.y - pick.floor * FLOOR_H, s.texture.width, s.texture.height, s.anchor.x, s.anchor.y, pick.mirrored, pick.bounds);
}

export class IsoScene {
  readonly root = new Container();
  private readonly floors: FloorView[] = [];
  private readonly layout: ChunkLayout;
  /** Iso bounds per chunk key. */
  private readonly bounds: Bounds[] = [];
  /** Built chunks by key. */
  private readonly chunks = new Map<number, Chunk>();
  private readonly lru = new ChunkLru(MAX_BUILT_CHUNKS);
  /** Chunk keys visible in the last update. */
  private visible = new Set<number>();
  /** Entity sprites by entity id. */
  private readonly entities = new Map<number, EntityView>();
  private readonly piles = new Map<number, PileView>();
  /** Every non-empty ground pile, refreshed when `containerVersion` changes. */
  private pileList: Pile[] = [];
  private pileVersion = -1;
  private readonly target: Sprite;
  private readonly invalid: Sprite;
  private invalidUntil = 0;
  /** Steady outline on the open context menu's cell. */
  private readonly menuMark: Sprite;
  /** Faint outline on the hovered target's cell. */
  private readonly hoverMark: Sprite;
  /** The ambient tint (the pack's day/night tint; white without one). */
  private tint = 0xffffff;
  /** Entity lights by entity id: their cell last frame. */
  private readonly entityLights = new Map<number, EntityLight>();
  /** The frame's entity sources (the `entityLights` records seen this frame). */
  private readonly frameLights: LightSource[] = [];
  /** Chunk keys whose lightmap an entity light's move made stale this frame. */
  private readonly lightDirtyKeys = new Set<number>();
  /** Every built chunk's tile sources must be gathered again (the map changed). */
  private lightsDirtyAll = true;
  /** The flicker slot of the last update. */
  private slot = -1;
  /** Source ids that reached a built chunk (for the `lights` stat); recounted when a lightmap changes. */
  private readonly reachedIds = new Set<number>();
  private lightCount = 0;
  private lightCountDirty = true;
  /** Tile index per cell as drawn by a built chunk (to find the cells a map edit changed). */
  private readonly drawn: Uint16Array;
  /** Edge tile per cell side as drawn by a built chunk, like `drawn`. */
  private readonly drawnN: Uint16Array;
  private readonly drawnW: Uint16Array;
  private tileVersion: number;
  /** Raised block sprite per cell index (built chunks only). */
  private readonly blockAt = new Map<number, Sprite>();
  /** Pick candidate per raised block, by cell index (as `blockAt`). */
  private readonly blockPick = new Map<number, Drawn>();
  /** Edge sprite per `edgeKey` (built chunks only). */
  private readonly edgeAt = new Map<number, Sprite>();
  /** Pick candidate per edge sprite, by `edgeKey` (as `edgeAt`). */
  private readonly edgePick = new Map<number, Drawn>();
  /** The camera of the last update (what picking sees). */
  private cam: CameraState = { offsetX: 0, offsetY: 0, zoom: 1 };
  /** The view floor (-1 before the first update). */
  private view = -1;
  /** Faded blocks and edges, and the player cell, view floor and tile version they were computed for. */
  private faded = new Set<Sprite>();
  private fadeKey = '';

  constructor(
    private readonly world: World,
    private readonly textures: TextureBank,
  ) {
    const { grid } = world;
    this.drawn = Uint16Array.from(grid.cells);
    this.drawnN = Uint16Array.from(grid.edgeN);
    this.drawnW = Uint16Array.from(grid.edgeW);
    this.tileVersion = world.tileVersion;
    this.layout = chunkLayout(grid.width, grid.height, grid.floors);
    for (let key = 0; key < chunkCount(this.layout); key++) this.bounds.push(chunkBounds(this.layout, key));

    for (let z = 0; z < grid.floors; z++) {
      const f: FloorView = { root: new Container(), ground: new Container(), markers: new Container(), objects: new Container(), buckets: [] };
      f.root.position.set(0, -z * FLOOR_H);
      f.root.addChild(f.ground, f.markers, f.objects);
      for (let d = 0; d <= grid.width + grid.height; d++) {
        const b = new Container();
        b.sortableChildren = true;
        f.buckets.push(b);
        f.objects.addChild(b);
      }
      this.floors.push(f);
      this.root.addChild(f.root);
    }

    this.target = sprite(textures.outline(TARGET_COLOR));
    this.invalid = sprite(textures.outline(INVALID_COLOR));
    this.menuMark = sprite(textures.outline(MENU_COLOR));
    this.hoverMark = sprite(textures.outline(HOVER_COLOR));
    this.hoverMark.alpha = HOVER_ALPHA;
    this.target.visible = this.invalid.visible = this.menuMark.visible = this.hoverMark.visible = false;
    this.floors[0]!.markers.addChild(this.hoverMark, this.target, this.invalid, this.menuMark);
  }

  /** Create a chunk's tile sprites: flat tiles in its ground container, raised ones and edges in the object buckets. Empty cells draw nothing. */
  private buildChunk(key: number): void {
    const { cx, cy, z } = chunkOf(this.layout, key);
    const ground = new Container();
    this.floors[z]!.ground.addChild(ground);
    const chunk: Chunk = {
      cx: cx * CHUNK,
      cy: cy * CHUNK,
      z,
      ground,
      blocks: [],
      visible: true,
      tinted: [],
      light: newChunkLightmap(cx * CHUNK, cy * CHUNK, z),
      tileLights: [],
      lightDirty: true,
      tintStale: true,
      tintAmbient: -1,
    };
    this.fillChunk(chunk);
    this.chunks.set(key, chunk);
  }

  /** Destroy a chunk's sprites. */
  private clearChunk(chunk: Chunk): void {
    const { grid } = this.world;
    for (const s of chunk.ground.removeChildren()) s.destroy();
    for (const s of chunk.blocks) s.destroy();
    chunk.tinted = [];
    chunk.tintStale = true;
    for (let y = chunk.cy; y < Math.min(chunk.cy + CHUNK, grid.height); y++) {
      for (let x = chunk.cx; x < Math.min(chunk.cx + CHUNK, grid.width); x++) {
        const i = grid.index(x, y, chunk.z);
        this.blockAt.delete(i);
        this.blockPick.delete(i);
        for (const side of EDGE_SIDES) {
          this.edgeAt.delete(edgeKey(i, side));
          this.edgePick.delete(edgeKey(i, side));
        }
      }
    }
    chunk.blocks = [];
  }

  private evictChunk(key: number): void {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    this.clearChunk(chunk);
    chunk.ground.destroy();
    this.chunks.delete(key);
    this.lightCountDirty = true;
    this.dropDestroyedFades();
  }

  private dropDestroyedFades(): void {
    for (const s of this.faded) if (s.destroyed) this.faded.delete(s);
  }

  private fillChunk(chunk: Chunk): void {
    const { grid } = this.world;
    const { facings } = this.world.def.maps[this.world.def.start.map]!;
    const { z } = chunk;
    const buckets = this.floors[z]!.buckets;
    for (let y = chunk.cy; y < Math.min(chunk.cy + CHUNK, grid.height); y++) {
      for (let x = chunk.cx; x < Math.min(chunk.cx + CHUNK, grid.width); x++) {
        const i = grid.index(x, y, z);
        this.drawn[i] = grid.cells[i]!;
        this.drawnN[i] = grid.edgeN[i]!;
        this.drawnW[i] = grid.edgeW[i]!;
        for (const side of EDGE_SIDES) this.addEdge(chunk, x, y, z, i, side);
        const tile = grid.tileAt(x, y, z);
        if (!tile) continue;
        const t = this.textures.tile(tile, facings[i] ?? null);
        const s = sprite(t);
        const p = tileAnchorIso(x, y);
        s.position.set(p.x, p.y);
        chunk.tinted.push({ s, x, y, x2: -1, y2: -1, tint: 0xffffff });
        if (tile.raised) {
          this.blockPick.set(i, pickOf(s, this.textures.mask(t.texture), z, drawOrder(z, x, y, Layer.Block), { kind: 'tile', x, y, z }));
          s.zIndex = depthKey(x, y, Layer.Block);
          s.visible = chunk.visible;
          buckets[diagonalOf(x, y)]!.addChild(s);
          chunk.blocks.push(s);
          this.blockAt.set(i, s);
        } else {
          chunk.ground.addChild(s);
        }
      }
    }
    this.fadeKey = ''; // the player's surroundings may have new block sprites
  }

  /** The edge slab on `side` of cell (x, y, z) (cell index `i`), if it has one. */
  private addEdge(chunk: Chunk, x: number, y: number, z: number, i: number, side: EdgeSide): void {
    const tile = this.world.grid.edgeAt(x, y, z, side);
    if (!tile) return;
    const t = this.textures.edge(tile, side);
    const s = sprite(t);
    const p = edgeAnchorIso(x, y);
    s.position.set(p.x, p.y);
    s.zIndex = depthKey(x, y, Layer.Edge);
    s.visible = chunk.visible;
    this.floors[z]!.buckets[diagonalOf(x, y)]!.addChild(s);
    chunk.blocks.push(s);
    // The slab takes the brighter of the two cells it separates; the other side may lie in another chunk or off the map.
    const x2 = side === 'w' ? x - 1 : x;
    const y2 = side === 'n' ? y - 1 : y;
    const inside = x2 >= 0 && y2 >= 0;
    chunk.tinted.push({ s, x, y, x2: inside ? x2 : -1, y2: inside ? y2 : -1, tint: 0xffffff });
    const key = edgeKey(i, side);
    this.edgeAt.set(key, s);
    this.edgePick.set(key, pickOf(s, this.textures.mask(t.texture), z, drawOrder(z, x, y, Layer.Edge), { kind: 'edge', x, y, z, side }));
  }

  /** After a map edit: rebuild every built chunk with a changed cell or edge (ground, raised blocks and edges). */
  private syncTiles(): void {
    const { world } = this;
    if (world.tileVersion === this.tileVersion) return;
    this.tileVersion = world.tileVersion;
    // A barricade or a shutter changes where light goes: every built chunk gathers its sources and casts again.
    this.lightsDirtyAll = true;
    const { grid } = world;
    for (const chunk of this.chunks.values()) {
      let dirty = false;
      for (let y = chunk.cy; y < Math.min(chunk.cy + CHUNK, grid.height) && !dirty; y++) {
        for (let x = chunk.cx; x < Math.min(chunk.cx + CHUNK, grid.width); x++) {
          const i = grid.index(x, y, chunk.z);
          if (grid.cells[i] !== this.drawn[i] || grid.edgeN[i] !== this.drawnN[i] || grid.edgeW[i] !== this.drawnW[i]) {
            dirty = true;
            break;
          }
        }
      }
      if (!dirty) continue;
      this.clearChunk(chunk);
      this.fillChunk(chunk);
    }
    this.dropDestroyedFades();
  }

  /** Create, retexture or destroy ground-pile sprites: only non-empty piles in built, visible chunks have one. */
  private syncPiles(): void {
    const { world } = this;
    if (world.containerVersion !== this.pileVersion) {
      this.pileVersion = world.containerVersion;
      this.pileList = [];
      for (const c of world.containers.values()) if (c.kind === 'ground' && c.stacks.length > 0) this.pileList.push(c);
    }
    const wanted = this.pileList.filter((c) => inShownChunk(this.layout, this.chunks, this.visible, c.x, c.y, c.z));
    const diff = spriteDiff(this.piles.keys(), wanted.map((c) => c.id));
    for (const id of diff.destroy) {
      this.piles.get(id)!.sprite.destroy();
      this.piles.delete(id);
    }
    for (const c of wanted) {
      const item = c.stacks[0]!.item;
      const v = this.piles.get(c.id);
      if (!v) {
        const t = this.textures.item(world.def.items[item]!);
        const s = sprite(t);
        const p = groundCentreIso(c.x, c.y);
        s.position.set(p.x, p.y);
        s.zIndex = depthKey(c.x, c.y, Layer.Pile);
        this.floors[c.z]!.buckets[diagonalOf(c.x, c.y)]!.addChild(s);
        const target: PickTarget = { kind: 'pile', x: c.x, y: c.y, z: c.z, container: c };
        this.piles.set(c.id, { sprite: s, item, pick: pickOf(s, this.textures.mask(t.texture), c.z, drawOrder(c.z, c.x, c.y, Layer.Pile), target), x: c.x, y: c.y, z: c.z, tint: 0xffffff });
      } else if (v.item !== item) {
        const t = this.textures.item(world.def.items[item]!);
        apply(v.sprite, t);
        place(v.pick, v.sprite, this.textures.mask(t.texture));
        v.item = item;
      }
    }
  }

  /** Put a marker on a cell of floor `z`. */
  private place(marker: Sprite, x: number, y: number, z: number): void {
    const p = tileAnchorIso(x, y);
    marker.position.set(p.x, p.y);
    const markers = this.floors[Math.min(Math.max(z, 0), this.floors.length - 1)]!.markers;
    if (marker.parent !== markers) markers.addChild(marker);
  }

  /** Flash a tile red: the player cannot get there. */
  flashUnreachable(x: number, y: number, z: number, now: number): void {
    this.place(this.invalid, x, y, z);
    this.invalid.visible = true;
    this.invalidUntil = now + FLASH_MS;
  }

  /** Outline the hovered target's cell (null hides it). */
  markHover(cell: { x: number; y: number; z: number } | null): void {
    this.hoverMark.visible = cell !== null;
    if (cell) this.place(this.hoverMark, cell.x, cell.y, cell.z);
  }

  /** Outline a cell while the context menu is open for it (null hides it). */
  markMenuTarget(cell: { x: number; y: number; z: number } | null): void {
    this.menuMark.visible = cell !== null;
    if (cell) this.place(this.menuMark, cell.x, cell.y, cell.z);
  }

  /** Destroy the scene's display objects; shared textures stay alive for the next scene. */
  destroy(): void {
    this.root.removeFromParent();
    this.root.destroy({ children: true });
  }

  /** Show floors up to the view floor and fade the blocks and edges in front of the player on it. */
  private cutaway(alpha: number): void {
    const { world } = this;
    const p = world.player;
    const view = viewFloor(renderPosition(p, world.tick, alpha).z, this.floors.length);
    if (view !== this.view) {
      this.view = view;
      this.floors.forEach((f, z) => (f.root.visible = floorVisible(z, view)));
    }
    const key = `${p.x},${p.y},${view}`;
    if (key === this.fadeKey) return;
    this.fadeKey = key;
    for (const s of this.faded) s.alpha = 1;
    this.faded.clear();
    const { grid } = world;
    for (const c of fadeCells(p.x, p.y)) {
      if (!grid.inBounds(c.x, c.y, view)) continue;
      const i = grid.index(c.x, c.y, view);
      for (const s of [this.blockAt.get(i), this.edgeAt.get(edgeKey(i, 'n')), this.edgeAt.get(edgeKey(i, 'w'))]) {
        if (!s) continue;
        s.alpha = FADE_ALPHA;
        this.faded.add(s);
      }
    }
  }

  /** What picking sees of the scene as last updated (built on the first pick). */
  private pickSource: PickSource | null = null;

  private makePickSource(): PickSource {
    const { grid } = this.world;
    return {
      grid,
      reach: this.textures.reach,
      block: (x, y, z) => {
        const i = grid.index(x, y, z);
        const s = this.blockAt.get(i);
        return s && s.visible && !this.faded.has(s) ? (this.blockPick.get(i) ?? null) : null;
      },
      edge: (x, y, z, side) => {
        const key = edgeKey(grid.index(x, y, z), side);
        const s = this.edgeAt.get(key);
        return s && s.visible && !this.faded.has(s) ? (this.edgePick.get(key) ?? null) : null;
      },
      faded: (x, y, z) => {
        const s = this.blockAt.get(grid.index(x, y, z));
        return s !== undefined && this.faded.has(s);
      },
      objects: () => this.drawnObjects(),
    };
  }

  private *drawnObjects(): Iterable<Drawn> {
    for (const v of this.piles.values()) yield v.pick;
    for (const v of this.entities.values()) yield v.pick;
  }

  /**
   * The target drawn under screen point (sx, sy) as of the last update: the
   * frontmost edge slab, raised block, ground pile or entity whose opaque pixels
   * contain it on a visible floor (faded blocks and edges are skipped), else the
   * ground cell (`pickCell`, falling through empty cells to lower floors).
   */
  pickTarget(sx: number, sy: number): PickTarget {
    return pickTarget(sx, sy, this.cam, Math.max(0, this.view), (this.pickSource ??= this.makePickSource()));
  }

  /**
   * Applies the camera, builds and evicts chunks, creates and destroys
   * entity and pile sprites, interpolates and re-buckets entities.
   */
  update(cam: CameraState, viewW: number, viewH: number, alpha: number, now: number): SceneStats {
    this.cam = cam;
    this.root.position.set(cam.offsetX, cam.offsetY);
    this.root.scale.set(cam.zoom);
    const view = viewIsoBounds(cam, viewW, viewH, CULL_MARGIN);

    this.syncTiles();
    const near = chunksInView(this.layout, this.bounds, view);
    this.visible = new Set(near.visible);
    const { build, evict } = this.lru.update(near.near);
    for (const key of evict) this.evictChunk(key);
    for (const key of build) this.buildChunk(key);
    for (const [key, c] of this.chunks) {
      const vis = this.visible.has(key);
      if (vis === c.visible) continue;
      c.visible = vis;
      c.ground.visible = vis;
      for (const s of c.blocks) s.visible = vis;
    }

    const { tick } = this.world;
    // The ambient: the pack's day/night tint. Containers stay white; every sprite carries its cell's tint (see `tints`).
    const tint = sceneTint(this.world.def, tick, alpha);
    if (tint !== null) this.tint = tint;

    this.syncPiles();
    this.cutaway(alpha);

    // Entity sprites: only for entities in built, visible chunks. Entity
    // lights are collected here too, wherever their entity stands.
    const top = this.floors.length - 1;
    const floorOf = (r: { z: number }) => Math.min(top, Math.max(0, Math.floor(r.z + 0.5)));
    const positions = new Map<number, { x: number; y: number; z: number }>();
    for (const el of this.entityLights.values()) el.seen = false;
    this.frameLights.length = 0;
    for (const entity of this.world.entities) {
      const r = renderPosition(entity, tick, alpha);
      const cx = Math.floor(r.x);
      const cy = Math.floor(r.y);
      const cz = floorOf(r);
      if (inShownChunk(this.layout, this.chunks, this.visible, cx, cy, cz)) positions.set(entity.id, r);
      if (entity.archetype.light) this.entityLight(entity.id, entity.archetype.light, cx, cy, cz);
    }
    for (const [id, el] of this.entityLights) {
      if (el.seen) continue;
      this.dirtyInReach(el.source);
      this.entityLights.delete(id);
    }
    this.lights(now);
    this.tints();
    const diff = spriteDiff(this.entities.keys(), positions.keys());
    for (const id of diff.destroy) {
      this.entities.get(id)!.sprite.destroy();
      this.entities.delete(id);
    }
    for (const id of diff.create) {
      const entity = this.world.entities[id]!;
      const r = positions.get(id)!;
      const facing = facingOf(entity);
      const t: FacedTexture = this.textures.archetype(entity.archetype, facing, null);
      const s = sprite(t);
      const floor = floorOf(r);
      const bucket = diagonalOf(r.x, r.y);
      this.floors[floor]!.buckets[bucket]!.addChild(s);
      const target: PickTarget = { kind: 'entity', x: entity.x, y: entity.y, z: entity.z, entity };
      const pick = pickOf(s, this.textures.mask(t.texture), floor, drawOrder(floor, r.x, r.y, Layer.Entity), target);
      const frames = this.textures.walkFrames(entity.archetype);
      // The pose loop below picks the walk frame on this same update (frame -1 ≠ any frame mid-step).
      this.entities.set(id, { entity, sprite: s, pick, floor, bucket, facing, shown: t.facing, frame: -1, frames, stepTick: entity.stepTick, stride: 0, tint: 0xffffff });
    }

    let visibleEntities = 0;
    for (const v of this.entities.values()) {
      const r = positions.get(v.entity.id)!;
      const floor = floorOf(r);
      const p = groundCentreIso(r.x, r.y);
      // Within its floor's container, an entity mid-climb is offset by the rest of its height.
      const py = p.y - (r.z - floor) * FLOOR_H;
      const s = v.sprite;
      if (floorVisible(floor, this.view)) visibleEntities++;
      // Lit by the cell it is rendered in (compare-and-set: a few ops per sprite).
      const et = this.cellTint(Math.floor(r.x), Math.floor(r.y), floor);
      if (et !== v.tint) s.tint = v.tint = et;
      let moved = false;
      if (s.x !== p.x || s.y !== py || floor !== v.pick.floor) {
        s.position.set(p.x, py);
        v.pick.floor = floor;
        v.pick.order = drawOrder(floor, r.x, r.y, Layer.Entity);
        moved = true;
      }
      const facing = facingOf(v.entity);
      // The pose: the shown facing plus, mid-step, a walk frame. A cycle spans
      // two steps, so the stride parity flips whenever a new step begins.
      let frame = -1;
      if (v.frames > 0) {
        const e = v.entity;
        if (e.stepTick !== v.stepTick) {
          v.stepTick = e.stepTick;
          v.stride = v.stride === 0 ? 1 : 0;
        }
        // An entity that never stepped (`from` is its cell, `stepTick` 0) stands, whatever the clock says.
        if (e.fromX !== e.x || e.fromY !== e.y || e.fromZ !== e.z) frame = walkFrame(stepProgress(e, tick, alpha), v.stride, v.frames) ?? -1;
      }
      if (facing !== v.facing || frame !== v.frame) {
        v.facing = facing;
        const t = this.textures.archetype(v.entity.archetype, facing, v.shown, frame);
        if (t.facing !== v.shown || frame !== v.frame) {
          v.shown = t.facing;
          v.frame = frame;
          apply(s, t);
          moved = true;
        }
      }
      if (moved) place(v.pick, s, this.textures.mask(s.texture));
      const bucket = diagonalOf(r.x, r.y);
      if (bucket !== v.bucket || floor !== v.floor) {
        this.floors[floor]!.buckets[bucket]!.addChild(s); // reparents
        v.bucket = bucket;
        v.floor = floor;
      }
      const z = depthKey(r.x, r.y, Layer.Entity);
      if (s.zIndex !== z) s.zIndex = z;
    }

    const goal = this.world.pathGoal(this.world.player);
    this.target.visible = goal !== null;
    if (goal) this.place(this.target, goal.x, goal.y, goal.z);
    if (this.invalid.visible && now > this.invalidUntil) this.invalid.visible = false;

    let litChunks = 0;
    for (const c of this.chunks.values()) if (c.light.lit > 0) litChunks++;
    return {
      builtChunks: this.chunks.size,
      visibleChunks: near.visible.length,
      totalChunks: this.bounds.length,
      visibleEntities,
      sprites: this.entities.size + this.piles.size,
      lights: this.lightCount,
      litChunks,
    };
  }

  // ── Local lights ─────────────────────────────────────────────────────────

  /** Record an entity light at its rendered cell; a cell or floor change dirties the chunks in reach of both cells. */
  private entityLight(id: number, light: LightDef, x: number, y: number, z: number): void {
    let el = this.entityLights.get(id);
    if (!el) {
      el = { source: { id: entitySourceId(id), x, y, z, x2: -1, y2: -1, light, seed: id }, seen: true };
      this.entityLights.set(id, el);
      this.dirtyInReach(el.source);
    } else {
      el.seen = true;
      const s = el.source;
      if (s.x !== x || s.y !== y || s.z !== z || s.light !== light) {
        this.dirtyInReach(s);
        s.x = x;
        s.y = y;
        s.z = z;
        s.light = light;
        this.dirtyInReach(s);
      }
    }
    this.frameLights.push(el.source);
  }

  private dirtyInReach(s: LightSource): void {
    for (const key of chunksInReach(this.layout, s.x, s.y, s.z, s.light.radius)) this.lightDirtyKeys.add(key);
  }

  /**
   * Recompute the lightmaps that went stale: every built chunk after a map
   * edit (its tile sources are gathered again), a freshly built chunk, the
   * chunks in reach of an entity light that changed cell, and those a
   * flickering source reaches when the flicker slot changes.
   */
  private lights(now: number): void {
    const slot = flickerSlot(now);
    const slotChanged = slot !== this.slot;
    this.slot = slot;
    const { grid, def } = this.world;
    for (const [key, c] of this.chunks) {
      if (this.lightsDirtyAll) {
        c.tileLights = tileSources(grid, def.tiles, c.cx, c.cy, c.z);
        c.lightDirty = true;
      } else if (this.lightDirtyKeys.has(key) || (slotChanged && c.light.flickering)) c.lightDirty = true;
      if (!c.lightDirty) continue;
      c.lightDirty = false;
      const sources = this.frameLights.length ? [...c.tileLights, ...this.frameLights] : c.tileLights;
      computeChunkLight(grid, c.cx, c.cy, c.z, sources, now, c.light);
      this.lightCountDirty = true;
      // The chunk's own sprites, and the edge slabs of the chunks to its right and below that border its cells.
      c.tintStale = true;
      this.markTintStale(key + 1, c.cx + CHUNK, c.cy, c.z);
      this.markTintStale(key + this.layout.cols, c.cx, c.cy + CHUNK, c.z);
    }
    this.lightsDirtyAll = false;
    this.lightDirtyKeys.clear();
    if (this.lightCountDirty) {
      this.lightCountDirty = false;
      this.reachedIds.clear();
      for (const c of this.chunks.values()) for (const id of c.light.reached) this.reachedIds.add(id);
      this.lightCount = this.reachedIds.size;
    }
  }

  private markTintStale(key: number, x: number, y: number, z: number): void {
    if (!this.world.grid.inBounds(x, y, z)) return;
    const c = this.chunks.get(key);
    if (c) c.tintStale = true;
  }

  /** The intensity and colour of the light at a cell, from its chunk's lightmap (unlit where the chunk is not built). */
  private lightI = 0;
  private lightC = 0;
  private lightAt(x: number, y: number, z: number): void {
    this.lightI = 0;
    const { grid } = this.world;
    if (!grid.inBounds(x, y, z)) return;
    const c = this.chunks.get(chunkKeyOf(this.layout, x, y, z));
    if (!c) return;
    const k = (y - c.cy) * CHUNK + (x - c.cx);
    this.lightI = c.light.intensity[k]!;
    this.lightC = c.light.color[k]!;
  }

  /** The tint of a sprite standing on a cell: the ambient lifted by the cell's light. */
  private cellTint(x: number, y: number, z: number): number {
    this.lightAt(x, y, z);
    return this.lightI > 0 ? litTint(this.tint, this.lightC, this.lightI) : this.tint;
  }

  /**
   * Rewrite the sprite tints of the visible chunks whose ambient changed
   * since their last refresh, whose lightmap changed or that just became
   * visible; piles compare-and-set theirs every frame. A hidden chunk is
   * left alone (its `tintStale` stays set).
   */
  private tints(): void {
    const ambient = this.tint;
    for (const c of this.chunks.values()) {
      if (!c.visible || (!c.tintStale && c.tintAmbient === ambient)) continue;
      c.tintStale = false;
      c.tintAmbient = ambient;
      for (const t of c.tinted) {
        this.lightAt(t.x, t.y, c.z);
        let i = this.lightI;
        let color = this.lightC;
        if (t.x2 >= 0) {
          // An edge slab takes the brighter of the two cells it separates.
          this.lightAt(t.x2, t.y2, c.z);
          if (this.lightI > i) {
            i = this.lightI;
            color = this.lightC;
          }
        }
        const tint = i > 0 ? litTint(ambient, color, i) : ambient;
        if (tint !== t.tint) t.s.tint = t.tint = tint;
      }
    }
    for (const v of this.piles.values()) {
      const tint = this.cellTint(v.x, v.y, v.z);
      if (tint !== v.tint) v.sprite.tint = v.tint = tint;
    }
  }
}
