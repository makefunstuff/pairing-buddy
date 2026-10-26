// Read-only access to the project's files for the `read` tool, confined to the project root.
import {readdir, readFile, realpath, stat} from 'node:fs/promises';
import {isAbsolute, relative, resolve} from 'node:path';

export const MAX_LINES = 300; // of a file, read shows this many lines at most
const MAX_ENTRIES = 200;

/** The real path of `file` if it is `root` or lies inside it (symlinks resolved), else null. */
export async function insideRoot(root, file) {
  const realRoot = await realpath(root);
  const real = await realpath(resolve(realRoot, file)).catch(() => null);
  if (!real) return null;
  const rel = relative(realRoot, real);
  return rel.startsWith('..') || isAbsolute(rel) ? null : real;
}

/** The real path of a regular file inside `root`, else null. */
export async function projectFile(root, file) {
  const path = await insideRoot(root, file);
  return path && (await stat(path)).isFile() ? path : null;
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

async function listing(path) {
  const entries = (await readdir(path, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name));
  const names = entries.slice(0, MAX_ENTRIES).map(entry => (entry.isDirectory() ? `${entry.name}/` : entry.name));
  const more = entries.length > MAX_ENTRIES ? `\n(${entries.length - MAX_ENTRIES} more entries)` : '';
  return names.join('\n') + more;
}

/**
 * What `read` shows of a path in the project: `{text}` of a file, `{listing}` of a directory, or `{error}`
 * when it is outside the root or missing.
 */
export async function readProjectPath(root, file) {
  const path = await insideRoot(root, file);
  if (!path) return {error: `Cannot read ${file}: not inside the project`};
  try {
    if ((await stat(path)).isDirectory()) return {listing: await listing(path)};
    return {text: await readFile(path, 'utf8')};
  } catch (error) {
    return {error: `Cannot read ${file}: ${error.code ?? error.message}`};
  }
}
