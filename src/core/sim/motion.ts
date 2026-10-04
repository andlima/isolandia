import type { Facing } from '../facing.ts';
import type { Entity } from './world.ts';

/**
 * Continuous render position of an entity, in tile units (the tile's origin
 * corner, like `x`/`y`), for a frame drawn `alpha` ∈ [0, 1) of the way from
 * world tick `tick` to the next.
 *
 * A step taken while processing tick T sets `stepTick = T + 1` and lasts
 * `ticksPerStep` ticks, so its progress is
 * `clamp((tick - stepTick + alpha) / ticksPerStep, 0, 1)`. The next step can
 * only be taken `ticksPerStep` ticks later, when progress has just reached 1,
 * so an entity walking a path or holding a key moves at constant speed.
 */
export function renderPosition(
  e: Pick<Entity, 'x' | 'y' | 'fromX' | 'fromY' | 'stepTick' | 'archetype'>,
  tick: number,
  alpha: number,
): { x: number; y: number } {
  const t = (tick - e.stepTick + alpha) / e.archetype.ticksPerStep;
  const p = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return { x: e.fromX + (e.x - e.fromX) * p, y: e.fromY + (e.y - e.fromY) * p };
}

/**
 * Render facing of an entity: its simulation facing (`Entity.facing`), which
 * turns one compass point per `ticks_per_turn` beat before a step in a new
 * direction and equals the step's direction once it moves.
 */
export function facingOf(e: Pick<Entity, 'facing'>): Facing {
  return e.facing;
}
