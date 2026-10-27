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

const reportsIn = dir => {
  try { return readFileSync(join(dir, 'log'), 'utf8').trim().split('\n'); } catch { return []; }
};

/** The reports with the shell's pid, which differs from run to run, as PID; and the pids, the same in all of them. */
function shellPids(reports) {
  const pids = new Set(reports.map(line => Number(/ --shell (\d+)/.exec(line)?.[1])));
  return {reports: reports.map(line => line.replace(/ --shell \d+/, ' --shell PID')), pids: [...pids]};
}

/** Runs `commands` in an interactive bash with the hook. */
function runBash(t, promptCommand, commands) {
  const dir = hookDir(t, 'bash');
  const script = [promptCommand, `source ${join(dir, 'hook')}`, ...commands, 'sleep 1', 'exit', ''].join('\n');
  const {stdout, pid} = spawnSync('bash', ['--norc', '-i'], {input: script, cwd: dir, env: {...process.env, HISTFILE: join(dir, 'history')}});
  return {reports: reportsIn(dir), output: stdout.toString(), pid};
}

/**
 * Types `commands` into `shell` on a terminal (zsh and fish run their hooks only there), a line at a time; a
 * command `{keys, wait}` types keys without Enter, waiting `wait` ms after each (no keys: waits once).
 */
async function runOnTerminal(t, shell, args, commands, dir = hookDir(t, shell)) {
  const child = spawn('script', ['-qec', [shell, ...args].join(' '), '/dev/null'], {cwd: dir, env: {...process.env, HOME: dir, XDG_CONFIG_HOME: dir, HERDR_PANE_ID: 'w1:p1'}});
  let output = '';
  child.stdout.on('data', data => { output += data; });
  for (const line of [`source ${join(dir, 'hook')}`, ...commands, '\x15exit']) { // Ctrl-U: whatever keys left on the line
    await new Promise(resolve => setTimeout(resolve, 300));
    if (typeof line === 'string') child.stdin.write(`${line}\r`);
    else if (!line.keys.length) await new Promise(resolve => setTimeout(resolve, line.wait));
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
    const {reports: logged, output, pid} = runBash(t, promptCommand, COMMANDS);
    const {reports, pids} = shellPids(logged);
    // Reports run in the background, so they may arrive in any order.
    assert.deepEqual(reports.filter(line => !/--cmd (sleep 1|source )/.test(line)).sort(), [...EXPECTED].sort());
    assert.deepEqual(pids, [pid], 'each names the shell it ran in');
    assert.ok(!output.includes('reporter noise'), 'the reports write nothing to the terminal');
    assert.ok(output.includes('\x1b]133;C\x07') && output.includes('\x1b]133;D;1\x07') && output.includes('\x1b]133;A\x07'), 'the OSC 133 marks');
  });
}

// zsh and fish are not installed everywhere; these run where they are.
const onTerminal = has('script') ? false : 'script (util-linux) not installed';
for (const [shell, args, keys] of [['zsh', ['-f', '-i'], ' --keys'], ['fish', ['--no-config', '-i'], '']]) {
  test(`the ${shell} hook reports each typed command once`, {skip: onTerminal || (has(shell) ? false : `${shell} not installed`)}, async t => {
    const expected = EXPECTED.map(line => line.replace('report', `report${keys}`));
    const {reports, pids} = shellPids(await runOnTerminal(t, shell, args, COMMANDS));
    assert.deepEqual(reports.sort(), expected.sort());
    assert.ok(pids.length === 1 && pids[0] > 0, 'each names the shell it ran in');
  });
}

/** zsh with the hook on a terminal and a daemon socket that records what it hears: [ms since the start, message]. */
async function zshHeard(t, commands, {prelude = ''} = {}) {
  const dir = hookDir(t, 'zsh');
  if (prelude) writeFileSync(join(dir, 'hook'), prelude + readFileSync(join(dir, 'hook'), 'utf8'));
  const heard = [];
  const start = Date.now();
  const server = createServer(socket => readMessages(socket, message => heard.push([Date.now() - start, message])));
  await new Promise(resolve => server.listen(join(dir, 'sock'), resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const {reports} = shellPids(await runOnTerminal(t, 'zsh', ['-f', '-i'], commands, dir));
  return {reports, typed: heard.filter(([, message]) => message.type === 'typing')};
}

const zsh = onTerminal || (has('zsh') ? false : 'zsh not installed');

// Each line is typed 300 ms after the last step: the source line at 300 ms, then the prompt waits until 2100 ms.
const SETTLE = {keys: [], wait: 1500};
const within = (typed, from, to) => typed.filter(([at]) => at >= from && at < to);

test('the zsh hook says keys at the prompt to the daemon\'s socket, at most twice a second, and not for a prompt alone', {skip: zsh}, async t => {
  // 'gits' a key every 200 ms from 2400 ms: two reports (2400, 3000); then Ctrl-U at 3500.
  const {typed} = await zshHeard(t, [SETTLE, {keys: [...'gits'], wait: 200}, {keys: ['\x15'], wait: 800}]);
  assert.ok(typed.every(([, message]) => message.pane === 'w1:p1' && typeof message.tmux === 'string' && message.shell > 0), JSON.stringify(typed));
  assert.deepEqual(within(typed, 700, 2300), [], `nothing while the prompt waits: ${JSON.stringify(typed)}`);
  assert.equal(within(typed, 2300, 3300).length, 2, `the burst over 800 ms: ${JSON.stringify(typed)}`);
  assert.equal(within(typed, 3300, 3700).length, 1, `Ctrl-U: ${JSON.stringify(typed)}`);
  for (let i = 1; i < typed.length; i++) assert.ok(typed[i][0] - typed[i - 1][0] >= 450, `twice a second: ${JSON.stringify(typed)}`);
});

test('the zsh hook says the first key at a new prompt, however soon after the last report', {skip: zsh}, async t => {
  // 'ls' and Enter at 2400 ms (reported), then 'x' at 2700 ms, within half a second, at the new prompt.
  const {typed} = await zshHeard(t, [SETTLE, 'ls', {keys: ['x'], wait: 400}]);
  assert.equal(within(typed, 2300, 2600).length, 1, JSON.stringify(typed));
  assert.equal(within(typed, 2650, 2950).length, 1, `the key after Enter: ${JSON.stringify(typed)}`);
});

test('the zsh hook claims keys only where zle\'s hooks are there, and the hook only once it is in', {skip: zsh}, async t => {
  const noWidgets = await zshHeard(t, [{keys: [], wait: 1000}, {keys: [...'ab'], wait: 300}, '\x15true'], {prelude: 'add-zle-hook-widget() { return 1 }\n'});
  assert.deepEqual(noWidgets.typed, []);
  assert.ok(noWidgets.reports.includes('report --ready --shell PID'), JSON.stringify(noWidgets.reports));
  assert.ok(noWidgets.reports.includes('report --exit 0 --shell PID --n 1 --cmd true'), JSON.stringify(noWidgets.reports));
  const noHooks = await zshHeard(t, ['true'], {prelude: 'add-zsh-hook() { return 1 }\n'});
  assert.deepEqual(noHooks.reports, [], 'no --ready: Pair keeps looking at the pane itself');
});

test('shell-hook knows bash, zsh and fish', () => {
  assert.match(shellHook('zsh', '/x/pair.mjs'), /add-zsh-hook precmd _pair_precmd/);
  assert.match(shellHook('fish', '/x/pair.mjs'), /--on-event fish_postexec/);
  assert.throws(() => shellHook('tcsh', '/x/pair.mjs'), /bash\|zsh\|fish/);
});
