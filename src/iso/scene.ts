/**
 * The Pixi scene for a World:
 *
 *   root (camera transform)
 *     ground   — flat tiles, one container per 16×16 render chunk (culled)
 *     markers  — path target outline, unreachable flash, context-menu target
 *     objects  — one container per diagonal (x + y); raised tiles, ground
 *                piles and entities, depth-sorted inside their diagonal only
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
import { depthKey, diagonalOf, Layer } from './depth.ts';
import {
  BLOCK_H,
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
  readonly ground: Container;
  blocks: Sprite[];
  readonly bounds: Bounds;
  visible: boolean;
}

interface PileView {
  readonly sprite: Sprite;
  /** Item index shown (the pile's first stack). */
  item: number;
}

interface EntityView {
  readonly entity: Entity;
  readonly sprite: Sprite;
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
  private readonly ground = new Container();
  private readonly markers = new Container();
  private readonly objects = new Container();
  private readonly buckets: Container[] = [];
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

  constructor(
    private readonly world: World,
    private readonly textures: TextureBank,
  ) {
    this.root.addChild(this.ground, this.markers, this.objects);
    const { grid } = world;
    this.drawn = Uint16Array.from(grid.cells);
    this.tileVersion = world.tileVersion;

    for (let d = 0; d <= grid.width + grid.height; d++) {
      const b = new Container();
      b.sortableChildren = true;
      this.buckets.push(b);
      this.objects.addChild(b);
    }

    for (let cy = 0; cy < grid.height; cy += CHUNK) {
      for (let cx = 0; cx < grid.width; cx += CHUNK) {
        const ground = new Container();
        this.ground.addChild(ground);
        const bounds = tileRectIsoBounds(cx, cy, CHUNK, CHUNK);
        bounds.minY -= BLOCK_H * 3; // raised tiles and tall sprites
        const chunk: Chunk = { cx, cy, ground, blocks: [], bounds, visible: true };
        this.fillChunk(chunk);
        this.chunks.push(chunk);
      }
    }

    for (const entity of world.entities) {
      const facing = facingOf(entity);
      const t: FacedTexture = textures.archetype(entity.archetype, facing, null);
      const s = sprite(t);
      const bucket = diagonalOf(entity.x, entity.y);
      this.buckets[bucket]!.addChild(s);
      this.entities.push({ entity, sprite: s, bucket, facing, shown: t.facing });
    }

    this.target = sprite(textures.outline(TARGET_COLOR));
    this.invalid = sprite(textures.outline(INVALID_COLOR));
    this.menuMark = sprite(textures.outline(MENU_COLOR));
    this.target.visible = this.invalid.visible = this.menuMark.visible = false;
    this.markers.addChild(this.target, this.invalid, this.menuMark);
  }

  /** Create the tile sprites of a chunk: flat tiles in its ground container, raised ones in the object buckets. */
  private fillChunk(chunk: Chunk): void {
    const { grid } = this.world;
    const { facings } = this.world.def.maps[this.world.def.start.map]!;
    for (let y = chunk.cy; y < Math.min(chunk.cy + CHUNK, grid.height); y++) {
      for (let x = chunk.cx; x < Math.min(chunk.cx + CHUNK, grid.width); x++) {
        const tile = grid.tileAt(x, y)!;
        const s = sprite(this.textures.tile(tile, facings[y * grid.width + x] ?? null));
        const p = tileAnchorIso(x, y);
        s.position.set(p.x, p.y);
        if (tile.raised) {
          s.zIndex = depthKey(x, y, Layer.Block);
          s.visible = chunk.visible;
          this.buckets[diagonalOf(x, y)]!.addChild(s);
          chunk.blocks.push(s);
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
    const dirty = new Set<number>();
    for (let i = 0; i < grid.cells.length; i++) {
      if (grid.cells[i] === this.drawn[i]) continue;
      this.drawn[i] = grid.cells[i]!;
      const x = i % grid.width;
      const y = (i - x) / grid.width;
      dirty.add(Math.floor(y / CHUNK) * perRow + Math.floor(x / CHUNK));
    }
    for (const k of dirty) {
      const chunk = this.chunks[k]!;
      for (const s of chunk.ground.removeChildren()) s.destroy();
      for (const s of chunk.blocks) s.destroy();
      chunk.blocks = [];
      this.fillChunk(chunk);
    }
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
        this.buckets[diagonalOf(c.x, c.y)]!.addChild(s);
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

  /** Flash a tile red: the player cannot get there. */
  flashUnreachable(x: number, y: number, now: number): void {
    const p = tileAnchorIso(x, y);
    this.invalid.position.set(p.x, p.y);
    this.invalid.visible = true;
    this.invalidUntil = now + FLASH_MS;
  }

  /** Outline a cell while the context menu is open for it (null hides it). */
  markMenuTarget(cell: { x: number; y: number } | null): void {
    this.menuMark.visible = cell !== null;
    if (cell) {
      const p = tileAnchorIso(cell.x, cell.y);
      this.menuMark.position.set(p.x, p.y);
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
      this.ground.tint = tint;
      this.objects.tint = tint;
    }

    this.syncTiles();
    this.syncPiles();

    let visibleEntities = 0;
    for (const v of this.entities) {
      const r = renderPosition(v.entity, tick, alpha);
      const p = groundCentreIso(r.x, r.y);
      const s = v.sprite;
      const vis = p.x >= view.minX && p.x <= view.maxX && p.y >= view.minY && p.y <= view.maxY;
      s.visible = vis;
      if (!vis) continue;
      visibleEntities++;
      if (s.x !== p.x || s.y !== p.y) s.position.set(p.x, p.y);
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
      if (bucket !== v.bucket) {
        this.buckets[bucket]!.addChild(s); // reparents
        v.bucket = bucket;
      }
      const z = depthKey(r.x, r.y, Layer.Entity);
      if (s.zIndex !== z) s.zIndex = z;
    }

    const goal = this.world.pathGoal(this.world.player);
    this.target.visible = goal !== null;
    if (goal) {
      const p = tileAnchorIso(goal.x, goal.y);
      this.target.position.set(p.x, p.y);
    }
    if (this.invalid.visible && now > this.invalidUntil) this.invalid.visible = false;

    return { visibleChunks, totalChunks: this.chunks.length, visibleEntities };
  }
}
