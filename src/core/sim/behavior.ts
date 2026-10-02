/**
 * Behavior think step: transitions, then the current state's built-in
 * activity. Activities only set the entity's pending intent; movement itself
 * happens in the world's intent phase, so walls, corners, cooldowns and A*
 * apply exactly as for queued intents.
 */

import type { BehaviorStateDef } from '../definition.ts';
import type { ExprContext } from '../expr/index.ts';
import type { Grid } from './grid.ts';
import type { Rng } from './rng.ts';
import type { Entity, StepIntent } from './world.ts';

/** The 8 neighbour directions, in the fixed order used for tie-breaks. */
const DIRS: readonly (readonly [-1 | 0 | 1, -1 | 0 | 1])[] = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

/** Preallocated step intent per entry of `DIRS`, so activities never allocate. */
const STEPS: readonly StepIntent[] = DIRS.map(([dx, dy]) => Object.freeze({ kind: 'step', dx, dy }));

/** `wander` draws one of the 8 directions or "stay" (the last slot). */
const WANDER_CHOICES = DIRS.length + 1;

/** What the think step reads from the world. */
export interface ThinkEnv {
  readonly grid: Grid;
  readonly rng: Rng;
  /** Shared expression context; `ctx.tick` is the current tick, `self` is set here. */
  readonly ctx: ExprContext;
}

type Point = { x: number; y: number };

const chebyshev = (ax: number, ay: number, bx: number, by: number) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

/** Run one entity's behavior for this tick (the entity must have one). */
export function think(e: Entity, env: ThinkEnv): void {
  const states = e.behavior!.states;
  env.ctx.self = e;
  const to = transition(e, states[e.state]!, env);
  if (to >= 0) {
    e.state = to;
    e.stateTick = env.ctx.tick;
    e.path = null;
    e.pathPos = 0;
    e.intent = null;
    e.planTick = -1;
  }
  activity(e, states[e.state]!, env);
}

/** The state to switch to (`on` → `timeout` → `done`), or -1. */
function transition(e: Entity, s: BehaviorStateDef, env: ThinkEnv): number {
  for (const t of s.on) if (t.when(env.ctx)) return t.to;
  if (s.timeout && env.ctx.tick - e.stateTick >= s.timeout.afterTicks) return s.timeout.to;
  if (s.done !== null && e.planTick >= 0 && e.planTick < env.ctx.tick) {
    if (arrived(e, s)) return s.done;
    const g = e.lastGoto;
    if (g && g.tick === e.planTick && !g.ok) return s.done;
  }
  return -1;
}

/** `done` arrival test: on the home cell (`home`); adjacent to or on the heard cell, or never heard (`investigate`). */
function arrived(e: Entity, s: BehaviorStateDef): boolean {
  if (s.activity === 'investigate') return e.heardTick < 0 || chebyshev(e.x, e.y, e.heardX, e.heardY) <= 1;
  return e.x === e.homeX && e.y === e.homeY;
}

function activity(e: Entity, s: BehaviorStateDef, env: ThinkEnv): void {
  switch (s.activity) {
    case 'idle':
      return;
    case 'wander':
      return wander(e, s, env);
    case 'pursue':
      return pursue(e, s, env);
    case 'flee':
      return flee(e, s, env);
    case 'home':
      return home(e, env);
    case 'investigate':
      return investigate(e, s, env);
  }
}

/** Whether a step issued now fires in this tick's intent phase. */
const ready = (e: Entity) => e.moveCooldown <= 1;

function wander(e: Entity, s: BehaviorStateDef, env: ThinkEnv): void {
  if (!ready(e) || e.path) return;
  const k = Math.floor(env.rng.next() * WANDER_CHOICES);
  if (k >= DIRS.length) return;
  const [dx, dy] = DIRS[k]!;
  if (!env.grid.canStep(e.x, e.y, dx, dy)) return;
  if (s.radius !== null && chebyshev(e.x + dx, e.y + dy, e.homeX, e.homeY) > s.radius) return;
  e.intent = STEPS[k]!;
}

function pursue(e: Entity, s: BehaviorStateDef, env: ThinkEnv): void {
  const t = s.target!(env.ctx) as Point;
  const tx = t.x;
  const ty = t.y;
  if (chebyshev(e.x, e.y, tx, ty) <= 1) {
    e.path = null;
    return;
  }
  const due = e.planTick < 0 || (env.ctx.tick - e.planTick >= s.repath && (!e.path || tx !== e.planX || ty !== e.planY));
  if (!due) return;
  e.intent = { kind: 'goto', x: tx, y: ty, adjacent: true };
  e.planX = tx;
  e.planY = ty;
  e.planTick = env.ctx.tick;
}

function flee(e: Entity, s: BehaviorStateDef, env: ThinkEnv): void {
  if (!ready(e)) return;
  const t = s.target!(env.ctx) as Point;
  const ox = e.x - t.x;
  const oy = e.y - t.y;
  let best = ox * ox + oy * oy;
  let pick = -1;
  for (let k = 0; k < DIRS.length; k++) {
    const [dx, dy] = DIRS[k]!;
    if (!env.grid.canStep(e.x, e.y, dx, dy)) continue;
    const d = (ox + dx) * (ox + dx) + (oy + dy) * (oy + dy);
    if (d > best) {
      best = d;
      pick = k;
    }
  }
  if (pick >= 0) e.intent = STEPS[pick]!;
}

/** One goto home per entry into the state; `done` is checked by `transition`. */
function home(e: Entity, env: ThinkEnv): void {
  if (e.planTick >= 0) return;
  e.planTick = env.ctx.tick;
  if (e.x === e.homeX && e.y === e.homeY) return;
  e.intent = { kind: 'goto', x: e.homeX, y: e.homeY };
  e.planX = e.homeX;
  e.planY = e.homeY;
}

/**
 * Walk up to the last heard noise. The first goto in a state is issued at
 * once; a newer noise re-plans at most once per `repath` window. When no goto
 * is needed, `planTick` still marks the state as planned (with `planX` -1), so
 * `done` can fire on the next tick.
 */
function investigate(e: Entity, s: BehaviorStateDef, env: ThinkEnv): void {
  const tick = env.ctx.tick;
  const hx = e.heardX;
  const hy = e.heardY;
  if (e.heardTick < 0 || chebyshev(e.x, e.y, hx, hy) <= 1) {
    if (e.heardTick >= 0) e.path = null;
    if (e.planTick < 0) {
      e.planTick = tick;
      e.planX = -1;
      e.planY = -1;
    }
    return;
  }
  const due = e.planTick < 0 || e.planX < 0 || (tick - e.planTick >= s.repath && (hx !== e.planX || hy !== e.planY));
  if (!due) return;
  e.intent = { kind: 'goto', x: hx, y: hy, adjacent: true };
  e.planX = hx;
  e.planY = hy;
  e.planTick = tick;
}
