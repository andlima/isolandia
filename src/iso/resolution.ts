/**
 * The `@Nx` file-name convention for PNG pack assets (docs/art.md#imported-art):
 * `road@2x.png` holds N image pixels per iso px, so it is drawn at 1/N of its
 * pixel size. Pure, so it is tested without Pixi.
 */

/**
 * Resolution of a pack asset from its pack-relative `file` path (not the
 * served URL, which the bundler may rename): N for a PNG named `…@Nx.png`
 * with N in 1–4, else 1. SVGs are always 1 here (they load at `SVG_RESOLUTION`).
 */
export function imageResolution(file: string): number {
  const m = /@([1-4])x\.png$/i.exec(file);
  return m ? Number(m[1]) : 1;
}
