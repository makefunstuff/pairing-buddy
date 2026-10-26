import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {shellHook} from '../src/shell-hook.mjs';

const hasBash = spawnSync('bash', ['--version']).status === 0;

/** Runs `commands` in an interactive bash with the hook; the reporter logs what it would send. */
function runBash(promptCommand, commands) {
  const dir = mkdtempSync(join(tmpdir(), 'pair-hook-'));
  const log = join(dir, 'log');
  const reporter = join(dir, 'reporter.mjs');
  writeFileSync(reporter, `import {appendFileSync} from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');\n`);
  writeFileSync(join(dir, 'hook.bash'), shellHook('bash', reporter));
  const script = [promptCommand, `source ${join(dir, 'hook.bash')}`, ...commands, 'sleep 1', 'exit', ''].join('\n');
  spawnSync('bash', ['--norc', '-i'], {input: script, cwd: dir, env: {...process.env, HISTFILE: join(dir, 'history')}});
  try { return readFileSync(log, 'utf8').trim().split('\n'); } catch { return []; }
}

const EXPECTED = ['report --exit 0 --cmd true', 'report --exit 1 --cmd false', 'report --exit 0 --cmd ls /nonexistent | cat'];

for (const [name, promptCommand] of [['a string', 'PROMPT_COMMAND="echo hi >/dev/null"'], ['an array', 'PROMPT_COMMAND=("echo a >/dev/null" "echo b >/dev/null")']]) {
  test(`the bash hook reports each typed command once, with PROMPT_COMMAND as ${name}`, {skip: hasBash ? false : 'bash not installed'}, () => {
    const reports = runBash(promptCommand, ['true', 'false', 'ls /nonexistent | cat']);
    // Reports run in the background, so they may arrive in any order.
    assert.deepEqual(reports.filter(line => !line.includes('sleep 1')).sort(), [...EXPECTED].sort());
  });
}

test('shell-hook knows bash and zsh only', () => {
  assert.match(shellHook('zsh', '/x/pair.mjs'), /add-zsh-hook precmd _pair_precmd/);
  assert.throws(() => shellHook('fish', '/x/pair.mjs'), /bash\|zsh/);
});
