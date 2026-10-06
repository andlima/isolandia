// Record the M7 move equivalence fixtures (test/fixtures/m7-*.json):
// `node --import tsx scripts/equivalence-fixture.ts [root]`. Run once on the
// packs before the move (`root` holds their `packs/`, e.g. a `git archive` of
// the commit before it); the tests compare the moved packs against these files.
import { writeFileSync } from 'node:fs';
import { loadStack, summarize } from '../test/equivalence.ts';

const root = process.argv[2] ?? '.';
const GAMES = {
  zombie: ['std', 'std-needs', 'zombie'],
  vampire: ['std', 'vampire'],
};
const SEEDS = [1, 7];

for (const [name, dirs] of Object.entries(GAMES)) {
  const def = loadStack(dirs.map((d) => `${root}/packs/${d}`));
  const out = `test/fixtures/m7-${name}.json`;
  writeFileSync(out, `${JSON.stringify(SEEDS.map((s) => summarize(def, s)), null, 2)}\n`);
  console.log(out);
}
