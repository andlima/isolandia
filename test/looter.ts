/**
 * A scripted looting player for the headless genre scenarios: it only ever
 * queues `goto` intents and `take`/`use` actions, reading the world like a
 * (omniscient) player would. A need without a measurement just gathers its
 * items (e.g. the goal items of a collecting game).
 */

import { countOf, World, type Container } from '../src/core/index.ts';

/** Use an item when a measurement crosses a threshold; without `measurement` the items are only gathered. */
export interface Need {
  readonly measurement?: string;
  /** Use when the value is ≥ `above` (or ≤ `below`). */
  readonly above?: number;
  readonly below?: number;
  /** Item ids, in order of preference. */
  readonly items: readonly string[];
  /** How many of these items to keep in stock. */
  readonly stock: number;
}

export interface LooterOptions {
  readonly needs: readonly Need[];
  /** Extra condition that must hold before walking to loot (e.g. night only). */
  readonly mayRoam?: (w: World) => boolean;
}

export class Looter {
  private readonly unreachable = new Set<number>();
  private target: Container | null = null;

  constructor(
    private readonly w: World,
    private readonly opts: LooterOptions,
  ) {}

  private count(ids: readonly string[]): number {
    const inv = this.w.player.inv!;
    return ids.reduce((n, id) => n + countOf(inv, this.w.def.ids.items[id]!), 0);
  }

  /** Call once per sim second, before `step()`. */
  think(): void {
    const w = this.w;
    const p = w.player;
    for (const n of this.opts.needs) {
      if (n.measurement === undefined) continue;
      const v = w.value(p, n.measurement)!;
      const due = (n.above !== undefined && v >= n.above) || (n.below !== undefined && v <= n.below);
      if (!due) continue;
      const id = n.items.find((i) => this.count([i]) > 0);
      if (id) w.queueAction({ kind: 'use', item: id });
    }

    const wanted = this.opts.needs.filter((n) => this.count(n.items) < n.stock).flatMap((n) => n.items);
    if (wanted.length === 0) return;
    const has = (c: Container) => wanted.some((id) => countOf(c, w.def.ids.items[id]!) > 0);

    const reach = w.reachableContainers().filter(has);
    for (const c of reach) {
      for (const id of wanted) if (countOf(c, w.def.ids.items[id]!) > 0) w.queueAction({ kind: 'take', container: c.id, item: id });
    }
    if (reach.length) {
      this.target = null;
      return;
    }
    if (p.path) return; // still walking
    if (this.target && w.lastGoto && !w.lastGoto.ok) this.unreachable.add(this.target.id);
    if (this.opts.mayRoam && !this.opts.mayRoam(w)) return;
    let best: Container | null = null;
    let bestD = Infinity;
    for (const c of w.containers.values()) {
      if (c.kind === 'inventory' || this.unreachable.has(c.id) || !has(c)) continue;
      const d = Math.max(Math.abs(c.x - p.x), Math.abs(c.y - p.y));
      if (d < bestD) {
        best = c;
        bestD = d;
      }
    }
    if (!best) return;
    if (this.target === best && w.lastGoto?.ok) {
      // Arrived but still not in reach (should not happen); give up on it.
      this.unreachable.add(best.id);
      return;
    }
    this.target = best;
    w.queueIntent({ kind: 'goto', x: best.x, y: best.y, adjacent: true });
  }
}
