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
