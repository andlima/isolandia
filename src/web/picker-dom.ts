/**
 * DOM rendering of the title screen (the model is `pickerModel` in
 * `picker.ts`): rows for the games and mods, checkboxes for extra mods, a
 * seed field and Play. It only renders the model and wires clicks.
 */

import type { Catalog } from '../core/index.ts';
import { DEFAULT_SEED } from './params.ts';
import { pickerModel } from './picker.ts';

/** Replace the page with the title screen; Play navigates to the chosen stack. */
export function showPicker(catalog: Catalog, navigate: (query: string) => void): void {
  let chosen: string | null = null;
  let checked: string[] = [];
  let seed = DEFAULT_SEED;

  const el = document.createElement('div');
  el.id = 'picker';
  const title = document.createElement('h1');
  title.textContent = 'isolandia';
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
  el.append(title, body, footer);
  document.body.replaceChildren(el);

  let query: string | null = null;
  play.addEventListener('click', () => {
    if (query !== null) navigate(query);
  });

  const text = (tag: string, className: string, value: string): HTMLElement => Object.assign(document.createElement(tag), { className, textContent: value });

  function render(): void {
    const view = pickerModel(catalog, chosen, checked, seed);
    checked = checked.filter((d) => view.mods.some((m) => m.dir === d && m.checked));
    query = view.query;
    play.disabled = query === null;
    const parts: HTMLElement[] = [];
    if (view.errors.length) {
      const ul = document.createElement('ul');
      ul.className = 'picker-errors';
      for (const e of view.errors) ul.append(text('li', '', e));
      parts.push(ul);
    }
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
