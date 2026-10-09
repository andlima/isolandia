import assert from 'node:assert/strict';
import { loadPacksOrThrow, World, type Definition, type PackSource } from '../src/core/index.ts';

/** Build an in-memory pack from `{ path: yamlText }`. */
export function pack(label: string, files: Record<string, string>): PackSource {
  return { label, files };
}

/** Ordered pack directories for each shipped playable stack (the base `town`, its genre mods, the garden). */
export const GAMES = {
  town: ['packs/std', 'packs/std-needs', 'packs/town'],
  zombie: ['packs/std', 'packs/std-needs', 'packs/town', 'packs/zombie'],
  vampire: ['packs/std', 'packs/std-needs', 'packs/town', 'packs/vampire'],
  noir: ['packs/std', 'packs/std-needs', 'packs/town', 'packs/noir'],
  western: ['packs/std', 'packs/std-needs', 'packs/town', 'packs/western'],
  garden: ['packs/std', 'packs/garden'],
} as const;

/**
 * Where each genre's original map sits in its composite start map: genre
 * scenarios written for the old single maps add these to their coordinates
 * (`town:town_center` in `town:city`, `vamp:mansion` in `vamp:estate`; the
 * garden is not a composite).
 */
export const GENRE_AT = {
  town: { x: 142, y: 157 },
  zombie: { x: 142, y: 157 },
  vampire: { x: 49, y: 54 },
  noir: { x: 142, y: 157 },
  western: { x: 142, y: 157 },
  garden: { x: 0, y: 0 },
} as const;

/** A cell of a genre's original map, in its start map's coordinates. */
export function genreCell(name: keyof typeof GENRE_AT, x: number, y: number): [number, number] {
  return [x + GENRE_AT[name].x, y + GENRE_AT[name].y];
}

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

/** Input for one tick, applied alike to the original and the restored world (it may only read the world it gets). */
export type Script = (w: World) => void;

const viaJson = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * The save round-trip invariant (docs/saves.md): `world` saved and restored
 * through JSON has the same snapshot, saves to the same `SaveFile` again, and
 * reaches the same `hash()` on every one of `ticks` further ticks when both
 * get the same `script` input. Steps `world` too; returns the restored copy.
 */
export function assertRoundTrip(world: World, script: Script = () => {}, ticks = 60): World {
  const save = viaJson(world.save());
  const r = World.restore(world.def, save);
  if (!r.ok) assert.fail(`restore failed at tick ${world.tick}:\n${r.errors.join('\n')}`);
  assert.deepEqual(r.warnings, []);
  const copy = r.world;
  assert.deepStrictEqual(copy.snapshot(), viaJson(world.snapshot()), `restored snapshot at tick ${world.tick}`);
  assert.deepStrictEqual(viaJson(copy.save()), save, 'saving the restored world again');
  assert.equal(copy.hash(), world.hash());
  for (let i = 0; i < ticks; i++) {
    script(world);
    script(copy);
    world.step();
    copy.step();
    assert.equal(copy.hash(), world.hash(), `hash ${i + 1} ticks after the save (tick ${world.tick})`);
  }
  return copy;
}

/**
 * The cell characters of an ASCII frame (`renderAscii`, double resolution):
 * its odd lines, odd columns — one string per viewport row.
 */
export function cellRows(frame: { readonly lines: readonly string[] }): string[] {
  return frame.lines.filter((_, r) => r % 2 === 1).map((l) => [...l].filter((_, c) => c % 2 === 1).join(''));
}
