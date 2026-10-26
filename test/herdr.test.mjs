import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {commandOutput, foregroundCommand, PaneWatch, plainLine} from '../src/herdr.mjs';
import {fakeHerdr} from './fake-herdr.mjs';

test('foregroundCommand is null at the shell prompt and the argv otherwise', () => {
  const shell = {pid: 10, name: 'bash', argv: ['/usr/bin/bash']};
  assert.equal(foregroundCommand({shell_pid: 10, foreground_processes: [shell]}), null);
  assert.equal(foregroundCommand({shell_pid: 10, foreground_processes: [{pid: 11, name: 'node', argv: ['node', 'test.js']}]}), 'node test.js');
});

test('commandOutput keeps the lines after the command, without the next prompt', () => {
  const text = '$ ls\nREADME.md\n$ node test.js\nAssertionError: expected 30000\n    at test.js:4\n$ \n\n';
  assert.equal(commandOutput(text, 'node test.js'), 'AssertionError: expected 30000\n    at test.js:4');
});

test('focus: no focused pane in the workspace means the user looks elsewhere', () => {
  const events = [];
  const watch = new PaneWatch({socketPath: '/unused', workspaceId: 'w1', chatPane: 'w1:p3', emit: event => events.push(event)});
  watch.updateFocus({pane_id: 'w1:p2', scroll: {offset_from_bottom: 0}});
  watch.updateFocus(undefined);
  watch.updateFocus(undefined);
  watch.updateFocus({pane_id: 'w1:p3'});
  assert.deepEqual(events.map(event => [event.target, event.pane]), [['terminal', 'w1:p2'], ['elsewhere', null], ['chat', 'w1:p3']]);
});

test('plainLine: one line of text, without Enter or any other control key', () => {
  for (const text of ['npm test', 'git log --oneline -5', 'echo "a b"']) assert.equal(plainLine(text), true, text);
  for (const text of ['', '  ', 'npm test\r', 'npm test\n', 'a\nb', '\x03', '\x15ls', '\x1b[A', 'ls\t-l', 'x\x7f']) {
    assert.equal(plainLine(text), false, JSON.stringify(text));
  }
});

test('type sends plain text to the user\'s terminal pane only, and never Enter', async () => {
  const socketPath = join(mkdtempSync(join(tmpdir(), 'pair-herdr-')), 'herdr.sock');
  const herdr = await fakeHerdr(socketPath);
  const watch = new PaneWatch({socketPath, workspaceId: 'w1', chatPane: 'w1:p2', scout: {paneId: 'w1:p3'}, emit: () => {}});
  watch.editors.add('w1:p4');
  try {
    await watch.type('w1:p1', 'npm test');
    await assert.rejects(watch.type('w1:p1', 'npm test\r'), /one line of plain text/);
    for (const pane of ['w1:p2', 'w1:p3', 'w1:p4']) await assert.rejects(watch.type(pane, 'npm test'), /not one of the user's terminals/);
    assert.deepEqual(herdr.sent, [['w1:p1', 'npm test']]);
  } finally {
    await herdr.close();
  }
});
