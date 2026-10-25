// Read-only access to the project's files for the `read` tool, confined to the project root.
import {readFile, realpath} from 'node:fs/promises';
import {isAbsolute, relative, resolve} from 'node:path';

const MAX_LINES = 300;

/** The real path of `file` if it lies inside `root` (symlinks resolved), else null. */
export async function insideRoot(root, file) {
  const realRoot = await realpath(root);
  const real = await realpath(resolve(realRoot, file)).catch(() => null);
  if (!real) return null;
  const rel = relative(realRoot, real);
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? null : real;
}

/** Lines `from`..`to` (1-based, inclusive) with line numbers, at most MAX_LINES of them. */
export function numberedLines(text, from = 1, to = from + MAX_LINES - 1) {
  const lines = text.split('\n');
  const first = Math.max(1, from);
  const last = Math.min(lines.length, to, first + MAX_LINES - 1);
  const shown = lines.slice(first - 1, last).map((line, i) => `${first + i}: ${line}`);
  const more = last < lines.length ? `\n(${lines.length - last} more lines; ask for start_line ${last + 1})` : '';
  return shown.join('\n') + more;
}

/** `{text}` of a project file on disk, or `{error}` when it is outside the root or missing. */
export async function readProjectFile(root, file) {
  const path = await insideRoot(root, file);
  if (!path) return {error: `Cannot read ${file}: not a file inside the project`};
  return readFile(path, 'utf8').then(text => ({text}), error => ({error: `Cannot read ${file}: ${error.code ?? error.message}`}));
}
