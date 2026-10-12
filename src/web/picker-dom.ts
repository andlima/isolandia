/**
 * DOM rendering of the title screen (the model is `pickerModel` in
 * `picker.ts`): quick-play cards for the featured packs, then an Advanced
 * section with rows for the games and mods, checkboxes for extra mods, a
 * seed field and Play. It only renders the model and wires clicks.
 */

import type { Catalog } from '../core/index.ts';
import { DEFAULT_SEED } from './params.ts';
import { pickerModel } from './picker.ts';

/** Replace the page with the title screen; a card or Play navigates to its stack. */
export function showPicker(catalog: Catalog, navigate: (query: string) => void): void {
  let chosen: string | null = null;
  let checked: string[] = [];
  let seed = DEFAULT_SEED;

  const el = document.createElement('div');
  el.id = 'picker';
  const title = document.createElement('h1');
  title.textContent = 'isolandia';
  const errors = document.createElement('div');
  const cards = document.createElement('div');
  cards.className = 'picker-cards';
  const advanced = document.createElement('details');
  advanced.className = 'picker-advanced';
  const summary = document.createElement('summary');
  summary.textContent = 'Advanced: build your own stack';
  const body = document.createElement('div');
  const footer = document.createElement('div');
  footer.className = 'picker-footer';
  const seedLabel = document.createElement('label');
  seedLabel.textContent = 'Seed ';
  const seedInput = document.createElement('input');
  seedInput.type = 'number';
  seedInput.step = '1';
  seedInput.value = String(seed);
  seedInput.addEventListener('input', () => {
    const n = Number(seedInput.value);
    seed = seedInput.value.trim() !== '' && Number.isInteger(n) ? n : DEFAULT_SEED;
    render();
  });
  seedLabel.append(seedInput);
  const play = document.createElement('button');
  play.id = 'picker-play';
  play.textContent = 'Play';
  footer.append(seedLabel, ' ', play);
  advanced.append(summary, body, footer);
  el.append(title, errors, cards, advanced);
  document.body.replaceChildren(el);

  let query: string | null = null;
  play.addEventListener('click', () => {
    if (query !== null) navigate(query);
  });

  const text = (tag: string, className: string, value: string): HTMLElement => Object.assign(document.createElement(tag), { className, textContent: value });

  let first = true;
  function render(): void {
    const view = pickerModel(catalog, chosen, checked, seed);
    checked = checked.filter((d) => view.mods.some((m) => m.dir === d && m.checked));
    query = view.query;
    play.disabled = query === null;
    if (view.errors.length) {
      const ul = document.createElement('ul');
      ul.className = 'picker-errors';
      for (const e of view.errors) ul.append(text('li', '', e));
      errors.replaceChildren(ul);
    } else errors.replaceChildren();
    cards.style.display = view.featured.length ? '' : 'none';
    // Closed behind the cards, open when there are none (then it is the whole screen).
    if (first) advanced.open = !view.featured.length;
    first = false;
    cards.replaceChildren(
      ...view.featured.map((c) => {
        const b = document.createElement('button');
        b.className = 'picker-card';
        b.disabled = !c.enabled;
        b.dataset['dir'] = c.dir;
        b.append(text('span', 'picker-name', c.name || c.dir), text('div', 'picker-desc', c.enabled ? c.description : c.reason!));
        b.addEventListener('click', () => {
          if (c.query !== null) navigate(c.query);
        });
        return b;
      }),
    );
    const parts: HTMLElement[] = [];
    if (!view.rows.length) parts.push(text('div', 'picker-hint', 'No game or mod packs found under packs/.'));
    for (const r of view.rows) {
      const b = document.createElement('button');
      b.className = `picker-row${r.chosen ? ' chosen' : ''}`;
      b.disabled = !r.enabled;
      b.dataset['dir'] = r.dir;
      b.append(
        text('span', 'picker-name', r.name || r.dir),
        text('span', 'picker-kind', ` ${r.kind}`),
        text('div', 'picker-desc', r.description),
        text('div', 'picker-stack', r.enabled ? `stack: ${r.stack.join(', ')}` : r.reason!),
      );
      b.addEventListener('click', () => {
        chosen = r.dir;
        render();
      });
      parts.push(b);
    }
    if (view.mods.length) {
      parts.push(text('div', 'picker-subtitle', 'Extra mods'));
      for (const m of view.mods) {
        const label = document.createElement('label');
        label.className = `picker-mod${m.enabled ? '' : ' disabled'}`;
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = m.checked;
        box.disabled = !m.enabled;
        box.addEventListener('change', () => {
          checked = box.checked ? [...checked, m.dir] : checked.filter((d) => d !== m.dir);
          render();
        });
        label.append(box, ` ${m.name || m.dir}`, text('div', 'picker-desc', m.reason ?? m.description));
        parts.push(label);
      }
    }
    if (view.stack.length) parts.push(text('div', 'picker-hint', `Loads: ${view.stack.join(', ')}`));
    body.replaceChildren(...parts);
  }
  render();
}
