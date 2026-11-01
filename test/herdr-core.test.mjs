// Pair on herdr-core (the newer herdr, `hc`) and the Herdr window, against fakes of both (fake-core.mjs): which herdr
// the environment is in, the user's terminals and focus, Pair's own terminal, the agents, the chat's terminal, doctor.
import assert from 'node:assert/strict';
import {mkdirSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {AgentBoard} from '../src/agents.mjs';
import {herdrCheck} from '../src/doctor.mjs';
import {coreAgents, coreCommand, CorePaneHost, CorePanes, HerdrApp, herdrOf, openCoreChat} from '../src/herdr-core.mjs';
import {PaneWatch} from '../src/pane-watch.mjs';
import {ScoutPane} from '../src/scout-pane.mjs';
import {fakeApp, fakeCore, SPACE_ID, TAB_ID} from './fake-core.mjs';
import {scratch} from './temp.mjs';

function tempDir(t, prefix) {
  const dir = scratch(prefix);
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

async function until(check, what, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A fake core and a fake Herdr window in a folder of the test's own. */
async function setUp(t, appState = {}) {
  const dir = tempDir(t, 'pair-core-');
  const socketPath = join(dir, 'core.sock');
  const core = await fakeCore(socketPath, {commands: {'npm test': {output: 'ok 1 - adds', exit: 0}}});
  mkdirSync(join(dir, 'app'));
  const app = fakeApp(join(dir, 'app'), appState);
  t.after(() => core.close());
  return {dir, socketPath, core, app, herdrApp: new HerdrApp({command: app.command})};
}

test('herdrOf: herdr by HERDR_SOCKET_PATH, herdr-core by HC_SOCKET and HC_TERMINAL_ID, none without them', () => {
  assert.deepEqual(herdrOf({HERDR_SOCKET_PATH: '/run/herdr.sock', HERDR_WORKSPACE_ID: 'w1', HERDR_PANE_ID: 'w1:p1'}), {kind: 'herdr', socket: '/run/herdr.sock', workspace: 'w1', pane: 'w1:p1'});
  assert.deepEqual(herdrOf({HC_SOCKET: '/run/hc/default.sock', HC_TERMINAL_ID: 't1q', HC_SESSION: 'default'}), {kind: 'core', socket: '/run/hc/default.sock', pane: 't1q', session: 'default', appHome: null});
  assert.equal(herdrOf({HC_TERMINAL_SOCKET: '/run/hc/s.sock', HC_TERMINAL_ID: 't6f'}).socket, '/run/hc/s.sock', 'the terminal socket when HC_SOCKET is not set');
  assert.equal(herdrOf({HERDR_SOCKET_PATH: '/run/herdr.sock', HC_SOCKET: '/run/hc.sock', HC_TERMINAL_ID: 't1'}).kind, 'herdr', 'a herdr started in a core terminal has its panes inside it');
  assert.equal(herdrOf({HC_SOCKET: '/run/hc.sock'}), null, 'no terminal of its own: hc used from outside');
  assert.equal(herdrOf({HERDR_SOCKET_PATH: '', HC_SOCKET: '', HC_TERMINAL_ID: ''}), null, 'emptied, as in Pair\'s :terminal buffers');
  assert.equal(herdrOf({}), null);
});

test('coreCommand: null with the terminal\'s own program in front, else what runs', () => {
  assert.equal(coreCommand({pid: 10, foreground: {pid: 10, name: 'bash', argv: ['/usr/bin/bash']}}), null);
  assert.equal(coreCommand({pid: 10, foreground: {pid: 11, name: 'node', argv: ['node', 'test.js']}}), 'node test.js');
  assert.equal(coreCommand({pid: 10, foreground: null}), null, 'finished');
});

test('the user\'s terminals are those of the chat\'s space; the focus is the window\'s, and a command\'s output is read', async t => {
  const {socketPath, core, app, herdrApp} = await setUp(t);
  const events = [];
  const watch = new PaneWatch({source: new CorePanes({socketPath, chatPane: 't2', app: herdrApp, focusMs: 100}), chatPane: 't2', emit: event => events.push(event)});
  watch.start();
  t.after(() => watch.stop());
  const of = kind => events.filter(event => event.kind === kind);
  const focus = () => of('focus').at(-1);
  await until(() => focus()?.pane === 't1', 'the window\'s focus');
  assert.deepEqual(focus(), {kind: 'focus', target: 'terminal', pane: 't1', scrolled: false});
  assert.deepEqual([...watch.panes.keys()].sort(), ['t1'], 'not the chat, nor a terminal of another space or of no window');
  const seen = of('focus').length;
  app.set({focused: 'p2'});
  await until(() => focus().target === 'chat', 'focus on the chat');
  app.set({space: 'sp2'});
  await until(() => focus().target === 'elsewhere', 'another space shown');
  assert.deepEqual(of('focus').slice(seen).map(({target, pane}) => [target, pane]), [['chat', 't2'], ['elsewhere', null]]);
  app.set({space: SPACE_ID, focused: 'p1'});
  await until(() => focus().pane === 't1', 'focus back');
  const user = core.terminals.get('t1');
  user.lines = ['$ npm test'];
  await pause(600);
  core.run('t1', ['node', '/usr/bin/npm', 'test']);
  await pause(700);
  user.lines.push('> p@1.0.0 test', 'not ok 1 - adds', '$ ');
  core.done('t1');
  await until(() => of('command_end').length === 1, 'the end of npm test');
  assert.deepEqual(of('command_end')[0], {kind: 'command_end', pane: 't1', cmd: 'node /usr/bin/npm test', exit: null, output: '> p@1.0.0 test\nnot ok 1 - adds'});
  // The Driver's type: herdr-core types only with Enter, so it is refused, and nothing is typed.
  await assert.rejects(watch.type('t1', 'npm test'), /cannot type into its terminals/);
  assert.deepEqual(core.sent, []);
  assert.ok(core.subscribers.size >= 1, 'terminals coming and going come pushed');
});

test('a terminal started later in the space is watched once the core says so', async t => {
  const {socketPath, core, herdrApp} = await setUp(t);
  const watch = new PaneWatch({source: new CorePanes({socketPath, chatPane: 't2', app: herdrApp, focusMs: 100}), chatPane: 't2', emit: () => {}});
  watch.start();
  t.after(() => watch.stop());
  await until(() => watch.panes.has('t1'), 'the first look');
  const {address} = await (await import('../src/herdr-core.mjs')).coreRequest(socketPath, 'terminal.run', {argv: ['/usr/bin/bash'], labels: {'herdr.space': SPACE_ID, 'herdr.tab': TAB_ID}});
  await until(() => watch.panes.has(address), 'the new terminal');
  assert.ok(core.calls.includes('terminal.list'));
});

test('without a window showing the chat, no terminal is the user\'s and nothing has focus', async t => {
  const {socketPath, core, herdrApp} = await setUp(t);
  core.terminals.get('t2').labels = {};
  const events = [];
  const watch = new PaneWatch({source: new CorePanes({socketPath, chatPane: 't2', app: herdrApp, focusMs: 100}), chatPane: 't2', emit: event => events.push(event)});
  watch.start();
  t.after(() => watch.stop());
  await until(() => events.length === 1, 'a look');
  assert.deepEqual(events, [{kind: 'focus', target: 'elsewhere', pane: null, scrolled: false}]);
  assert.equal(watch.panes.size, 0);
});

test('Pair\'s own terminal: started beside the chat, its commands pasted with Enter, found again after a restart', async t => {
  const {dir, socketPath, core} = await setUp(t);
  const root = join(dir, 'shop');
  mkdirSync(root);
  const pane = () => new ScoutPane({host: new CorePaneHost({socketPath, besidePane: 't2', root}), cwd: root, runsDir: join(dir, 'panes'), setup: {sandbox: false}});
  const scout = pane();
  const result = await scout.run('npm test', {timeoutMs: 3000});
  assert.deepEqual({exit: result.exit, output: result.output.trim()}, {exit: 0, output: 'ok 1 - adds'});
  const [opened] = core.started;
  assert.deepEqual(opened.labels, {'herdr.space': SPACE_ID, 'herdr.tab': TAB_ID, 'pair.scout': root}, 'in the chat\'s space and tab, named for its project');
  assert.equal(opened.no_parent, true, 'it outlives the chat');
  assert.match(opened.line, /^exec env /, 'its shell is the terminal\'s program');
  assert.deepEqual(core.sent, [[scout.paneId, 'npm test']]);
  assert.deepEqual(core.keys, [[scout.paneId, ['ctrl+u']]], 'Ctrl-U first, as in herdr');
  const again = pane();
  await again.run('npm test', {timeoutMs: 3000});
  assert.equal(again.paneId, scout.paneId, 'a restarted daemon finds it by its label');
  assert.equal(core.started.length, 1);
  await again.close();
  assert.equal(core.terminals.get(scout.paneId).state, 'finished');
});

test('herdr-core\'s agents: the terminals that say what they do, focused through the Herdr window', async t => {
  const {socketPath, core, app} = await setUp(t);
  core.terminals.get('t1').status = {state: 'blocked', app: 'pi', msg: 'May I run npm test?'};
  assert.deepEqual((await coreAgents(socketPath)).map(agent => [agent.pane_id, agent.agent, agent.agent_status, agent.terminal_title_stripped]), [
    ['t1', 'pi', 'blocked', 'May I run npm test?'], ['t4', 'claude-code', 'working', 'Reading src/a.js'],
  ]);
  const board = new AgentBoard({board: null, pollMs: 60_000, appCommand: app.command});
  board.useHerdr({kind: 'core', socket: socketPath});
  await board.look();
  assert.deepEqual(board.list().map(item => [item.key, item.status]), [['agent:t1', 'needs'], ['agent:t4', 'working']]);
  core.terminals.get('t4').status = {state: 'error', app: 'claude-code'};
  await board.look();
  assert.equal(board.list().find(item => item.key === 'agent:t4').status, 'failed');
  assert.equal(await board.focus('agent:t4'), true);
  assert.deepEqual(app.calls().at(-1), ['do', 'agent.focus', '--terminal', 't4']);
});

test('pair in a herdr-core terminal: the chat starts beside it in the window, or here without one', async t => {
  const {socketPath, core} = await setUp(t);
  const herdr = {kind: 'core', socket: socketPath, pane: 't1'};
  assert.equal(await openCoreChat(herdr, {argv: ['node', 'pair.mjs', 'chat'], cwd: '/src/shop', env: {PAIR_SOCKET: '/run/pair.sock'}}), true);
  assert.deepEqual(core.started.at(-1), {argv: ['node', 'pair.mjs', 'chat'], cwd: '/src/shop', env: {PAIR_SOCKET: '/run/pair.sock'}, labels: {'herdr.space': SPACE_ID, 'herdr.tab': TAB_ID}, no_parent: true, no_notify: true});
  assert.equal(await openCoreChat({...herdr, pane: 't4'}, {argv: ['x'], cwd: '/'}), false, 't4 is in no window');
  assert.equal(core.started.length, 1);
});

test('pair doctor names the herdr it is in: herdr-core with or without the window, herdr, or none', async t => {
  const {socketPath, app, herdrApp} = await setUp(t);
  const env = {HC_SOCKET: socketPath, HC_TERMINAL_ID: 't1', PATH: ''};
  const shown = await herdrCheck(env, {app: herdrApp});
  assert.equal(shown.level, 'ok');
  assert.match(shown.text, /^herdr-core 0\.1\.16 \(terminals, session default\) answers in \d+ ms, 4 live terminals; the Herdr window shows terminal t1, and `herdr-app status` answers for its focus/);
  app.set({window: false});
  assert.match((await herdrCheck(env, {app: herdrApp})).text, /its focus cannot be read/);
  const alone = await herdrCheck({...env, HC_TERMINAL_ID: 't4'}, {app: herdrApp});
  assert.equal(alone.level, 'warn');
  assert.match(alone.text, /no Herdr window shows terminal t4/);
  assert.equal((await herdrCheck({...env, HC_SOCKET: '/nowhere.sock'})).level, 'fail');
  assert.match((await herdrCheck({PATH: ''})).text, /^not installed/);
});

test('a core that does not answer at first is tried again, and its terminals are watched once it does', async t => {
  const {socketPath, core, herdrApp} = await setUp(t);
  const source = new CorePanes({socketPath: `${socketPath}.not-yet`, chatPane: 't2', app: herdrApp, focusMs: 100});
  const failures = [];
  source.start(() => {}, () => {}, error => failures.push(error));
  await until(() => failures.length === 1, 'the failed start');
  source.socketPath = socketPath; // the core is back, and nothing else asks for a look
  await until(() => core.subscribers.size === 1, 'the event stream, started again by itself');
  assert.deepEqual((await source.list()).map(each => each.pane).sort(), ['t1', 't2']);
  source.stop();
});
