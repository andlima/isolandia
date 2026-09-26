/** Pack color strings (`#rrggbb` or a terminal color name) as 0xRRGGBB. */

const NAMED: Readonly<Record<string, number>> = {
  black: 0x000000,
  red: 0xcd3131,
  green: 0x0dbc79,
  yellow: 0xe5e510,
  blue: 0x2472c8,
  magenta: 0xbc3fbc,
  cyan: 0x11a8cd,
  white: 0xe5e5e5,
  gray: 0x808080,
  grey: 0x808080,
  bright_red: 0xf14c4c,
  bright_green: 0x23d18b,
  bright_yellow: 0xf5f543,
  bright_blue: 0x3b8eea,
  bright_magenta: 0xd670d6,
  bright_cyan: 0x29b8db,
  bright_white: 0xffffff,
};

export function parseColor(color: string): number {
  if (/^#[0-9a-fA-F]{6}$/.test(color)) return parseInt(color.slice(1), 16);
  return NAMED[color] ?? 0xff00ff;
}

/** Multiply each channel by `k` (clamped to 0..255). */
export function shade(rgb: number, k: number): number {
  const ch = (s: number) => Math.max(0, Math.min(255, Math.round(((rgb >> s) & 255) * k)));
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/** Relative luminance in [0, 1], for picking a readable glyph color. */
export function luminance(rgb: number): number {
  return (0.2126 * ((rgb >> 16) & 255) + 0.7152 * ((rgb >> 8) & 255) + 0.0722 * (rgb & 255)) / 255;
}
