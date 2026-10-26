// The tests on text the user has not saved: what the Driver's edit does, before anything is written to the project.
// Go reads the text through `go test -overlay`. Other runners run in a copy of the project's files (the ones git
// knows, tracked or not ignored) with the text in it; what git ignores, such as node_modules, is linked, not copied.
import {execFile} from 'node:child_process';
import {copyFile, mkdir, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {basename, dirname, join, relative, sep} from 'node:path';
import {promisify} from 'node:util';
import {shellQuote} from './scout-pane.mjs';

const GO_TEST = /(^|[\s;&|(])go test(?=\s|$)/;
const MAX_FILES = 5000; // a bigger project is not copied for one run

/** `command` with `go test` reading `overlay`, or null when it runs no `go test`. */
export const overlaid = (command, overlay) => (GO_TEST.test(command) ? command.replace(GO_TEST, `$1go test -overlay ${shellQuote(overlay)}`) : null);

async function gitFiles(root) {
  const {stdout} = await promisify(execFile)('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {cwd: root, maxBuffer: 64 << 20})
    .catch(() => { throw new Error('the project is not a git repository, so there is no copy to test the buffer in'); });
  return [...new Set(stdout.split('\0').filter(Boolean))];
}

/**
 * Copies the project at `root` to `tree`: git's files, and a link for each other top-level entry but .git.
 * Returns the names of the linked entries.
 */
async function copyProject(root, tree) {
  const files = await gitFiles(root);
  if (files.length > MAX_FILES) throw new Error(`the project has more than ${MAX_FILES} files to copy`);
  for (const file of files) {
    await mkdir(dirname(join(tree, file)), {recursive: true});
    await copyFile(join(root, file), join(tree, file)).catch(() => {}); // deleted since, or a submodule
  }
  const copied = new Set(files.map(file => file.split('/')[0]));
  const linked = (await readdir(root)).filter(entry => entry !== '.git' && !copied.has(entry));
  for (const entry of linked) await symlink(join(root, entry), join(tree, entry));
  return linked;
}

/**
 * How `command` runs on `text` as file `file` (absolute, inside `root`), with scratch files in `dir`:
 * `{command, root, texts, toProject}`. It runs in `root`; `texts` maps files to the text a run sees in them, where
 * that differs from the disk; `toProject(path)` maps a path in the run back to the project.
 */
export async function prepareUnsaved({root, command, file, text, dir}) {
  await rm(dir, {recursive: true, force: true});
  await mkdir(dir, {recursive: true});
  const overlay = join(dir, 'overlay.json');
  const goCommand = overlaid(command, overlay);
  if (goCommand) {
    const copy = join(dir, basename(file));
    await writeFile(copy, text);
    await writeFile(overlay, JSON.stringify({Replace: {[file]: copy}}));
    return {command: goCommand, root, texts: new Map([[file, text]]), toProject: path => path};
  }
  const tree = join(dir, 'tree');
  const linked = await copyProject(root, tree);
  const inTree = relative(root, file);
  // Written through a link, the text would land in the project itself.
  if (linked.includes(inTree.split(sep)[0])) throw new Error(`${inTree} is in a folder git ignores`);
  await mkdir(dirname(join(tree, inTree)), {recursive: true});
  await writeFile(join(tree, inTree), text);
  return {command, root: tree, texts: new Map(), toProject: path => (path?.startsWith(tree + sep) ? join(root, relative(tree, path)) : path)};
}
