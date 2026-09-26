import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  depthKey,
  isoToWorld,
  screenToTile,
  screenToWorld,
  tileRectIsoBounds,
  worldToIso,
  worldToScreen,
  zoomAt,
  type CameraState,
} from '../spike/render/iso.ts';

const close = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-6, msg ?? `${a} != ${b}`);

test('projection matches the 2:1 formula', () => {
  assert.deepEqual(worldToIso(0, 0), { x: 0, y: 0 });
  assert.deepEqual(worldToIso(1, 0), { x: 32, y: 16 });
  assert.deepEqual(worldToIso(0, 1), { x: -32, y: 16 });
  assert.deepEqual(worldToIso(3, 5), { x: -64, y: 128 });
});

test('iso projection and inverse round-trip', () => {
  for (const [x, y] of [[0, 0], [1.5, 2.25], [127.9, 0.1], [-3, 40], [64, 64]] as const) {
    const i = worldToIso(x, y);
    const w = isoToWorld(i.x, i.y);
    close(w.x, x);
    close(w.y, y);
  }
});

test('screen round-trip under zoom and pan', () => {
  const cams: CameraState[] = [
    { offsetX: 0, offsetY: 0, zoom: 1 },
    { offsetX: 400, offsetY: -250, zoom: 2 },
    { offsetX: -1234.5, offsetY: 77, zoom: 0.35 },
  ];
  for (const cam of cams) {
    for (const [x, y] of [[0, 0], [10.3, 20.7], [127.5, 3.25]] as const) {
      const s = worldToScreen(x, y, cam);
      const w = screenToWorld(s.x, s.y, cam);
      close(w.x, x);
      close(w.y, y);
    }
  }
});

test('screenToTile picks the tile under the cursor', () => {
  const cam: CameraState = { offsetX: 500, offsetY: 100, zoom: 1.5 };
  for (const [tx, ty] of [[0, 0], [5, 9], [127, 127], [64, 3]] as const) {
    // Tile centre and points near each of the diamond's corners but inside it.
    for (const [fx, fy] of [[0.5, 0.5], [0.05, 0.05], [0.95, 0.05], [0.05, 0.95], [0.95, 0.95]] as const) {
      const s = worldToScreen(tx + fx, ty + fy, cam);
      assert.deepEqual(screenToTile(s.x, s.y, cam), { x: tx, y: ty });
    }
  }
});

test('zoomAt keeps the anchor point fixed and clamps', () => {
  const cam: CameraState = { offsetX: 100, offsetY: 50, zoom: 1 };
  const before = screenToWorld(300, 200, cam);
  const z = zoomAt(cam, 300, 200, 1.7, 0.25, 3);
  const after = screenToWorld(300, 200, z);
  close(z.zoom, 1.7);
  close(after.x, before.x);
  close(after.y, before.y);
  assert.equal(zoomAt(cam, 0, 0, 100, 0.25, 3).zoom, 3);
  assert.equal(zoomAt(cam, 0, 0, 0.001, 0.25, 3).zoom, 0.25);
});

test('chunk iso bounds contain all corners', () => {
  const b = tileRectIsoBounds(32, 64, 32, 32);
  for (const [x, y] of [[32, 64], [64, 64], [32, 96], [64, 96]] as const) {
    const p = worldToIso(x, y);
    assert.ok(p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY);
  }
});

test('depth key orders nearer tiles later', () => {
  assert.ok(depthKey(3, 3) > depthKey(2, 3));
  assert.ok(depthKey(3, 3) > depthKey(3, 2));
  assert.ok(depthKey(4, 2) > depthKey(2, 4)); // same row sum: x breaks ties
});
