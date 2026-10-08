/**
 * Journal view models shared by the shells: the sections of the journal
 * panel (browser) and screen (terminal), its Standing rows, and the one-line
 * toast for a tick's stage changes, journal additions and standing tier
 * changes. Pure functions of `world.journal()` and `world.journalEvents`.
 */

import type { JournalEvent, JournalStanding, JournalView, World } from './sim/world.ts';

/** One section of the journal: `Active`, `Done`, then one per entry category. */
export interface JournalSection {
  readonly title: string;
  readonly rows: readonly string[];
}

/** Mark of an ended quest in the `Done` section. */
export const QUEST_MARK = { success: '✓', failure: '✗' } as const;

/** Longest toast, in characters (`…` included). */
export const TOAST_MAX = 80;

/**
 * The journal's sections, empty ones left out: *Active* quests (`Title:
 * stage text`), *Done* quests (`✓ Title: text` / `✗ Title: text`), then one
 * section per entry category in order of first use, entries in the order added.
 */
export function journalSections(view: JournalView): JournalSection[] {
  const out: JournalSection[] = [];
  const active = view.quests.filter((q) => q.state === 'active').map((q) => `${q.title}: ${q.text}`);
  const done = view.quests.filter((q) => q.state !== 'active').map((q) => `${QUEST_MARK[q.state as 'success' | 'failure']} ${q.title}: ${q.text}`);
  if (active.length) out.push({ title: 'Active', rows: active });
  if (done.length) out.push({ title: 'Done', rows: done });
  const categories = new Map<string, string[]>();
  for (const e of view.entries) {
    const rows = categories.get(e.category);
    if (rows) rows.push(e.text);
    else categories.set(e.category, [e.text]);
  }
  for (const [title, rows] of categories) out.push({ title, rows });
  return out;
}

/** Title of the journal's standing section. */
export const STANDING_TITLE = 'Standing';

/** One faction of the Standing section. */
export interface StandingRow {
  /** Qualified faction id. */
  readonly faction: string;
  readonly label: string;
  readonly tier: string;
  /** The standing, rounded to a whole number for display. */
  readonly value: number;
  /** Position of the standing on a bar from -100 (0) to 100 (1). */
  readonly fraction: number;
  /** `Police: Wary (-22)`. */
  readonly text: string;
}

/** A standing rounded for display (never `-0`). */
function displayValue(value: number): number {
  return Math.round(value) || 0;
}

/** The Standing section's rows: one per faction that is not hidden, in definition order. */
export function standingRows(view: JournalView): StandingRow[] {
  return view.standing.map((s: JournalStanding) => {
    const value = displayValue(s.value);
    return { faction: s.faction, label: s.label, tier: s.tier, value, fraction: Math.min(1, Math.max(0, (s.value + 100) / 200)), text: `${s.label}: ${s.tier} (${value})` };
  });
}

/** The journal as text lines (the terminal's journal screen): a heading per section, its rows indented, then the standing lines. */
export function journalLines(view: JournalView): string[] {
  const sections = journalSections(view);
  const standing = standingRows(view);
  if (sections.length === 0 && standing.length === 0) return ['Journal', '', '  Nothing yet.'];
  const out = ['Journal'];
  for (const s of sections) out.push('', s.title, ...s.rows.map((r) => `  ${r}`));
  if (standing.length) out.push('', STANDING_TITLE, ...standing.map((r) => `  ${r.text}`));
  return out;
}

/** The first line of `text`, trimmed and cut to `max` characters with `…`. */
export function oneLine(text: string, max: number = TOAST_MAX): string {
  const line = text.trim().split('\n')[0]!.trim();
  const chars = [...line];
  return chars.length <= max ? line : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

/** Whether an event may be shown: a hidden quest's stages stay secret until it ends. */
function visible(e: JournalEvent, world: World): boolean {
  if (e.kind !== 'stage') return true;
  const q = world.def.quests[world.def.ids.quests[e.quest!]!]!;
  return !q.hidden || q.stages.some((s) => s.name === e.stage && s.end !== null);
}

/** The toast text of a standing tier change: `<Label>: <from> → <to>`. */
export function standingToast(e: JournalEvent, world: World): string {
  const f = world.def.factions[world.def.ids.factions[e.faction!]!]!;
  return `${f.label}: ${e.from} → ${e.to}`;
}

/**
 * The toast for a tick's journal events: `Journal: <quest title>: <stage
 * text>`, `Journal: <entry text>` or `<Faction>: <from tier> → <to tier>`
 * for the last shown event, with `(+N)` when there were N more; one line,
 * cut with `…`. Null when there is nothing to show.
 */
export function journalToast(events: readonly JournalEvent[], world: World): string | null {
  const shown = events.filter((e) => visible(e, world));
  const last = shown[shown.length - 1];
  if (!last) return null;
  const { def } = world;
  let text: string;
  if (last.kind === 'reputation') text = standingToast(last, world);
  else if (last.kind === 'stage') {
    const q = def.quests[def.ids.quests[last.quest!]!]!;
    text = `Journal: ${q.title}: ${q.stages.find((s) => s.name === last.stage)!.journal}`;
  } else text = `Journal: ${def.journal[def.ids.journal[last.entry!]!]!.text}`;
  const more = shown.length > 1 ? ` (+${shown.length - 1})` : '';
  return `${oneLine(text, TOAST_MAX - more.length)}${more}`;
}
