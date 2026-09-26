import { Graphics, type Renderer, type Texture } from 'pixi.js';
import { TILE_H, TILE_W } from './iso.ts';

/** Height of a raised block (px, unscaled). */
export const BLOCK_H = 24;

export interface AnchoredTexture {
  texture: Texture;
  anchorX: number;
  anchorY: number;
}

/**
 * Procedural placeholder textures. Each graphic is drawn with its logical
 * origin at (0, 0) — the floor diamond's top vertex for blocks, the feet for
 * entities — and the anchor is derived from the local bounds so sprites can
 * be positioned directly at projected coordinates.
 */
export function makeTextures(renderer: Renderer) {
  const hw = TILE_W / 2;
  const hh = TILE_H / 2;
  const H = BLOCK_H;

  const block = new Graphics()
    // left face
    .poly([-hw, hh - H, 0, TILE_H - H, 0, TILE_H, -hw, hh])
    .fill(0x6b5b4b)
    // right face
    .poly([0, TILE_H - H, hw, hh - H, hw, hh, 0, TILE_H])
    .fill(0x4d4136)
    // top face
    .poly([0, -H, hw, hh - H, 0, TILE_H - H, -hw, hh - H])
    .fill(0x9c8a74)
    .stroke({ width: 1, color: 0x3a3029, alpha: 0.6 });

  const pawn = (body: number, outline: number, scale: number) =>
    new Graphics()
      .ellipse(0, 0, 8 * scale, 4 * scale)
      .fill({ color: 0x000000, alpha: 0.3 })
      .roundRect(-5 * scale, -18 * scale, 10 * scale, 14 * scale, 4 * scale)
      .fill(body)
      .stroke({ width: 1, color: outline })
      .circle(0, -21 * scale, 4.5 * scale)
      .fill(body)
      .stroke({ width: 1, color: outline });

  const marker = (color: number) =>
    new Graphics()
      .poly([0, 0, hw, hh, 0, TILE_H, -hw, hh])
      .fill({ color, alpha: 0.25 })
      .stroke({ width: 2, color });

  const bake = (g: Graphics): AnchoredTexture => {
    const b = g.getLocalBounds();
    const texture = renderer.generateTexture(g);
    g.destroy();
    return { texture, anchorX: -b.minX / b.width, anchorY: -b.minY / b.height };
  };

  return {
    block: bake(block),
    // White body so each wanderer can be tinted.
    wanderer: bake(pawn(0xffffff, 0x222222, 1)),
    player: bake(pawn(0xffd23f, 0xb00020, 1.35)),
    target: bake(marker(0xffd23f)),
    invalidTarget: bake(marker(0xff3355)),
  };
}

export type SpikeTextures = ReturnType<typeof makeTextures>;
