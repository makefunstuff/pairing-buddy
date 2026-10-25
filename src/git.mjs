// Read-only git questions the daemon asks for the session state. The model never runs git.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run = promisify(execFile);

async function git(cwd, args) {
  const {stdout} = await run('git', ['-C', cwd, ...args], {timeout: 3000});
  return stdout.trim();
}

export const gitRoot = cwd => git(cwd, ['rev-parse', '--show-toplevel']).catch(() => null);
export const gitBranch = root => git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null);
