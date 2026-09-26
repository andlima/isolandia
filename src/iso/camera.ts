/**
 * Camera state for the iso view: follows the player by default, keeping it
 * at an anchor point (a fraction of the viewport, initially the centre).
 * Panning turns follow off; zooming around a point keeps follow and moves the
 * anchor to wherever the zoom put the player; `recenter` restores both.
 */

import { cameraAt, isoToScreen, zoomAt, type CameraState } from './projection.ts';

export class CameraRig {
  cam: CameraState = { offsetX: 0, offsetY: 0, zoom: 1 };
  follow = true;
  private fx = 0.5;
  private fy = 0.5;

  pan(dx: number, dy: number): void {
    this.follow = false;
    this.cam = { ...this.cam, offsetX: this.cam.offsetX + dx, offsetY: this.cam.offsetY + dy };
  }

  /** Zoom by `factor` around screen point (sx, sy); `player` is the player's iso position. */
  zoom(sx: number, sy: number, factor: number, player: { x: number; y: number }, viewW: number, viewH: number): void {
    this.cam = zoomAt(this.cam, sx, sy, factor);
    if (this.follow && viewW > 0 && viewH > 0) {
      const p = isoToScreen(player.x, player.y, this.cam);
      this.fx = p.x / viewW;
      this.fy = p.y / viewH;
    }
  }

  recenter(): void {
    this.follow = true;
    this.fx = this.fy = 0.5;
  }

  /** Per-frame update: when following, keep the player at the anchor. */
  update(player: { x: number; y: number }, viewW: number, viewH: number): CameraState {
    if (this.follow) this.cam = cameraAt(player.x, player.y, viewW * this.fx, viewH * this.fy, this.cam.zoom);
    return this.cam;
  }
}
