import { Container, Sprite } from 'pixi.js';
import type { Grid } from '../sim/grid.ts';
import { Kind, type Sim } from '../sim/sim.ts';
import { buildChunkGround } from './chunks.ts';
import { depthKey, tileRectIsoBounds, worldToIso, type CameraState } from './iso.ts';
import { BLOCK_H, type AnchoredTexture, type SpikeTextures } from './textures.ts';

interface Chunk {
  ground: Container;
  blocks: Sprite[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  visible: boolean;
}

export interface ViewStats {
  visibleChunks: number;
  visibleEntities: number;
}

// Extra iso-space margin so tall sprites at the viewport edge are not culled early.
const CULL_MARGIN = 64;

function sprite(t: AnchoredTexture): Sprite {
  const s = new Sprite(t.texture);
  s.anchor.set(t.anchorX, t.anchorY);
  return s;
}

/**
 * Scene graph:
 *   root (camera transform)
 *     ground   — one cached container per chunk
 *     markers  — click target highlight
 *     objects  — blocks + entities, depth-sorted via zIndex
 */
export class WorldView {
  readonly root = new Container();
  private readonly ground = new Container();
  private readonly markers = new Container();
  private readonly objects = new Container();
  private readonly chunks: Chunk[] = [];
  private readonly entitySprites: Sprite[] = [];
  private readonly target: Sprite;
  private readonly invalidTarget: Sprite;
  private invalidUntil = 0;

  constructor(
    grid: Grid,
    private readonly sim: Sim,
    textures: SpikeTextures,
  ) {
    this.root.addChild(this.ground, this.markers, this.objects);
    this.objects.sortableChildren = true;

    const cs = grid.chunkSize;
    for (let cy = 0; cy < grid.chunksY; cy++) {
      for (let cx = 0; cx < grid.chunksX; cx++) {
        const ground = buildChunkGround(grid, cx, cy);
        this.ground.addChild(ground);
        const blocks: Sprite[] = [];
        for (let y = cy * cs; y < (cy + 1) * cs; y++) {
          for (let x = cx * cs; x < (cx + 1) * cs; x++) {
            if (grid.blocked[y * grid.width + x] === 0) continue;
            const s = sprite(textures.block);
            const p = worldToIso(x, y);
            s.position.set(p.x, p.y);
            s.zIndex = depthKey(x + 0.5, y + 0.5);
            blocks.push(s);
            this.objects.addChild(s);
          }
        }
        const bounds = tileRectIsoBounds(cx * cs, cy * cs, cs, cs);
        bounds.minY -= BLOCK_H;
        this.chunks.push({ ground, blocks, bounds, visible: true });
      }
    }

    for (let e = 0; e < sim.count; e++) {
      const isPlayer = sim.kind[e] === Kind.Player;
      const s = sprite(isPlayer ? textures.player : textures.wanderer);
      if (!isPlayer) s.tint = entityColor(e);
      this.entitySprites.push(s);
      this.objects.addChild(s);
    }

    this.target = sprite(textures.target);
    this.invalidTarget = sprite(textures.invalidTarget);
    this.target.visible = this.invalidTarget.visible = false;
    this.markers.addChild(this.target, this.invalidTarget);
  }

  showTarget(x: number, y: number, valid: boolean, now: number): void {
    const s = valid ? this.target : this.invalidTarget;
    const p = worldToIso(x, y);
    s.position.set(p.x, p.y);
    s.visible = true;
    if (!valid) this.invalidUntil = now + 600;
  }

  /** Applies the camera, culls, interpolates entities and updates depth keys. */
  update(cam: CameraState, viewW: number, viewH: number, alpha: number, now: number): ViewStats {
    this.root.position.set(cam.offsetX, cam.offsetY);
    this.root.scale.set(cam.zoom);

    // Viewport in iso space.
    const minX = -cam.offsetX / cam.zoom - CULL_MARGIN;
    const minY = -cam.offsetY / cam.zoom - CULL_MARGIN;
    const maxX = (viewW - cam.offsetX) / cam.zoom + CULL_MARGIN;
    const maxY = (viewH - cam.offsetY) / cam.zoom + CULL_MARGIN;

    let visibleChunks = 0;
    for (const c of this.chunks) {
      const b = c.bounds;
      const vis = b.maxX >= minX && b.minX <= maxX && b.maxY >= minY && b.minY <= maxY;
      if (vis) visibleChunks++;
      if (vis !== c.visible) {
        c.visible = vis;
        c.ground.visible = vis;
        for (const s of c.blocks) s.visible = vis;
      }
    }

    const { prevX, prevY, posX, posY } = this.sim;
    let visibleEntities = 0;
    for (let e = 0; e < this.entitySprites.length; e++) {
      const x = prevX[e]! + (posX[e]! - prevX[e]!) * alpha;
      const y = prevY[e]! + (posY[e]! - prevY[e]!) * alpha;
      const ix = (x - y) * 32;
      const iy = (x + y) * 16;
      const s = this.entitySprites[e]!;
      const vis = ix >= minX && ix <= maxX && iy >= minY && iy <= maxY;
      s.visible = vis;
      if (!vis) continue;
      visibleEntities++;
      s.position.set(ix, iy);
      const z = depthKey(x, y);
      if (s.zIndex !== z) s.zIndex = z;
    }

    // Hide the target marker once the player gets there.
    if (this.target.visible) {
      const tx = Math.floor(posX[0]!);
      const ty = Math.floor(posY[0]!);
      const p = worldToIso(tx, ty);
      if (p.x === this.target.x && p.y === this.target.y && this.sim.paths[0] === null) this.target.visible = false;
    }
    if (this.invalidTarget.visible && now > this.invalidUntil) this.invalidTarget.visible = false;

    return { visibleChunks, visibleEntities };
  }
}

/** Distinct-ish pastel colour per entity id (golden-angle hue). */
function entityColor(e: number): number {
  const h = (e * 137.508) % 360;
  const s = 0.55;
  const l = 0.62;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
}
