// The folders /gen keeps in Pair's data folder, outside every project: gen/<project>/try/<n>/ holds the sample of a
// /gen try request, which the model writes and runs there and the user reads, runs again and changes in a split. A
// try folder is no part of the project: the Watcher never sees its edits (session.mjs drops edits outside the root),
// and /keep is the only way its code gets in, as a buffer to review. Runs there happen in the sandbox with only that
// folder writable. A folder goes once it has not changed, nor been run, for gen.keepTries days.
// gen/<project>/<n>/ holds a /gen scaffold request's copy of the project, made as the scratch copy of unsaved.mjs is
// (reflinks, ignored folders left out, dependency folders linked), or with --branch a git worktree on branch gen/<n>.
// The model writes and runs there; what differs from the project is the request's proposal, which the user keeps a
// file at a time: a new file as a buffer to review, a change to a file of theirs as hunks shown in it as suggestions.
// A copy goes when the user deletes it, or after gen.keepTries days as a try does; a worktree only when they delete it.
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat, mkdir, readdir, readFile, realpath, rm, stat} from 'node:fs/promises';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {promisify} from 'node:util';
import {cacheFolders, sandboxWords, sandboxWorks} from './sandbox.mjs';
import {shellQuote} from './scout-shell.mjs';
import {linkDependencies, projectFiles, stamp, syncTree} from './unsaved.mjs';

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

/** The folder of scaffold request `n` of the project whose /gen folder is `folder`: its copy, or its worktree. */
export const scaffoldFolder = (folder, n) => join(folder, String(n));

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

/**
 * Whether `dir` lies in `genDir` through real folders only: a link on the way (Scout's commands may write in the gen
 * folder) would send the daemon's writes and deletes elsewhere.
 */
export async function noLinks(genDir, dir) {
  const rel = relative(genDir, dir);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false;
  let at = genDir;
  for (const part of rel.split(sep)) {
    at = join(at, part);
    const info = await lstat(at).catch(() => null);
    if (info?.isSymbolicLink() || (info && !info.isDirectory())) return false;
  }
  return true;
}

/** The try folders of the project whose /gen folder is `folder`, newest number first: `{n, dir, changed}`. */
export async function triesIn(folder) {
  const root = join(folder, 'try');
  // Not through a link: what is listed here may be deleted.
  if ((await lstat(folder).catch(() => null))?.isSymbolicLink() || (await lstat(root).catch(() => null))?.isSymbolicLink()) return [];
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
 * Deletes the try folders in `genDir` (every project's) that have not changed for `days` days, and the scaffold
 * copies not used for as long; the paths it deleted. A worktree stays: it is on a branch of the user's repository. A
 * folder that cannot be read or deleted stays, for the next time.
 */
export async function expireTries(genDir, days, now = Date.now()) {
  const gone = [];
  for (const project of await readdir(genDir, {withFileTypes: true}).catch(() => [])) {
    if (!project.isDirectory()) continue;
    for (const one of await triesIn(join(genDir, project.name))) {
      if (one.changed + days * DAY > now) continue;
      if (await rm(one.dir, {recursive: true, force: true}).then(() => true, () => false)) gone.push(one.dir);
    }
    for (const one of await copiesIn(join(genDir, project.name))) {
      if (one.changed + days * DAY > now) continue;
      if (await removeCopy(one.dir)) gone.push(one.dir);
    }
  }
  return gone;
}

/**
 * The scaffold copies of the project whose /gen folder is `folder` (not its worktrees), with when each was last
 * used: the copy's own folder, which a write, a run or a keep touches, else its manifest.
 */
export async function copiesIn(folder) {
  if ((await lstat(folder).catch(() => null))?.isSymbolicLink()) return [];
  const copies = [];
  for (const entry of await readdir(folder, {withFileTypes: true}).catch(() => [])) {
    if (!entry.isDirectory() || !/^[1-9]\d*$/.test(entry.name)) continue;
    const dir = join(folder, entry.name);
    if (await lstat(join(dir, '.git')).catch(() => null)) continue; // a worktree
    const times = await Promise.all([lstat(dir), lstat(`${dir}.json`)].map(one => one.then(info => info.mtimeMs, () => 0)));
    copies.push({n: Number(entry.name), dir, changed: Math.max(...times)});
  }
  return copies;
}

/** Deletes the scaffold copy `dir` and its manifest; whether it is gone. */
export async function removeCopy(dir) {
  const gone = await rm(dir, {recursive: true, force: true}).then(() => true, () => false);
  await rm(`${dir}.json`, {force: true}).catch(() => {});
  return gone;
}

const git = (cwd, args) => promisify(execFile)('git', args, {cwd, maxBuffer: 64 << 20}).then(result => result.stdout);

/**
 * Makes the scaffold copy `dir` in `genDir` of the project at `root`, with `texts` (absolute file -> text, the unsaved
 * buffers) in place of the files on disk, as the user sees the project. Throws when a link is on the way, or the
 * project is too big to copy.
 */
export async function makeCopy(genDir, dir, root, texts = new Map()) {
  await freshFolder(genDir, dir);
  await rm(`${dir}.json`, {force: true});
  await syncTree(root, dir, texts);
}

/**
 * Makes the scaffold worktree `dir` in `genDir`: the git repository of `root` checked out there on a new branch
 * `branch`, from HEAD, with the project's dependency folders linked as in a copy. `{base}`, the commit it starts
 * from. Throws without git, or when the branch exists.
 */
export async function makeWorktree(genDir, dir, root, branch) {
  const top = (await git(root, ['rev-parse', '--show-toplevel']).catch(() => '')).trim();
  if (!top) throw new Error('--branch needs a git repository');
  if ((await realpath(top).catch(() => top)) !== (await realpath(root).catch(() => root))) throw new Error(`--branch needs the session at the repository's root, ${top}`);
  const base = (await git(root, ['rev-parse', 'HEAD']).catch(() => '')).trim();
  if (!base) throw new Error('--branch needs a commit to start from');
  if (await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false)) throw new Error(`the branch ${branch} exists already`);
  if (!(await noLinks(genDir, dir))) throw new Error(`a link on the way to ${dir}: not made there`);
  await rm(dir, {recursive: true, force: true});
  await git(root, ['worktree', 'prune']).catch(() => {});
  await mkdir(dirname(dir), {recursive: true, mode: 0o700});
  await git(root, ['worktree', 'add', '-q', '-b', branch, dir, base]);
  const {linked} = await projectFiles(root);
  for (const folder of linked) {
    if (await lstat(join(dir, folder)).then(() => true, () => false)) continue;
    await mkdir(dirname(join(dir, folder)), {recursive: true});
    await linkDependencies(join(root, folder), join(dir, folder)).catch(() => {});
  }
  return {base};
}

/**
 * Deletes the scaffold worktree `dir` of the repository at `root`, and its branch while it is still at `base` (no
 * commit of the user's on it). What happened: `{removed, branchKept}`.
 */
export async function removeWorktree(root, dir, branch, base) {
  const removed = await git(root, ['worktree', 'remove', '--force', dir]).then(() => true, () => false);
  if (!removed) await rm(dir, {recursive: true, force: true}).then(() => git(root, ['worktree', 'prune']), () => {}).catch(() => {});
  const tip = branch ? (await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).catch(() => '')).trim() : '';
  const branchKept = Boolean(tip) && tip !== base;
  if (tip && !branchKept) await git(root, ['branch', '-D', branch]).catch(() => {});
  return {removed: removed || !(await lstat(dir).catch(() => null)), branchKept};
}

const BINARY_BYTES = 1 << 20; // a file in the copy bigger than this is no proposal

/**
 * What differs in the scaffold folder `dir` from the project at `root`, besides `known` (relative paths the model
 * wrote): the files a run there made or changed, relative, as `{rel, isNew}`. In a copy, by its manifest; in a
 * worktree, by git. Files git ignores (what a build makes) are left out, and so are dependency folders.
 */
export async function changedIn(dir, root, {worktree = false, known = new Set()} = {}) {
  if (worktree) {
    const listed = await git(dir, ['status', '--porcelain', '-z', '--untracked-files=all']).catch(() => '');
    const found = [];
    for (const entry of listed.split('\0').filter(Boolean)) {
      const code = entry.slice(0, 2);
      const rel = entry.slice(3);
      if (code.includes('D') || code.includes('R') || known.has(rel)) continue;
      found.push({rel, isNew: code === '??' || code.includes('A')});
    }
    return found;
  }
  const manifest = JSON.parse(await readFile(`${dir}.json`, 'utf8').catch(() => '{}'));
  const kept = {...(manifest.files ?? {}), ...(manifest.buffers ?? {})};
  const candidates = [];
  async function walk(at) {
    for (const entry of await readdir(at, {withFileTypes: true}).catch(() => [])) {
      const path = join(at, entry.name);
      const rel = relative(dir, path);
      if (entry.isDirectory() && !SKIPPED.has(entry.name)) await walk(path);
      else if (entry.isFile() && !known.has(rel)) {
        const was = kept[rel];
        if (!was) candidates.push({rel, isNew: true});
        else if (was.copy !== stamp(await lstat(path).catch(() => null))) candidates.push({rel, isNew: false});
      }
    }
  }
  await walk(dir);
  const fresh = candidates.filter(one => one.isNew).map(one => one.rel);
  const ignored = new Set(fresh.length ? await ignoredOf(root, fresh) : []);
  return candidates.filter(one => !ignored.has(one.rel));
}

/** Of `paths` (relative to `root`), those its .gitignore files ignore; none without git. */
async function ignoredOf(root, paths) {
  const run = promisify(execFile)('git', ['check-ignore', '--no-index', '-z', '--stdin'], {cwd: root, maxBuffer: 64 << 20});
  run.child.stdin.end(paths.join('\0'));
  const listed = await run.then(result => result.stdout, error => error.stdout ?? '');
  return listed.split('\0').filter(Boolean);
}

/** The text of the file at `path` when it is one Pair can propose: not too big, not binary; else null. */
export async function textOf(path) {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.size > BINARY_BYTES) return null;
  const text = await readFile(path, 'utf8').catch(() => null);
  return text === null || text.includes('\0') ? null : text;
}

/**
 * Makes try folder `dir` in `genDir`, empty: a folder left from an earlier request of that number goes first. Throws
 * when a link on the way would put it elsewhere.
 */
export async function freshFolder(genDir, dir) {
  if (!(await noLinks(genDir, dir))) throw new Error(`a link on the way to ${dir}: not made there`);
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
 * and no network unless `network`. The command goes as one word to bash, so a comment or a heredoc in it ends there.
 */
export function tryLine(dir, command, {sandboxed = true, network = false, caches = cacheFolders()} = {}) {
  if (!sandboxed) return `(cd ${word(dir)} && bash -c ${shellQuote(command)})`;
  const words = sandboxWords({cwd: dir, network, caches});
  return `(cd ${word(dir)} && ${[...words, 'bash', '-c', command].map(word).join(' ')})`;
}

// Lines: what changed between two texts, and how a change lands on the buffer as it is now.

const MAX_STEPS = 1000; // a diff that needs more steps than this is one hunk over the whole file

/** The lines of `text`, without the empty one after its last newline. */
export const linesOf = text => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));

/**
 * The edit script from lines `a` to `b`, 0-based: `['=', i, j]` keeps a[i] as b[j], `['-', i]` deletes a[i], `['+',
 * j]` adds b[j]. Myers' diff on what lies between the lines they share at both ends; null when that takes more than
 * MAX_STEPS steps.
 */
export function diffLines(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const middle = myers(a, b, start, endA - start, endB - start);
  if (!middle) return null;
  const script = [];
  for (let i = 0; i < start; i++) script.push(['=', i, i]);
  script.push(...middle);
  for (let k = 0; k < a.length - endA; k++) script.push(['=', endA + k, endB + k]);
  return script;
}

function myers(a, b, off, n, m) {
  if (!n) return Array.from({length: m}, (_, j) => ['+', off + j]);
  if (!m) return Array.from({length: n}, (_, i) => ['-', off + i]);
  const limit = Math.min(n + m, MAX_STEPS);
  const at = limit + 1; // where k = 0 is in v
  const v = new Int32Array(2 * limit + 3);
  const trace = [];
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[at + k - 1] < v[at + k + 1]) ? v[at + k + 1] : v[at + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[off + x] === b[off + y]) { x++; y++; }
      v[at + k] = x;
      if (x >= n && y >= m) return back(trace, at, off, n, m);
    }
  }
  return null;
}

function back(trace, at, off, n, m) {
  const script = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    const before = k === -d || (k !== d && v[at + k - 1] < v[at + k + 1]) ? k + 1 : k - 1;
    const fromX = v[at + before];
    const fromY = fromX - before;
    while (x > fromX && y > fromY) script.push(['=', off + --x, off + --y]);
    if (d > 0) script.push(x === fromX ? ['+', off + --y] : ['-', off + --x]);
    x = fromX;
    y = fromY;
  }
  return script.reverse();
}

/**
 * The hunks that make lines `a` into lines `b`: `{from, to, lines}`, the lines a[from..to) (0-based; none for an
 * insertion before a[from]) replaced by `lines`. One hunk over everything when the diff is too big to make.
 */
export function hunksOf(a, b) {
  const script = diffLines(a, b);
  if (!script) return [{from: 0, to: a.length, lines: b}];
  const hunks = [];
  let open = null;
  let i = 0;
  for (const op of script) {
    if (op[0] === '=') {
      if (open) hunks.push(open);
      open = null;
      i = op[1] + 1;
      continue;
    }
    open ??= {from: i, to: i, lines: []};
    if (op[0] === '-') open.to = ++i;
    else open.lines.push(b[op[1]]);
  }
  if (open) hunks.push(open);
  return hunks;
}

/** Lines added and removed from `before` to `after` (texts; `before` null for a new file): `{added, removed}`. */
export function sizeOf(before, after) {
  const next = linesOf(after);
  if (before === null) return {added: next.length, removed: 0};
  let added = 0;
  let removed = 0;
  for (const hunk of hunksOf(linesOf(before), next)) {
    added += hunk.lines.length;
    removed += hunk.to - hunk.from;
  }
  return {added, removed};
}

/**
 * The change from text `base` to `next`, as it lands on `current` (the user's buffer now, which may have changed since
 * `base`): `{hunks, conflicts}`. Each hunk is a suggestion: `{line, endLine, insert, text, old}`, lines `line`..`endLine`
 * of `current` replaced by `text`, or `text` put below `line` (`insert`). A hunk over lines the user changed since is
 * a conflict, not shown. A deletion keeps a line next to it, since a suggestion has at least one line.
 */
export function placeHunks(base, next, current) {
  const a = linesOf(base);
  const now = linesOf(current);
  const map = new Array(a.length).fill(-1); // a's line -> its line in the buffer now, while the user left it as it was
  const script = base === current ? null : diffLines(a, now);
  if (base === current) a.forEach((_, i) => { map[i] = i; });
  else for (const op of script ?? []) if (op[0] === '=') map[op[1]] = op[2];
  const kept = i => i >= 0 && i < a.length && map[i] >= 0;
  const together = (from, to) => {
    for (let i = from; i < to; i++) if (!kept(i) || (i > from && map[i] !== map[i - 1] + 1)) return false;
    return true;
  };
  const hunks = [];
  let conflicts = 0;
  for (const hunk of hunksOf(a, linesOf(next))) {
    let {from, to, lines} = hunk;
    if (!lines.length) {
      // A deletion: with the line after it, else the one before, kept as it is.
      if (to < a.length) lines = [a[to++]];
      else if (from > 0) lines = [a[--from]];
      else { conflicts++; continue; }
    }
    if (to > from) {
      if (!together(from, to)) { conflicts++; continue; }
      hunks.push({line: map[from] + 1, endLine: map[to - 1] + 1, insert: false, text: lines.join('\n'), old: now.slice(map[from], map[to - 1] + 1)});
    } else if (from > 0 && kept(from - 1)) {
      hunks.push({line: map[from - 1] + 1, endLine: map[from - 1] + 1, insert: true, text: lines.join('\n'), old: []});
    } else if (from === 0 && kept(0)) {
      // At the top: in place of the first line, with it under the new ones.
      hunks.push({line: map[0] + 1, endLine: map[0] + 1, insert: false, text: [...lines, a[0]].join('\n'), old: [now[map[0]]]});
    } else {
      conflicts++;
    }
  }
  return {hunks, conflicts};
}
