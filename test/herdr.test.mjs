import assert from 'node:assert/strict';
import {rmSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {foregroundCommand, PaneWatch, plainLine} from '../src/herdr.mjs';
import {fakeHerdr} from './fake-herdr.mjs';
import {scratch} from './temp.mjs';

/** A new folder in the test file's temp folder, removed when test `t` ends, passed or failed. */
function tempDir(t, prefix) {
  const dir = scratch(prefix);
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

test('foregroundCommand is null at the shell prompt and the argv otherwise', () => {
  const shell = {pid: 10, name: 'bash', argv: ['/usr/bin/bash']};
  assert.equal(foregroundCommand({shell_pid: 10, foreground_processes: [shell]}), null);
  assert.equal(foregroundCommand({shell_pid: 10, foreground_processes: [{pid: 11, name: 'node', argv: ['node', 'test.js']}]}), 'node test.js');
});

test('focus: no focused pane in the workspace means the user looks elsewhere', () => {
  const events = [];
  const watch = new PaneWatch({socketPath: '/unused', workspaceId: 'w1', chatPane: 'w1:p3', emit: event => events.push(event)});
  for (const focused of [{pane: 'w1:p2', scrolled: false}, null, null, {pane: 'w1:p3', scrolled: false}]) {
    watch.focused = focused;
    watch.emitFocus();
  }
  assert.deepEqual(events.map(event => [event.target, event.pane]), [['terminal', 'w1:p2'], ['elsewhere', null], ['chat', 'w1:p3']]);
});

test('plainLine: one line of text, without Enter or any other control key', () => {
  for (const text of ['npm test', 'git log --oneline -5', 'echo "a b"']) assert.equal(plainLine(text), true, text);
  for (const text of ['', '  ', 'npm test\r', 'npm test\n', 'a\nb', '\x03', '\x15ls', '\x1b[A', 'ls\t-l', 'x\x7f']) {
    assert.equal(plainLine(text), false, JSON.stringify(text));
  }
});

test('type sends plain text to the user\'s terminal pane only, and never Enter', async t => {
  const socketPath = join(tempDir(t, 'pair-herdr-'), 'herdr.sock');
  const herdr = await fakeHerdr(socketPath);
  const watch = new PaneWatch({socketPath, workspaceId: 'w1', chatPane: 'w1:p2', scout: {paneId: 'w1:p3'}, emit: () => {}});
  watch.paneState('w1:p4').editor = true;
  try {
    await watch.type('w1:p1', 'npm test');
    await assert.rejects(watch.type('w1:p1', 'npm test\r'), /one line of plain text/);
    for (const pane of ['w1:p2', 'w1:p3', 'w1:p4']) await assert.rejects(watch.type(pane, 'npm test'), /not one of the user's terminals/);
    assert.deepEqual(herdr.sent, [['w1:p1', 'npm test']]);
  } finally {
    await herdr.close();
  }
});

/** Resolves once `check()` is true; fails the test after two seconds. */
async function until(check, what) {
  const end = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function watching(t) {
  const socketPath = join(tempDir(t, 'pair-herdr-'), 'herdr.sock');
  const herdr = await fakeHerdr(socketPath);
  const events = [];
  const watch = new PaneWatch({socketPath, workspaceId: 'w1', chatPane: 'w1:p2', emit: event => events.push(event)});
  watch.start();
  t.after(async () => { watch.stop(); await herdr.close(); });
  const user = herdr.panes.get('w1:p1');
  return {herdr, watch, events, user, of: kind => events.filter(event => event.kind === kind)};
}

test('focus and scrolling come pushed from herdr\'s events', async t => {
  const {herdr, of} = await watching(t);
  await until(() => of('focus').length === 1, 'the first focus');
  herdr.focus('w1:p2');
  await until(() => of('focus').length === 2, 'focus on the chat');
  herdr.focus('w1:p1');
  await until(() => of('focus').length === 3 && herdr.subscribers.size === 1, 'focus back');
  await until(() => [...herdr.subscribers][0].subscriptions.some(({pane_id}) => pane_id === 'w1:p1'), 'the scroll subscription');
  herdr.scroll('w1:p1', 12);
  await until(() => of('focus').length === 4, 'the scroll');
  assert.deepEqual(of('focus').map(({target, pane, scrolled}) => [target, pane, scrolled]), [
    ['terminal', 'w1:p1', false], ['chat', 'w1:p2', false], ['terminal', 'w1:p1', false], ['terminal', 'w1:p1', true],
  ]);
});

test('keys at a shell prompt count as typing; the Driver\'s own text does not', async t => {
  const {watch, user, of} = await watching(t);
  await new Promise(resolve => setTimeout(resolve, 700)); // the first look at the prompt
  user.lines = ['$ git st'];
  await until(() => of('typing').length === 1, 'typing');
  assert.deepEqual(of('typing')[0], {kind: 'typing', source: 'terminal', pane: 'w1:p1'});
  await watch.type('w1:p1', 'npm test');
  user.lines = ['$ npm test'];
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(of('typing').length, 1);
});

test('commands in the user\'s pane: one seen running, then one too short for that, each with its output', async t => {
  const {herdr, user, of} = await watching(t);
  user.lines = ['old', '$ npm test'];
  await new Promise(resolve => setTimeout(resolve, 700));
  herdr.processes.set('w1:p1', [{pid: 7, name: 'node', argv: ['node', '/usr/bin/npm', 'test']}]);
  await new Promise(resolve => setTimeout(resolve, 700));
  user.lines.push('> p@1.0.0 test', 'not ok 1 - adds', '$');
  herdr.processes.delete('w1:p1');
  await until(() => of('command_end').length === 1, 'the end of npm test');
  assert.deepEqual(of('command_end')[0], {kind: 'command_end', pane: 'w1:p1', cmd: 'node /usr/bin/npm test', exit: null, output: '> p@1.0.0 test\nnot ok 1 - adds'});
  user.lines.splice(-1, 1, '$ ls', 'a.js', '$'); // typed on the prompt line, entered, and done before the next look
  await until(() => of('command_end').length === 2, 'ls');
  assert.deepEqual(of('command_end')[1], {kind: 'command_end', pane: 'w1:p1', cmd: 'ls', exit: null, output: 'a.js'});
  assert.equal(of('typing').length, 0);
});

test('with the user in another workspace and nothing running, Pair asks herdr nothing', async t => {
  const {herdr, of} = await watching(t);
  await until(() => of('focus').length === 1, 'the first focus');
  herdr.focus('w2:p1');
  await until(() => of('focus').length === 2, 'focus elsewhere');
  await new Promise(resolve => setTimeout(resolve, 100));
  const before = herdr.calls.length;
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.deepEqual(herdr.calls.slice(before), []);
});
