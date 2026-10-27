import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {shown} from '../src/pane-runs.mjs';
import {sandboxWorks} from '../src/sandbox.mjs';
import {ScoutPane, shellQuote} from '../src/scout-pane.mjs';
import {scoutPaneConfig} from '../src/scout-shell.mjs';
import {fakeHerdr} from './fake-herdr.mjs';
import {runInPane} from './pane-shell.mjs';

const hasBash = spawnSync('bash', ['--version']).status === 0;

/** A new folder in the system's temp folder, removed when test `t` ends, passed or failed. */
function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

const COMPOUND = [
  'echo out; echo err >&2; false',
  '',
  'cd / && pwd',
  'seq 1 2500',
  'printf "a\\nb\\na\\n" | grep a | wc -l',
  'echo x | cat',
  '(cd /tmp && echo sub | cat)',
  'echo "$(echo nested)"',
  '(sleep 1; echo late) &',
  'pwd',
];

for (const [name, sandbox] of [['', false], [' in the sandbox', true]]) {
  const skip = !hasBash ? 'bash not installed' : sandbox && !sandboxWorks() ? 'bubblewrap does not work here' : false;
  test(`the pane's shell gives each command its whole output and exit code, whatever its shell syntax${name}`, {skip, timeout: 30_000}, async t => {
    const dir = tempDir(t, 'pair-runs-');
    const {results, runs} = await runInPane({setup: scoutPaneConfig({sandbox}), cwd: dir, dir: join(dir, 'pane'), commands: COMPOUND});
    await new Promise(resolve => setTimeout(resolve, 1500)); // the job in the background prints after its command ended
    assert.deepEqual(results[0], {exit: 1, output: 'out\nerr'});
    assert.deepEqual(results[1], {exit: 0, output: '/'});
    assert.equal(results[2].output.split('\n').length, 2500, 'more than herdr\'s 1000 lines, from the first');
    assert.equal(results[2].output.split('\n')[0], '1');
    assert.deepEqual(results.slice(3, 6), [{exit: 0, output: '2'}, {exit: 0, output: 'x'}, {exit: 0, output: 'sub'}], 'pipes end, a subshell is a command');
    assert.deepEqual(results[6], {exit: 0, output: 'nested'});
    assert.equal(results[7].exit, 0);
    assert.doesNotMatch(results[7].output, /late/, 'a job in the background does not hold its command open, nor add to its output');
    assert.deepEqual(results[8], {exit: 0, output: '/'}, 'a cd stays: commands run in the pane\'s own shell');
    assert.equal(await runs.next(), 10, 'empty lines are no commands');
  });
}

test('once a command has ended, the shell is at its prompt for the next one, also right away', {skip: hasBash ? false : 'bash not installed', timeout: 60_000}, async t => {
  const dir = tempDir(t, 'pair-runs-');
  // runInPane reads `next` the moment each command ended, as a run queued behind it does.
  const {results} = await runInPane({setup: scoutPaneConfig({sandbox: false}), cwd: dir, dir: join(dir, 'pane'), commands: Array.from({length: 300}, (_, i) => `echo ${i}`)});
  assert.equal(results.length, 300);
  assert.deepEqual(results.at(-1), {exit: 0, output: '299'});
});

const hasScript = spawnSync('script', ['--version']).status === 0;

test('on a terminal, Ctrl-C ends a command and keeps its output, also with a job left in the background', {skip: hasBash && hasScript ? false : 'needs bash and script (util-linux)', timeout: 20_000}, async t => {
  const dir = tempDir(t, 'pair-runs-');
  const {results, runs, shell} = await runInPane({setup: scoutPaneConfig({sandbox: false}), cwd: dir, dir: join(dir, 'pane'), commands: ['sleep 30 &'], terminal: true});
  try {
    assert.equal(results[0].exit, 0);
    shell.stdin.write('echo started; sleep 30\r');
    await assert.rejects(runs.ended(2, 1000), /timed out/);
    shell.stdin.write('\x03');
    await runs.ended(2, 5000);
    assert.deepEqual(await runs.result(2), {exit: 130, output: 'started'});
    shell.stdin.write('echo after | cat\r');
    await runs.ended(3, 5000);
    assert.deepEqual(await runs.result(3), {exit: 0, output: 'after'});
  } finally {
    shell.kill();
  }
});

test('the output reads as the pane shows it: no escape sequences, a progress bar at its last state', () => {
  assert.equal(shown('\x1b[H\x1b[2J\x1b[3Jafter\n\x1b[31mred\x1b[0m \x1b]8;;http://x\x07link\x1b]8;;\x07'), 'after\nred link');
  assert.equal(shown('10%\r50%\r100%\r\ndone\r\n'), '100%\ndone\n');
});

test('shellQuote makes one word of anything', () => {
  assert.equal(shellQuote("it's $HOME; rm -rf /"), "'it'\\''s $HOME; rm -rf /'");
});

test('the pane opens beside the chat, runs commands one at a time and types only into itself', async t => {
  const dir = tempDir(t, 'pair-herdr-');
  const socketPath = join(dir, 'herdr.sock');
  const herdr = await fakeHerdr(socketPath, {commands: {'npm test': {output: 'Tests: 1 failed, 1 total', exit: 1}, 'echo two': {output: 'two'}}});
  const pane = new ScoutPane({socketPath, workspaceId: 'w1', besidePane: 'w1:p2', cwd: '/project', runsDir: join(dir, 'panes')});
  try {
    const [first, second] = await Promise.all([pane.run('npm test'), pane.run('echo two')]);
    assert.deepEqual(first, {exit: 1, output: 'Tests: 1 failed, 1 total', timedOut: false, cancelled: false});
    assert.deepEqual(second, {exit: 0, output: 'two', timedOut: false, cancelled: false});
    assert.equal(herdr.panes.get(pane.paneId).label, 'pair scout');
    assert.ok(herdr.sent.every(([target]) => target === pane.paneId), 'nothing is typed into the user\'s or the chat pane');

    // A later daemon finds the pane by its label instead of opening another.
    const again = new ScoutPane({socketPath, workspaceId: 'w1', besidePane: 'w1:p2', cwd: '/project', runsDir: join(dir, 'panes')});
    await again.run('echo two');
    assert.equal(again.paneId, pane.paneId);
    assert.equal(herdr.panes.size, 3);

    await pane.close();
    assert.equal(herdr.panes.has(again.paneId), false);
    assert.equal(existsSync(pane.runs.dir), false, 'its files go with it');
  } finally {
    await herdr.close();
  }
});

test('a command whose signal aborts is stopped with Ctrl-C, and one aborted before its turn is never typed', async t => {
  const dir = tempDir(t, 'pair-herdr-');
  const socketPath = join(dir, 'herdr.sock');
  let stop;
  const herdr = await fakeHerdr(socketPath, {commands: command => (command === 'slow' ? new Promise(resolve => { stop = () => resolve({exit: 130}); }) : {})});
  const pane = new ScoutPane({socketPath, workspaceId: 'w1', besidePane: 'w1:p2', cwd: '/project', runsDir: join(dir, 'panes')});
  try {
    const controller = new AbortController();
    const slow = pane.run('slow', {signal: controller.signal});
    const later = new AbortController();
    const queued = pane.run('never', {signal: later.signal});
    while (!stop) await new Promise(resolve => setTimeout(resolve, 5));
    later.abort();
    controller.abort();
    while (!herdr.sent.some(([, text]) => text === '\x03')) await new Promise(resolve => setTimeout(resolve, 5));
    stop(); // the fake shell's Ctrl-C
    assert.deepEqual(await slow, {exit: 130, output: '', timedOut: false, cancelled: true});
    assert.deepEqual(await queued, {exit: null, output: '', timedOut: false, cancelled: true});
    assert.equal(herdr.sent.some(([, text]) => text.includes('never')), false);
  } finally {
    await herdr.close();
  }
});

test('the pane starts its shell as the config says, hides herdr\'s socket and lists the rc file\'s names once', async t => {
  const dir = tempDir(t, 'pair-herdr-');
  const socketPath = join(dir, 'herdr.sock');
  const rc = join(dir, 'bashrc');
  writeFileSync(rc, "alias ll='ls -l'\n");
  const herdr = await fakeHerdr(socketPath);
  const daemonSocket = join(dir, 'pair.sock');
  writeFileSync(daemonSocket, '');
  const pane = new ScoutPane({socketPath, workspaceId: 'w1', besidePane: 'w1:p2', cwd: dir, runsDir: join(dir, 'panes'), setup: scoutPaneConfig({rc, sandbox: 'auto'}), hidden: [daemonSocket]});
  try {
    await pane.open();
    const [, line] = herdr.sent[0];
    assert.match(line, new RegExp(`PAIR_SCOUT_RC=${rc} `));
    if (sandboxWorks()) {
      assert.match(line, / bwrap /);
      assert.ok(line.includes(`--ro-bind /dev/null ${socketPath}`) && line.includes(`--ro-bind /dev/null ${daemonSocket}`));
      assert.ok(line.includes(`--bind ${pane.runs.dir} ${pane.runs.dir}`), 'its folder is writable, to take the shell\'s files');
    }
    const names = pane.rcNames();
    assert.equal(pane.rcNames(), names);
    assert.deepEqual((await names).aliases, {ll: 'ls -l'});
    assert.equal(await new ScoutPane({socketPath, cwd: dir, runsDir: join(dir, 'panes')}).rcNames(), undefined, 'without an rc file there are none');
  } finally {
    await herdr.close();
  }
});
