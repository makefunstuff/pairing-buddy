import assert from 'node:assert/strict';
import {rmSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {foregroundCommand, PaneWatch, plainLine} from '../src/herdr.mjs';
import {PaneWatch as PaneWatchOf} from '../src/pane-watch.mjs';
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

test('a pane with the zsh hook: Pair polls nothing, and takes commands, output and keys from the hook', async t => {
  const {herdr, watch, user, of} = await watching(t);
  await until(() => of('focus').length === 1, 'the first focus');
  watch.shellReady('w1:p1', {shell: 42, keys: true});
  await new Promise(resolve => setTimeout(resolve, 100));
  const before = herdr.calls.length;
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.deepEqual(herdr.calls.slice(before), [], 'nothing polled while the focused pane waits at its prompt');

  user.lines = ['old', '$ npm test', '$ npm test'];
  await watch.commandStarted('w1:p1', {shell: 42, n: 1, cmd: 'npm test'});
  assert.deepEqual(herdr.calls.slice(before), ['pane.read', 'pane.process_info'], 'one look, at the start');
  user.lines.push('> jest', 'not ok 1 - adds', '$');
  const output = await watch.commandEnded('w1:p1', {shell: 42, n: 1, cmd: 'npm test'});
  assert.equal(output, '> jest\nnot ok 1 - adds', 'from the line it was typed on, the last of the two');

  watch.keysTyped('w1:p1');
  await watch.type('w1:p1', 'git status');
  watch.keysTyped('w1:p1'); // the Driver's text arriving
  assert.deepEqual(of('typing'), [{kind: 'typing', source: 'terminal', pane: 'w1:p1'}]);
});

test('a hooked command whose end is reported before its start is not taken for one still running', async t => {
  const {watch, of} = await watching(t);
  await until(() => of('focus').length === 1, 'the first focus');
  watch.shellReady('w1:p1', {shell: 42, keys: true});
  await watch.commandEnded('w1:p1', {shell: 42, n: 1, cmd: 'false'});
  await watch.commandStarted('w1:p1', {shell: 42, n: 1, cmd: 'false'});
  assert.equal(watch.paneState('w1:p1').running, null);
  await watch.commandStarted('w1:p1', {shell: 42, n: 2, cmd: 'nvim a.js'});
  assert.equal(watch.paneState('w1:p1').running, 'nvim a.js');
  // A new shell in the pane counts its lines from 1 again.
  await watch.commandStarted('w1:p1', {shell: 43, n: 1, cmd: 'ls'});
  assert.equal(watch.paneState('w1:p1').running, 'ls');
});

test('a hooked pane running an editor is the editor until the command ends', async t => {
  const {herdr, watch, of} = await watching(t);
  await until(() => of('focus').length === 1, 'the first focus');
  watch.shellReady('w1:p1', {shell: 42, keys: true});
  herdr.processes.set('w1:p1', [{pid: 7, name: 'nvim', argv: ['nvim', 'a.js']}]);
  await watch.commandStarted('w1:p1', {shell: 42, n: 1, cmd: 'nvim a.js'});
  herdr.processes.delete('w1:p1');
  await watch.commandEnded('w1:p1', {shell: 42, n: 1, cmd: 'nvim a.js'});
  assert.deepEqual(of('focus').map(event => event.target), ['terminal', 'editor', 'terminal']);
});

test('a hooked pane whose command opens an editor late (git commit after its hooks) becomes the editor, and nothing is typed into it', async t => {
  const {herdr, watch, of} = await watching(t);
  await until(() => of('focus').length === 1, 'the first focus');
  watch.shellReady('w1:p1', {shell: 42, keys: true});
  await watch.commandStarted('w1:p1', {shell: 42, n: 1, cmd: 'git commit'});
  assert.equal(watch.targetOf('w1:p1'), 'terminal');
  herdr.processes.set('w1:p1', [{pid: 7, name: 'git', argv: ['git', 'commit']}]);
  await new Promise(resolve => setTimeout(resolve, 600));
  herdr.processes.set('w1:p1', [{pid: 8, name: 'nvim', argv: ['nvim', '.git/COMMIT_EDITMSG']}]);
  await until(() => watch.targetOf('w1:p1') === 'editor', 'the editor');
  await assert.rejects(watch.type('w1:p1', 'dd'), /not one of the user's terminals/);
  assert.deepEqual(herdr.sent, []);
  herdr.processes.delete('w1:p1');
  await watch.commandEnded('w1:p1', {shell: 42, n: 1, cmd: 'git commit'});
  assert.deepEqual(of('focus').map(event => event.target), ['terminal', 'editor', 'terminal']);
});

test('with the bash or fish hook, the focused pane is only read at its prompt, for typing', async t => {
  const {herdr, watch, user, of} = await watching(t);
  await until(() => of('focus').length === 1, 'the first focus');
  watch.shellReady('w1:p1', {shell: 42, keys: false});
  await new Promise(resolve => setTimeout(resolve, 1200));
  const before = herdr.calls.length;
  user.lines = ['$ git st'];
  await until(() => of('typing').length === 1, 'typing');
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.ok(herdr.calls.slice(before).every(method => method === 'pane.read'), 'no process_info');
});

test('the hook in Pair\'s own panes (the chat\'s shell has the user\'s rc file) is not the user\'s', async t => {
  const {herdr, watch, of} = await watching(t);
  await until(() => of('focus').length === 1, 'the first focus');
  const before = herdr.calls.length;
  watch.shellReady('w1:p2', {shell: 9});
  await watch.commandStarted('w1:p2', {shell: 9, n: 1, cmd: 'pair chat'});
  assert.equal(await watch.commandEnded('w1:p2', {shell: 9, n: 1, cmd: 'pair chat'}), null);
  watch.keysTyped('w1:p2');
  assert.equal(watch.hooked.has('w1:p2'), false);
  assert.deepEqual(herdr.calls.slice(before).filter(method => method !== 'pane.read' && method !== 'pane.process_info'), []);
  assert.equal(of('typing').length, 0);
});

test('keys the hook reports from a Neovim :terminal or a tmux pane are found by the shell\'s pid', async () => {
  const events = [];
  const terminals = new Map([[77, 'nvim:5:3']]); // shell pid -> its terminal
  const source = {
    name: 'fake', start() {}, stop() {}, list: async () => [{pane: 'nvim:5:3', focused: true}, {pane: 'tmux:%1', focused: false}],
    paneOfShell: pid => terminals.get(pid) ?? null, commandOf: async () => null, read: async () => '$ ', send: async () => {},
  };
  const watch = new PaneWatchOf({source, emit: event => events.push(event)});
  await watch.listPanes();
  assert.equal(watch.keysTypedIn({shell: 77, pane: 'tmux:%1'}), true); // a Neovim in tmux: its terminal, not the tmux pane
  assert.equal(watch.keysTypedIn({shell: 78, pane: 'tmux:%1'}), true);
  assert.equal(watch.keysTypedIn({shell: 79, pane: null}), false); // a terminal this watch does not see
  assert.deepEqual(events.filter(event => event.kind === 'typing').map(event => event.pane), ['nvim:5:3', 'tmux:%1']);
});
