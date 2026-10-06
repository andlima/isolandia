/**
 * Query parameters: `?packs=a,b,…` (pack directory names or namespaces;
 * dependencies are added by the stack resolver in `main.ts`) and `?seed=N`.
 */

export interface Params {
  /** The requested pack tokens, or null without a `packs` parameter (the title screen). */
  readonly packs: string[] | null;
  readonly seed: number;
  readonly errors: string[];
}

export const DEFAULT_SEED = 1;

export function parseParams(search: string): Params {
  const q = new URLSearchParams(search);
  const errors: string[] = [];
  const raw = q.get('packs');
  const packs = raw === null ? null : raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (packs !== null && packs.length === 0) errors.push(`?packs= must list at least one pack`);
  let seed = DEFAULT_SEED;
  const s = q.get('seed');
  if (s !== null) {
    const n = Number(s);
    if (s.trim() === '' || !Number.isInteger(n)) errors.push(`?seed= expects an integer, got '${s}'`);
    else seed = n;
  }
  return { packs, seed, errors };
}
