// Commands on text the user has not saved: the check after the Driver's edit, and Scout's runs on the buffers. They
// see every unsaved buffer of the project, before anything is written to the project.
// Go reads the texts through `go test -overlay`. Other commands run in a scratch copy of the project: the files git
// knows, and the files it ignores, such as .env (without git, every file). Folders git ignores are left out, so
// what a run builds or caches (dist, coverage, target) is made in the copy, never in the project; only dependency
// folders are linked, at any depth, since a run needs them and does not build them. In node_modules each package is
// linked, and its caches (.cache, .vite) are left out.
// The copy stays between runs, one per project: each run copies only the files that changed since the last (as
// reflinks where the file system has them) and puts back the ones a buffer replaced, so a build in the copy (make,
// cargo, tsc) builds only what changed, as it would in the project.
// A /gen scaffold request makes its own copy the same way (see gen-tree.mjs), and the model writes in it.
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {copyFile, lstat, mkdir, readdir, readFile, rm, stat, symlink, utimes, writeFile} from 'node:fs/promises';
import {basename, dirname, extname, join, relative, sep} from 'node:path';
import {promisify} from 'node:util';
import {shellQuote} from './scout-shell.mjs';

const GO_TEST = /(^|[\s;&|(])go test(?=\s|$)/;
const MAX_FILES = 50_000; // a bigger project is not copied
const COPIES_AT_ONCE = 32;
const DEPENDENCIES = new Set(['node_modules', '.venv', 'venv']);
const NODE_MODULES_KEPT = new Set(['.bin', '.pnpm']); // the dot-entries of node_modules that are not caches
const NOT_COPIED = new Set(['.git', '.hg', '.svn']); // without git: a repository's own folder
const PICTURES = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp'};
const MAX_PICTURE_BYTES = 4 << 20;

/** `command` with `go test` reading `overlay`, or null when it runs no `go test`. */
export const overlaid = (command, overlay) => (GO_TEST.test(command) ? command.replace(GO_TEST, `$1go test -overlay ${shellQuote(overlay)}`) : null);

/** The paths git lists in `root` with `args`, or null outside a git repository; ignored folders end with a slash. */
async function gitList(root, args) {
  const listed = await promisify(execFile)('git', ['ls-files', '-z', ...args], {cwd: root, maxBuffer: 64 << 20}).catch(() => null);
  return listed && [...new Set(listed.stdout.split('\0').filter(Boolean))];
}

/** Without git: every file of `root`, and its dependency folders (ending with a slash), as gitList gives them. */
async function walk(root, dir = '', found = []) {
  for (const entry of await readdir(join(root, dir), {withFileTypes: true}).catch(() => [])) {
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (found.length > MAX_FILES) break;
    if (entry.isDirectory() && DEPENDENCIES.has(entry.name)) found.push(`${path}/`);
    else if (entry.isDirectory() && !NOT_COPIED.has(entry.name)) await walk(root, path, found);
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

/** The files to copy from `root` and the dependency folders to link, relative to it. */
export async function projectFiles(root) {
  const known = await gitList(root, ['--cached', '--others', '--exclude-standard']);
  const ignored = known ? await gitList(root, ['--others', '--ignored', '--exclude-standard', '--directory']) : await walk(root);
  const files = [...(known ?? []), ...ignored.filter(path => !path.endsWith('/'))];
  if (files.length > MAX_FILES) throw new Error(`the project has more than ${MAX_FILES} files to copy`);
  const linked = ignored.filter(path => path.endsWith('/') && DEPENDENCIES.has(basename(path))).map(path => path.slice(0, -1));
  return {files, linked};
}

/** Links dependency folder `from` at `to`; node_modules package by package, without its caches. */
export async function linkDependencies(from, to) {
  if (basename(from) !== 'node_modules') return symlink(from, to);
  await mkdir(to, {recursive: true});
  for (const entry of await readdir(from)) {
    if (!entry.startsWith('.') || NODE_MODULES_KEPT.has(entry)) await symlink(join(from, entry), join(to, entry)).catch(() => {});
  }
}

/** What the manifest keeps of a file to see that it changed: its time and size. */
export const stamp = info => info && `${info.mtimeMs}:${info.size}`;
const statOf = path => stat(path).catch(() => null);

/** Runs `work` on each of `items`, COPIES_AT_ONCE at a time. */
async function eachAtOnce(items, work) {
  let next = 0;
  const worker = async () => { while (next < items.length) await work(items[next++]); };
  await Promise.all(Array.from({length: COPIES_AT_ONCE}, worker));
}

/**
 * Brings the copy `tree` of the project at `root` up to date, with `texts` (absolute file -> text) in it in place of
 * the files on disk. Its manifest, next to it, says what each file in it was copied from, or which buffer text it
 * has, so only files changed on either side are written again. Returns the files of `texts` it left out: those
 * outside the project, or in a dependency folder, which a write would put into the project through the link.
 */
export async function syncTree(root, tree, texts) {
  const manifestFile = `${tree}.json`;
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8').catch(() => '{}'));
  const before = manifest.files ?? {};
  const buffersBefore = manifest.buffers ?? {};
  const {files, linked} = await projectFiles(root);
  const left = [];
  const wanted = new Map();
  for (const [file, text] of texts) {
    const inTree = relative(root, file);
    if (inTree.startsWith('..') || linked.some(folder => inTree === folder || inTree.startsWith(folder + sep))) left.push(file);
    else wanted.set(inTree, text);
  }
  const copied = {};
  await eachAtOnce(files.filter(file => !wanted.has(file)), async file => {
    const info = await statOf(join(root, file));
    const source = stamp(info);
    if (!source) return; // deleted since, or a submodule
    const copy = join(tree, file);
    const kept = before[file];
    if (kept?.source === source && kept.copy === stamp(await statOf(copy))) {
      copied[file] = kept;
      return;
    }
    await mkdir(dirname(copy), {recursive: true});
    await rm(copy, {force: true}); // a reflink or copy, never through a link a run left there
    if (!(await copyFile(join(root, file), copy, constants.COPYFILE_FICLONE).then(() => true, () => false))) return;
    // The copy keeps the file's time, so a build sees the project's order: the buffers, written now, are newer than
    // anything built from the disk. A file a buffer replaced until now is new to a build that saw the buffer.
    if (!buffersBefore[file]) await utimes(copy, info.atime, info.mtime);
    copied[file] = {source, copy: stamp(await statOf(copy))};
  });
  const buffers = {};
  for (const [file, text] of wanted) {
    const copy = join(tree, file);
    const hash = createHash('sha256').update(text).digest('hex');
    if (buffersBefore[file]?.hash !== hash || buffersBefore[file].copy !== stamp(await statOf(copy))) {
      await mkdir(dirname(copy), {recursive: true});
      await rm(copy, {force: true});
      await writeFile(copy, text);
    }
    buffers[file] = {hash, copy: stamp(await statOf(copy))};
  }
  // Files gone from the project, and buffers of files that were never saved, go from the copy too.
  for (const file of [...Object.keys(before), ...Object.keys(buffersBefore)]) {
    if (!copied[file] && !buffers[file]) await rm(join(tree, file), {force: true});
  }
  for (const folder of linked) {
    if (await lstat(join(tree, folder)).then(() => true, () => false)) continue;
    await mkdir(dirname(join(tree, folder)), {recursive: true});
    await linkDependencies(join(root, folder), join(tree, folder));
  }
  await writeFile(manifestFile, JSON.stringify({files: copied, buffers}));
  return left;
}

const busyTrees = new Map(); // tree -> the work on it under way

/** Runs `work()` once nothing else uses the copy `tree`: a run in it must not see another's buffers. */
export function withTree(tree, work) {
  const turn = (busyTrees.get(tree) ?? Promise.resolve()).then(work);
  const done = turn.catch(() => {});
  busyTrees.set(tree, done);
  done.then(() => { if (busyTrees.get(tree) === done) busyTrees.delete(tree); });
  return turn;
}

/**
 * How `command` runs on `texts` (absolute file -> text, the unsaved buffers inside `root`), with scratch files in
 * `dir` and the copy of the project in `tree`: `{command, root, texts, left, toProject}`. It runs in `root`; `texts`
 * maps files to the text a run sees in them, where that differs from the disk; `left` are the buffers it could not
 * use (see syncTree); `toProject(path)` maps a path in the run back to the project. Use the copy inside withTree.
 */
export async function prepareUnsaved({root, command, texts, dir, tree}) {
  await rm(dir, {recursive: true, force: true});
  await mkdir(dir, {recursive: true});
  const overlay = join(dir, 'overlay.json');
  const goCommand = overlaid(command, overlay);
  if (goCommand) {
    const replace = {};
    let n = 0;
    for (const [file, text] of texts) {
      const copy = join(dir, `${++n}-${basename(file)}`);
      await writeFile(copy, text);
      replace[file] = copy;
    }
    await writeFile(overlay, JSON.stringify({Replace: replace}));
    return {command: goCommand, root, texts, left: [], toProject: path => path};
  }
  await mkdir(tree, {recursive: true});
  const left = await syncTree(root, tree, texts);
  return {command, root: tree, texts: new Map(), left, toProject: path => (path?.startsWith(tree + sep) ? join(root, relative(tree, path)) : path)};
}

/**
 * The picture a run wrote in the scratch copy `tree` since `since` (ms), the newest: `{file, data, mimeType}`, with
 * `file` relative to the tree and `data` in base64, or null. The program's screenshot, when it writes one.
 */
export async function pictureSince(tree, since) {
  const entries = await readdir(tree, {recursive: true, withFileTypes: true}).catch(() => []);
  let newest = null;
  for (const entry of entries) {
    if (!entry.isFile() || !PICTURES[extname(entry.name).toLowerCase()]) continue;
    const path = join(entry.parentPath, entry.name);
    const {mtimeMs, size} = await stat(path);
    if (mtimeMs >= since && size <= MAX_PICTURE_BYTES && mtimeMs > (newest?.mtimeMs ?? -1)) newest = {path, mtimeMs};
  }
  if (!newest) return null;
  const data = (await readFile(newest.path)).toString('base64');
  return {file: relative(tree, newest.path), data, mimeType: PICTURES[extname(newest.path).toLowerCase()]};
}
