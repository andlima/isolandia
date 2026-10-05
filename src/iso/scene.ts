/**
 * The Pixi scene for a World:
 *
 *   root (camera transform)
 *     floor z (one per map floor, raised by z × FLOOR_H; hidden above the view floor)
 *       ground   — flat tiles, one container per 16×16 render chunk (culled)
 *       markers  — path target outline, unreachable flash, context-menu target
 *       objects  — one container per diagonal (x + y); raised tiles, ground
 *                  piles and entities, depth-sorted inside their diagonal only
 *
 * Floors draw in order (floor 0 ground, floor 0 objects, floor 1 ground, …),
 * so a floor sits on top of the walls below it. Empty cells draw nothing.
 * Floors above the view floor (the player's, see `cutaway.ts`) are cut away
 * by hiding their container, and raised blocks just in front of the player
 * on the view floor fade.
 *
 * Ground and objects are multiplied by the pack's day/night tint (if any);
 * markers are not.
 *
 * Entities show their simulation facing (`facingOf`); a sprite's
 * texture, anchor and mirroring are swapped only when the direction it shows
 * changes. Tiles face their cell's legend `facing`.
 *
 * Map edits (`world.tileVersion`) rebuild the render chunks whose cells
 * changed: their ground container and their raised blocks.
 *
 * Only a bucket whose contents moved gets re-sorted (Pixi sorts a
 * `sortableChildren` container only when one of its children's zIndex
 * changed), so a still scene costs no sorting at all.
 */

import { Container, Sprite } from 'pixi.js';
import { facingOf, renderPosition, type Entity, type Facing, type World } from '../core/index.ts';
import { FADE_ALPHA, fadeCells, floorVisible, viewFloor } from './cutaway.ts';
import { depthKey, diagonalOf, Layer } from './depth.ts';
import {
  BLOCK_H,
  FLOOR_H,
  groundCentreIso,
  intersects,
  tileAnchorIso,
  tileRectIsoBounds,
  viewIsoBounds,
  type Bounds,
  type CameraState,
} from './projection.ts';
import type { AnchoredTexture, FacedTexture, TextureBank } from './textures.ts';
import { sceneTint } from './tint.ts';

export const CHUNK = 16;
/** Iso-space margin so tall sprites at the viewport edge are not culled early. */
const CULL_MARGIN = 96;
const FLASH_MS = 600;
const TARGET_COLOR = 0xffd23f;
const INVALID_COLOR = 0xff3355;
const MENU_COLOR = 0xffffff;

interface Chunk {
  readonly cx: number;
  readonly cy: number;
  readonly z: number;
  readonly ground: Container;
  blocks: Sprite[];
  readonly bounds: Bounds;
  visible: boolean;
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

interface PileView {
  readonly sprite: Sprite;
  /** Item index shown (the pile's first stack). */
  item: number;
}

interface EntityView {
  readonly entity: Entity;
  readonly sprite: Sprite;
  /** Floor and diagonal of the bucket the sprite is in. */
  floor: number;
  bucket: number;
  /** Facing derived last frame (`facingOf`). */
  facing: Facing;
  /** Facing the sprite shows (after snapping to a 4-way asset). */
  shown: Facing;
}

export interface SceneStats {
  visibleChunks: number;
  totalChunks: number;
  visibleEntities: number;
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

export class IsoScene {
  readonly root = new Container();
  private readonly floors: FloorView[] = [];
  private readonly chunks: Chunk[] = [];
  private readonly entities: EntityView[] = [];
  private readonly piles = new Map<number, PileView>();
  private pileVersion = -1;
  private readonly target: Sprite;
  private readonly invalid: Sprite;
  private invalidUntil = 0;
  /** Steady outline on the open context menu's cell. */
  private readonly menuMark: Sprite;
  private tint = 0xffffff;
  /** Tile index per cell as drawn (to find the cells a map edit changed). */
  private readonly drawn: Uint16Array;
  private tileVersion: number;
  /** Raised block sprite per cell index. */
  private readonly blockAt = new Map<number, Sprite>();
  /** The view floor (-1 before the first update). */
  private view = -1;
  /** Faded blocks, and the player cell, view floor and tile version they were computed for. */
  private faded: Sprite[] = [];
  private fadeKey = '';

  constructor(
    private readonly world: World,
    private readonly textures: TextureBank,
  ) {
    const { grid } = world;
    this.drawn = Uint16Array.from(grid.cells);
    this.tileVersion = world.tileVersion;

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

    for (let z = 0; z < grid.floors; z++) {
      for (let cy = 0; cy < grid.height; cy += CHUNK) {
        for (let cx = 0; cx < grid.width; cx += CHUNK) {
          const ground = new Container();
          this.floors[z]!.ground.addChild(ground);
          const bounds = tileRectIsoBounds(cx, cy, CHUNK, CHUNK);
          bounds.minY -= BLOCK_H * 3 + z * FLOOR_H; // raised tiles and tall sprites
          bounds.maxY -= z * FLOOR_H;
          const chunk: Chunk = { cx, cy, z, ground, blocks: [], bounds, visible: true };
          this.fillChunk(chunk);
          this.chunks.push(chunk);
        }
      }
    }

    for (const entity of world.entities) {
      const facing = facingOf(entity);
      const t: FacedTexture = textures.archetype(entity.archetype, facing, null);
      const s = sprite(t);
      const bucket = diagonalOf(entity.x, entity.y);
      this.floors[entity.z]!.buckets[bucket]!.addChild(s);
      this.entities.push({ entity, sprite: s, floor: entity.z, bucket, facing, shown: t.facing });
    }

    this.target = sprite(textures.outline(TARGET_COLOR));
    this.invalid = sprite(textures.outline(INVALID_COLOR));
    this.menuMark = sprite(textures.outline(MENU_COLOR));
    this.target.visible = this.invalid.visible = this.menuMark.visible = false;
    this.floors[0]!.markers.addChild(this.target, this.invalid, this.menuMark);
  }

  /** Create the tile sprites of a chunk: flat tiles in its ground container, raised ones in the object buckets. Empty cells draw nothing. */
  private fillChunk(chunk: Chunk): void {
    const { grid } = this.world;
    const { facings } = this.world.def.maps[this.world.def.start.map]!;
    const { z } = chunk;
    const buckets = this.floors[z]!.buckets;
    for (let y = chunk.cy; y < Math.min(chunk.cy + CHUNK, grid.height); y++) {
      for (let x = chunk.cx; x < Math.min(chunk.cx + CHUNK, grid.width); x++) {
        const tile = grid.tileAt(x, y, z);
        if (!tile) continue;
        const i = grid.index(x, y, z);
        const s = sprite(this.textures.tile(tile, facings[i] ?? null));
        const p = tileAnchorIso(x, y);
        s.position.set(p.x, p.y);
        if (tile.raised) {
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
  }

  /** After a map edit: rebuild every chunk with a changed cell (ground and raised blocks). */
  private syncTiles(): void {
    const { world } = this;
    if (world.tileVersion === this.tileVersion) return;
    this.tileVersion = world.tileVersion;
    const { grid } = world;
    const perRow = Math.ceil(grid.width / CHUNK);
    const perFloor = perRow * Math.ceil(grid.height / CHUNK);
    const dirty = new Set<number>();
    for (let i = 0; i < grid.cells.length; i++) {
      if (grid.cells[i] === this.drawn[i]) continue;
      this.drawn[i] = grid.cells[i]!;
      const { x, y, z } = grid.cellOf(i);
      dirty.add(z * perFloor + Math.floor(y / CHUNK) * perRow + Math.floor(x / CHUNK));
    }
    for (const k of dirty) {
      const chunk = this.chunks[k]!;
      for (const s of chunk.ground.removeChildren()) s.destroy();
      for (const s of chunk.blocks) s.destroy();
      for (let y = chunk.cy; y < Math.min(chunk.cy + CHUNK, grid.height); y++) {
        for (let x = chunk.cx; x < Math.min(chunk.cx + CHUNK, grid.width); x++) this.blockAt.delete(grid.index(x, y, chunk.z));
      }
      chunk.blocks = [];
      this.fillChunk(chunk);
    }
    this.fadeKey = ''; // faded sprites may have been replaced
    this.faded = this.faded.filter((s) => !s.destroyed);
  }

  /** Add, retexture or remove ground-pile sprites after container changes. */
  private syncPiles(): void {
    const { world } = this;
    if (world.containerVersion === this.pileVersion) return;
    this.pileVersion = world.containerVersion;
    const live = new Set<number>();
    for (const c of world.containers.values()) {
      if (c.kind !== 'ground' || c.stacks.length === 0) continue;
      live.add(c.id);
      const item = c.stacks[0]!.item;
      let v = this.piles.get(c.id);
      if (!v) {
        const s = sprite(this.textures.item(world.def.items[item]!));
        const p = groundCentreIso(c.x, c.y);
        s.position.set(p.x, p.y);
        s.zIndex = depthKey(c.x, c.y, Layer.Pile);
        this.floors[c.z]!.buckets[diagonalOf(c.x, c.y)]!.addChild(s);
        v = { sprite: s, item };
        this.piles.set(c.id, v);
      } else if (v.item !== item) {
        apply(v.sprite, this.textures.item(world.def.items[item]!));
        v.item = item;
      }
    }
    for (const [id, v] of this.piles) {
      if (live.has(id)) continue;
      v.sprite.destroy();
      this.piles.delete(id);
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

  /** Show floors up to the view floor and fade the blocks in front of the player on it. */
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
    this.faded = [];
    const { grid } = world;
    for (const c of fadeCells(p.x, p.y)) {
      if (!grid.inBounds(c.x, c.y, view)) continue;
      const s = this.blockAt.get(grid.index(c.x, c.y, view));
      if (!s) continue;
      s.alpha = FADE_ALPHA;
      this.faded.push(s);
    }
  }

  /** Applies the camera, culls chunks and entities, interpolates and re-buckets entities. */
  update(cam: CameraState, viewW: number, viewH: number, alpha: number, now: number): SceneStats {
    this.root.position.set(cam.offsetX, cam.offsetY);
    this.root.scale.set(cam.zoom);
    const view = viewIsoBounds(cam, viewW, viewH, CULL_MARGIN);

    let visibleChunks = 0;
    for (const c of this.chunks) {
      const vis = intersects(c.bounds, view);
      if (vis) visibleChunks++;
      if (vis !== c.visible) {
        c.visible = vis;
        c.ground.visible = vis;
        for (const s of c.blocks) s.visible = vis;
      }
    }

    const { tick } = this.world;
    const tint = sceneTint(this.world.def, tick, alpha);
    if (tint !== null && tint !== this.tint) {
      this.tint = tint;
      for (const f of this.floors) {
        f.ground.tint = tint;
        f.objects.tint = tint;
      }
    }

    this.syncTiles();
    this.syncPiles();
    this.cutaway(alpha);

    let visibleEntities = 0;
    const top = this.floors.length - 1;
    for (const v of this.entities) {
      const r = renderPosition(v.entity, tick, alpha);
      const floor = Math.min(top, Math.max(0, Math.floor(r.z + 0.5)));
      const p = groundCentreIso(r.x, r.y);
      // Within its floor's container, an entity mid-climb is offset by the rest of its height.
      const py = p.y - (r.z - floor) * FLOOR_H;
      const s = v.sprite;
      const sy = py - floor * FLOOR_H;
      const vis = p.x >= view.minX && p.x <= view.maxX && sy >= view.minY && sy <= view.maxY;
      s.visible = vis;
      if (!vis) continue;
      if (floorVisible(floor, this.view)) visibleEntities++;
      if (s.x !== p.x || s.y !== py) s.position.set(p.x, py);
      const facing = facingOf(v.entity);
      if (facing !== v.facing) {
        v.facing = facing;
        const t = this.textures.archetype(v.entity.archetype, facing, v.shown);
        if (t.facing !== v.shown) {
          v.shown = t.facing;
          apply(s, t);
        }
      }
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

    return { visibleChunks, totalChunks: this.chunks.length, visibleEntities };
  }
}

