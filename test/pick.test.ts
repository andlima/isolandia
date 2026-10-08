import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPTY_TILE, Grid, loadPacksOrThrow, World, type EdgeSide, type Entity, type MapDef, type TileDef } from '../src/core/index.ts';
import { Layer } from '../src/iso/depth.ts';
import { drawOrder, hits, hitTest, makeMask, maskFromRgba, spriteBounds, type Candidate, type HitMask } from '../src/iso/hit.ts';
import { pickTarget, type Drawn, type PickSource, type PickTarget } from '../src/iso/pick.ts';
import { edgeAnchorIso, FLOOR_H, groundCentreIso, isoToScreen, pickCell, tileAnchorIso, type CameraState } from '../src/iso/projection.ts';
import { readPack } from '../src/node/read-pack.ts';
import { GAMES } from './helpers.ts';

const ID: CameraState = { offsetX: 0, offsetY: 0, zoom: 1 };
const CAMS: CameraState[] = [ID, { offsetX: 400, offsetY: -250, zoom: 2 }, { offsetX: -123.5, offsetY: 77, zoom: 0.5 }];

const FULL_BLOCK = blockMask();
/** A 64×64 block on the 32×32 art grid: the top diamond and the two front faces (corners transparent). */
function blockMask(): HitMask {
  // Image px: top vertex (32, 0), side vertices (0|64, 16), bottom vertex (32, 64), sides down to y = 48.
  return makeMask(32, 32, (c, r) => {
    const x = c * 2 + 1;
    const y = r * 2 + 1;
    const dx = Math.abs(x - 32);
    return y >= dx / 2 && y <= 64 - dx / 2;
  });
}
const FULL = (cols: number, rows: number) => makeMask(cols, rows, () => true);

const FLOOR: TileDef = { raised: false, walkable: true, opaque: false } as TileDef;
const WALL: TileDef = { raised: true, walkable: false, opaque: true } as TileDef;
const WALL_EDGE: TileDef = { raised: false, walkable: false, opaque: true, edge: true } as TileDef;

/** A grid from rows per floor: `.` floor, `#` raised, space empty; `edges` are wall edges as `x,y,z,side`. */
function grid(floors: string[][], edges: string[] = []): Grid {
  const height = floors[0]!.length;
  const width = floors[0]![0]!.length;
  const cells = floors.flatMap((rows) => rows.flatMap((row) => [...row].map((ch) => (ch === '.' ? 0 : ch === '#' ? 1 : EMPTY_TILE))));
  const edgeN = cells.map(() => EMPTY_TILE);
  const edgeW = cells.map(() => EMPTY_TILE);
  for (const e of edges) {
    const [x, y, z, side] = e.split(',');
    (side === 'n' ? edgeN : edgeW)[(Number(z) * height + Number(y)) * width + Number(x)] = 2;
  }
  return new Grid({ width, height, floors: floors.length, cells, edgeN, edgeW } as unknown as MapDef, [FLOOR, WALL, WALL_EDGE]);
}

/** A 40×64 edge image on the 20×32 art grid (anchor [0.1, 0.65625], image px (4, 42)): the `n` slab, 32 px tall. */
const EDGE_MASK = makeMask(20, 32, (c, r) => {
  const dx = c * 2 + 1 - 4;
  const ground = 42 + dx / 2;
  return dx >= -2 && dx <= 34 && r * 2 + 1 <= ground + 2 && r * 2 + 1 >= ground - 34;
});

function edgeAt(x: number, y: number, z: number, side: EdgeSide): Drawn {
  const a = edgeAnchorIso(x, y);
  return {
    bounds: spriteBounds(a.x, a.y - z * FLOOR_H, 40, 64, 0.1, 0.65625, side === 'w'),
    mask: EDGE_MASK,
    mirrored: side === 'w',
    order: drawOrder(z, x, y, Layer.Edge),
    target: { kind: 'edge', x, y, z, side },
    floor: z,
  };
}

function blockAt(x: number, y: number, z: number, mask = FULL_BLOCK, mirrored = false): Drawn {
  const a = tileAnchorIso(x, y);
  return {
    bounds: spriteBounds(a.x, a.y - z * FLOOR_H, 64, 64, 0.5, 1, mirrored),
    mask,
    mirrored,
    order: drawOrder(z, x, y, Layer.Block),
    target: { kind: 'tile', x, y, z },
    floor: z,
  };
}

function entityAt(e: Entity, mask = FULL(16, 24)): Drawn {
  const a = groundCentreIso(e.x, e.y);
  return {
    bounds: spriteBounds(a.x, a.y - e.z * FLOOR_H, 32, 48, 0.5, 0.92, false),
    mask,
    mirrored: false,
    order: drawOrder(e.z, e.x, e.y, Layer.Entity),
    target: { kind: 'entity', x: e.x, y: e.y, z: e.z, entity: e },
    floor: e.z,
  };
}

/** A source drawing every raised cell with `blockAt` (unless overridden) and every edge with `edgeAt`, minus the faded cells (and their edges). */
function source(g: Grid, opts: { objects?: Drawn[]; faded?: string[]; blocks?: Map<string, Drawn> } = {}): PickSource {
  const faded = new Set(opts.faded ?? []);
  const cache = new Map<number, Drawn>();
  return {
    grid: g,
    reach: { up: 64, down: 0, side: 32 },
    block: (x, y, z) => {
      if (faded.has(`${x},${y},${z}`) || !g.tileAt(x, y, z)?.raised) return null;
      const i = g.index(x, y, z);
      let d = cache.get(i);
      if (!d) cache.set(i, (d = opts.blocks?.get(`${x},${y},${z}`) ?? blockAt(x, y, z)));
      return d;
    },
    edge: (x, y, z, side) => (faded.has(`${x},${y},${z}`) || !g.edgeAt(x, y, z, side) ? null : edgeAt(x, y, z, side)),
    faded: (x, y, z) => faded.has(`${x},${y},${z}`),
    objects: () => opts.objects ?? [],
  };
}

const at = (ix: number, iy: number, cam: CameraState) => isoToScreen(ix, iy, cam);
const cell = (t: PickTarget) => [t.kind, t.x, t.y, t.z];

const ROOM = [
  '........',
  '........',
  '........',
  '........',
  '........',
  '.....#..',
  '........',
  '........',
];

test('hit masks: alpha ≥ 0.5 is opaque, sampled at art-pixel centres', () => {
  // 4×2 px RGBA → 2×1 art pixels; alpha 77 (a 0.3 drop shadow) is not a hit, 128 is.
  const a = (alpha: number) => [0, 0, 0, alpha];
  const px = [...a(0), ...a(0), ...a(77), ...a(77), ...a(0), ...a(255), ...a(128), ...a(0)];
  const m = maskFromRgba(px, 4, 2, 2, 1);
  // Centre of art px 0 is pixel (1, 1) → alpha 255; art px 1 samples (3, 1) → 0.
  assert.deepEqual([...m.bits], [1, 0]);
  const shadow = maskFromRgba([...a(77), ...a(77), ...a(77), ...a(77)], 2, 2, 1, 1);
  assert.deepEqual([...shadow.bits], [0]);
  const half = maskFromRgba([...a(128), ...a(128), ...a(128), ...a(128)], 2, 2, 1, 1);
  assert.deepEqual([...half.bits], [1]);
});

test('hitTest: frontmost hit wins; transparent pixels fall through; outside bounds misses', () => {
  const back: Candidate<string> = { bounds: { minX: 0, minY: 0, maxX: 4, maxY: 4 }, mask: FULL(2, 2), mirrored: false, order: 1, target: 'back' };
  // Front: opaque only in its bottom row.
  const front: Candidate<string> = { bounds: { minX: 0, minY: 0, maxX: 4, maxY: 4 }, mask: makeMask(2, 2, (_c, r) => r === 1), mirrored: false, order: 2, target: 'front' };
  assert.equal(hitTest(1, 3, [back, front])?.target, 'front');
  assert.equal(hitTest(1, 3, [front, back])?.target, 'front');
  assert.equal(hitTest(1, 1, [front, back])?.target, 'back');
  assert.equal(hitTest(5, 1, [front, back]), null);
  assert.equal(hitTest(1, 3, [back, front], 1)?.target, 'back', 'only the first `count` candidates');
});

test('hitTest: a mirrored mask is read right to left, around the anchor spot', () => {
  // A 4×2 sprite anchored at its left edge, opaque only in its left half; mirrored it extends left of the anchor.
  const mask = makeMask(2, 1, (c) => c === 0);
  const plain: Candidate<string> = { bounds: spriteBounds(10, 2, 4, 2, 0, 1, false), mask, mirrored: false, order: 0, target: 'plain' };
  assert.deepEqual(plain.bounds, { minX: 10, minY: 0, maxX: 14, maxY: 2 });
  assert.ok(hits(plain, 11, 1));
  assert.ok(!hits(plain, 13, 1));
  const flipped: Candidate<string> = { ...plain, bounds: spriteBounds(10, 2, 4, 2, 0, 1, true), mirrored: true };
  assert.deepEqual(flipped.bounds, { minX: 6, minY: 0, maxX: 10, maxY: 2 });
  assert.ok(hits(flipped, 9, 1), 'the image’s left column is drawn next to the anchor, on the right');
  assert.ok(!hits(flipped, 7, 1));
});

test('pick: the upper part of a block’s front face hits the block, not the cell behind it', () => {
  const g = grid([ROOM]);
  const src = source(g);
  // Block (5, 5): anchor iso (0, 192); its left face's top edge at x = −20 is y = 150.
  for (const cam of CAMS) {
    const p = at(-20, 153, cam);
    const old = pickCell(p.x, p.y, cam, 0, (x, y, z) => g.tileAt(x, y, z)?.raised ?? false, (x, y, z) => g.tileAt(x, y, z) !== undefined);
    assert.deepEqual([old.x, old.y], [4, 5], 'pickCell picks the floor behind');
    assert.deepEqual(cell(pickTarget(p.x, p.y, cam, 0, src)), ['tile', 5, 5, 0]);
    // The top face still picks the block, and the floor beside it is ground.
    const top = at(0, 140, cam);
    assert.deepEqual(cell(pickTarget(top.x, top.y, cam, 0, src)), ['tile', 5, 5, 0]);
    const side = at(-60, 140, cam);
    assert.equal(pickTarget(side.x, side.y, cam, 0, src).kind, 'ground');
  }
});

test('pick: a character’s head in front of a wall hits the entity, at its simulation cell', () => {
  const g = grid([ROOM]);
  const zombie = { x: 6, y: 5, z: 0 } as Entity;
  const src = source(g, { objects: [entityAt(zombie)] });
  // Entity at (6, 5) stands at iso (32, 192); its head is ~40 px up, over the wall's right face.
  for (const cam of CAMS) {
    const p = at(28, 155, cam);
    const t = pickTarget(p.x, p.y, cam, 0, src);
    assert.deepEqual(cell(t), ['entity', 6, 5, 0]);
    assert.equal(t.kind === 'entity' && t.entity, zombie);
  }
  // The entity's sprite may be mid-step; the target reads its cell at pick time.
  zombie.x = 7;
  const p = at(28, 155, ID);
  assert.deepEqual(cell(pickTarget(p.x, p.y, ID, 0, src)), ['entity', 7, 5, 0]);
});

test('pick: a transparent pixel of a sprite falls through to the sprite behind it', () => {
  const rows = ROOM.slice();
  rows[4] = '....#...';
  const g = grid([rows]);
  // The front block (5, 5) has a hole in its top face; the block (4, 4) is behind it.
  const holed = makeMask(32, 32, (c, r) => FULL_BLOCK.bits[r * 32 + c] === 1 && !(c < 14 && r >= 8 && r < 12));
  const src = source(g, { blocks: new Map([['5,5,0', blockAt(5, 5, 0, holed)]]) });
  const hole = at(-20, 146, ID); // image px (12, 18) → art (6, 9); (4, 4)'s left face is behind it
  assert.deepEqual(cell(pickTarget(hole.x, hole.y, ID, 0, src)), ['tile', 4, 4, 0]);
  const solid = at(-20, 153, ID);
  assert.deepEqual(cell(pickTarget(solid.x, solid.y, ID, 0, src)), ['tile', 5, 5, 0]);
});

test('pick: a block faded by the cutaway is clicked through, top face included', () => {
  const g = grid([ROOM]);
  const src = source(g, { faded: ['5,5,0'] });
  const face = at(-20, 153, ID);
  assert.deepEqual(cell(pickTarget(face.x, face.y, ID, 0, src)), ['ground', 4, 5, 0]);
  const top = at(0, 140, ID); // over the faded block's top face: the floor diamond behind it
  assert.deepEqual(cell(pickTarget(top.x, top.y, ID, 0, src)), ['ground', 4, 4, 0]);
});

test('pick: floors above the view floor are ignored; the ground falls through empty cells to lower floors', () => {
  const f0 = ['......', '......', '......', '......', '......', '......'];
  const f1 = ['##    ', '##    ', '      ', '      ', '    . ', '      '];
  const g = grid([f0, f1]);
  const src = source(g);
  // Block (1, 1) on floor 1: anchor iso (0, 64 − 32). Seen from floor 0 it is cut away.
  const p = at(0, 20, ID);
  assert.deepEqual(cell(pickTarget(p.x, p.y, ID, 1, src)), ['tile', 1, 1, 1]);
  const below = pickTarget(p.x, p.y, ID, 0, src);
  assert.equal(below.kind, 'ground');
  assert.equal(below.z, 0);
  // Without sprite hits, pickTarget is pickCell, on every floor and camera.
  const isRaised = (x: number, y: number, z: number) => g.tileAt(x, y, z)?.raised ?? false;
  const isFilled = (x: number, y: number, z: number) => g.tileAt(x, y, z) !== undefined;
  const none: PickSource = { ...src, block: () => null, edge: () => null };
  for (const cam of CAMS) {
    for (let i = 0; i < 400; i++) {
      const ix = -200 + (i % 20) * 20 + 3.3;
      const iy = -40 + Math.floor(i / 20) * 12 + 1.7;
      const s = at(ix, iy, cam);
      for (const view of [0, 1]) {
        const old = pickCell(s.x, s.y, cam, view, isRaised, isFilled);
        const t = pickTarget(s.x, s.y, cam, view, none);
        assert.deepEqual([t.x, t.y, t.z], [old.x, old.y, old.z], `iso (${ix}, ${iy}) view ${view}`);
      }
    }
  }
});

const OPEN = ['......', '......', '......', '......', '......', '......'];
const side = (t: PickTarget) => (t.kind === 'edge' ? t.side : null);

test('pick: a wall edge’s slab picks the edge and its side; the w slab is the mirrored n one', () => {
  const g = grid([OPEN], ['3,3,0,n', '3,3,0,w']);
  const src = source(g);
  // Both slabs start at (3, 3)'s top vertex, iso (0, 96): n runs down-right, w down-left, 32 px tall.
  for (const cam of CAMS) {
    const n = at(16, 88, cam);
    const tn = pickTarget(n.x, n.y, cam, 0, src);
    assert.deepEqual([...cell(tn), side(tn)], ['edge', 3, 3, 0, 'n']);
    const w = at(-16, 88, cam);
    const tw = pickTarget(w.x, w.y, cam, 0, src);
    assert.deepEqual([...cell(tw), side(tw)], ['edge', 3, 3, 0, 'w']);
    // Above the slab: the ground behind it.
    const above = at(16, 60, cam);
    assert.equal(pickTarget(above.x, above.y, cam, 0, src).kind, 'ground');
  }
});

test('pick: an entity in front of an edge hits over it; one behind it is covered', () => {
  const g = grid([OPEN], ['3,3,0,n']);
  const front = { x: 3, y: 3, z: 0 } as Entity; // stands at iso (0, 112)
  const back = { x: 3, y: 2, z: 0 } as Entity; // stands at iso (0, 80), behind the slab
  const p = at(8, 82, ID); // over both entities and the slab
  assert.deepEqual(cell(pickTarget(p.x, p.y, ID, 0, source(g, { objects: [entityAt(front)] }))), ['entity', 3, 3, 0]);
  assert.deepEqual(cell(pickTarget(p.x, p.y, ID, 0, source(g, { objects: [entityAt(back)] }))), ['edge', 3, 3, 0]);
});

test('pick: an edge faded by the cutaway is clicked through', () => {
  const g = grid([OPEN], ['3,3,0,n']);
  const p = at(16, 88, ID);
  assert.deepEqual(cell(pickTarget(p.x, p.y, ID, 0, source(g, { faded: ['3,3,0'] }))), ['ground', 3, 2, 0]);
});

test('pick: on the 343×343 zombie city a pick takes well under 1 ms (synthetic masks)', () => {
  const w = World.create(loadPacksOrThrow(GAMES.zombie.map((d) => readPack(d))), 1);
  const g = w.grid;
  assert.ok(g.width >= 280 && g.height >= 280);
  const objects = w.entities.map((e) => entityAt(e));
  const src = source(g, { objects });
  const p = groundCentreIso(w.player.x, w.player.y);
  const cam: CameraState = { offsetX: 640 - p.x * 2, offsetY: 360 - p.y * 2, zoom: 2 };
  const N = 2000;
  const run = () => {
    for (let i = 0; i < N; i++) pickTarget((i * 37) % 1280, (i * 53) % 720, cam, 0, src);
  };
  run(); // warm up
  const t0 = performance.now();
  run();
  const ms = (performance.now() - t0) / N;
  assert.ok(ms < 0.25, `${ms.toFixed(4)} ms per pick`);
});
