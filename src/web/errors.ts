import { formatError, type LoadError } from '../core/index.ts';

/** The CLI's error output (`npm run check`), as one string. */
export function errorReport(errors: readonly (LoadError | string)[]): string {
  const lines = errors.map((e) => (typeof e === 'string' ? e : formatError(e)));
  return `${lines.join('\n')}\n\n${errors.length} error(s); packs not loaded.`;
}

/** Replace the page with the error list and a link back to the title screen. */
export function showErrors(errors: readonly (LoadError | string)[]): void {
  const pre = document.createElement('pre');
  pre.id = 'errors';
  pre.textContent = `${errorReport(errors)}\n\n`;
  const back = document.createElement('a');
  back.id = 'title-link';
  back.href = location.pathname;
  back.textContent = 'Back to the title screen';
  pre.append(back);
  document.body.replaceChildren(pre);
}
