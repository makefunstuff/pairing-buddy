import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {join} from 'node:path';
import {test} from 'node:test';
import {readMessages} from '../src/protocol.mjs';
import {shellHook} from '../src/shell-hook.mjs';
import {scratch} from './temp.mjs';

const has = command => spawnSync(command, ['--version']).status === 0;
const hasBash = has('bash');

/**
 * A directory with `shell`'s hook in it, whose reporter logs what it would send (and zsh's keys go to the socket
 * `sock` in it); removed when test `t` ends.
 */
function hookDir(t, shell) {
  const dir = scratch('pair-hook-');
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const reporter = join(dir, "it's reporter.mjs"); // a quote in the path, as a home folder may have
  writeFileSync(reporter, `import {appendFileSync} from 'node:fs';\nappendFileSync(${JSON.stringify(join(dir, 'log'))}, process.argv.slice(2).join(' ') + '\\n');\nprocess.stderr.write('reporter noise');\n`);
  writeFileSync(join(dir, 'hook'), shellHook(shell, reporter, {socket: join(dir, 'sock')}));
  return dir;
}

// The shell's pid differs from run to run.
const reportsIn = dir => {
  try { return readFileSync(join(dir, 'log'), 'utf8').trim().split('\n').map(line => line.replace(/--shell \d+/, '--shell PID')); } catch { return []; }
};

/** Runs `commands` in an interactive bash with the hook. */
function runBash(t, promptCommand, commands) {
  const dir = hookDir(t, 'bash');
  const script = [promptCommand, `source ${join(dir, 'hook')}`, ...commands, 'sleep 1', 'exit', ''].join('\n');
  const {stdout} = spawnSync('bash', ['--norc', '-i'], {input: script, cwd: dir, env: {...process.env, HISTFILE: join(dir, 'history')}});
  return {reports: reportsIn(dir), output: stdout.toString()};
}

/**
 * Types `commands` into `shell` on a terminal (zsh and fish run their hooks only there), a line at a time; a
 * command `{keys, wait}` types keys without Enter, then waits `wait` ms.
 */
async function runOnTerminal(t, shell, args, commands, dir = hookDir(t, shell)) {
  const child = spawn('script', ['-qec', [shell, ...args].join(' '), '/dev/null'], {cwd: dir, env: {...process.env, HOME: dir, XDG_CONFIG_HOME: dir, HERDR_PANE_ID: 'w1:p1'}});
  let output = '';
  child.stdout.on('data', data => { output += data; });
  for (const line of [`source ${join(dir, 'hook')}`, ...commands, '\x15exit']) { // Ctrl-U: whatever keys left on the line
    await new Promise(resolve => setTimeout(resolve, 300));
    if (typeof line === 'string') child.stdin.write(`${line}\r`);
    else for (const key of line.keys) { child.stdin.write(key); await new Promise(resolve => setTimeout(resolve, line.wait)); }
  }
  await new Promise(resolve => child.on('exit', resolve));
  await new Promise(resolve => setTimeout(resolve, 500)); // the last report runs in the background
  assert.ok(!output.includes('reporter noise'), 'the reports write nothing to the terminal');
  return reportsIn(dir).filter(line => !line.includes('--cmd source ') && !line.includes('--cmd exit'));
}

const COMMANDS = ['true', '', 'false', 'ls /nonexistent | cat', ''];
// Each line's start and end, numbered, and the shell's start; never one for an empty line.
const EXPECTED = [
  'report --ready --shell PID',
  'report --start --shell PID --n 1 --cmd true', 'report --exit 0 --shell PID --n 1 --cmd true',
  'report --start --shell PID --n 2 --cmd false', 'report --exit 1 --shell PID --n 2 --cmd false',
  'report --start --shell PID --n 3 --cmd ls /nonexistent | cat', 'report --exit 0 --shell PID --n 3 --cmd ls /nonexistent | cat',
];

for (const [name, promptCommand] of [['a string', 'PROMPT_COMMAND="echo hi >/dev/null"'], ['an array', 'PROMPT_COMMAND=("echo a >/dev/null" "echo b >/dev/null")']]) {
  test(`the bash hook reports each typed command once, also after an empty line, with PROMPT_COMMAND as ${name}`, {skip: hasBash ? false : 'bash not installed'}, t => {
    const {reports, output} = runBash(t, promptCommand, COMMANDS);
    // Reports run in the background, so they may arrive in any order.
    assert.deepEqual(reports.filter(line => !/--cmd (sleep 1|source )/.test(line)).sort(), [...EXPECTED].sort());
    assert.ok(!output.includes('reporter noise'), 'the reports write nothing to the terminal');
    assert.ok(output.includes('\x1b]133;C\x07') && output.includes('\x1b]133;D;1\x07') && output.includes('\x1b]133;A\x07'), 'the OSC 133 marks');
  });
}

// zsh and fish are not installed everywhere; these run where they are.
const onTerminal = has('script') ? false : 'script (util-linux) not installed';
for (const [shell, args, keys] of [['zsh', ['-f', '-i'], ' --keys'], ['fish', ['--no-config', '-i'], '']]) {
  test(`the ${shell} hook reports each typed command once`, {skip: onTerminal || (has(shell) ? false : `${shell} not installed`)}, async t => {
    const expected = EXPECTED.map(line => line.replace('report', `report${keys}`));
    assert.deepEqual((await runOnTerminal(t, shell, args, COMMANDS)).sort(), expected.sort());
  });
}

test('the zsh hook says keys at the prompt to the daemon\'s socket, at most once a second, and not for a prompt alone', {skip: onTerminal || (has('zsh') ? false : 'zsh not installed')}, async t => {
  const dir = hookDir(t, 'zsh');
  const heard = []; // [ms since the start, message]
  const start = Date.now();
  const server = createServer(socket => readMessages(socket, message => heard.push([Date.now() - start, message])));
  await new Promise(resolve => server.listen(join(dir, 'sock'), resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  // An empty line and a command first: their keys count too, so the test waits for the prompt to settle.
  await runOnTerminal(t, 'zsh', ['-f', '-i'], ['', {keys: [], wait: 0}, {keys: ['\x03'], wait: 1500}, {keys: [...'gits'], wait: 150}, {keys: ['\x15'], wait: 1200}, {keys: ['x'], wait: 300}], dir);
  const typed = heard.filter(([, message]) => message.type === 'typing');
  assert.ok(typed.every(([, message]) => message.pane === 'w1:p1'), JSON.stringify(heard));
  // 'gits' over 600 ms is one report; Ctrl-U a second later another; 'x' a second after that a third.
  const late = typed.filter(([at]) => at > 2800);
  assert.ok(late.length >= 2 && late.length <= 3, JSON.stringify(typed));
  for (let i = 1; i < typed.length; i++) assert.ok(typed[i][0] - typed[i - 1][0] >= 900, `once a second: ${JSON.stringify(typed)}`);
});

test('shell-hook knows bash, zsh and fish', () => {
  assert.match(shellHook('zsh', '/x/pair.mjs'), /add-zsh-hook precmd _pair_precmd/);
  assert.match(shellHook('fish', '/x/pair.mjs'), /--on-event fish_postexec/);
  assert.throws(() => shellHook('tcsh', '/x/pair.mjs'), /bash\|zsh\|fish/);
});
