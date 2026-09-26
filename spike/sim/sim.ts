import { Pathfinder } from './astar.ts';
import type { Grid } from './grid.ts';
import { isWalkable } from './grid.ts';
import { mulberry32, randInt, type Rng } from './rng.ts';

export const Kind = { Wanderer: 0, Player: 1 } as const;

export interface SimOptions {
  entityCount: number;
  seed: number;
  /** Max A* requests served per tick; the rest wait in a FIFO queue. */
  pathBudgetPerTick?: number;
  /** Ticks per tile for wanderers (player is faster). */
  wandererStepTicks?: number;
  playerStepTicks?: number;
}

/**
 * Headless simulation: mutable, struct-of-arrays entity storage, no Pixi/DOM.
 *
 * Movement: an entity walks its path one tile per `stepTicks` ticks. Each tick
 * the sim writes a continuous position (`posX/posY`, tile centre = +0.5) and
 * keeps the previous tick's position (`prevX/prevY`), so a renderer can
 * interpolate between the two with the loop's alpha.
 *
 * Entity 0 is the player; the rest are wanderers.
 */
export class Sim {
  readonly grid: Grid;
  readonly count: number;
  readonly pathfinder: Pathfinder;
  tick = 0;

  // Tile the entity is at (or leaving) and the tile it is moving to.
  readonly fromX: Int32Array;
  readonly fromY: Int32Array;
  readonly toX: Int32Array;
  readonly toY: Int32Array;
  /** Ticks elapsed within the current step. */
  readonly stepProgress: Int32Array;
  readonly stepTicks: Int32Array;
  readonly kind: Uint8Array;
  // Continuous positions for rendering (current and previous tick).
  readonly posX: Float32Array;
  readonly posY: Float32Array;
  readonly prevX: Float32Array;
  readonly prevY: Float32Array;

  readonly paths: (Int32Array | null)[];
  readonly pathIndex: Int32Array;
  /** Pending destination tile index (-1 = none). */
  readonly goal: Int32Array;
  private readonly queued: Uint8Array;
  private queue: number[] = [];
  private queueHead = 0;
  readonly pathBudgetPerTick: number;
  private playerRequest = false;

  // Stats for the HUD / bench.
  pathsThisTick = 0;
  pathsTotal = 0;
  pathFailures = 0;

  private readonly rng: Rng;

  constructor(grid: Grid, opts: SimOptions) {
    this.grid = grid;
    this.count = Math.max(1, opts.entityCount + 1);
    this.pathfinder = new Pathfinder(grid);
    this.rng = mulberry32(opts.seed ^ 0x9e3779b9);
    this.pathBudgetPerTick = opts.pathBudgetPerTick ?? 32;
    const n = this.count;
    this.fromX = new Int32Array(n);
    this.fromY = new Int32Array(n);
    this.toX = new Int32Array(n);
    this.toY = new Int32Array(n);
    this.stepProgress = new Int32Array(n);
    this.stepTicks = new Int32Array(n);
    this.kind = new Uint8Array(n);
    this.posX = new Float32Array(n);
    this.posY = new Float32Array(n);
    this.prevX = new Float32Array(n);
    this.prevY = new Float32Array(n);
    this.paths = new Array(n).fill(null);
    this.pathIndex = new Int32Array(n);
    this.goal = new Int32Array(n).fill(-1);
    this.queued = new Uint8Array(n);

    const wStep = opts.wandererStepTicks ?? 3;
    const pStep = opts.playerStepTicks ?? 2;
    const w = grid.width;
    for (let e = 0; e < n; e++) {
      const tile = this.randomWalkable();
      const x = tile % w;
      const y = (tile / w) | 0;
      this.fromX[e] = this.toX[e] = x;
      this.fromY[e] = this.toY[e] = y;
      this.posX[e] = this.prevX[e] = x + 0.5;
      this.posY[e] = this.prevY[e] = y + 0.5;
      this.kind[e] = e === 0 ? Kind.Player : Kind.Wanderer;
      this.stepTicks[e] = e === 0 ? pStep : wStep;
      if (e !== 0) this.requestPath(e, this.randomWalkable());
    }
  }

  get queueLength(): number {
    return this.queue.length - this.queueHead;
  }

  /** Player click-to-move: served ahead of the queue on the next tick. */
  movePlayerTo(x: number, y: number): boolean {
    if (!isWalkable(this.grid, x, y)) return false;
    this.goal[0] = y * this.grid.width + x;
    this.playerRequest = true;
    return true;
  }

  step(): void {
    this.tick++;
    this.pathsThisTick = 0;

    if (this.playerRequest) {
      this.playerRequest = false;
      this.solve(0);
    }
    let budget = this.pathBudgetPerTick;
    while (budget > 0 && this.queueHead < this.queue.length) {
      const e = this.queue[this.queueHead++]!;
      this.queued[e] = 0;
      this.solve(e);
      budget--;
    }
    if (this.queueHead > 1024 && this.queueHead * 2 > this.queue.length) {
      this.queue = this.queue.slice(this.queueHead);
      this.queueHead = 0;
    }

    for (let e = 0; e < this.count; e++) this.move(e);
  }

  private move(e: number): void {
    this.prevX[e] = this.posX[e]!;
    this.prevY[e] = this.posY[e]!;
    const t = this.stepTicks[e]!;
    if (this.fromX[e] !== this.toX[e] || this.fromY[e] !== this.toY[e]) {
      if (++this.stepProgress[e]! < t) {
        this.lerpPos(e);
        return;
      }
      this.fromX[e] = this.toX[e]!;
      this.fromY[e] = this.toY[e]!;
      this.stepProgress[e] = 0;
      // This tick lands on the tile centre; the next step starts next tick.
      const p = this.paths[e];
      if (p && this.pathIndex[e]! < p.length) {
        this.lerpPos(e);
        return;
      }
    }
    // Standing on a tile: start the next step of the path.
    const path = this.paths[e];
    if (path && this.pathIndex[e]! < path.length) {
      const next = path[this.pathIndex[e]!++]!;
      this.toX[e] = next % this.grid.width;
      this.toY[e] = (next / this.grid.width) | 0;
      this.stepProgress[e] = 1;
      if (t <= 1) {
        this.fromX[e] = this.toX[e]!;
        this.fromY[e] = this.toY[e]!;
        this.stepProgress[e] = 0;
      }
      this.lerpPos(e);
      return;
    }
    this.lerpPos(e);
    if (path) {
      // Arrived.
      this.paths[e] = null;
      if (this.kind[e] === Kind.Wanderer) this.requestPath(e, this.randomWalkable());
    }
  }

  private lerpPos(e: number): void {
    const a = this.stepProgress[e]! / this.stepTicks[e]!;
    this.posX[e] = this.fromX[e]! + (this.toX[e]! - this.fromX[e]!) * a + 0.5;
    this.posY[e] = this.fromY[e]! + (this.toY[e]! - this.fromY[e]!) * a + 0.5;
  }

  private solve(e: number): void {
    const goal = this.goal[e]!;
    if (goal < 0) return;
    const w = this.grid.width;
    // Plan from the tile the entity will stand on next.
    const path = this.pathfinder.findPath(this.toX[e]!, this.toY[e]!, goal % w, (goal / w) | 0);
    this.pathsThisTick++;
    this.pathsTotal++;
    this.goal[e] = -1;
    if (path === null) {
      this.pathFailures++;
      this.paths[e] = null;
      if (this.kind[e] === Kind.Wanderer) this.requestPath(e, this.randomWalkable());
      return;
    }
    this.paths[e] = path;
    this.pathIndex[e] = 0;
  }

  private requestPath(e: number, goalTile: number): void {
    this.goal[e] = goalTile;
    if (this.queued[e] === 0) {
      this.queued[e] = 1;
      this.queue.push(e);
    }
  }

  private randomWalkable(): number {
    const w = this.grid.walkable;
    return w[randInt(this.rng, w.length)]!;
  }
}
