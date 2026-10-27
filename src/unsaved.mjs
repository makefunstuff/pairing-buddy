// The tests on text the user has not saved: what the Driver's edit does, before anything is written to the project.
// Go reads the text through `go test -overlay`. Other runners run in a scratch copy of the project: the files git
// knows, and the files it ignores, such as .env. Folders git ignores are left out, so what a run builds or caches
// (dist, coverage, target) is made in the copy, never in the project; only dependency folders are linked, at any
// depth, since a run needs them and does not build them. In node_modules each package is linked, and its caches
// (.cache, .vite) are left out.
import {execFile} from 'node:child_process';
import {copyFile, mkdir, readdir, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {basename, dirname, extname, join, relative, sep} from 'node:path';
import {promisify} from 'node:util';
import {shellQuote} from './scout-pane.mjs';

const GO_TEST = /(^|[\s;&|(])go test(?=\s|$)/;
const MAX_FILES = 5000; // a bigger project is not copied for one run
const DEPENDENCIES = new Set(['node_modules', '.venv', 'venv']);
const NODE_MODULES_KEPT = new Set(['.bin', '.pnpm']); // the dot-entries of node_modules that are not caches
const PICTURES = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp'};
const MAX_PICTURE_BYTES = 4 << 20;

/** `command` with `go test` reading `overlay`, or null when it runs no `go test`. */
export const overlaid = (command, overlay) => (GO_TEST.test(command) ? command.replace(GO_TEST, `$1go test -overlay ${shellQuote(overlay)}`) : null);

/** The paths git lists in `root` with `args`; ignored folders end with a slash. */
async function gitList(root, args) {
  const {stdout} = await promisify(execFile)('git', ['ls-files', '-z', ...args], {cwd: root, maxBuffer: 64 << 20})
    .catch(() => { throw new Error('the project is not a git repository, so there is no copy to test the buffer in'); });
  return [...new Set(stdout.split('\0').filter(Boolean))];
}

/** Links dependency folder `from` at `to`; node_modules package by package, without its caches. */
async function linkDependencies(from, to) {
  if (basename(from) !== 'node_modules') return symlink(from, to);
  await mkdir(to, {recursive: true});
  for (const entry of await readdir(from)) {
    if (!entry.startsWith('.') || NODE_MODULES_KEPT.has(entry)) await symlink(join(from, entry), join(to, entry));
  }
}

/**
 * Copies the project at `root` to `tree` as the module comment says. Returns the dependency folders it linked,
 * relative to `root`.
 */
async function copyProject(root, tree) {
  const known = await gitList(root, ['--cached', '--others', '--exclude-standard']);
  const ignored = await gitList(root, ['--others', '--ignored', '--exclude-standard', '--directory']);
  const files = [...known, ...ignored.filter(path => !path.endsWith('/'))];
  if (files.length > MAX_FILES) throw new Error(`the project has more than ${MAX_FILES} files to copy`);
  for (const file of files) {
    await mkdir(dirname(join(tree, file)), {recursive: true});
    await copyFile(join(root, file), join(tree, file)).catch(() => {}); // deleted since, or a submodule
  }
  const linked = ignored.filter(path => path.endsWith('/') && DEPENDENCIES.has(basename(path))).map(path => path.slice(0, -1));
  for (const folder of linked) {
    await mkdir(dirname(join(tree, folder)), {recursive: true});
    await linkDependencies(join(root, folder), join(tree, folder));
  }
  return linked;
}

/**
 * How `command` runs on `texts` (a Map from files, absolute and inside `root`, to their unsaved text), with scratch
 * files in `dir`: `{command, root, texts, toProject}`. It runs in `root`; `texts` maps files to the text a run sees
 * in them, where that differs from the disk; `toProject(path)` maps a path in the run back to the project.
 */
export async function prepareUnsaved({root, command, texts, dir}) {
  await rm(dir, {recursive: true, force: true});
  await mkdir(dir, {recursive: true});
  const overlay = join(dir, 'overlay.json');
  const goCommand = overlaid(command, overlay);
  if (goCommand) {
    const replace = {};
    for (const [index, [file, text]] of [...texts].entries()) {
      replace[file] = join(dir, `${index}-${basename(file)}`); // two edited files may share a name
      await writeFile(replace[file], text);
    }
    await writeFile(overlay, JSON.stringify({Replace: replace}));
    return {command: goCommand, root, texts, toProject: path => path};
  }
  const tree = join(dir, 'tree');
  const linked = await copyProject(root, tree);
  for (const [file, text] of texts) {
    const inTree = relative(root, file);
    // Written through a link, the text would land in the project itself.
    if (linked.some(folder => inTree.startsWith(folder + sep))) throw new Error(`${inTree} is in a dependency folder`);
    await mkdir(dirname(join(tree, inTree)), {recursive: true});
    await writeFile(join(tree, inTree), text);
  }
  return {command, root: tree, texts: new Map(), toProject: path => (path?.startsWith(tree + sep) ? join(root, relative(tree, path)) : path)};
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
