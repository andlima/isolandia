/**
 * Query parameters: `?packs=a,b,…` (pack directory names or namespaces;
 * dependencies are added by the stack resolver in `main.ts`), `?seed=N` and
 * `?bench=S` (a benchmark run of S seconds instead of play, see `bench.ts`).
 */

export interface Params {
  /** The requested pack tokens, or null without a `packs` parameter (the title screen). */
  readonly packs: string[] | null;
  readonly seed: number;
  /** Benchmark duration in seconds; 0 without a `bench` parameter (play as usual). */
  readonly bench: number;
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
  let bench = 0;
  const b = q.get('bench');
  if (b !== null) {
    const n = Number(b);
    if (b.trim() === '' || !Number.isInteger(n) || n <= 0) errors.push(`?bench= expects a positive whole number of seconds, got '${b}'`);
    else bench = n;
  }
  return { packs, seed, bench, errors };
}
