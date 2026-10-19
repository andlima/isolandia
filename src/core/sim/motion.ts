import type { Facing } from '../facing.ts';
import type { Entity } from './world.ts';

/**
 * Progress of an entity's current step, in [0, 1], for a frame drawn `alpha`
 * ∈ [0, 1) of the way from world tick `tick` to the next.
 *
 * A step taken while processing tick T sets `stepTick = T + 1` and lasts
 * `ticksPerStep` ticks, so its progress is
 * `clamp((tick - stepTick + alpha) / ticksPerStep, 0, 1)`. The next step can
 * only be taken `ticksPerStep` ticks later, when progress has just reached 1,
 * so an entity walking a path or holding a key moves at constant speed and
 * never dwells at 1 between two steps. A standing entity is at 1.
 */
export function stepProgress(e: Pick<Entity, 'stepTick' | 'archetype'>, tick: number, alpha: number): number {
  const t = (tick - e.stepTick + alpha) / e.archetype.ticksPerStep;
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

/**
 * Continuous render position of an entity, in tile units (the tile's origin
 * corner, like `x`/`y`, and the floor `z`), for a frame drawn `alpha` ∈ [0, 1) of the way from
 * world tick `tick` to the next: `from` to the cell at `stepProgress`.
 */
export function renderPosition(
  e: Pick<Entity, 'x' | 'y' | 'z' | 'fromX' | 'fromY' | 'fromZ' | 'stepTick' | 'archetype'>,
  tick: number,
  alpha: number,
): { x: number; y: number; z: number } {
  const p = stepProgress(e, tick, alpha);
  return { x: e.fromX + (e.x - e.fromX) * p, y: e.fromY + (e.y - e.fromY) * p, z: e.fromZ + (e.z - e.fromZ) * p };
}

/**
 * The walk-cycle frame to show at step progress `progress` (`stepProgress`)
 * for an entity whose current step has stride parity `stride` (0 or 1; the
 * renderer flips it every step) and a cycle of `frames` frames (even, ≥ 2).
 * A cycle spans two steps, one footfall per tile: the first step of a pair
 * plays the first half of the frames, the second step the other half. Null
 * at `progress ≥ 1`: the entity stands, so the standing image shows.
 */
export function walkFrame(progress: number, stride: 0 | 1, frames: number): number | null {
  if (progress >= 1 || frames <= 0) return null;
  const k = Math.floor(((stride + progress) * frames) / 2);
  return k < 0 ? 0 : k >= frames ? frames - 1 : k;
}

/**
 * Render facing of an entity: its simulation facing (`Entity.facing`), which
 * turns one compass point per `ticks_per_turn` beat before a step in a new
 * direction and equals the step's direction once it moves.
 */
export function facingOf(e: Pick<Entity, 'facing'>): Facing {
  return e.facing;
}
