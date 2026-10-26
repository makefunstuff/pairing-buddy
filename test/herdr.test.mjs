import assert from 'node:assert/strict';
import {test} from 'node:test';
import {commandOutput, foregroundCommand, PaneWatch} from '../src/herdr.mjs';

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
