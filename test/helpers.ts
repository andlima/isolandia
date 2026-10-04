import { loadPacksOrThrow, type Definition, type PackSource } from '../src/core/index.ts';

/** Build an in-memory pack from `{ path: yamlText }`. */
export function pack(label: string, files: Record<string, string>): PackSource {
  return { label, files };
}

/** Ordered pack directories for each real genre game. */
export const GAMES = {
  zombie: ['packs/std', 'packs/std-needs', 'packs/zombie'],
  vampire: ['packs/std', 'packs/vampire'],
  garden: ['packs/std', 'packs/garden'],
} as const;

export const MANIFEST_T = 'namespace: t\nname: Test\nversion: 1.0.0\n';

export const TILES_T = `tiles:
  - { id: floor, label: Floor, glyph: ".", color: white, walkable: true }
  - { id: wall, label: Wall, glyph: "#", color: gray, walkable: false }
`;

/** A small valid pack `t`; override or add files per test. */
export function fixture(files: Record<string, string> = {}): PackSource {
  return pack('fixture', {
    'pack.yaml': MANIFEST_T,
    'tiles.yaml': TILES_T,
    'measurements.yaml': `measurements:
  - id: hp
    label: HP
    max: 10
    initial: 10
  - id: food
    label: Food
    max: 100
    initial: 50
    rate: -1
`,
    'archetypes.yaml': `archetypes:
  - id: hero
    label: Hero
    glyph: "@"
    color: yellow
    tags: [living]
    measurements: [hp, food]
    ticks_per_turn: 0
  - id: rock
    label: Rock
    glyph: o
    color: gray
    ticks_per_turn: 0
`,
    'map.yaml': `maps:
  - id: room
    legend:
      ".": { tile: floor }
      "#": { tile: wall }
      "@": { tile: floor, player: true }
      "o": { tile: floor, spawn: rock }
    rows:
      - "#####"
      - "#.@o#"
      - "#...#"
      - "#####"
start:
  map: room
  player: hero
`,
    ...files,
  });
}

export function loadFixture(files: Record<string, string> = {}): Definition {
  return loadPacksOrThrow([fixture(files)]);
}
