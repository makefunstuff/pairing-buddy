import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {sandboxWorks} from '../src/sandbox.mjs';
import {commandResult, promptNumber, ScoutPane, shellQuote} from '../src/scout-pane.mjs';
import {scoutPaneConfig} from '../src/scout-shell.mjs';
import {fakeHerdr} from './fake-herdr.mjs';

test('promptNumber reads the prompt on the last line only', () => {
  assert.equal(promptNumber('scout[1] exit 0 $ ls\na.js\nscout[2] exit 0 $ '), 2);
  assert.equal(promptNumber('scout[2] exit 0 $ npm test\nrunning...'), null);
  assert.equal(promptNumber('[you@host project]$ '), null);
});

test('commandResult cuts out one command\'s output and its exit code', () => {
  const text = 'scout[3] exit 0 $ npm test\nFAIL ws.test.js\nTests: 1 failed, 1 total\nscout[4] exit 1 $ ';
  assert.deepEqual(commandResult(text, 3), {exit: 1, output: 'FAIL ws.test.js\nTests: 1 failed, 1 total'});
  assert.equal(commandResult('scout[3] exit 0 $ npm test\nstill running', 3), null);
  assert.deepEqual(commandResult('line 900\nline 901\nscout[4] exit 0 $ ', 3), {exit: 0, output: '(earlier output cut)\nline 900\nline 901'});
});

test('shellQuote makes one word of anything', () => {
  assert.equal(shellQuote("it's $HOME; rm -rf /"), "'it'\\''s $HOME; rm -rf /'");
});

test('the pane opens beside the chat, runs commands one at a time and types only into itself', async () => {
  const socketPath = join(mkdtempSync(join(tmpdir(), 'pair-herdr-')), 'herdr.sock');
  const herdr = await fakeHerdr(socketPath, {commands: {'npm test': {output: 'Tests: 1 failed, 1 total', exit: 1}, 'echo two': {output: 'two'}}});
  const pane = new ScoutPane({socketPath, workspaceId: 'w1', besidePane: 'w1:p2', cwd: '/project'});
  try {
    const [first, second] = await Promise.all([pane.run('npm test'), pane.run('echo two')]);
    assert.deepEqual(first, {exit: 1, output: 'Tests: 1 failed, 1 total', timedOut: false});
    assert.deepEqual(second, {exit: 0, output: 'two', timedOut: false});
    assert.equal(herdr.panes.get(pane.paneId).label, 'pair scout');
    assert.ok(herdr.sent.every(([target]) => target === pane.paneId), 'nothing is typed into the user\'s or the chat pane');

    // A later daemon finds the pane by its label instead of opening another.
    const again = new ScoutPane({socketPath, workspaceId: 'w1', besidePane: 'w1:p2', cwd: '/project'});
    await again.run('echo two');
    assert.equal(again.paneId, pane.paneId);
    assert.equal(herdr.panes.size, 3);

    await pane.close();
    assert.equal(herdr.panes.has(again.paneId), false);
  } finally {
    await herdr.close();
  }
});

test('the pane starts its shell as the config says, hides herdr\'s socket and lists the rc file\'s names once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pair-herdr-'));
  const socketPath = join(dir, 'herdr.sock');
  const rc = join(dir, 'bashrc');
  writeFileSync(rc, "alias ll='ls -l'\n");
  const herdr = await fakeHerdr(socketPath);
  const daemonSocket = join(dir, 'pair.sock');
  writeFileSync(daemonSocket, '');
  const pane = new ScoutPane({socketPath, workspaceId: 'w1', besidePane: 'w1:p2', cwd: dir, setup: scoutPaneConfig({rc, sandbox: 'auto'}), hidden: [daemonSocket]});
  try {
    await pane.open();
    const [, line] = herdr.sent[0];
    assert.match(line, new RegExp(`PAIR_SCOUT_RC=${rc} `));
    if (sandboxWorks()) {
      assert.match(line, / bwrap /);
      assert.ok(line.includes(`--ro-bind /dev/null ${socketPath}`) && line.includes(`--ro-bind /dev/null ${daemonSocket}`));
    }
    const names = pane.rcNames();
    assert.equal(pane.rcNames(), names);
    assert.deepEqual((await names).aliases, {ll: 'ls -l'});
    assert.equal(await new ScoutPane({socketPath, cwd: dir}).rcNames(), undefined, 'without an rc file there are none');
  } finally {
    await herdr.close();
  }
});
