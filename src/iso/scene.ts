/**
 * The Pixi scene for a World:
 *
 *   root (camera transform)
 *     ground   — flat tiles, one container per 16×16 render chunk (culled)
 *     markers  — path target outline, unreachable flash
 *     objects  — one container per diagonal (x + y); raised tiles and
 *                entities, depth-sorted inside their diagonal only
 *
 * Ground and objects are multiplied by the pack's day/night tint (if any);
 * markers are not.
 *
 * Only a bucket whose contents moved gets re-sorted (Pixi sorts a
 * `sortableChildren` container only when one of its children's zIndex
 * changed), so a still scene costs no sorting at all.
 */

import { Container, Sprite } from 'pixi.js';
import { renderPosition, type Entity, type World } from '../core/index.ts';
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
import type { AnchoredTexture, TextureBank } from './textures.ts';
import { sceneTint } from './tint.ts';

export const CHUNK = 16;
/** Iso-space margin so tall sprites at the viewport edge are not culled early. */
const CULL_MARGIN = 96;
const FLASH_MS = 600;
const TARGET_COLOR = 0xffd23f;
const INVALID_COLOR = 0xff3355;

interface Chunk {
  readonly ground: Container;
  readonly blocks: Sprite[];
  readonly bounds: Bounds;
  visible: boolean;
}

interface EntityView {
  readonly entity: Entity;
  readonly sprite: Sprite;
  bucket: number;
}

export interface SceneStats {
  visibleChunks: number;
  totalChunks: number;
  visibleEntities: number;
}

function sprite(t: AnchoredTexture): Sprite {
  const s = new Sprite(t.texture);
  s.anchor.set(t.anchorX, t.anchorY);
  return s;
}

export class IsoScene {
  readonly root = new Container();
  private readonly ground = new Container();
  private readonly markers = new Container();
  private readonly objects = new Container();
  private readonly buckets: Container[] = [];
  private readonly chunks: Chunk[] = [];
  private readonly entities: EntityView[] = [];
  private readonly target: Sprite;
  private readonly invalid: Sprite;
  private invalidUntil = 0;
  private tint = 0xffffff;

  constructor(
    private readonly world: World,
    textures: TextureBank,
  ) {
    this.root.addChild(this.ground, this.markers, this.objects);
    const { grid } = world;

    for (let d = 0; d <= grid.width + grid.height; d++) {
      const b = new Container();
      b.sortableChildren = true;
      this.buckets.push(b);
      this.objects.addChild(b);
    }

    for (let cy = 0; cy < grid.height; cy += CHUNK) {
      for (let cx = 0; cx < grid.width; cx += CHUNK) {
        const ground = new Container();
        const blocks: Sprite[] = [];
        for (let y = cy; y < Math.min(cy + CHUNK, grid.height); y++) {
          for (let x = cx; x < Math.min(cx + CHUNK, grid.width); x++) {
            const tile = grid.tileAt(x, y)!;
            const s = sprite(textures.tile(tile));
            const p = tileAnchorIso(x, y);
            s.position.set(p.x, p.y);
            if (tile.raised) {
              s.zIndex = depthKey(x, y, Layer.Block);
              this.buckets[diagonalOf(x, y)]!.addChild(s);
              blocks.push(s);
            } else {
              ground.addChild(s);
            }
          }
        }
        this.ground.addChild(ground);
        const bounds = tileRectIsoBounds(cx, cy, CHUNK, CHUNK);
        bounds.minY -= BLOCK_H * 3; // raised tiles and tall sprites
        this.chunks.push({ ground, blocks, bounds, visible: true });
      }
    }

    for (const entity of world.entities) {
      const s = sprite(textures.archetype(entity.archetype));
      const bucket = diagonalOf(entity.x, entity.y);
      this.buckets[bucket]!.addChild(s);
      this.entities.push({ entity, sprite: s, bucket });
    }

    this.target = sprite(textures.outline(TARGET_COLOR));
    this.invalid = sprite(textures.outline(INVALID_COLOR));
    this.target.visible = this.invalid.visible = false;
    this.markers.addChild(this.target, this.invalid);
  }

  /** Flash a tile red: the player cannot get there. */
  flashUnreachable(x: number, y: number, now: number): void {
    const p = tileAnchorIso(x, y);
    this.invalid.position.set(p.x, p.y);
    this.invalid.visible = true;
    this.invalidUntil = now + FLASH_MS;
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
