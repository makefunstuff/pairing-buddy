// Read-only git questions the daemon asks for the session state. The model never runs git.
import {execFile} from 'node:child_process';
import {basename, dirname} from 'node:path';
import {promisify} from 'node:util';

const run = promisify(execFile);

async function git(cwd, args) {
  const {stdout} = await run('git', ['-C', cwd, ...args], {timeout: 3000});
  return stdout.trim();
}

export const gitRoot = cwd => git(cwd, ['rev-parse', '--show-toplevel']).catch(() => null);
export const gitBranch = root => git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null);
/** `git status --short`: the uncommitted changes, one file per line. */
export const gitStatus = root => git(root, ['status', '--short']).catch(() => null);
/** The last commit as "abc1234 subject", or null in a repository without one. */
export const gitLastCommit = root => git(root, ['log', '-1', '--format=%h %s']).catch(() => null);
/** The commits made since `since` (ms), newest first, as "abc1234 subject" lines; [] when unknown. */
export const gitCommitsSince = (root, since) => git(root, ['log', '-10', `--since=@${Math.floor(since / 1000)}`, '--format=%h %s'])
  .then(out => out.split('\n').filter(Boolean), () => []);
/** The files git tracks in `root` whose path ends in `name` ("worker.go", "delivery/worker.go"), relative to it. */
export const gitFilesNamed = (root, name) => git(root, ['ls-files', '--', `:(glob)**/${name}`])
  .then(out => out.split('\n').filter(Boolean), () => []);
/** The files of `root` git knows or would add (tracked, and new ones it does not ignore), relative to it; null outside git. */
export const gitFiles = root => git(root, ['ls-files', '--cached', '--others', '--exclude-standard'])
  .then(out => [...new Set(out.split('\n').filter(Boolean))], () => null);

/**
 * The names the repository of `root` goes by: the folder of its main checkout (also from one of its worktrees) and
 * the name in its origin's URL.
 */
export async function repoNames(root) {
  const common = await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => null);
  const origin = await git(root, ['remote', 'get-url', 'origin']).catch(() => null);
  const names = [
    common && basename(common) === '.git' ? basename(dirname(common)) : null,
    origin ? basename(origin).replace(/\.git$/, '') : null,
  ];
  return [...new Set(names.filter(Boolean))];
}

/** The folder of the main checkout of `root`'s repository, also from one of its worktrees; null outside git. */
export async function gitCheckout(root) {
  const common = await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => null);
  return common && basename(common) === '.git' ? dirname(common) : null;
}

/** The worktrees of `root`'s repository by branch: Map branch -> folder; empty outside git. */
export async function gitWorktrees(root) {
  const out = await git(root, ['worktree', 'list', '--porcelain']).catch(() => '');
  const worktrees = new Map();
  let path = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
    else if (line.startsWith('branch refs/heads/') && path) worktrees.set(line.slice('branch refs/heads/'.length), path);
  }
  return worktrees;
}

/** The branch the repository of `root` merges into: its origin's default, else main or master; null when it has none. */
export async function gitBaseBranch(root) {
  const head = await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => null);
  if (head) return head.replace(/^origin\//, '');
  for (const name of ['main', 'master']) {
    if (await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).then(() => true, () => false)) return name;
  }
  return null;
}

/** What `branch` changes since it left `base` (`git diff base...branch`); a diff over `maxBytes` is refused. */
export async function gitBranchDiff(root, base, branch, maxBytes = 4 << 20) {
  const {stdout} = await run('git', ['-C', root, 'diff', '--no-color', `${base}...${branch}`], {timeout: 10_000, maxBuffer: maxBytes});
  return stdout;
}

/**
 * What a task's branch changes, as `git diff -U0` (changed lines, no context): in its `worktree` against where it left
 * `base`, its commits and the changes its agent has not committed yet; without one, `base...branch`. Read only.
 */
export async function gitTaskDiff(root, base, branch, {worktree = null, maxBytes = 4 << 20} = {}) {
  const diff = ['diff', '--no-color', '--no-ext-diff', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', '-U0'];
  const options = {timeout: 10_000, maxBuffer: maxBytes};
  if (!worktree) return (await run('git', ['-C', root, ...diff, `${base}...${branch}`], options)).stdout;
  const left = (await run('git', ['-C', worktree, 'merge-base', base, 'HEAD'], options)).stdout.trim();
  return (await run('git', ['-C', worktree, ...diff, left], options)).stdout;
}
