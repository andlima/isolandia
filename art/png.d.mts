// Types for art/png.mjs, so the TypeScript tests can use it.

export interface Rgba {
  width: number;
  height: number;
  /** RGBA, straight alpha, `width * height * 4` bytes. */
  data: Uint8Array;
}

export function png(w: number, h: number, rgb: Uint8Array): Buffer;
export function encodePng(img: Rgba): Buffer;
export function pngSize(buf: Buffer): { width: number; height: number };
export function decodePng(buf: Buffer): Rgba;
export function inDiamond(x: number, y: number, W: number, H: number, cell?: number): boolean;
export function readZip(buf: Buffer): Map<string, Buffer>;
