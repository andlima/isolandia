/**
 * Real-time terminal shell for the ASCII renderer: raw-mode keyboard input,
 * a fixed 10 ticks/s loop, and ANSI coloring of the pure render output.
 */

import type { Intent, World } from '../core/index.ts';
import { renderAscii, type AsciiFrame } from './render.ts';

const NAMED: Record<string, string> = {
  black: '30',
  red: '31',
  green: '32',
  yellow: '33',
  blue: '34',
  magenta: '35',
  cyan: '36',
  white: '37',
  gray: '90',
  grey: '90',
  bright_red: '91',
  bright_green: '92',
  bright_yellow: '93',
  bright_blue: '94',
  bright_magenta: '95',
  bright_cyan: '96',
  bright_white: '97',
};

function sgr(color: string | null): string {
  if (!color) return '';
  if (color.startsWith('#')) {
    const n = parseInt(color.slice(1), 16);
    return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
  }
  const code = NAMED[color];
  return code ? `\x1b[${code}m` : '';
}

/** Apply ANSI colors to a frame. */
export function colorize(frame: AsciiFrame): string {
  const out: string[] = [];
  frame.lines.forEach((line, y) => {
    let s = '';
    let prev: string | null = null;
    [...line].forEach((ch, x) => {
      const c = frame.colors[y]![x] ?? null;
      if (c !== prev) {
        s += '\x1b[0m' + sgr(c);
        prev = c;
      }
      s += ch;
    });
    out.push(s + '\x1b[0m');
  });
  return [...out, '', ...frame.hud].join('\n');
}

const d = (dx: -1 | 0 | 1, dy: -1 | 0 | 1): Intent => ({ kind: 'step', dx, dy });

/** Key sequence → movement intent (arrows, WASD, numpad, vi keys). */
export const KEYMAP: Readonly<Record<string, Intent>> = {
  '\x1b[A': d(0, -1),
  '\x1b[B': d(0, 1),
  '\x1b[C': d(1, 0),
  '\x1b[D': d(-1, 0),
  w: d(0, -1),
  s: d(0, 1),
  a: d(-1, 0),
  d: d(1, 0),
  '8': d(0, -1),
  '2': d(0, 1),
  '4': d(-1, 0),
  '6': d(1, 0),
  '7': d(-1, -1),
  '9': d(1, -1),
  '1': d(-1, 1),
  '3': d(1, 1),
  // Numpad with NumLock off.
  '\x1b[H': d(-1, -1),
  '\x1b[1~': d(-1, -1),
  '\x1b[5~': d(1, -1),
  '\x1b[F': d(-1, 1),
  '\x1b[4~': d(-1, 1),
  '\x1b[6~': d(1, 1),
  h: d(-1, 0),
  j: d(0, 1),
  k: d(0, -1),
  l: d(1, 0),
  y: d(-1, -1),
  u: d(1, -1),
  b: d(-1, 1),
  n: d(1, 1),
};

export interface TerminalIO {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
}

/** Run an interactive session until `q`/Ctrl-C. Resolves when the session ends. */
export function runTerminal(world: World, io: TerminalIO): Promise<void> {
  const { stdin, stdout } = io;
  const tickMs = 1000 / world.def.ticksPerSecond;
  // Clock, measurements, status and defeat lines, blank line, help line.
  const HUD_ROWS = 2 + world.player.archetype.measurements.length + 2 + 2;

  return new Promise((resolve) => {
    const draw = () => {
      const width = Math.max(10, stdout.columns ?? 80);
      const height = Math.max(5, (stdout.rows ?? 24) - HUD_ROWS);
      const frame = renderAscii(world, { width, height });
      stdout.write('\x1b[H' + colorize(frame).replace(/\n/g, '\x1b[K\n') + '\x1b[K\n\x1b[2mq: quit\x1b[0m\x1b[J');
    };

    const onKey = (buf: Buffer) => {
      const key = buf.toString('utf8');
      if (key === 'q' || key === 'Q' || key === '\x03') return stop();
      const intent = KEYMAP[key] ?? KEYMAP[key.toLowerCase()];
      if (intent) world.queueIntent(intent);
    };

    const start = Date.now();
    const timer = setInterval(() => {
      // Catch up on missed ticks so sim time tracks wall time.
      const due = Math.floor((Date.now() - start) / tickMs);
      let n = 0;
      while (world.tick < due && n++ < 10) world.step();
      draw();
    }, tickMs);

    function stop() {
      clearInterval(timer);
      stdin.off('data', onKey);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l');
      resolve();
    }

    stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J');
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onKey);
    draw();
  });
}
