/**
 * Facings on the map compass (`x` grows east, `y` grows south) and the
 * mirroring/snapping rules shared by the loader, the simulation and the
 * renderers. Pure data and functions. Facing is simulation state
 * (`Entity.facing`): an entity turns one compass point at a time
 * (`turnToward`) before it steps in a new direction.
 */

/** The 8 facings, clockwise from north. Arrays indexed by facing use this order. */
export const FACINGS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;
export type Facing = (typeof FACINGS)[number];

/** The 4-way set: the four faces of the tile diamond. */
export const CARDINALS: readonly Facing[] = ['n', 'e', 's', 'w'];

export const DEFAULT_FACING: Facing = 's';

/** Map step `(dx, dy)` per facing (same order as `FACINGS`). */
export const FACING_STEP: Readonly<Record<Facing, readonly [number, number]>> = {
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
  nw: [-1, -1],
};

/** The facing a horizontally flipped image shows (a screen flip swaps `dx` and `dy`). */
export const MIRROR: Readonly<Record<Facing, Facing>> = {
  n: 'w',
  ne: 'sw',
  e: 's',
  se: 'se',
  s: 'e',
  sw: 'ne',
  w: 'n',
  nw: 'nw',
};

export function isFacing(v: unknown): v is Facing {
  return typeof v === 'string' && (FACINGS as readonly string[]).includes(v);
}

export function isDiagonal(f: Facing): boolean {
  return FACINGS.indexOf(f) % 2 === 1;
}

/** Facing of a map step; `null` for (0, 0). Only the signs matter. */
export function facingOfStep(dx: number, dy: number): Facing | null {
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  if (sx === 0 && sy === 0) return null;
  return FACINGS.find((f) => FACING_STEP[f][0] === sx && FACING_STEP[f][1] === sy)!;
}

/**
 * One compass point (45°) from `from` toward `to`, the short way round; an
 * exact reversal turns clockwise. Returns `to` when already facing it.
 */
export function turnToward(from: Facing, to: Facing): Facing {
  const i = FACINGS.indexOf(from);
  const d = (FACINGS.indexOf(to) - i + 8) % 8;
  if (d === 0) return to;
  return FACINGS[(i + (d <= 4 ? 1 : 7)) % 8]!;
}

/** Which image shows a facing, and whether it is flipped horizontally around the anchor spot. */
export interface FacingImage {
  readonly image: number;
  readonly mirrored: boolean;
}

/**
 * Per-facing image table (indexed like `FACINGS`) for a set of explicitly
 * drawn facings. A listed facing uses its own image; a missing one uses its
 * mirror partner's image, flipped. Entries stay null when neither is drawn,
 * and for diagonals of a 4-way set (no diagonal listed), which are snapped
 * at render time instead (`resolveFacing`).
 *
 * Returns the table plus the facings the set must produce but cannot.
 */
export function facingTable(listed: ReadonlyMap<Facing, number>): { byFacing: (FacingImage | null)[]; missing: Facing[] } {
  const eightWay = [...listed.keys()].some(isDiagonal);
  const byFacing: (FacingImage | null)[] = [];
  const missing: Facing[] = [];
  for (const f of FACINGS) {
    const own = listed.get(f);
    const partner = listed.get(MIRROR[f]);
    if (own !== undefined) byFacing.push({ image: own, mirrored: false });
    else if (partner !== undefined) byFacing.push({ image: partner, mirrored: true });
    else {
      byFacing.push(null);
      if (eightWay || !isDiagonal(f)) missing.push(f);
    }
  }
  return { byFacing, missing };
}

/**
 * The facing to show and its image, for an asset table `byFacing` (as built
 * by `facingTable`). When the facing has no image (a diagonal on a 4-way
 * asset) it snaps to one of its two neighbours: `prev` if it is one of them
 * (so a sprite does not flicker between the two), otherwise the clockwise
 * one (`ne→e`, `se→s`, `sw→w`, `nw→n`).
 */
export function resolveFacing(
  byFacing: readonly (FacingImage | null)[],
  facing: Facing,
  prev: Facing | null,
): FacingImage & { readonly facing: Facing } {
  const i = FACINGS.indexOf(facing);
  const own = byFacing[i];
  if (own) return { facing, ...own };
  const ccw = FACINGS[(i + 7) % 8]!;
  const cw = FACINGS[(i + 1) % 8]!;
  const shown = prev === ccw && byFacing[(i + 7) % 8] ? ccw : cw;
  const img = byFacing[FACINGS.indexOf(shown)];
  // Every loaded table can show all cardinals; fall back to image 0 just in case.
  return { facing: shown, ...(img ?? { image: 0, mirrored: false }) };
}
