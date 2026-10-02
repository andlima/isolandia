/** Query parameters: `?packs=std,std-needs,<game>` (ordered pack directory names) and `?seed=N`. */

export interface Params {
  readonly packs: string[];
  readonly seed: number;
  readonly errors: string[];
}

export const DEFAULT_SEED = 1;

export function parseParams(search: string, defaultPacks: readonly string[]): Params {
  const q = new URLSearchParams(search);
  const errors: string[] = [];
  const raw = q.get('packs');
  const packs = raw === null ? [...defaultPacks] : raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (packs.length === 0) errors.push(`?packs= must list at least one pack directory`);
  let seed = DEFAULT_SEED;
  const s = q.get('seed');
  if (s !== null) {
    const n = Number(s);
    if (s.trim() === '' || !Number.isInteger(n)) errors.push(`?seed= expects an integer, got '${s}'`);
    else seed = n;
  }
  return { packs, seed, errors };
}
