/**
 * Weight-capped item containers. Items are plain data: a container holds an
 * ordered list of stacks `{ item, count }` (item indices, at most one stack
 * per item). Weights and capacities are integer hundredths, so sums and
 * comparisons never drift.
 */

export type ContainerKind = 'tile' | 'inventory' | 'ground';

export interface Stack {
  readonly item: number;
  count: number;
}

export interface Container {
  readonly id: number;
  readonly kind: ContainerKind;
  /** Cell of a tile container or ground pile; -1 for inventories. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Owner entity id of an inventory; -1 otherwise. */
  readonly owner: number;
  /** Capacity in hundredths; Infinity for ground piles. */
  readonly capacity: number;
  /** Tile index of a tile container; -1 otherwise. */
  readonly tile: number;
  readonly stacks: Stack[];
  /** Σ weight × count, in hundredths (kept up to date by `add`/`remove`). */
  load: number;
}

export function createContainer(
  id: number,
  kind: ContainerKind,
  capacity: number,
  at: { x?: number; y?: number; z?: number; owner?: number; tile?: number } = {},
): Container {
  return { id, kind, x: at.x ?? -1, y: at.y ?? -1, z: at.z ?? -1, owner: at.owner ?? -1, tile: at.tile ?? -1, capacity, stacks: [], load: 0 };
}

/** Units of an item in a container (a scan of its stacks). */
export function countOf(c: Container, item: number): number {
  const st = c.stacks;
  for (let i = 0; i < st.length; i++) if (st[i]!.item === item) return st[i]!.count;
  return 0;
}

/** Recomputed load (Σ weight × count), for checks; `c.load` is the cached value. */
export function load(c: Container, weights: readonly number[]): number {
  let sum = 0;
  for (const s of c.stacks) sum += weights[s.item]! * s.count;
  return sum;
}

/** How many of `want` units of weight `weight` fit without exceeding capacity. */
export function fits(c: Container, weight: number, want: number): number {
  if (want <= 0) return 0;
  if (weight === 0 || c.capacity === Infinity) return want;
  const room = c.capacity - c.load;
  return room <= 0 ? 0 : Math.min(want, Math.floor(room / weight));
}

/** Add units (no capacity check): merges into the item's stack or appends a new one. */
export function add(c: Container, item: number, count: number, weight: number): void {
  if (count <= 0) return;
  c.load += weight * count;
  for (const s of c.stacks) {
    if (s.item === item) {
      s.count += count;
      return;
    }
  }
  c.stacks.push({ item, count });
}

/** Remove up to `count` units; drops the stack when it reaches 0. Returns units removed. */
export function remove(c: Container, item: number, count: number, weight: number): number {
  const st = c.stacks;
  for (let i = 0; i < st.length; i++) {
    const s = st[i]!;
    if (s.item !== item) continue;
    const n = Math.min(count, s.count);
    if (n <= 0) return 0;
    s.count -= n;
    c.load -= weight * n;
    if (s.count === 0) st.splice(i, 1);
    return n;
  }
  return 0;
}

/** Label of a ground pile (engine-level, not pack data). */
export const GROUND_LABEL = 'Ground';
