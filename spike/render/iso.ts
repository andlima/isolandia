/**
 * Classic 2:1 dimetric projection with 64×32 px tile diamonds. World
 * coordinates are continuous tile units: tile (i, j) covers [i, i+1)×[j, j+1)
 * and its diamond's top vertex is at iso(i, j).
 *
 * "iso" space is the unscaled projected plane; "screen" space applies the
 * camera: screen = iso * zoom + offset. All functions are pure.
 */
export const TILE_W = 64;
export const TILE_H = 32;
const HALF_W = TILE_W / 2;
const HALF_H = TILE_H / 2;

export interface Point {
  x: number;
  y: number;
}

export interface CameraState {
  /** Screen position of the iso origin (pan). */
  offsetX: number;
  offsetY: number;
  zoom: number;
}

export function worldToIso(x: number, y: number): Point {
  return { x: (x - y) * HALF_W, y: (x + y) * HALF_H };
}

export function isoToWorld(ix: number, iy: number): Point {
  const a = ix / HALF_W; // x - y
  const b = iy / HALF_H; // x + y
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

export function worldToScreen(x: number, y: number, cam: CameraState): Point {
  const p = worldToIso(x, y);
  return { x: p.x * cam.zoom + cam.offsetX, y: p.y * cam.zoom + cam.offsetY };
}

export function screenToWorld(sx: number, sy: number, cam: CameraState): Point {
  return isoToWorld((sx - cam.offsetX) / cam.zoom, (sy - cam.offsetY) / cam.zoom);
}

export function screenToTile(sx: number, sy: number, cam: CameraState): Point {
  const w = screenToWorld(sx, sy, cam);
  return { x: Math.floor(w.x), y: Math.floor(w.y) };
}

/** Axis-aligned iso-space bounds of a rectangular block of tiles. */
export function tileRectIsoBounds(
  x0: number,
  y0: number,
  w: number,
  h: number,
): { minX: number; minY: number; maxX: number; maxY: number } {
  return {
    minX: worldToIso(x0, y0 + h).x,
    maxX: worldToIso(x0 + w, y0).x,
    minY: worldToIso(x0, y0).y,
    maxY: worldToIso(x0 + w, y0 + h).y,
  };
}

/** Zoom by `factor` keeping the screen point (sx, sy) fixed; zoom is clamped. */
export function zoomAt(
  cam: CameraState,
  sx: number,
  sy: number,
  factor: number,
  minZoom: number,
  maxZoom: number,
): CameraState {
  const zoom = Math.min(maxZoom, Math.max(minZoom, cam.zoom * factor));
  const k = zoom / cam.zoom;
  return {
    zoom,
    offsetX: sx - (sx - cam.offsetX) * k,
    offsetY: sy - (sy - cam.offsetY) * k,
  };
}

/** Depth key: nearer (larger x + y) draws later; x breaks ties. */
export function depthKey(x: number, y: number): number {
  return (x + y) * 1024 + x;
}
