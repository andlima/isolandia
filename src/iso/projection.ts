/**
 * 2:1 dimetric projection with a 64×32 px tile diamond (see VISION.md §7).
 *
 * World coordinates are continuous tile units: tile (i, j) covers
 * [i, i+1)×[j, j+1) and its diamond's top vertex is at iso(i, j). "iso" space
 * is the unscaled projected plane; "screen" space applies the camera:
 * `screen = iso * zoom + offset`. Everything here is pure.
 */

export const TILE_W = 64;
export const TILE_H = 32;
const HALF_W = TILE_W / 2;
const HALF_H = TILE_H / 2;

/** Height of a generated raised block (px, unscaled); its image is 64×64. */
export const BLOCK_H = 32;

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 3;

export interface Point {
  x: number;
  y: number;
}

export interface CameraState {
  /** Screen position of the iso origin (pan). */
  readonly offsetX: number;
  readonly offsetY: number;
  readonly zoom: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function worldToIso(x: number, y: number): Point {
  return { x: (x - y) * HALF_W, y: (x + y) * HALF_H };
}

export function isoToWorld(ix: number, iy: number): Point {
  const a = ix / HALF_W; // x - y
  const b = iy / HALF_H; // x + y
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

export function isoToScreen(ix: number, iy: number, cam: CameraState): Point {
  return { x: ix * cam.zoom + cam.offsetX, y: iy * cam.zoom + cam.offsetY };
}

export function screenToIso(sx: number, sy: number, cam: CameraState): Point {
  return { x: (sx - cam.offsetX) / cam.zoom, y: (sy - cam.offsetY) / cam.zoom };
}

export function worldToScreen(x: number, y: number, cam: CameraState): Point {
  const p = worldToIso(x, y);
  return isoToScreen(p.x, p.y, cam);
}

export function screenToWorld(sx: number, sy: number, cam: CameraState): Point {
  const p = screenToIso(sx, sy, cam);
  return isoToWorld(p.x, p.y);
}

/** Tile whose ground diamond contains the screen point. */
export function screenToTile(sx: number, sy: number, cam: CameraState): Point {
  const w = screenToWorld(sx, sy, cam);
  return { x: Math.floor(w.x), y: Math.floor(w.y) };
}

/**
 * Tile under the cursor, preferring a raised block whose top face (drawn
 * `blockH` px above its ground diamond) contains the point.
 */
export function pickTile(
  sx: number,
  sy: number,
  cam: CameraState,
  isRaised: (x: number, y: number) => boolean,
  blockH = BLOCK_H,
): Point {
  const top = screenToTile(sx, sy + blockH * cam.zoom, cam);
  return isRaised(top.x, top.y) ? top : screenToTile(sx, sy, cam);
}

/** Iso point where a tile sprite's anchor goes: the diamond's bottom vertex. */
export function tileAnchorIso(x: number, y: number): Point {
  return worldToIso(x + 1, y + 1);
}

/** Iso point where an entity at continuous tile position (x, y) stands: its tile's ground centre. */
export function groundCentreIso(x: number, y: number): Point {
  return worldToIso(x + 0.5, y + 0.5);
}

/** Axis-aligned iso bounds of a rectangular block of tiles (ground level). */
export function tileRectIsoBounds(x0: number, y0: number, w: number, h: number): Bounds {
  return {
    minX: worldToIso(x0, y0 + h).x,
    maxX: worldToIso(x0 + w, y0).x,
    minY: worldToIso(x0, y0).y,
    maxY: worldToIso(x0 + w, y0 + h).y,
  };
}

/** The viewport in iso space, grown by `margin` iso px on every side. */
export function viewIsoBounds(cam: CameraState, viewW: number, viewH: number, margin = 0): Bounds {
  return {
    minX: -cam.offsetX / cam.zoom - margin,
    minY: -cam.offsetY / cam.zoom - margin,
    maxX: (viewW - cam.offsetX) / cam.zoom + margin,
    maxY: (viewH - cam.offsetY) / cam.zoom + margin,
  };
}

export function intersects(a: Bounds, b: Bounds): boolean {
  return a.maxX >= b.minX && a.minX <= b.maxX && a.maxY >= b.minY && a.minY <= b.maxY;
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Zoom by `factor` keeping the screen point (sx, sy) fixed; zoom is clamped. */
export function zoomAt(cam: CameraState, sx: number, sy: number, factor: number): CameraState {
  const zoom = clampZoom(cam.zoom * factor);
  const k = zoom / cam.zoom;
  return { zoom, offsetX: sx - (sx - cam.offsetX) * k, offsetY: sy - (sy - cam.offsetY) * k };
}

/** Camera with the given zoom that puts iso point (ix, iy) at screen point (sx, sy). */
export function cameraAt(ix: number, iy: number, sx: number, sy: number, zoom: number): CameraState {
  return { zoom, offsetX: sx - ix * zoom, offsetY: sy - iy * zoom };
}
