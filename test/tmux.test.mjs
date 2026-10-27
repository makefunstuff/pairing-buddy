// Pair's view of the user's terminals in tmux, without herdr: a real tmux server on a socket of the test's own,
// with one client attached through `script` (a session nobody looks at has no focus), and a plain bash in it.
// Then the panes as one source with a Neovim's terminals (Panes), the shell's foreground command, and the daemon
// watching the tmux session of a chat pane in it. Skips without tmux or script.
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {createModels, fauxAssistantMessage, fauxProvider, fauxText} from '@earendil-works/pi-ai';
import {parseConfig} from '../src/config.mjs';
import {startDaemon} from '../src/daemon.mjs';
import {foregroundCommand, processCommand} from '../src/foreground.mjs';
import {NvimPanes} from '../src/nvim-panes.mjs';
import {Panes, PaneWatch} from '../src/pane-watch.mjs';
import {tmux, TmuxPanes, tmuxOf} from '../src/tmux.mjs';
import {client} from './daemon-client.mjs';
import {scratch, socketDir} from './temp.mjs';

const has = command => { try { execFileSync('which', [command], {stdio: 'ignore'}); return true; } catch { return false; } };
const skip = !has('tmux') ? 'tmux not installed' : !has('script') ? 'script (util-linux) not installed' : false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, what, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A tmux server with session "t" running bash, a client attached to it; both end with test `t`. */
async function tmuxServer(t) {
  const dir = socketDir('pair-tmux-');
  const socket = join(dir, 'tmux.sock');
  // Not the tmux these tests may run in, and a shell without your rc files or history.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('TMUX')));
  env.HISTFILE = join(dir, 'history');
  execFileSync('tmux', ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '100', '-y', '30', 'bash --norc --noprofile'], {env});
  const client = spawn('script', ['-qfc', `tmux -S ${socket} attach -t t`, '/dev/null'], {env: {...env, TERM: 'xterm-256color'}, stdio: ['pipe', 'ignore', 'ignore']});
  t.after(() => {
    client.kill();
    try { execFileSync('tmux', ['-S', socket, 'kill-server'], {stdio: 'ignore'}); } catch {}
  });
  const pane = (await tmux(socket, ['list-panes', '-t', 't', '-F', '#{pane_id}'])).trim();
  await until(async () => (await tmux(socket, ['display', '-p', '-t', pane, '#{session_attached}'])).trim() === '1', 'the client');
  const shell = Number((await tmux(socket, ['display', '-p', '-t', pane, '#{pane_pid}'])).trim());
  const keys = (...args) => tmux(socket, ['send-keys', '-t', pane, ...args]);
  const screen = async () => (await tmux(socket, ['capture-pane', '-p', '-t', pane])).trimEnd();
  await until(async () => /\$$/.test(await screen()), 'the prompt');
  return {socket, pane, shell, keys, screen};
}

test('tmux: the focused pane, a command seen running and its output, typing, and the Driver\'s text', {skip, timeout: 40_000}, async t => {
  const {socket, pane, shell, keys, screen} = await tmuxServer(t);
  const events = [];
  const watch = new PaneWatch({source: new TmuxPanes({socketPath: socket, pane}), emit: event => events.push(event)});
  watch.start();
  t.after(() => watch.stop());
  const id = `tmux:${pane}`;
  await until(() => events.some(event => event.kind === 'focus' && event.pane === id && event.target === 'terminal'), 'the focus');
  await sleep(1000); // read at its prompt

  await keys('-l', 'sleep 1; echo tmux said hi');
  await until(() => events.some(event => event.kind === 'typing' && event.pane === id), 'typing');
  await keys('Enter');
  await until(async () => (await foregroundCommand(shell)) === 'sleep 1', 'sleep in the foreground');
  assert.equal(await foregroundCommand(shell, {proc: false}), 'sleep 1', 'ps says the same as /proc');
  const ended = await until(() => events.find(event => event.kind === 'command_end'), 'the command\'s end');
  assert.deepEqual(ended, {kind: 'command_end', pane: id, exit: null, cmd: 'sleep 1; echo tmux said hi', output: 'tmux said hi'});
  assert.equal(await foregroundCommand(shell), null, 'at the prompt again');

  const typing = events.filter(event => event.kind === 'typing').length;
  await watch.type(id, 'echo typed by pair');
  await until(async () => /\$ echo typed by pair$/.test(await screen()), 'the text at the prompt');
  await sleep(1500);
  assert.equal(events.filter(event => event.kind === 'typing').length, typing, 'the Driver\'s text is not the user typing');
  assert.doesNotMatch(await screen(), /^typed by pair$/m, 'Enter stays with the user');
  await assert.rejects(watch.type(id, 'make\r'), /one line of plain text/);
  assert.deepEqual(watch.terminals(), [id]);

  // A shell hook's command names its tmux pane by its shell's pid.
  assert.equal(await watch.paneOf({shell, pane: null}), id);
});

test('tmux pane and Neovim terminals as one source: a Neovim terminal you are in has the focus only while tmux shows that Neovim', async () => {
  let tmuxFocus = 'tmux:%0';
  const tmuxSource = {
    name: 'tmux', owns: pane => pane.startsWith('tmux:'), start() {}, stop() {},
    list: async () => ['tmux:%0', 'tmux:%1'].map(pane => ({pane, focused: pane === tmuxFocus, scrolled: false, weight: 1})),
    paneOfShell: pid => (pid === 11 ? 'tmux:%1' : null),
    commandOf: async pane => (pane === 'tmux:%0' ? 'nvim a.js' : null),
  };
  let current = null;
  const editors = [{pid: 7, focused: null, pane: 'tmux:%0'}];
  const ask = async (editor, message) => (message.type === 'terminals' ? {terminals: [{pane: 'nvim:7:3', pid: 12}], current, scrolled: false} : null);
  const logged = [];
  const panes = new Panes([tmuxSource, new NvimPanes({editors: () => editors, ask, foreground: async pid => (pid === 12 ? 'make' : null)})], {log: line => logged.push(line)});
  const focused = async () => (await panes.list()).filter(pane => pane.focused).map(pane => pane.pane);

  assert.deepEqual(await focused(), ['tmux:%0'], 'in Neovim, not in a terminal of it: tmux\'s pane, which runs Neovim');
  current = 'nvim:7:3';
  assert.deepEqual(await focused(), ['nvim:7:3']);
  // To another tmux pane, with tmux's focus-events off: Neovim never hears it lost the focus, tmux says where you are.
  tmuxFocus = 'tmux:%1';
  assert.deepEqual(await focused(), ['tmux:%1']);
  tmuxFocus = 'tmux:%0';
  editors[0].focused = false; // Neovim lost the terminal's focus (focus-events on)
  assert.deepEqual(await focused(), ['tmux:%0']);
  assert.equal(await panes.commandOf('nvim:7:3'), 'make');
  assert.equal(await panes.commandOf('nvim:7'), 'nvim', 'a Neovim is an editor');
  assert.equal(await panes.commandOf('tmux:%0'), 'nvim a.js');
  assert.equal(panes.paneOfShell(12), 'nvim:7:3');
  assert.equal(panes.paneOfShell(11), 'tmux:%1');
  assert.equal(panes.paneOfShell(13), null);

  // No client on the tmux session: the Neovim's own focus stands.
  tmuxFocus = null;
  editors[0].focused = null;
  assert.deepEqual(await focused(), ['nvim:7:3']);

  // tmux gone: Neovim's terminals are still watched, and one line says so, not one per look; one when it is back.
  const list = tmuxSource.list;
  tmuxSource.list = async () => { throw new Error('tmux list-panes: no server running'); };
  assert.deepEqual(await focused(), ['nvim:7:3']);
  await focused();
  tmuxSource.list = list;
  await focused();
  assert.deepEqual(logged, ['tmux: tmux list-panes: no server running', 'tmux answers again']);
  current = null;

  // A Neovim in no herdr or tmux pane, and no other source: Neovim itself has the focus while you are in it.
  const alone = [{pid: 7, focused: null, pane: null}];
  assert.deepEqual(await new Panes([new NvimPanes({editors: () => alone, ask})]).list().then(list => list.filter(pane => pane.focused).map(pane => pane.pane)), ['nvim:7']);
});

test('tmux: a pane that runs Neovim in place of a shell is an editor; the Neovim terminal loses the focus when you go to another pane', {skip: skip || (has('nvim') ? false : 'nvim not installed'), timeout: 40_000}, async t => {
  const {socket, pane: shellPane, keys} = await tmuxServer(t);
  const editorPane = (await tmux(socket, ['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', shellPane, 'nvim --clean -n -i NONE'])).trim();
  const nvimPid = Number((await tmux(socket, ['display', '-p', '-t', editorPane, '#{pane_pid}'])).trim());
  await until(async () => /nvim/.test(await processCommand(nvimPid)), 'Neovim in the pane');
  // The Neovim as the daemon knows it: its tmux pane, a :terminal of it you are in, and no word about focus.
  const editors = [{pid: 7, focused: null, pane: `tmux:${editorPane}`}];
  const ask = async (editor, message) => (message.type === 'terminals' ? {terminals: [{pane: 'nvim:7:3', pid: 999999}], current: 'nvim:7:3', scrolled: false} : null);
  const events = [];
  const tmuxPanes = new TmuxPanes({socketPath: socket, pane: shellPane});
  const watch = new PaneWatch({source: new Panes([tmuxPanes, new NvimPanes({editors: () => editors, ask})]), emit: event => events.push(event)});
  const focus = () => events.filter(event => event.kind === 'focus').at(-1);

  await tmux(socket, ['select-pane', '-t', editorPane]);
  watch.start();
  t.after(() => watch.stop());
  await until(() => focus()?.pane === 'nvim:7:3', 'the focus in the Neovim terminal you are in');
  assert.equal(await tmuxPanes.commandOf(`tmux:${editorPane}`), 'nvim --clean -n -i NONE');
  assert.ok(!watch.terminals().includes(`tmux:${editorPane}`), 'the Neovim pane is no terminal to type into');
  assert.ok(watch.terminals().includes(`tmux:${shellPane}`));

  await tmux(socket, ['select-pane', '-t', shellPane]);
  await until(() => focus()?.pane === `tmux:${shellPane}` && focus().target === 'terminal', 'the focus in the tmux pane you went to');
  await sleep(1000); // read at its prompt
  await keys('-l', 'echo seen in the tmux pane');
  await until(() => events.some(event => event.kind === 'typing' && event.pane === `tmux:${shellPane}`), 'typing there');
  await keys('Enter');
  await until(() => events.some(event => event.kind === 'command_end' && event.cmd === 'echo seen in the tmux pane' && event.output === 'seen in the tmux pane'), 'the command there');

  await tmux(socket, ['select-pane', '-t', editorPane]);
  await until(() => focus()?.pane === 'nvim:7:3', 'the focus back in the Neovim terminal');
  editors[0].pane = null;
  await tmux(socket, ['select-pane', '-t', shellPane]);
  watch.refresh();
  await sleep(1500);
  assert.equal(focus().pane, 'nvim:7:3', 'a Neovim in no tmux pane keeps its own focus');
});

test('the tmux server and pane come from $TMUX and $TMUX_PANE', () => {
  assert.deepEqual(tmuxOf({TMUX: '/tmp/tmux-1000/default,123,0', TMUX_PANE: '%4'}), {socket: '/tmp/tmux-1000/default', pane: '%4'});
  assert.equal(tmuxOf({TMUX_PANE: '%4'}), null);
});

test('the daemon watches the tmux session the chat runs in, and a shell hook\'s command there comes with its output', {skip, timeout: 40_000}, async t => {
  const {socket, pane: user, shell, keys, screen} = await tmuxServer(t);
  const chatPane = (await tmux(socket, ['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', user, 'sleep 600'])).trim();
  const project = realpathSync(scratch('pair-project-'));
  const dataDir = socketDir('pair-data-');
  const config = parseConfig({
    dataDir, socket: join(dataDir, 'pair.sock'), agents: false, board: null, scoutPane: {sandbox: false},
    models: {watcher: {api: 'openai', baseUrl: 'http://unused', model: 'w'}, partner: {api: 'openai', baseUrl: 'http://unused', model: 'p'}},
  });
  const watcher = fauxProvider({provider: 'faux-watcher'});
  const partner = fauxProvider({provider: 'faux-partner', models: [{id: 'p'}]});
  const models = createModels();
  models.setProvider(watcher.provider);
  models.setProvider(partner.provider);
  watcher.setResponses(Array.from({length: 20}, () => fauxAssistantMessage([fauxText('0')]))); // no remarks
  const daemon = await startDaemon(config, {pairModels: {models, watcher: watcher.getModel(), partner: partner.getModel()}, probe: async () => ({ok: true}), log: () => {}});
  const chat = client(config.socket, {type: 'hello', role: 'chat', cwd: project, herdr: null, tmux: {socket, pane: chatPane}});
  t.after(async () => { chat.close(); await daemon.close(); });
  await chat.next(message => message.type === 'welcome');
  const status = () => new Promise(resolve => {
    const asking = client(config.socket, {type: 'status'});
    asking.next(message => message.type === 'status').then(reply => { asking.close(); resolve(reply); });
  });
  assert.equal((await status()).sessions[0].tmux, true);

  await keys('-l', 'echo out of the hooked shell');
  await keys('Enter');
  await until(async () => /^out of the hooked shell$/m.test(await screen()), 'the output');
  // What the hook sends: the shell's pid names the pane, though TMUX_PANE is not the user's (a Neovim's :terminal inherits it).
  const hook = client(config.socket, {type: 'command', cwd: project, pane: null, tmux: chatPane, shell, cmd: 'echo out of the hooked shell', exit: 4});
  t.after(() => hook.close());
  const card = async () => {
    const from = chat.received.length;
    chat.send({type: 'context'});
    return JSON.stringify(await until(() => chat.received.slice(from).find(message => message.type === 'context'), 'the card'));
  };
  await until(async () => /`echo out of the hooked shell` failed \(exit 4\): out of the hooked shell/.test(await card()), 'the command with its output');
});
