import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {PaneRuns, shown} from '../src/pane-runs.mjs';
import {ScoutPane, shellQuote} from '../src/scout-pane.mjs';
import {fakeHerdr} from './fake-herdr.mjs';

const hasBash = spawnSync('bash', ['--version']).status === 0;

/** Starts the pane's shell in `runs.dir`; `input` is its stdin (a pipe) or null for a terminal. */
async function paneShell(runs) {
  return runs.shellLine();
}

test('the pane\'s shell gives each command its whole output and exit code, whatever its shell syntax', {skip: hasBash ? false : 'bash not installed', timeout: 20_000}, async () => {
  const runs = new PaneRuns(join(mkdtempSync(join(tmpdir(), 'pair-runs-')), 'w1-p3'));
  const line = await paneShell(runs);
  const commands = [
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
  const results = [];
  // One command at a time, as Pair types them: each waits for the one before to end.
  const child = spawn('bash', ['-c', line], {env: {PATH: process.env.PATH, HOME: runs.dir}, stdio: ['pipe', 'ignore', 'ignore']});
  await runs.ready(5000);
  for (const command of commands) {
    const number = await runs.next();
    if (command) await runs.clearLog();
    child.stdin.write(`${command}\n`);
    if (!command) continue;
    await runs.ended(number, 5000);
    results.push(await runs.result(number));
  }
  await new Promise(resolve => setTimeout(resolve, 1500)); // the job in the background prints after its command ended
  child.stdin.end();
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

const hasScript = spawnSync('script', ['--version']).status === 0;

test('on a terminal, Ctrl-C ends a command and keeps its output, also with a job left in the background', {skip: hasBash && hasScript ? false : 'needs bash and script (util-linux)', timeout: 20_000}, async () => {
  const runs = new PaneRuns(join(mkdtempSync(join(tmpdir(), 'pair-runs-')), 'w1-p3'));
  const line = await paneShell(runs);
  const child = spawn('script', ['-qec', line, '/dev/null'], {env: {PATH: process.env.PATH, HOME: runs.dir, TERM: 'xterm'}});
  child.stdout.resume();
  try {
    await runs.ready(5000);
    child.stdin.write('sleep 30 &\r');
    await runs.ended(1, 5000);
    assert.equal((await runs.result(1)).exit, 0);
    child.stdin.write('echo started; sleep 30\r');
    await assert.rejects(runs.ended(2, 1000), /timed out/);
    child.stdin.write('\x03');
    await runs.ended(2, 5000);
    assert.deepEqual(await runs.result(2), {exit: 130, output: 'started'});
    child.stdin.write('echo after | cat\r');
    await runs.ended(3, 5000);
    assert.deepEqual(await runs.result(3), {exit: 0, output: 'after'});
  } finally {
    child.kill();
  }
});

test('the output reads as the pane shows it: no escape sequences, a progress bar at its last state', () => {
  assert.equal(shown('\x1b[H\x1b[2J\x1b[3Jafter\n\x1b[31mred\x1b[0m \x1b]8;;http://x\x07link\x1b]8;;\x07'), 'after\nred link');
  assert.equal(shown('10%\r50%\r100%\r\ndone\r\n'), '100%\ndone\n');
});

test('shellQuote makes one word of anything', () => {
  assert.equal(shellQuote("it's $HOME; rm -rf /"), "'it'\\''s $HOME; rm -rf /'");
});

test('the pane opens beside the chat, runs commands one at a time and types only into itself', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pair-herdr-'));
  const socketPath = join(dir, 'herdr.sock');
  const herdr = await fakeHerdr(socketPath, {commands: {'npm test': {output: 'Tests: 1 failed, 1 total', exit: 1}, 'echo two': {output: 'two'}}});
  const pane = new ScoutPane({socketPath, workspaceId: 'w1', besidePane: 'w1:p2', cwd: '/project', runsDir: join(dir, 'panes')});
  try {
    const [first, second] = await Promise.all([pane.run('npm test'), pane.run('echo two')]);
    assert.deepEqual(first, {exit: 1, output: 'Tests: 1 failed, 1 total', timedOut: false});
    assert.deepEqual(second, {exit: 0, output: 'two', timedOut: false});
    assert.equal(herdr.panes.get(pane.paneId).label, 'pair scout');
    assert.ok(herdr.sent.every(([target]) => target === pane.paneId), 'nothing is typed into the user\'s or the chat pane');

    // A later daemon finds the pane by its label instead of opening another.
    const again = new ScoutPane({socketPath, workspaceId: 'w1', besidePane: 'w1:p2', cwd: '/project', runsDir: join(dir, 'panes')});
    await again.run('echo two');
    assert.equal(again.paneId, pane.paneId);
    assert.equal(herdr.panes.size, 3);

    await pane.close();
    assert.equal(herdr.panes.has(again.paneId), false);
    assert.equal(existsSync(join(dir, 'panes', again.paneId.replace(':', '-'))), false, 'its files go with it');
  } finally {
    await herdr.close();
  }
});
