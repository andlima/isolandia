import { formatError, type LoadError } from '../core/index.ts';

/** The CLI's error output (`npm run check`), as one string. */
export function errorReport(errors: readonly (LoadError | string)[]): string {
  const lines = errors.map((e) => (typeof e === 'string' ? e : formatError(e)));
  return `${lines.join('\n')}\n\n${errors.length} error(s); packs not loaded.`;
}

/** Replace the page with the error list. */
export function showErrors(errors: readonly (LoadError | string)[]): void {
  const pre = document.createElement('pre');
  pre.id = 'errors';
  pre.textContent = errorReport(errors);
  document.body.replaceChildren(pre);
}
