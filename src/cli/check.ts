import { loadOrExit, parseArgs } from './common.ts';

const { dirs } = parseArgs(process.argv.slice(2), 'usage: npm run check -- <pack-dir> [<pack-dir>…]');
const def = loadOrExit(dirs);
console.log(
  `OK: ${def.packs.map((p) => `${p.namespace}@${p.version}`).join(', ')} — ` +
    `${def.measurements.length} measurements, ${def.assets.length} assets, ${def.tiles.length} tiles, ` +
    `${def.archetypes.length} archetypes, ${def.maps.length} maps, ` +
    `${def.systems.length} systems, ${def.statuses.length} statuses`,
);
