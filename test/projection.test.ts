import assert from 'node:assert/strict';
import { test } from 'node:test';
import { luminance, parseColor, shade } from '../src/iso/colors.ts';
import { depthKey, diagonalOf, Layer } from '../src/iso/depth.ts';
import {
  BLOCK_H,
  cameraAt,
  groundCentreIso,
  intersects,
  isoToWorld,
  pickTile,
  screenToTile,
  screenToWorld,
  tileAnchorIso,
  tileRectIsoBounds,
  viewIsoBounds,
  worldToIso,
  worldToScreen,
  zoomAt,
  type CameraState,
} from '../src/iso/projection.ts';

const close = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-6, msg ?? `${a} != ${b}`);

const CAMS: CameraState[] = [
  { offsetX: 0, offsetY: 0, zoom: 1 },
  { offsetX: 400, offsetY: -250, zoom: 2 },
  { offsetX: -1234.5, offsetY: 77, zoom: 0.35 },
  { offsetX: 500, offsetY: 100, zoom: 3 },
];

test('projection: 2:1 dimetric with a 64×32 diamond', () => {
  assert.deepEqual(worldToIso(0, 0), { x: 0, y: 0 });
  assert.deepEqual(worldToIso(1, 0), { x: 32, y: 16 });
  assert.deepEqual(worldToIso(0, 1), { x: -32, y: 16 });
  assert.deepEqual(worldToIso(1, 1), { x: 0, y: 32 });
  assert.deepEqual(tileAnchorIso(2, 3), worldToIso(3, 4));
  assert.deepEqual(groundCentreIso(2, 3), worldToIso(2.5, 3.5));
});

test('projection: world ↔ iso ↔ screen round-trips', () => {
  for (const [x, y] of [[0, 0], [1.5, 2.25], [127.9, 0.1], [-3, 40], [64, 64]] as const) {
    const i = worldToIso(x, y);
    const w = isoToWorld(i.x, i.y);
    close(w.x, x);
    close(w.y, y);
    for (const cam of CAMS) {
      const s = worldToScreen(x, y, cam);
      const b = screenToWorld(s.x, s.y, cam);
      close(b.x, x);
      close(b.y, y);
    }
  }
});

test('picking: points just inside each diamond edge pick that tile', () => {
  const e = 1e-3;
  for (const cam of CAMS) {
    for (const [tx, ty] of [[0, 0], [5, 9], [39, 14], [64, 3]] as const) {
      // Centre, and points just inside each of the four vertices and edge midpoints.
      const inside: [number, number][] = [
        [0.5, 0.5],
        [e, e], [1 - e, e], [e, 1 - e], [1 - e, 1 - e],
        [0.5, e], [0.5, 1 - e], [e, 0.5], [1 - e, 0.5],
      ];
      for (const [fx, fy] of inside) {
        const s = worldToScreen(tx + fx, ty + fy, cam);
        assert.deepEqual(screenToTile(s.x, s.y, cam), { x: tx, y: ty }, `cam ${cam.zoom} tile ${tx},${ty} at ${fx},${fy}`);
      }
      // Just across the top-right edge (x - e) is the neighbour at x - 1, etc.
      const across: [number, number, number, number][] = [
        [-e, 0.5, tx - 1, ty],
        [1 + e, 0.5, tx + 1, ty],
        [0.5, -e, tx, ty - 1],
        [0.5, 1 + e, tx, ty + 1],
      ];
      for (const [fx, fy, ex, ey] of across) {
        const s = worldToScreen(tx + fx, ty + fy, cam);
        assert.deepEqual(screenToTile(s.x, s.y, cam), { x: ex, y: ey });
      }
    }
  }
});

test('picking: raised blocks are picked by their top face', () => {
  const cam: CameraState = { offsetX: 300, offsetY: 50, zoom: 2 };
  const raised = (x: number, y: number) => x === 4 && y === 4;
  // The top face of block (4,4) is its ground diamond lifted by BLOCK_H.
  const top = worldToScreen(4.5, 4.5, cam);
  assert.deepEqual(pickTile(top.x, top.y - BLOCK_H * cam.zoom, cam, raised), { x: 4, y: 4 });
  // Without a raised block there, the same point picks the ground behind it.
  const flat = pickTile(top.x, top.y - BLOCK_H * cam.zoom, cam, () => false);
  assert.deepEqual(flat, screenToTile(top.x, top.y - BLOCK_H * cam.zoom, cam));
  assert.notDeepEqual(flat, { x: 4, y: 4 });
  // Flat ground next to the block picks normally.
  const g = worldToScreen(6.5, 6.5, cam);
  assert.deepEqual(pickTile(g.x, g.y, cam, raised), { x: 6, y: 6 });
});

test('camera: zoomAt keeps the anchor fixed and clamps to 0.25–3', () => {
  const cam: CameraState = { offsetX: 100, offsetY: 50, zoom: 1 };
  const before = screenToWorld(300, 200, cam);
  const z = zoomAt(cam, 300, 200, 1.7);
  const after = screenToWorld(300, 200, z);
  close(z.zoom, 1.7);
  close(after.x, before.x);
  close(after.y, before.y);
  assert.equal(zoomAt(cam, 0, 0, 100).zoom, 3);
  assert.equal(zoomAt(cam, 0, 0, 0.001).zoom, 0.25);
});

test('camera: cameraAt puts an iso point at a screen point', () => {
  const cam = cameraAt(120, -40, 400, 300, 1.5);
  const p = worldToScreen(isoToWorld(120, -40).x, isoToWorld(120, -40).y, cam);
  close(p.x, 400);
  close(p.y, 300);
});

test('culling: chunk bounds contain all corners and intersect the view', () => {
  const b = tileRectIsoBounds(32, 64, 16, 16);
  for (const [x, y] of [[32, 64], [48, 64], [32, 80], [48, 80]] as const) {
    const p = worldToIso(x, y);
    assert.ok(p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY);
  }
  const c = worldToIso(40, 72);
  const cam = cameraAt(c.x, c.y, 400, 300, 1);
  assert.ok(intersects(b, viewIsoBounds(cam, 800, 600)));
  const far = worldToIso(400, 72);
  assert.ok(!intersects(b, viewIsoBounds(cameraAt(far.x, far.y, 400, 300, 1), 800, 600)));
});

test('depth: nearer diagonals later, then larger x', () => {
  assert.ok(depthKey(3, 3, Layer.Block) > depthKey(2, 3, Layer.Block));
  assert.ok(depthKey(3, 3, Layer.Block) > depthKey(3, 2, Layer.Block));
  assert.ok(depthKey(4, 2, Layer.Block) > depthKey(2, 4, Layer.Block));
  assert.ok(depthKey(0, 200, Layer.Entity) > depthKey(199, 0, Layer.Block), 'diagonal dominates x on wide maps');
});

test('depth: a raised tile against entities in front of and behind it', () => {
  const block = depthKey(3, 3, Layer.Block);
  // In front (+x or +y neighbours, and the diagonal in front): drawn after.
  for (const [x, y] of [[3, 4], [4, 3], [4, 4], [2, 5], [4, 2]] as const) {
    assert.ok(depthKey(x, y, Layer.Entity) > block, `entity at ${x},${y} should be after the block`);
  }
  // Behind: drawn before.
  for (const [x, y] of [[3, 2], [2, 3], [2, 2], [1, 4]] as const) {
    assert.ok(depthKey(x, y, Layer.Entity) < block, `entity at ${x},${y} should be before the block`);
  }
  // Moving entities use their interpolated position: walking from (3,2)
  // (behind) to (4,2) and on to (4,3) (in front) crosses over the block once.
  const path = [[3, 2], [3.5, 2], [4, 2], [4, 2.5], [4, 3]] as const;
  const after = path.map(([x, y]) => depthKey(x, y, Layer.Entity) > block);
  assert.deepEqual(after, [false, false, true, true, true]);
  // Same tile position: entity after the block.
  assert.ok(depthKey(3, 3, Layer.Entity) > block);
});

test('depth: diagonal buckets', () => {
  assert.equal(diagonalOf(3, 3), 6);
  assert.equal(diagonalOf(3.5, 3), 6);
  assert.equal(diagonalOf(3.5, 3.5), 7);
  // Within a bucket every key is below every key of the next bucket.
  assert.ok(depthKey(0, 6.99, Layer.Entity) < depthKey(0, 7, Layer.Block));
  assert.ok(depthKey(6.99, 0, Layer.Entity) < depthKey(0, 7, Layer.Block));
});

test('colors: hex, names, shading, luminance', () => {
  assert.equal(parseColor('#8b1e2d'), 0x8b1e2d);
  assert.equal(parseColor('bright_white'), 0xffffff);
  assert.equal(parseColor('nonsense'), 0xff00ff);
  assert.equal(shade(0x808080, 0.5), 0x404040);
  assert.equal(shade(0xf0f0f0, 2), 0xffffff);
  assert.ok(luminance(0xffffff) > 0.99 && luminance(0) === 0);
});
