/**
 * Real-time terminal shell for the ASCII renderer: raw-mode keyboard input,
 * a fixed 10 ticks/s loop, and ANSI coloring of the pure render output.
 */

import { hudModel, journalLines, journalToast, LEAVE_REFUSED_TEXT, reasonText, recipeHint, type Action, type EdgeSide, type Intent, type World } from '../core/index.ts';
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
  const hud = frame.hud.map((line, i) => {
    const level = frame.hudLevels[i];
    return level ? `${sgr(level === 'danger' ? 'red' : 'yellow')}${line}\x1b[0m` : line;
  });
  return [...out, '', ...hud].join('\n');
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

/** An entry of the `x` list. */
export interface ActEntry {
  readonly label: string;
  /** Target cell (tile actions and containers). */
  readonly x?: number;
  readonly y?: number;
  /** The target is the edge on this side of the cell. */
  readonly side?: EdgeSide;
  readonly ok: boolean;
  /** Why it cannot be done now (`reasonText`), or `''`. */
  readonly hint: string;
  /** Queued in order when chosen. */
  readonly actions: readonly Action[];
  /** Queued when chosen, before the actions (`Go up` / `Go down`). */
  readonly intent?: Intent;
}

/** Climb keys: `<` goes up a floor, `>` down. */
export const CLIMB_KEYS: Readonly<Record<string, 1 | -1>> = { '<': 1, '>': -1 };

/** The `c` list: recipes that can be made now, or (when there are none) a few that cannot, with hints. */
export interface CraftMenu {
  /** `ok` recipes, in definition order (at most 9); `1`–`9` craft one. */
  readonly entries: readonly ActEntry[];
  /** Up to three not-`ok` recipes, only when `entries` is empty (to aid discovery). */
  readonly blocked: readonly ActEntry[];
}

/** Pending multi-key input (the `d` drop prefix, the `x` action list and the `c` craft list). */
export interface KeyState {
  dropPending: boolean;
  /** The open `x` list, or null/absent when closed. */
  actions?: ActEntry[] | null;
  /** The open `c` list, or null/absent when closed. */
  crafting?: CraftMenu | null;
  /** A message for the help line set by the last key (e.g. `No way up here.`), or null/absent. */
  message?: string | null;
  /** The open journal screen (`J`, `journalLines`), shown until any key; null/absent when closed. */
  journal?: string[] | null;
}

/**
 * The `x` list, at most 9 entries: `Go up` / `Go down` when the player
 * stands on a link, `Talk to …` for each NPC with a dialogue in reach
 * (row-major), the self and tile actions that can be started here
 * (`availableActions`), then `take all` for each reachable non-empty
 * container (`interactionsAt` over the reachable cells, row-major).
 */
export function actionMenu(world: World): ActEntry[] {
  const out: ActEntry[] = [];
  const { x: px, y: py, z: pz } = world.player;
  for (const e of world.interactionsAt(px, py, pz)) {
    if (e.kind === 'climb') out.push({ label: e.label, ok: e.ok, hint: '', actions: [], intent: e.intent! });
  }
  for (let y = py - 1; y <= py + 1; y++) {
    for (let x = px - 1; x <= px + 1; x++) {
      for (const e of world.interactionsAt(x, y, pz)) {
        if (e.kind === 'talk' && e.inReach) out.push({ label: e.label, x, y, ok: e.ok, hint: reasonText(e), actions: [e.action!] });
      }
    }
  }
  for (const a of world.availableActions()) {
    if (a.kind !== 'act') continue;
    const side = a.side ? { side: a.side } : {};
    const action: Action = a.x !== undefined ? { kind: 'act', action: a.action!, x: a.x, y: a.y!, z: a.z!, ...side } : { kind: 'act', action: a.action! };
    out.push({ label: a.label, ...(a.x !== undefined ? { x: a.x, y: a.y!, ...side } : {}), ok: a.ok, hint: reasonText(a), actions: [action] });
  }
  for (let y = py - 1; y <= py + 1; y++) {
    for (let x = px - 1; x <= px + 1; x++) {
      for (const e of world.interactionsAt(x, y, pz)) {
        if (e.kind === 'take_all') out.push({ label: e.label, x, y, ok: e.ok, hint: reasonText(e), actions: e.actions! });
      }
    }
  }
  return out.slice(0, 9);
}

/** `act: 1) Barricade (12,3 w)  2) Rest [Not now]` (an edge target names its side), or a note when nothing can be done here. */
export function actionMenuText(list: readonly ActEntry[]): string {
  if (list.length === 0) return 'no actions here (any key)';
  const entry = (a: ActEntry, i: number) => `${i + 1}) ${a.label}${a.x !== undefined ? ` (${a.x},${a.y}${a.side ? ` ${a.side}` : ''})` : ''}${a.ok ? '' : ` [${a.hint}]`}`;
  return `act: ${list.map(entry).join('  ')}`;
}

/** The `c` list from `availableRecipes` (labels `<verb>: <label>`, each crafted at its chosen station). */
export function craftMenu(world: World): CraftMenu {
  const all = world.availableRecipes().map(
    (r): ActEntry => ({
      label: `${r.verb}: ${r.label}`,
      ...(r.station ? { x: r.station.x, y: r.station.y } : {}),
      ok: r.ok,
      hint: r.ok ? '' : recipeHint(world, r),
      actions: [r.station ? { kind: 'craft', recipe: r.recipe, x: r.station.x, y: r.station.y, z: r.station.z } : { kind: 'craft', recipe: r.recipe }],
    }),
  );
  const entries = all.filter((e) => e.ok).slice(0, 9);
  return { entries, blocked: entries.length ? [] : all.filter((e) => !e.ok).slice(0, 3) };
}

/** `craft: 1) Cook: Hot beans  2) Make: Bandage`, or `Nothing to craft` and a few blocked recipes with their hints. */
export function craftMenuText(menu: CraftMenu): string {
  if (menu.entries.length) return `craft: ${menu.entries.map((e, i) => `${i + 1}) ${e.label}`).join('  ')}`;
  return ['Nothing to craft', ...menu.blocked.map((e) => `${e.label} [${e.hint}]`)].join('  ');
}

/**
 * The conversation screen while one is open (else null): the speaker, the
 * text, the numbered visible choices (disabled ones with their hint) and the
 * keys.
 */
export function conversationLines(world: World): string[] | null {
  const view = world.conversationView();
  if (!view) return null;
  const n = view.choices.length;
  return [
    `${view.speaker}:`,
    ...view.text.split('\n').map((l) => `  ${l}`),
    ...view.choices.map((c, i) => `${i + 1}) ${c.text}${c.ok ? '' : ` [${reasonText(c)}]`}`),
    `(${n === 1 ? '1' : `1-${n}`}: choose${view.leave ? '  Esc: leave' : ''})`,
  ];
}

/** What a key asks of the terminal loop, beyond changing the world. */
export type KeyResult = 'quit' | 'save' | 'load' | void;

/** The message-line text for the last stepped tick's journal events (`journalToast`), or null. */
export function journalMessage(world: World): string | null {
  return world.journalEvents.length ? journalToast(world.journalEvents, world) : null;
}

/**
 * Apply one key to the world. While a conversation is open, `1`–`9` choose
 * a visible choice and Escape leaves (or says `LEAVE_REFUSED_TEXT`); other
 * keys except `q`, `J`, `S` and `L` do nothing. `J` opens the journal screen (lowercase `j`
 * still moves), closed again by any key. `x` opens the list of pack actions and
 * `take all`s that can be done here, `c` the list of recipes that can be
 * made now (`1`–`9` start one, any other key closes either). With an
 * inventory, `g` takes everything that fits from every reachable container,
 * `1`–`9` use inventory stack N and `d` then `1`–`9` drops stack N (so
 * digits and `d` stop moving; arrows, `hjklyubn`, `wsa` and the numpad with
 * NumLock off still do, and cancel what the player is doing). `<` / `>`
 * climb through the link at the player's cell (`climbIntent`), or set
 * `state.message` to `No way up here.` / `No way down here.`. Returns
 * `'quit'` for `q`/Ctrl-C, and `'save'` / `'load'` for `S` / `L` (the
 * caller does the file work; lowercase `s`/`l` still move).
 */
export function handleKey(world: World, key: string, state: KeyState): KeyResult {
  state.message = null;
  if (key === '\x03') return 'quit';
  if (state.journal) {
    state.journal = null;
    return;
  }
  if (key === 'q' || key === 'Q') return 'quit';
  if (key === 'J') {
    state.actions = null;
    state.crafting = null;
    state.dropPending = false;
    state.journal = journalLines(world.journal());
    return;
  }
  if (key === 'S' || key === 'L') {
    state.actions = null;
    state.crafting = null;
    state.dropPending = false;
    return key === 'S' ? 'save' : 'load';
  }
  if (world.conversation) {
    // The world is paused: digits choose, Escape leaves, everything else (movement included) does nothing.
    state.actions = null;
    state.crafting = null;
    state.dropPending = false;
    if (/^[1-9]$/.test(key)) {
      world.choose(Number(key) - 1);
      state.message = journalMessage(world);
    } else if (key === '\x1b') {
      if (!world.leaveConversation().ok) state.message = LEAVE_REFUSED_TEXT;
    }
    return;
  }
  const open = state.actions ?? state.crafting?.entries;
  if (open) {
    state.actions = null;
    state.crafting = null;
    const a = /^[1-9]$/.test(key) ? open[Number(key) - 1] : undefined;
    if (a) {
      if (a.intent) world.queueIntent(a.intent);
      for (const action of a.actions) world.queueAction(action);
      return;
    }
    if (/^[1-9]$/.test(key)) return;
  } else if (CLIMB_KEYS[key] && !state.dropPending) {
    const dz = CLIMB_KEYS[key];
    const intent = world.climbIntent(dz);
    if (intent) world.queueIntent(intent);
    else state.message = dz > 0 ? 'No way up here.' : 'No way down here.';
    return;
  } else if (key === 'x' && !state.dropPending) {
    state.actions = actionMenu(world);
    return;
  } else if (key === 'c' && !state.dropPending) {
    state.crafting = craftMenu(world);
    return;
  }
  const inv = world.player.inv;
  if (inv) {
    const digit = /^[1-9]$/.test(key) ? Number(key) : 0;
    if (state.dropPending) {
      state.dropPending = false;
      if (digit) {
        const s = inv.stacks[digit - 1];
        if (s) world.queueAction({ kind: 'drop', item: world.def.items[s.item]!.id });
        return;
      }
    } else if (key === 'd') {
      state.dropPending = true;
      return;
    } else if (digit) {
      const s = inv.stacks[digit - 1];
      if (s) world.queueAction({ kind: 'use', item: world.def.items[s.item]!.id });
      return;
    }
    if (key === 'g') {
      for (const c of hudModel(world).nearby) for (const s of c.stacks) world.queueAction({ kind: 'take', container: c.id, item: s.item });
      return;
    }
  }
  const intent = KEYMAP[key] ?? KEYMAP[key.toLowerCase()];
  if (intent) world.queueIntent(intent);
}

export interface TerminalIO {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
}

/** File work for `S` / `L`, done by the caller (see `src/cli/saves.ts`). */
export interface TerminalSaves {
  /** Write the save; returns the message to show. */
  save(world: World): string;
  /** Read the save: a new world (or null on errors) and the message to show. */
  load(): { world: World | null; message: string };
}

/** `active N, dormant M` for the status line, or '' while no NPC is dormant. */
export function simStatus(world: World): string {
  const active = world.activeCount;
  const dormant = world.entities.length - active;
  return dormant > 0 ? `active ${active}, dormant ${dormant}` : '';
}

/** How long a save/load message stays on the help line. */
const STATUS_MS = 4000;

/** Run an interactive session until `q`/Ctrl-C. Resolves when the session ends. */
export function runTerminal(initial: World, io: TerminalIO, saves?: TerminalSaves, status = ''): Promise<void> {
  const { stdin, stdout } = io;
  let world = initial;
  const tickMs = 1000 / world.def.ticksPerSecond;
  const keys: KeyState = { dropPending: false, actions: null, crafting: null };
  let message = status;
  let messageAt = Date.now();
  const say = (text: string) => {
    message = text;
    messageAt = Date.now();
  };

  return new Promise((resolve) => {
    const draw = () => {
      // Clock, floor, measurements, carrying/inventory, status, nearby, activity, action and defeat/victory lines, blank line, help line.
      const hudRows = 2 + (world.grid.floors > 1 ? 1 : 0) + hudModel(world).measurements.length + 7 + 2;
      if (keys.journal) {
        stdout.write('\x1b[H' + [...keys.journal, '', '\x1b[2m(any key)\x1b[0m'].join('\x1b[K\n') + '\x1b[K\n\x1b[J');
        return;
      }
      const help = (world.player.inv ? 'q: quit  g: take all  1-9: use  d 1-9: drop  x: act  c: craft' : 'q: quit  x: act') + '  J: journal' + (saves ? '  S: save  L: load' : '');
      // The view is double resolution (cells between edges): 2·w + 1 columns by 2·h + 1 lines.
      const width = Math.max(5, Math.floor(((stdout.columns ?? 80) - 1) / 2));
      const height = Math.max(2, Math.floor(((stdout.rows ?? 24) - hudRows - 1) / 2));
      const talk = conversationLines(world);
      if (talk) {
        // The conversation replaces the help line under a shorter map.
        const h = Math.max(2, Math.floor(((stdout.rows ?? 24) - hudRows - talk.length) / 2));
        const lines = message ? [...talk, message] : talk;
        stdout.write('\x1b[H' + colorize(renderAscii(world, { width, height: h })).replace(/\n/g, '\x1b[K\n') + `\x1b[K\n${lines.join('\x1b[K\n')}\x1b[J`);
        return;
      }
      const frame = renderAscii(world, { width, height });
      if (message && Date.now() - messageAt > STATUS_MS) message = '';
      const sim = simStatus(world);
      const line = keys.actions ? actionMenuText(keys.actions) : keys.crafting ? craftMenuText(keys.crafting) : keys.dropPending ? 'drop which? 1-9' : (message || help) + (sim ? `  |  ${sim}` : '');
      stdout.write('\x1b[H' + colorize(frame).replace(/\n/g, '\x1b[K\n') + `\x1b[K\n\x1b[2m${line}\x1b[0m\x1b[J`);
    };

    // Sim time tracks wall time from (startMs, startTick); a load restarts the count.
    let startMs = Date.now();
    let startTick = world.tick;

    const onKey = (buf: Buffer) => {
      const r = handleKey(world, buf.toString('utf8'), keys);
      if (r === 'quit') return stop();
      if (keys.message) {
        say(keys.message);
        draw();
      }
      if (!saves) return;
      if (r === 'save') say(saves.save(world));
      else if (r === 'load') {
        const loaded = saves.load();
        say(loaded.message);
        if (loaded.world) {
          world = loaded.world;
          startMs = Date.now();
          startTick = world.tick;
        }
      }
      if (r) draw();
    };

    const timer = setInterval(() => {
      // Catch up on missed ticks so sim time tracks wall time; a conversation pauses the clock.
      if (world.conversation) {
        startMs = Date.now();
        startTick = world.tick;
      }
      const due = startTick + Math.floor((Date.now() - startMs) / tickMs);
      let n = 0;
      while (world.tick < due && n++ < 10) {
        world.step();
        const note = journalMessage(world);
        if (note) say(note);
      }
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
