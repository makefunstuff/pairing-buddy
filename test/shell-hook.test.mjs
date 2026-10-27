import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {shellHook} from '../src/shell-hook.mjs';
import {scratch} from './temp.mjs';

const has = command => spawnSync(command, ['--version']).status === 0;
const hasBash = has('bash');

/** A directory with `shell`'s hook in it, whose reporter logs what it would send; removed when test `t` ends. */
function hookDir(t, shell) {
  const dir = scratch('pair-hook-');
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const reporter = join(dir, 'reporter.mjs');
  writeFileSync(reporter, `import {appendFileSync} from 'node:fs';\nappendFileSync(${JSON.stringify(join(dir, 'log'))}, process.argv.slice(2).join(' ') + '\\n');\n`);
  writeFileSync(join(dir, 'hook'), shellHook(shell, reporter));
  return dir;
}

const reportsIn = dir => {
  try { return readFileSync(join(dir, 'log'), 'utf8').trim().split('\n'); } catch { return []; }
};

/** The reports without the shell's pid each ends with, and the pids: one shell's, the same in all of them. */
function shellPids(reports) {
  const pids = new Set(reports.map(line => Number(/ --shell (\d+)$/.exec(line)?.[1])));
  return {reports: reports.map(line => line.replace(/ --shell \d+$/, '')), pids: [...pids]};
}

/** Runs `commands` in an interactive bash with the hook. */
function runBash(t, promptCommand, commands) {
  const dir = hookDir(t, 'bash');
  const script = [promptCommand, `source ${join(dir, 'hook')}`, ...commands, 'sleep 1', 'exit', ''].join('\n');
  const {stdout, pid} = spawnSync('bash', ['--norc', '-i'], {input: script, cwd: dir, env: {...process.env, HISTFILE: join(dir, 'history')}});
  return {reports: reportsIn(dir), output: stdout.toString(), pid};
}

/** Types `commands` into `shell` on a terminal (zsh and fish run their hooks only there), a line at a time. */
async function runOnTerminal(t, shell, args, commands) {
  const dir = hookDir(t, shell);
  const child = spawn('script', ['-qec', [shell, ...args].join(' '), '/dev/null'], {cwd: dir, env: {...process.env, HOME: dir, XDG_CONFIG_HOME: dir}});
  child.stdout.resume();
  for (const line of [`source ${join(dir, 'hook')}`, ...commands, 'exit']) {
    await new Promise(resolve => setTimeout(resolve, 300));
    child.stdin.write(`${line}\r`);
  }
  await new Promise(resolve => child.on('exit', resolve));
  await new Promise(resolve => setTimeout(resolve, 500)); // the last report runs in the background
  return reportsIn(dir).filter(line => !line.includes('--cmd source '));
}

const COMMANDS = ['true', '', 'false', 'ls /nonexistent | cat', ''];
const EXPECTED = ['report --exit 0 --cmd true', 'report --exit 1 --cmd false', 'report --exit 0 --cmd ls /nonexistent | cat'];

for (const [name, promptCommand] of [['a string', 'PROMPT_COMMAND="echo hi >/dev/null"'], ['an array', 'PROMPT_COMMAND=("echo a >/dev/null" "echo b >/dev/null")']]) {
  test(`the bash hook reports each typed command once, also after an empty line, with PROMPT_COMMAND as ${name}`, {skip: hasBash ? false : 'bash not installed'}, t => {
    const {reports: logged, output, pid} = runBash(t, promptCommand, COMMANDS);
    const {reports, pids} = shellPids(logged);
    // Reports run in the background, so they may arrive in any order.
    assert.deepEqual(reports.filter(line => !line.includes('sleep 1')).sort(), [...EXPECTED].sort());
    assert.deepEqual(pids, [pid], 'each names the shell it ran in');
    assert.ok(output.includes('\x1b]133;C\x07') && output.includes('\x1b]133;D;1\x07') && output.includes('\x1b]133;A\x07'), 'the OSC 133 marks');
  });
}

// zsh and fish are not installed everywhere; these run where they are.
const onTerminal = has('script') ? false : 'script (util-linux) not installed';
for (const [shell, args] of [['zsh', ['-f', '-i']], ['fish', ['--no-config', '-i']]]) {
  test(`the ${shell} hook reports each typed command once`, {skip: onTerminal || (has(shell) ? false : `${shell} not installed`)}, async t => {
    const {reports, pids} = shellPids(await runOnTerminal(t, shell, args, COMMANDS));
    assert.deepEqual(reports.sort(), [...EXPECTED].sort());
    assert.ok(pids.length === 1 && pids[0] > 0, 'each names the shell it ran in');
  });
}

test('shell-hook knows bash, zsh and fish', () => {
  assert.match(shellHook('zsh', '/x/pair.mjs'), /add-zsh-hook precmd _pair_precmd/);
  assert.match(shellHook('fish', '/x/pair.mjs'), /--on-event fish_postexec/);
  assert.throws(() => shellHook('tcsh', '/x/pair.mjs'), /bash\|zsh\|fish/);
});
