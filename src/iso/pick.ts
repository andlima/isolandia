/**
 * Picking what is drawn under the pointer (pure; the scene supplies its
 * drawn sprites as `PickSource`).
 *
 * Floors are tried from the view floor down. On each floor the frontmost
 * raised block, ground pile or entity sprite whose hit mask contains the
 * point wins; otherwise the floor's ground pick (`pickTile`) is used if that
 * cell is filled, since a floor's ground covers everything below it. When
 * every floor misses, the view floor's ground pick is returned: without a
 * sprite hit this is exactly `pickCell`. Blocks faded by the cutaway are
 * neither hit nor picked by their top face, so the pointer reaches what is
 * behind them.
 */

import type { Container as Pile, EdgeSide, Entity, Grid } from '../core/index.ts';
import { hits, type Candidate, type Reach } from './hit.ts';
import { FLOOR_H, floorCamera, pickTile, screenToIso, TILE_H, TILE_W, type CameraState } from './projection.ts';

/** What a pick found. Every target carries a cell; an entity's is its simulation cell, an edge's the cell it belongs to. */
export type PickTarget =
  | { readonly kind: 'ground' | 'tile'; readonly x: number; readonly y: number; readonly z: number }
  | { readonly kind: 'edge'; readonly x: number; readonly y: number; readonly z: number; readonly side: EdgeSide }
  | { readonly kind: 'pile'; readonly x: number; readonly y: number; readonly z: number; readonly container: Pile }
  | { readonly kind: 'entity'; readonly x: number; readonly y: number; readonly z: number; readonly entity: Entity };

/** A drawn sprite: a candidate (iso bounds of the whole scene, floor offset included) on a floor. */
export interface Drawn extends Candidate<PickTarget> {
  /** The floor container the sprite is drawn in. */
  readonly floor: number;
}

/** The scene's drawn sprites, as picking sees them. */
export interface PickSource {
  readonly grid: Grid;
  /** How far a raised tile's sprite reaches from its anchor spot (bounds the cell search). */
  readonly reach: Reach;
  /** The raised block drawn at a cell (in a built, visible chunk and not faded), or null. */
  block(x: number, y: number, z: number): Drawn | null;
  /** Whether the block at a cell is faded by the cutaway. */
  faded(x: number, y: number, z: number): boolean;
  /** Every live ground-pile and entity sprite. */
  objects(): Iterable<Drawn>;
}

const HW = TILE_W / 2;
const HH = TILE_H / 2;

/** The target under screen point (sx, sy) with view floor `view` (floors above it are cut away). */
export function pickTarget(sx: number, sy: number, cam: CameraState, view: number, src: PickSource): PickTarget {
  const { grid, reach } = src;
  const p = screenToIso(sx, sy, cam);
  const isRaised = (x: number, y: number, z: number) => (grid.tileAt(x, y, z)?.raised ?? false) && !src.faded(x, y, z);
  let first: PickTarget | null = null;
  for (let z = Math.min(view, grid.floors - 1); z >= 0; z--) {
    let best: Drawn | null = null;
    // A block's anchor is its diamond's bottom vertex, iso ((x − y)·HW, (x + y + 2)·HH) on its floor.
    const py = p.y + z * FLOOR_H;
    const s0 = Math.ceil((py - reach.down) / HH) - 2;
    const s1 = Math.floor((py + reach.up) / HH) - 2;
    const u0 = Math.ceil((p.x - reach.side) / HW);
    const u1 = Math.floor((p.x + reach.side) / HW);
    for (let s = s0; s <= s1; s++) {
      for (let u = u0; u <= u1; u++) {
        if (((s + u) & 1) !== 0) continue; // x + y and x − y share parity
        const x = (s + u) / 2;
        const y = (s - u) / 2;
        if (!grid.inBounds(x, y, z)) continue;
        const c = src.block(x, y, z);
        if (c && (best === null || c.order > best.order) && hits(c, p.x, p.y)) best = c;
      }
    }
    for (const c of src.objects()) {
      if (c.floor === z && (best === null || c.order > best.order) && hits(c, p.x, p.y)) best = c;
    }
    if (best) return resolve(best.target);
    const t = pickTile(sx, sy, floorCamera(cam, z), (x, y) => isRaised(x, y, z));
    const ground: PickTarget = { kind: 'ground', x: t.x, y: t.y, z };
    first ??= ground;
    if (grid.tileAt(t.x, t.y, z) !== undefined) return ground;
  }
  return first ?? { kind: 'ground', ...pickTile(sx, sy, cam, () => false), z: 0 };
}

/** A copy of a target; an entity's cell is read now. */
function resolve(t: PickTarget): PickTarget {
  return t.kind === 'entity' ? { kind: 'entity', x: t.entity.x, y: t.entity.y, z: t.entity.z, entity: t.entity } : { ...t };
}
