/**
 * Sprite textures for tiles and archetypes: loaded pack assets when a
 * definition entry has a `sprite`, generated placeholders from its `color`
 * otherwise. Every texture is built at most once per definition entry.
 */

import { Assets, Container, Graphics, Text, type Renderer, type Texture } from 'pixi.js';
import type { ArchetypeDef, AssetDef, Definition, TileDef } from '../core/index.ts';
import { luminance, parseColor, shade } from './colors.ts';
import { BLOCK_H, TILE_H, TILE_W } from './projection.ts';

/** A texture plus the normalized image point that goes on the sprite's anchor spot. */
export interface AnchoredTexture {
  readonly texture: Texture;
  readonly anchorX: number;
  readonly anchorY: number;
}

const HW = TILE_W / 2;
const HH = TILE_H / 2;
/** Generated textures are rasterized at this resolution so zooming in stays crisp. */
const BAKE_RESOLUTION = 3;

/**
 * Load every asset (index-aligned with `def.assets`; `urls[i]` null when the
 * shell has no URL for it). Failures log a warning and yield null, so the
 * caller falls back to placeholders.
 */
export async function loadAssetTextures(assets: readonly AssetDef[], urls: readonly (string | null)[]): Promise<(Texture | null)[]> {
  return Promise.all(
    assets.map(async (a, i) => {
      const src = urls[i];
      if (!src) {
        console.warn(`asset ${a.id}: no URL for ${a.pack}/${a.file}; using a placeholder`);
        return null;
      }
      const svg = a.file.toLowerCase().endsWith('.svg');
      try {
        return await Assets.load<Texture>({ src, parser: svg ? 'svg' : 'texture', data: svg ? { resolution: 2 } : undefined });
      } catch (e) {
        console.warn(`asset ${a.id}: failed to load ${a.pack}/${a.file}; using a placeholder`, e);
        return null;
      }
    }),
  );
}

export class TextureBank {
  private readonly tiles: (AnchoredTexture | undefined)[] = [];
  private readonly archetypes: (AnchoredTexture | undefined)[] = [];
  private readonly markers = new Map<number, AnchoredTexture>();

  constructor(
    private readonly renderer: Renderer,
    private readonly def: Definition,
    /** Loaded asset textures, index-aligned with `def.assets` (null = failed). */
    private readonly assets: readonly (Texture | null)[],
  ) {}

  /** Texture for a tile; its anchor goes on the diamond's bottom vertex. */
  tile(t: TileDef): AnchoredTexture {
    return (this.tiles[t.index] ??= this.fromAsset(t.sprite) ?? this.bake(t.raised ? block(t.color) : diamond(t.color)));
  }

  /** Texture for an archetype; its anchor goes on the tile's ground centre. */
  archetype(a: ArchetypeDef): AnchoredTexture {
    return (this.archetypes[a.index] ??= this.fromAsset(a.sprite) ?? this.bake(marker(a.color, a.glyph)));
  }

  /** Diamond outline for tile highlights; anchored like a flat tile. */
  outline(color: number): AnchoredTexture {
    let t = this.markers.get(color);
    if (!t) {
      t = this.bake(
        new Graphics()
          .poly([0, -TILE_H, HW, -HH, 0, 0, -HW, -HH])
          .fill({ color, alpha: 0.25 })
          .stroke({ width: 2, color, alignment: 1 }),
      );
      this.markers.set(color, t);
    }
    return t;
  }

  private fromAsset(index: number | null): AnchoredTexture | null {
    if (index === null) return null;
    const texture = this.assets[index];
    if (!texture) return null;
    const [anchorX, anchorY] = this.def.assets[index]!.anchor;
    return { texture, anchorX, anchorY };
  }

  /** Render a display object drawn around its anchor spot (0, 0) into a texture. */
  private bake(c: Container): AnchoredTexture {
    const b = c.getLocalBounds();
    const texture = this.renderer.generateTexture({ target: c, resolution: BAKE_RESOLUTION, antialias: true });
    c.destroy({ children: true });
    return { texture, anchorX: -b.minX / b.width, anchorY: -b.minY / b.height };
  }
}

// Placeholder shapes. Each is drawn with its anchor spot at (0, 0): the
// diamond's bottom vertex for tiles, the ground centre for entities.

function diamond(color: string): Graphics {
  const c = parseColor(color);
  // The same-colored hairline stroke hides seams between neighbouring tiles.
  return new Graphics()
    .poly([0, -TILE_H, HW, -HH, 0, 0, -HW, -HH])
    .fill(c)
    .stroke({ width: 1, color: shade(c, 0.88) });
}

function block(color: string): Graphics {
  const c = parseColor(color);
  const H = BLOCK_H;
  return new Graphics()
    .poly([-HW, -HH - H, 0, -H, 0, 0, -HW, -HH]) // left face
    .fill(shade(c, 0.72))
    .poly([0, -H, HW, -HH - H, HW, -HH, 0, 0]) // right face
    .fill(shade(c, 0.55))
    .poly([0, -TILE_H - H, HW, -HH - H, 0, -H, -HW, -HH - H]) // top face
    .fill(c)
    .stroke({ width: 1, color: shade(c, 0.4), alpha: 0.8 });
}

function marker(color: string, glyph: string): Container {
  const c = parseColor(color);
  const outline = shade(c, 0.45);
  const g = new Graphics()
    .ellipse(0, 0, 11, 5)
    .fill({ color: 0x000000, alpha: 0.3 })
    .roundRect(-9, -34, 18, 32, 7)
    .fill(c)
    .stroke({ width: 1.5, color: outline });
  const text = new Text({
    text: glyph,
    style: {
      fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
      fontSize: 16,
      fontWeight: 'bold',
      fill: luminance(c) > 0.55 ? 0x111111 : 0xffffff,
    },
    resolution: BAKE_RESOLUTION,
  });
  text.anchor.set(0.5);
  text.position.set(0, -18);
  const root = new Container();
  root.addChild(g, text);
  return root;
}
