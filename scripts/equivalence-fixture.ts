// Record the M7 move equivalence fixtures (test/fixtures/m7-*.json):
// `node --import tsx scripts/equivalence-fixture.ts`. Run once on the packs
// before the move; the tests compare the moved packs against these files.
import { writeFileSync } from 'node:fs';
import { loadStack, summarize } from '../test/equivalence.ts';

const GAMES = {
  zombie: ['packs/std', 'packs/std-needs', 'packs/zombie'],
  vampire: ['packs/std', 'packs/vampire'],
};
const SEEDS = [1, 7];

for (const [name, dirs] of Object.entries(GAMES)) {
  const def = loadStack(dirs);
  const out = `test/fixtures/m7-${name}.json`;
  writeFileSync(out, `${JSON.stringify(SEEDS.map((s) => summarize(def, s)), null, 2)}\n`);
  console.log(out);
}
