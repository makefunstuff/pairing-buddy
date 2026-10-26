import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {PaneRuns, shown} from '../src/pane-runs.mjs';
import {ScoutPane, shellQuote} from '../src/scout-pane.mjs';
import {fakeHerdr} from './fake-herdr.mjs';

const hasBash = spawnSync('bash', ['--version']).status === 0;

test('the pane\'s shell writes each command\'s whole output and exit code, not the rest of its rc file', {skip: hasBash ? false : 'bash not installed'}, async () => {
  const runs = new PaneRuns(join(mkdtempSync(join(tmpdir(), 'pair-runs-')), 'w1-p3'));
  const line = await runs.shellLine();
  const typed = ['echo out; echo err >&2; false', '', 'cd / && pwd', 'seq 1 2500', 'pwd', ''].join('\n');
  spawnSync('bash', ['-c', line], {input: typed, env: {PATH: process.env.PATH, HOME: runs.dir}});
  assert.deepEqual(await runs.result(1), {exit: 1, output: 'out\nerr'});
  assert.deepEqual(await runs.result(2), {exit: 0, output: '/'});
  const long = await runs.result(3);
  assert.equal(long.output.split('\n').length, 2500, 'more than herdr\'s 1000 lines, from the first');
  assert.equal(long.output.split('\n')[0], '1');
  assert.deepEqual(await runs.result(4), {exit: 0, output: '/'}, 'a cd stays: commands run in the pane\'s own shell');
  assert.equal(await runs.next(), 5, 'empty lines are no commands');
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
