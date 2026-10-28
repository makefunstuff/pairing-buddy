// The folders /gen keeps in Pair's data folder, outside every project: gen/<project>/try/<n>/ holds the sample of a
// /gen try request, which the model writes and runs there and the user reads, runs again and changes in a split. A
// try folder is no part of the project: the Watcher never sees its edits (session.mjs drops edits outside the root),
// and /keep is the only way its code gets in, as a buffer to review. Runs there happen in the sandbox with only that
// folder writable. A folder goes once it has not changed for gen.keepTries days.
import {createHash} from 'node:crypto';
import {lstat, mkdir, readdir, realpath, rm, stat} from 'node:fs/promises';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {cacheFolders, sandboxWords, sandboxWorks} from './sandbox.mjs';
import {shellQuote} from './scout-shell.mjs';

const DAY = 24 * 60 * 60 * 1000;
const LISTED = 50; // a try folder's files the list names, at most
const SKIPPED = new Set(['node_modules', '.git', 'target', '__pycache__', '.venv']); // what a run may fill, never listed

/** The folder /gen keeps for the project at `root`: its name and a short hash of the path, so two `shop`s differ. */
export function projectFolder(genDir, root) {
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 8);
  return join(genDir, `${basename(root) || 'root'}-${hash}`);
}

/** The folder of try request `n` of the project whose /gen folder is `folder`. */
export const tryFolder = (folder, n) => join(folder, 'try', String(n));

const inside = (dir, path) => {
  const rel = relative(dir, path);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
};

/**
 * Where `path` (relative to the try folder `dir`, or absolute inside it) is, as a real path inside it, or null: a
 * path that leaves it, or goes through a link that does (a sample's run may have made one), is refused, since the
 * daemon itself writes there without the sandbox. A file that is a link is refused too.
 */
export async function pathIn(dir, path) {
  if (typeof path !== 'string' || !path.trim()) return null;
  const realDir = await realpath(dir).catch(() => null);
  if (!realDir) return null;
  const wanted = resolve(realDir, isAbsolute(path) ? relative(dir, path) : path);
  if (!inside(realDir, wanted)) return null;
  let folder = dirname(wanted);
  while (!(await stat(folder).catch(() => null))) folder = dirname(folder);
  const real = await realpath(folder).catch(() => null);
  if (!real || (real !== realDir && !inside(realDir, real))) return null;
  const at = join(real, relative(folder, wanted));
  const link = await lstat(at).catch(() => null);
  if (link?.isSymbolicLink()) return null;
  if (link?.isDirectory()) return null;
  return at;
}

/** The files in try folder `dir`, relative to it and sorted, without what runs fill (node_modules and such). */
export async function filesIn(dir) {
  const found = [];
  async function walk(at) {
    const entries = await readdir(at, {withFileTypes: true}).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= LISTED) return;
      const path = join(at, entry.name);
      if (entry.isDirectory() && !SKIPPED.has(entry.name)) await walk(path);
      else if (entry.isFile()) found.push(relative(dir, path));
    }
  }
  await walk(dir);
  return found;
}

/** When anything in `dir` last changed: the newest mtime of the folder and what is in it. */
async function changedAt(dir) {
  let newest = (await lstat(dir).catch(() => null))?.mtimeMs ?? 0;
  async function walk(at) {
    for (const entry of await readdir(at, {withFileTypes: true}).catch(() => [])) {
      const path = join(at, entry.name);
      const info = await lstat(path).catch(() => null);
      if (info) newest = Math.max(newest, info.mtimeMs);
      if (entry.isDirectory() && !SKIPPED.has(entry.name)) await walk(path);
    }
  }
  await walk(dir);
  return newest;
}

/** The try folders of the project whose /gen folder is `folder`, newest number first: `{n, dir, changed}`. */
export async function triesIn(folder) {
  const root = join(folder, 'try');
  const entries = await readdir(root, {withFileTypes: true}).catch(() => []);
  const tries = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[1-9]\d*$/.test(entry.name)) continue;
    const dir = join(root, entry.name);
    tries.push({n: Number(entry.name), dir, changed: await changedAt(dir)});
  }
  return tries.sort((a, b) => b.n - a.n);
}

/** Days left before a try folder that changed `changed` goes, kept `days` days: at least 0. */
export const daysLeft = (changed, days, now) => Math.max(0, Math.ceil((changed + days * DAY - now) / DAY));

/**
 * Deletes the try folders in `genDir` (every project's) that have not changed for `days` days; the paths it deleted.
 * A folder that cannot be read or deleted stays, for the next time.
 */
export async function expireTries(genDir, days, now = Date.now()) {
  const gone = [];
  for (const project of await readdir(genDir, {withFileTypes: true}).catch(() => [])) {
    if (!project.isDirectory()) continue;
    for (const one of await triesIn(join(genDir, project.name))) {
      if (one.changed + days * DAY > now) continue;
      if (await rm(one.dir, {recursive: true, force: true}).then(() => true, () => false)) gone.push(one.dir);
    }
  }
  return gone;
}

/** Makes try folder `dir`, empty: a folder left from an earlier request of that number goes first. */
export async function freshFolder(dir) {
  await rm(dir, {recursive: true, force: true});
  await mkdir(dir, {recursive: true, mode: 0o700});
}

const word = text => (/^[\w@%+=:,./-]+$/.test(text) ? text : shellQuote(text));

/**
 * Whether a try's runs are in the sandbox, for `sandbox` as scoutPane.sandbox has it ("auto", true or false); throws
 * when it must be and cannot.
 */
export function trySandboxed(sandbox = 'auto', works = sandboxWorks) {
  if (sandbox === false) return false;
  if (works()) return true;
  if (sandbox === true) throw new Error('scoutPane.sandbox is true, and bubblewrap (bwrap) is not installed or may not make namespaces here');
  return false;
}

/**
 * The line Pair's pane runs `command` of a try by, in its folder `dir`: in a subshell, so the pane stays in the
 * project, and in the sandbox (`sandboxed`) with only `dir` writable, the project and the rest of the disk read-only,
 * and no network unless `network`.
 */
export function tryLine(dir, command, {sandboxed = true, network = false, caches = cacheFolders()} = {}) {
  if (!sandboxed) return `(cd ${word(dir)} && ${command})`;
  const words = sandboxWords({cwd: dir, network, caches});
  return `(cd ${word(dir)} && ${[...words, 'bash', '-c', command].map(word).join(' ')})`;
}
