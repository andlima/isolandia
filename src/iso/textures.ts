/**
 * Sprite textures for tiles and archetypes: loaded pack assets when a
 * definition entry has a `sprite`, generated placeholders from its `color`
 * otherwise. Directional assets pick an image per facing (mirroring the
 * partner image where needed); placeholders get a facing cue. Every texture
 * is built at most once per definition entry and facing.
 */

import { Assets, Container, Graphics, Text, type Renderer, type Texture } from 'pixi.js';
import {
  DEFAULT_FACING,
  FACING_STEP,
  FACINGS,
  resolveFacing,
  type ArchetypeDef,
  type Definition,
  type Facing,
  type ItemDef,
  type TileDef,
} from '../core/index.ts';
import { luminance, parseColor, shade } from './colors.ts';
import { growReach, maskFromRgba, type HitMask, type Reach } from './hit.ts';
import { BLOCK_H, MAX_ZOOM, TILE_H, TILE_W } from './projection.ts';

/** A texture plus the normalized image point that goes on the sprite's anchor spot. */
export interface AnchoredTexture {
  readonly texture: Texture;
  readonly anchorX: number;
  readonly anchorY: number;
  /** Flip horizontally around the anchor spot (`scale.x = -1`). */
  readonly mirrored: boolean;
}

/** A texture chosen for a facing, plus the facing it actually shows (after snapping). */
export interface FacedTexture extends AnchoredTexture {
  readonly facing: Facing;
}

const HW = TILE_W / 2;
const HH = TILE_H / 2;
/** Generated textures are rasterized at this resolution so zooming in stays crisp. */
const BAKE_RESOLUTION = 3;
/** Iso px per art pixel (SVG art and placeholders; PNGs use their own pixels). */
const ART_PX = 2;
const EMPTY_MASK: HitMask = { cols: 1, rows: 1, bits: new Uint8Array(1) };
/** SVG pack assets are rasterized at the maximum zoom, so pixel-art edges stay sharp at every zoom level. */
const SVG_RESOLUTION = MAX_ZOOM;

/**
 * Load every image of every asset referenced by a tile, archetype or item
 * (`result[asset][image]`, aligned with `def.assets` and `AssetDef.images`;
 * `urls[asset][image]` null when the shell has no URL for it). Failures log
 * a warning and yield null, so the caller falls back to placeholders;
 * unreferenced assets are skipped.
 */
export async function loadAssetTextures(def: Definition, urls: readonly (readonly (string | null)[])[]): Promise<(Texture | null)[][]> {
  const used = new Set<number | null>([...def.tiles.map((t) => t.sprite), ...def.archetypes.map((a) => a.sprite), ...def.items.map((i) => i.sprite)]);
  return Promise.all(
    def.assets.map(async (a, i) => {
      if (!used.has(i)) return [];
      return Promise.all(
        a.images.map(async ({ file }, j) => {
          const src = urls[i]?.[j];
          if (!src) {
            console.warn(`asset ${a.id}: no URL for ${a.pack}/${file}; using a placeholder`);
            return null;
          }
          const svg = file.toLowerCase().endsWith('.svg');
          try {
            return await Assets.load<Texture>({ src, parser: svg ? 'svg' : 'texture', data: svg ? { resolution: SVG_RESOLUTION } : undefined });
          } catch (e) {
            console.warn(`asset ${a.id}: failed to load ${a.pack}/${file}; using a placeholder`, e);
            return null;
          }
        }),
      );
    }),
  );
}

/** Screen-space unit vector of a facing (2:1 projection: a step east goes down-right). */
export function facingScreenDir(f: Facing): { x: number; y: number } {
  const [dx, dy] = FACING_STEP[f];
  const x = (dx - dy) * HW;
  const y = (dx + dy) * HH;
  const len = Math.hypot(x, y);
  return { x: x / len, y: y / len };
}

/**
 * The diamond edge a cardinal facing faces, as [from, to] points relative to
 * the bottom vertex (the tile anchor spot): `n` up-right, `e` down-right,
 * `s` down-left, `w` up-left.
 */
export function facingEdge(f: Facing): readonly [readonly [number, number], readonly [number, number]] {
  const top = [0, -TILE_H] as const;
  const right = [HW, -HH] as const;
  const bottom = [0, 0] as const;
  const left = [-HW, -HH] as const;
  switch (f) {
    case 'n':
      return [top, right];
    case 'e':
      return [right, bottom];
    case 'w':
      return [left, top];
    default:
      return [bottom, left];
  }
}

export class TextureBank {
  /** Per tile, 5 slots: no explicit facing, then `n`, `e`, `s`, `w`. */
  private readonly tiles: (FacedTexture | undefined)[] = [];
  /** Per archetype placeholder, one slot per facing (`FACINGS` order). */
  private readonly archetypes: (FacedTexture | undefined)[] = [];
  private readonly items: (AnchoredTexture | undefined)[] = [];
  private readonly markers = new Map<number, AnchoredTexture>();
  /** Hit mask per texture drawn for a tile, archetype or item (mirrored facings share their partner's). */
  private readonly masks = new Map<Texture, HitMask>();
  /** How far any tile, archetype or item sprite reaches from its anchor spot (iso px). */
  readonly reach: Reach = { up: 0, down: 0, side: 0 };
  /** Time spent building the asset masks at startup (ms). */
  readonly maskMs: number;

  constructor(
    private readonly renderer: Renderer,
    private readonly def: Definition,
    /** Loaded asset textures, `[asset][image]` (null = failed). */
    private readonly assets: readonly (readonly (Texture | null)[])[],
  ) {
    const t0 = performance.now();
    def.assets.forEach((a, i) =>
      a.images.forEach(({ file, anchor }, j) => {
        const texture = assets[i]?.[j];
        if (texture) this.addMask(texture, anchor[0], anchor[1], file.toLowerCase().endsWith('.png') ? 1 : ART_PX);
      }),
    );
    this.maskMs = performance.now() - t0;
  }

  /** The hit mask of a texture returned by `tile`, `archetype` or `item`. */
  mask(texture: Texture): HitMask {
    return this.masks.get(texture) ?? EMPTY_MASK;
  }

  /** Build a texture's mask from its pixels, `artPx` iso px per mask cell. */
  private addMask(texture: Texture, anchorX: number, anchorY: number, artPx: number): void {
    if (this.masks.has(texture)) return;
    const { pixels, width, height } = this.renderer.extract.pixels({ target: texture });
    const cols = Math.max(1, Math.round(texture.width / artPx));
    const rows = Math.max(1, Math.round(texture.height / artPx));
    this.masks.set(texture, maskFromRgba(pixels, width, height, cols, rows));
    growReach(this.reach, texture.width, texture.height, anchorX, anchorY);
  }

  /**
   * Texture for a tile in a cell with the given legend `facing` (null = not
   * set, shown as `s` without a placeholder cue); its anchor goes on the
   * diamond's bottom vertex.
   */
  tile(t: TileDef, facing: Facing | null = null): FacedTexture {
    const slot = t.index * 5 + (facing === null ? 0 : 1 + ['n', 'e', 's', 'w'].indexOf(facing));
    const f = facing ?? DEFAULT_FACING;
    return (this.tiles[slot] ??=
      this.fromAsset(t.sprite, f, null) ?? { ...this.bakeMasked(t.raised ? block(t.color, facing) : diamond(t.color, facing)), facing: f });
  }

  /**
   * Texture for an archetype facing `facing`; its anchor goes on the tile's
   * ground centre. `prev` is the facing last shown for this sprite (snap
   * stickiness for 4-way assets, see `resolveFacing`).
   */
  archetype(a: ArchetypeDef, facing: Facing = DEFAULT_FACING, prev: Facing | null = null): FacedTexture {
    const fromAsset = this.fromAsset(a.sprite, facing, prev);
    if (fromAsset) return fromAsset;
    const slot = a.index * 8 + FACINGS.indexOf(facing);
    return (this.archetypes[slot] ??= { ...this.bakeMasked(marker(a.color, a.glyph, facing)), facing });
  }

  /** Texture for a ground pile of an item (always facing `s`); its anchor goes on the tile's ground centre. */
  item(i: ItemDef): AnchoredTexture {
    return (this.items[i.index] ??= this.fromAsset(i.sprite, DEFAULT_FACING, null) ?? this.bakeMasked(pile(i.color)));
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

  private fromAsset(index: number | null, facing: Facing, prev: Facing | null): FacedTexture | null {
    if (index === null) return null;
    const asset = this.def.assets[index]!;
    const r = resolveFacing(asset.byFacing, facing, prev);
    const texture = this.assets[index]?.[r.image];
    if (!texture) return null;
    const [anchorX, anchorY] = asset.images[r.image]!.anchor;
    return { texture, anchorX, anchorY, mirrored: r.mirrored, facing: r.facing };
  }

  /** `bake` plus a hit mask (placeholders get theirs when first baked). */
  private bakeMasked(c: Container): AnchoredTexture {
    const t = this.bake(c);
    this.addMask(t.texture, t.anchorX, t.anchorY, ART_PX);
    return t;
  }

  /** Render a display object drawn around its anchor spot (0, 0) into a texture. */
  private bake(c: Container): AnchoredTexture {
    const b = c.getLocalBounds();
    const texture = this.renderer.generateTexture({ target: c, resolution: BAKE_RESOLUTION, antialias: true });
    c.destroy({ children: true });
    return { texture, anchorX: -b.minX / b.width, anchorY: -b.minY / b.height, mirrored: false };
  }
}

// Placeholder shapes. Each is drawn with its anchor spot at (0, 0): the
// diamond's bottom vertex for tiles, the ground centre for entities.

/** Width of the front-edge cue, as a fraction of the way to the diamond centre. */
const EDGE_CUE = 0.22;

/** Darker stripe along the diamond edge a tile faces, `lift` px above the ground. */
function edgeCue(g: Graphics, c: number, facing: Facing, lift: number): Graphics {
  const [[ax, ay], [bx, by]] = facingEdge(facing);
  const cy = -HH; // diamond centre is (0, -HH)
  const k = EDGE_CUE;
  return g
    .poly([ax, ay - lift, bx, by - lift, bx + (0 - bx) * k, by + (cy - by) * k - lift, ax + (0 - ax) * k, ay + (cy - ay) * k - lift])
    .fill(shade(c, 0.6));
}

function diamond(color: string, facing: Facing | null): Graphics {
  const c = parseColor(color);
  // The same-colored hairline stroke hides seams between neighbouring tiles.
  const g = new Graphics()
    .poly([0, -TILE_H, HW, -HH, 0, 0, -HW, -HH])
    .fill(c)
    .stroke({ width: 1, color: shade(c, 0.88) });
  return facing ? edgeCue(g, c, facing, 0) : g;
}

function block(color: string, facing: Facing | null): Graphics {
  const c = parseColor(color);
  const H = BLOCK_H;
  const g = new Graphics()
    .poly([-HW, -HH - H, 0, -H, 0, 0, -HW, -HH]) // left face
    .fill(shade(c, 0.72))
    .poly([0, -H, HW, -HH - H, HW, -HH, 0, 0]) // right face
    .fill(shade(c, 0.55))
    .poly([0, -TILE_H - H, HW, -HH - H, 0, -H, -HW, -HH - H]) // top face
    .fill(c);
  if (facing) edgeCue(g, c, facing, H);
  return g.poly([0, -TILE_H - H, HW, -HH - H, 0, -H, -HW, -HH - H]).stroke({ width: 1, color: shade(c, 0.4), alpha: 0.8 });
}

/** A small sack in the item's colour, resting on the ground centre. */
function pile(color: string): Graphics {
  const c = parseColor(color);
  return new Graphics()
    .ellipse(0, 0, 10, 4)
    .fill({ color: 0x000000, alpha: 0.3 })
    .roundRect(-7, -12, 14, 12, 4)
    .fill(c)
    .stroke({ width: 1.5, color: shade(c, 0.45) });
}

const SHADOW_RX = 11;
const SHADOW_RY = 5;

/** Distance from the shadow centre to its rim along a screen direction. */
function rimDistance(x: number, y: number): number {
  return 1 / Math.hypot(x / SHADOW_RX, y / SHADOW_RY);
}

/**
 * Wedge on the drop shadow pointing in the facing's screen direction. It is
 * drawn over the body, so facings away from the camera stay visible.
 */
function facingWedge(g: Graphics, facing: Facing, color: number): Graphics {
  const u = facingScreenDir(facing);
  const tip = rimDistance(u.x, u.y) + 7;
  const pts: number[] = [u.x * tip, u.y * tip];
  for (const a of [0.55, -0.55]) {
    const x = u.x * Math.cos(a) - u.y * Math.sin(a);
    const y = u.x * Math.sin(a) + u.y * Math.cos(a);
    const r = rimDistance(x, y) * 0.8;
    pts.push(x * r, y * r);
  }
  return g.poly(pts).fill({ color, alpha: 0.9 }).stroke({ width: 1, color: 0x000000, alpha: 0.35 });
}

function marker(color: string, glyph: string, facing: Facing): Container {
  const c = parseColor(color);
  const outline = shade(c, 0.45);
  const g = new Graphics()
    .ellipse(0, 0, SHADOW_RX, SHADOW_RY)
    .fill({ color: 0x000000, alpha: 0.3 })
    .roundRect(-9, -34, 18, 32, 7)
    .fill(c)
    .stroke({ width: 1.5, color: outline });
  facingWedge(g, facing, outline);
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
