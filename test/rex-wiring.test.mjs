// Rex integration seams in Pair's daemon, CLI, shell hook and doctor, tested without the Rex backend module.
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {chmodSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {createModels, fauxProvider} from '@earendil-works/pi-ai';
import {openChatPane, reportPane} from '../bin/pair.mjs';
import {linkDaemon} from '../src/chat.mjs';
import {parseConfig} from '../src/config.mjs';
import {startDaemon} from '../src/daemon.mjs';
import {doctor} from '../src/doctor.mjs';
import {readMessages, requestDaemon} from '../src/protocol.mjs';
import {shellHook} from '../src/shell-hook.mjs';
import {client} from './daemon-client.mjs';
import {scratch} from './temp.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const hasNvim = (() => { try { execFileSync('nvim', ['--version'], {stdio: 'ignore'}); return true; } catch { return false; } })();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, what, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await pause(20);
  }
}

function testConfig(dataDir) {
  const entry = {api: 'openai', baseUrl: 'http://unused', model: 'm'};
  return parseConfig({dataDir, socket: join(dataDir, 'pair.sock'), agents: false, plan: false, models: {watcher: entry, partner: entry}});
}

function scriptedModels() {
  const provider = fauxProvider();
  const models = createModels();
  models.setProvider(provider.provider);
  return {pairModels: {models, watcher: provider.getModel(), partner: provider.getModel()}};
}

async function doctorRexLine(env, rexStatus) {
  const dir = scratch('pair-rex-doctor-');
  const config = testConfig(join(dir, 'state'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({
    dataDir: config.dataDir, socket: config.socket, agents: false, plan: false,
    models: {watcher: config.models.watcher, partner: config.models.partner},
  }));
  for await (const check of doctor({
    path, env, manager: null, service: async () => null, nvimPlugin: async () => 'no-nvim',
    auth: join(dir, 'missing-auth.json'), rexStatus,
  })) {
    if (check.name === 'rex') return check;
  }
  return null;
}

/** Fake Rex classes for the daemon's `rexWith`, and the options they were built with. */
function fakeRex() {
  const created = {sources: [], hosts: []};
  const seen = {stopped: [], hostCalls: []}; // the options of each source stopped; the host methods Pair used
  class FakeRexPanes {
    constructor(options) { this.name = 'rex'; this.options = options; created.sources.push(options); }
    owns(id) { return id.startsWith('rex:'); }
    start() {}
    stop() { seen.stopped.push(this.options); }
    list() { return Promise.resolve([]); }
    commandOf() { return null; }
    read() { return Promise.resolve(''); }
    send() {}
    paneOfShell() { return null; }
    canType() { return true; }
  }
  class FakeRexPaneHost {
    constructor(options) { Object.assign(this, options); this.key = `rex:${options.session}`; this.hidden = [options.socketPath]; created.hosts.push(options); }
    has() { return Promise.resolve(false); }
    find() { seen.hostCalls.push('find'); return Promise.resolve(null); }
    open() { seen.hostCalls.push('open'); throw new Error('unused'); }
    send() {}
    close() {}
  }
  return {created, seen, rexWith: {rexPane: block => `rex:${block}`, RexPanes: FakeRexPanes, RexPaneHost: FakeRexPaneHost}};
}

test('chat hello forwards the Rex descriptor from its environment', async t => {
  const socketPath = join(scratch('pair-rex-hello-'), 'hello.sock');
  let hello = null;
  const server = createServer(socket => readMessages(socket, message => { hello = message; }));
  await new Promise((resolve, reject) => server.once('error', reject).listen(socketPath, resolve));
  const link = linkDaemon(socketPath, {failed: error => assert.fail(error.message), lost: () => {}, message: () => {}}, {
    cwd: '/project', env: {REX_SERVER: 'unix:///run/rex%20dir/rex.sock', REX_SESSION: 'session:1', REX_BLOCK: 'block:2'},
  });
  t.after(async () => {
    link.close();
    await new Promise(resolve => server.close(resolve));
  });
  await until(() => hello, 'the chat hello');
  assert.deepEqual(hello.rex, {server: '/run/rex dir/rex.sock', session: 'session:1', block: 'block:2'});
});

test('Neovim hello names its Rex block, and nested chat clears Rex from its environment', {skip: hasNvim ? false : 'nvim not installed', timeout: 15_000}, async t => {
  const dir = scratch('pair-rex-nvim-');
  const project = scratch('pair-rex-project-');
  const socketPath = join(dir, 'pair.sock');
  const rexSocket = join(dir, 'rex socket.sock');
  const capture = join(dir, 'chat-env.json');
  let hello = null;
  const server = createServer(socket => readMessages(socket, message => { if (message.type === 'hello' && message.role === 'editor') hello = message; }));
  await new Promise((resolve, reject) => server.once('error', reject).listen(socketPath, resolve));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(HERDR_|HC_|REX_|TMUX)/.test(name)));
  Object.assign(env, {TMPDIR: dir, XDG_STATE_HOME: dir, PAIR_REPO: REPO, PAIR_SOCKET: socketPath, PAIR_CAPTURE: capture, REX_SERVER: `unix://${encodeURIComponent(rexSocket).replaceAll('%2F', '/')}`, REX_SESSION: 'session:1', REX_BLOCK: 'block:2'});
  const nvim = spawn('nvim', ['--headless', '--clean',
    '-c', 'lua vim.opt.rtp:append(vim.env.PAIR_REPO)',
    '-c', "lua require('pair').setup({socket=vim.env.PAIR_SOCKET, auto_connect=false})",
    '-c', "lua require('pair').connect()",
    '-c', 'lua vim.wait(500)',
    '-c', "lua vim.fn.jobstart = function(_, opts) vim.fn.writefile({vim.json.encode(opts.env)}, vim.env.PAIR_CAPTURE); return 1 end; require('pair.pane').chat('/fake/pair.sock')",
    '-c', 'qa!'], {cwd: project, env, stdio: ['ignore', 'pipe', 'pipe']});
  let output = '';
  nvim.stdout.setEncoding('utf8').on('data', text => { output += text; });
  nvim.stderr.setEncoding('utf8').on('data', text => { output += text; });
  const exited = new Promise(resolve => nvim.once('exit', (code, signal) => resolve({code, signal})));
  t.after(async () => {
    if (nvim.exitCode === null && nvim.signalCode === null) nvim.kill('SIGTERM');
    await exited;
    await new Promise(resolve => server.close(resolve));
  });
  try {
    await until(() => hello, 'the editor hello');
    await until(() => existsSync(capture), 'the nested chat environment');
  } catch (error) {
    throw new Error(`${error.message}${output ? `; nvim: ${output}` : ''}`);
  }
  const exit = await exited;
  assert.deepEqual(exit, {code: 0, signal: null});
  assert.deepEqual(hello.rex, {server: env.REX_SERVER, session: 'session:1', block: 'block:2'}); // raw: Lua has no decoder
  assert.equal(hello.pane, 'rex:block:2');
  const chatEnv = JSON.parse(readFileSync(capture, 'utf8'));
  assert.equal(chatEnv.PAIR_SOCKET, '/fake/pair.sock');
  assert.deepEqual([chatEnv.REX_SERVER, chatEnv.REX_SESSION, chatEnv.REX_BLOCK], ['', '', '']);
});

test('shell pane identity falls back to namespaced Rex', () => {
  assert.equal(reportPane({REX_BLOCK: 'block:abc'}), 'rex:block:abc');
  assert.equal(reportPane({HC_TERMINAL_ID: 'core:1', REX_BLOCK: 'block:abc'}), 'core:1');
  assert.equal(reportPane({HERDR_PANE_ID: 'w:p1', HC_TERMINAL_ID: 'core:1', REX_BLOCK: 'block:abc'}), 'w:p1');
  assert.equal(reportPane({}), null);
});

test('the zsh hook names a Rex terminal rex:<block>, and that id passes the hook\'s own validation', {skip: (() => { try { execFileSync('zsh', ['-fc', 'true']); return false; } catch { return 'zsh not installed'; } })()}, () => {
  const hook = shellHook('zsh', '/path/to/pair', {socket: '/tmp/pair.sock'});
  const line = hook.split('\n').find(text => text.includes('local id=') && text.includes('pane='));
  assert.ok(line, 'the hook sets the pane it reports');
  const env = {PATH: process.env.PATH, REX_BLOCK: 'block:01a1-x_y.z'};
  const run = script => execFileSync('zsh', ['-fc', script], {env, encoding: 'utf8'});
  assert.equal(run(`${line}\nprint -r -- $pane`).trim(), reportPane(env));
  assert.equal(run(`${line}\nprint -r -- $pane`).trim(), 'rex:block:01a1-x_y.z');
  assert.equal(run(`${line}\n[[ $pane =~ $id ]] && print valid`).trim(), 'valid');
});

test('pair with no arguments opens Rex chat with cwd, argv and Pair overrides', async () => {
  const calls = [];
  const config = {socket: '/run/pair.sock', dataDir: '/state/pair'};
  const env = {
    REX_SERVER: 'unix:///run/rex.sock', REX_SESSION: 'session:1', REX_BLOCK: 'block:2',
    PAIR_CONFIG: '/config/pair.json', PAIR_SOCKET: '/run/pair.sock', PAIR_AUTH: '/config/auth.json',
  };
  await openChatPane(config, {
    ensure: async actual => assert.equal(actual, config), env, cwd: '/project',
    launchRex: async (rex, options) => { calls.push({rex, options}); return true; },
    run: () => assert.fail('chat should open in Rex, not in place'),
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].rex, {server: '/run/rex.sock', session: 'session:1', block: 'block:2'});
  assert.deepEqual(calls[0].options.argv, [process.execPath, calls[0].options.argv[1], 'chat']);
  assert.match(calls[0].options.argv[1], /\/bin\/pair\.mjs$/);
  assert.deepEqual(calls[0].options.cwd, '/project');
  assert.deepEqual(calls[0].options.env, {PAIR_CONFIG: '/config/pair.json', PAIR_SOCKET: '/run/pair.sock', PAIR_AUTH: '/config/auth.json'});
});

test('doctor yields Rex success, PATH-only warning, no line without Rex, and failure', async t => {
  const dir = scratch('pair-rex-path-');
  writeFileSync(join(dir, 'rex'), '');
  chmodSync(join(dir, 'rex'), 0o755);
  const env = {REX_SERVER: 'unix:///run/rex.sock', REX_SESSION: 'session:1', REX_BLOCK: 'block:2', PATH: ''};
  const success = await doctorRexLine(env, async rex => {
    assert.deepEqual(rex, {server: '/run/rex.sock', session: 'session:1', block: 'block:2'});
    return {version: '1.2.3', label: 'work', terminals: 2, ms: 4};
  });
  assert.deepEqual(success, {level: 'ok', name: 'rex', text: 'Rex 1.2.3 (session work) answers in 4 ms, 2 terminals in this session; no scroll position or keystrokes: the shell hook gives command boundaries'});

  const warning = await doctorRexLine({PATH: dir}, async () => assert.fail('status is not queried outside Rex'));
  assert.deepEqual(warning, {level: 'warn', name: 'rex', text: 'not checked here: run `pair doctor` in a Rex terminal'});
  assert.equal(await doctorRexLine({PATH: ''}, async () => assert.fail('status is not queried outside Rex')), null);
  const remote = await doctorRexLine({...env, REX_SERVER: 'tcp://host:1'}, async () => assert.fail('a remote server is not queried'));
  assert.deepEqual(remote, {level: 'warn', name: 'rex', text: 'the Rex server is not a local socket (REX_SERVER=tcp://host:1): not checked'});
  const failed = await doctorRexLine(env, async () => { throw new Error('socket refused'); });
  assert.deepEqual(failed, {level: 'fail', name: 'rex', text: 'socket refused'});
});

test('Rex chat hello installs the Rex source and Scout host and reports Rex in daemon status', {timeout: 20_000}, async t => {
  const config = testConfig(scratch('pair-rex-daemon-'));
  const project = scratch('pair-rex-project-');
  const {created, rexWith} = fakeRex();
  const daemon = await startDaemon(config, {...scriptedModels(), probe: async () => ({ok: true}), log: () => {}, rexWith});
  const descriptor = {server: '/run/rex.sock', session: 'session:1', block: 'block:2'};
  const editor = client(config.socket, {type: 'hello', role: 'editor', cwd: project, pane: 'rex:block:nvim', rex: descriptor});
  const chat = client(config.socket, {type: 'hello', role: 'chat', cwd: project, rex: descriptor});
  t.after(async () => { editor.close(); chat.close(); await daemon.close(); });
  await chat.next(message => message.type === 'welcome');
  await until(() => created.hosts.length === 1 && created.sources.some(source => source.chatPane === 'rex:block:2'), 'Rex source and host');
  const status = await requestDaemon(config.socket, {type: 'status'});
  assert.equal(status.sessions[0].rex, true);
  assert.deepEqual(created.hosts, [{socketPath: descriptor.server, session: descriptor.session, besidePane: 'rex:block:2', root: project}]);
  assert.ok(created.sources.every(source => source.socketPath === descriptor.server && source.session === descriptor.session));
});

test('the daemon gives Rex only the decoded socket path, whichever hello names it first', {timeout: 20_000}, async t => {
  const config = testConfig(scratch('pair-rex-decode-'));
  const project = scratch('pair-rex-project-');
  const created = {sources: [], hosts: []};
  class FakeRexPanes {
    constructor(options) { this.name = 'rex'; created.sources.push(options); }
    owns(id) { return id.startsWith('rex:'); }
    start() {}
    stop() {}
    list() { return Promise.resolve([]); }
    commandOf() { return null; }
    read() { return Promise.resolve(''); }
    send() {}
    paneOfShell() { return null; }
    canType() { return true; }
  }
  class FakeRexPaneHost {
    constructor(options) { Object.assign(this, options); this.key = `rex:${options.session}`; this.hidden = [options.socketPath]; created.hosts.push(options); }
    has() { return Promise.resolve(false); }
    find() { return Promise.resolve(null); }
    open() { throw new Error('unused'); }
    send() {}
    close() {}
  }
  const daemon = await startDaemon(config, {
    ...scriptedModels(), probe: async () => ({ok: true}), log: () => {},
    rexWith: {rexPane: block => `rex:${block}`, RexPanes: FakeRexPanes, RexPaneHost: FakeRexPaneHost},
  });
  const path = '/run/rex dir/rex.sock';
  const fromPlugin = {server: 'unix:///run/rex%20dir/rex.sock', session: 'session:1', block: 'block:1'};
  const editor = client(config.socket, {type: 'hello', role: 'editor', cwd: project, pane: 'rex:block:1', rex: fromPlugin});
  const chat = client(config.socket, {type: 'hello', role: 'chat', cwd: project, rex: {server: path, session: 'session:1', block: 'block:2'}});
  t.after(async () => { editor.close(); chat.close(); await daemon.close(); });
  await chat.next(message => message.type === 'welcome');
  await until(() => created.hosts.length === 1 && created.sources.some(source => source.chatPane === 'rex:block:2'), 'Rex source and host');
  assert.ok(created.sources.length >= 2);
  assert.deepEqual([...created.sources, ...created.hosts].map(built => built.socketPath), Array(created.sources.length + created.hosts.length).fill(path));
});

test('pair with no arguments runs the chat in place with the shell environment, in tmux and when Rex refuses', async () => {
  const config = {socket: '/run/pair.sock', dataDir: '/state/pair'};
  const tmux = {TMUX: '/tmp/tmux-1/default,1,0', TMUX_PANE: '%3', TERM: 'xterm-256color', NO_COLOR: '1', PAIR_SOCKET: '/run/pair.sock'};
  const rex = {REX_SERVER: 'unix:///run/rex.sock', REX_SESSION: 'session:1', REX_BLOCK: 'block:2', TERM: 'xterm-256color', NO_COLOR: '1'};
  for (const [env, launchRex] of [[tmux, async () => assert.fail('no Rex here')], [rex, async () => false]]) {
    const runs = [];
    await openChatPane(config, {ensure: async () => {}, env, cwd: '/project', launchRex, run: (socket, options) => { runs.push({socket, options}); }});
    assert.deepEqual(runs, [{socket: '/run/pair.sock', options: {dataDir: '/state/pair', cwd: '/project', env}}]);
  }
});

test('tmux inside Rex: the daemon builds no Rex source, whichever hello comes first', {timeout: 20_000}, async t => {
  const config = testConfig(scratch('pair-rex-tmux-'));
  const project = scratch('pair-rex-project-');
  const {created, rexWith} = fakeRex();
  const daemon = await startDaemon(config, {...scriptedModels(), probe: async () => ({ok: true}), log: () => {}, rexWith});
  const rex = {server: 'unix:///run/rex.sock', session: 'session:1', block: 'block:1'};
  const tmux = {socket: join(scratch('pair-rex-tmux-socket-'), 'none'), pane: '%1'};
  const editor = client(config.socket, {type: 'hello', role: 'editor', cwd: project, rex, tmux});
  const rexOnly = client(config.socket, {type: 'hello', role: 'editor', cwd: project, pane: 'rex:block:3', rex});
  const chat = client(config.socket, {type: 'hello', role: 'chat', cwd: project, rex: {...rex, server: '/run/rex.sock', block: 'block:2'}, tmux});
  t.after(async () => { editor.close(); rexOnly.close(); chat.close(); await daemon.close(); });
  await chat.next(message => message.type === 'welcome');
  const status = await requestDaemon(config.socket, {type: 'status'});
  assert.deepEqual([status.sessions[0].tmux, status.sessions[0].rex], [true, false]);
  assert.deepEqual(created, {sources: [], hosts: []});
});

test('Neovim in tmux inside Rex names no Rex pane: its pane is tmux\'s', {skip: hasNvim ? false : 'nvim not installed', timeout: 15_000}, async t => {
  const dir = scratch('pair-rex-nvim-tmux-');
  const project = scratch('pair-rex-project-');
  const socketPath = join(dir, 'pair.sock');
  let hello = null;
  const server = createServer(socket => readMessages(socket, message => { if (message.type === 'hello' && message.role === 'editor') hello = message; }));
  await new Promise((resolve, reject) => server.once('error', reject).listen(socketPath, resolve));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(HERDR_|HC_|REX_|TMUX)/.test(name)));
  Object.assign(env, {TMPDIR: dir, XDG_STATE_HOME: dir, PAIR_REPO: REPO, PAIR_SOCKET: socketPath, REX_SERVER: 'unix:///run/rex.sock', REX_SESSION: 'session:1', REX_BLOCK: 'block:2', TMUX: '/tmp/tmux-1/default,1,0', TMUX_PANE: '%3'});
  const nvim = spawn('nvim', ['--headless', '--clean',
    '-c', 'lua vim.opt.rtp:append(vim.env.PAIR_REPO)',
    '-c', "lua require('pair').setup({socket=vim.env.PAIR_SOCKET, auto_connect=false})",
    '-c', "lua require('pair').connect()",
    '-c', 'lua vim.wait(500)',
    '-c', 'qa!'], {cwd: project, env, stdio: 'ignore'});
  const exited = new Promise(resolve => nvim.once('exit', resolve));
  t.after(async () => {
    if (nvim.exitCode === null && nvim.signalCode === null) nvim.kill('SIGTERM');
    await exited;
    await new Promise(resolve => server.close(resolve));
  });
  await until(() => hello, 'the editor hello');
  assert.equal(hello.pane ?? null, null);
  assert.deepEqual(hello.tmux, {socket: '/tmp/tmux-1/default', pane: '%3'});
  assert.equal(hello.rex.block, 'block:2');
});

test('after the host of Scout swaps, the live pane watch knows the new Scout: its pane is Pair\'s, not the user\'s', {timeout: 30_000}, async t => {
  const dir = scratch('pair-rex-scout-swap-');
  const config = parseConfig({
    dataDir: dir, socket: join(dir, 'pair.sock'), agents: false, plan: false, board: null, scoutPane: {sandbox: false},
    models: {watcher: {api: 'openai', baseUrl: 'http://unused', model: 'm'}, partner: {api: 'openai', baseUrl: 'http://unused', model: 'm'}},
  });
  const project = scratch('pair-rex-project-');
  const {rexWith} = fakeRex();
  const daemon = await startDaemon(config, {...scriptedModels(), probe: async () => ({ok: true}), log: () => {}, rexWith});
  const rex = {server: '/run/rex.sock', session: 'session:1', block: 'block:chat'};
  const tmux = {socket: join(scratch('pair-rex-tmux-socket-'), 'none'), pane: '%2'};
  const editor = client(config.socket, {type: 'hello', role: 'editor', cwd: project});
  // A Neovim that opens Pair's pane as its buffer 7.
  const asked = [];
  const answering = setInterval(() => {
    for (const message of editor.received) {
      if (message.type !== 'pane' || asked.includes(message)) continue;
      asked.push(message);
      const result = {find: {buf: null}, open: {buf: 7}, close: {ok: true}}[message.action] ?? {error: 'no pane in a test'};
      editor.send({type: 'reply', id: message.id, result});
    }
  }, 20);
  const chats = [];
  t.after(async () => { clearInterval(answering); editor.close(); chats.forEach(chat => chat.close()); await daemon.close(); });
  const hello = async extra => {
    chats.push(client(config.socket, {type: 'hello', role: 'chat', cwd: project, ...extra}));
    await chats.at(-1).next(message => message.type === 'welcome');
  };
  await editor.next(message => message.type === 'welcome');
  await hello({tmux});
  await hello({rex});
  await hello({tmux});

  editor.send({type: 'role', role: 'scout'});
  await until(() => asked.some(message => message.action === 'open'), 'Scout opening its pane in Neovim');
  // Its shell has the user's hook too: a command ended in Pair's pane is not a command of the user's.
  const command = (pane, cmd) => client(config.socket, {type: 'command', cwd: project, pane, tmux: null, shell: null, cmd, exit: 0});
  const hooks = [command(7, 'echo from Scout'), command('%9', 'echo from the user')];
  t.after(() => hooks.forEach(hook => hook.close()));
  const chat = chats.at(-1);
  const card = async () => {
    const from = chat.received.length;
    chat.send({type: 'context'});
    return JSON.stringify(await chat.next(message => message.type === 'context' && chat.received.indexOf(message) >= from));
  };
  const end = Date.now() + 3000;
  let seen = await card();
  while (!seen.includes('echo from the user') && Date.now() < end) { await pause(50); seen = await card(); }
  assert.ok(seen.includes('echo from the user'), 'the user\'s command is in the context');
  assert.ok(!seen.includes('echo from Scout'), 'Scout\'s pane is not a terminal of the user');
});

test('a chat before any Neovim: Scout\'s pane, set when the editor comes, is no terminal of the user', {timeout: 30_000}, async t => {
  const dir = scratch('pair-rex-scout-first-');
  const config = parseConfig({
    dataDir: dir, socket: join(dir, 'pair.sock'), agents: false, plan: false, board: null, scoutPane: {sandbox: false},
    models: {watcher: {api: 'openai', baseUrl: 'http://unused', model: 'm'}, partner: {api: 'openai', baseUrl: 'http://unused', model: 'm'}},
  });
  const project = scratch('pair-rex-project-');
  const daemon = await startDaemon(config, {...scriptedModels(), probe: async () => ({ok: true}), log: () => {}});
  const chat = client(config.socket, {type: 'hello', role: 'chat', cwd: project});
  await chat.next(message => message.type === 'welcome');
  const editor = client(config.socket, {type: 'hello', role: 'editor', cwd: project});
  const asked = [];
  const answering = setInterval(() => {
    for (const message of editor.received) {
      if (message.type !== 'pane' || asked.includes(message)) continue;
      asked.push(message);
      const result = {find: {buf: null}, open: {buf: 7}, close: {ok: true}}[message.action] ?? {error: 'no pane in a test'};
      editor.send({type: 'reply', id: message.id, result});
    }
  }, 20);
  t.after(async () => { clearInterval(answering); editor.close(); chat.close(); await daemon.close(); });
  await editor.next(message => message.type === 'welcome');
  editor.send({type: 'role', role: 'scout'});
  await until(() => asked.some(message => message.action === 'open'), 'Scout opening its pane in Neovim');
  const command = (pane, cmd) => client(config.socket, {type: 'command', cwd: project, pane, tmux: null, shell: null, cmd, exit: 0});
  const hooks = [command(7, 'echo from Scout'), command('%9', 'echo from the user')];
  t.after(() => hooks.forEach(hook => hook.close()));
  const card = async () => {
    const from = chat.received.length;
    chat.send({type: 'context'});
    return JSON.stringify(await chat.next(message => message.type === 'context' && chat.received.indexOf(message) >= from));
  };
  const end = Date.now() + 3000;
  let seen = await card();
  while (!seen.includes('echo from the user') && Date.now() < end) { await pause(50); seen = await card(); }
  assert.ok(seen.includes('echo from the user'), 'the user\'s command is in the context');
  assert.ok(!seen.includes('echo from Scout'), 'Scout\'s pane is not a terminal of the user');
});

test('a herdr chat after a Rex chat takes over as the chat pane, and Rex is no source then', {timeout: 20_000}, async t => {
  const config = testConfig(scratch('pair-rex-herdr-'));
  const project = scratch('pair-rex-project-');
  const {created, seen, rexWith} = fakeRex();
  const logs = [];
  const daemon = await startDaemon(config, {...scriptedModels(), probe: async () => ({ok: true}), log: line => logs.push(line), rexWith});
  const rex = {server: '/run/rex.sock', session: 'session:1', block: 'block:2'};
  const herdr = {kind: 'herdr', socket: join(scratch('pair-rex-herdr-socket-'), 'none'), workspace: 'w1', pane: 'w1:p1'};
  const chats = [];
  t.after(async () => { chats.forEach(chat => chat.close()); await daemon.close(); });
  const hello = async extra => {
    chats.push(client(config.socket, {type: 'hello', role: 'chat', cwd: project, rex, ...extra}));
    await chats.at(-1).next(message => message.type === 'welcome');
  };
  await hello({});
  await until(() => created.sources.at(-1)?.chatPane === 'rex:block:2', 'the Rex chat as the chat pane');
  await hello({herdr});
  await until(() => logs.some(line => line.includes('watching herdr workspace')), 'herdr as the chat pane');
  assert.equal(created.sources.length, 1, 'no Rex source is built after herdr');
  assert.deepEqual(seen.stopped, [created.sources[0]], 'the Rex source it had is stopped');
  const status = (await requestDaemon(config.socket, {type: 'status'})).sessions[0];
  assert.deepEqual([status.herdr, status.rex], [true, false]);
  await hello({herdr});
  await pause(200);
  assert.equal(logs.filter(line => line.includes('watching herdr workspace')).length, 1);
  assert.equal(created.sources.length, 1);
});

test('herdr inside Rex: the daemon builds no Rex source, whichever hello comes first', {timeout: 20_000}, async t => {
  const config = testConfig(scratch('pair-rex-herdr-nested-'));
  const project = scratch('pair-rex-project-');
  const {created, rexWith} = fakeRex();
  const daemon = await startDaemon(config, {...scriptedModels(), probe: async () => ({ok: true}), log: () => {}, rexWith});
  const rex = {server: '/run/rex.sock', session: 'session:1', block: 'block:2'};
  const herdr = {kind: 'herdr', socket: join(scratch('pair-rex-herdr-socket-'), 'none'), workspace: 'w1', pane: 'w1:p1'};
  const chat = client(config.socket, {type: 'hello', role: 'chat', cwd: project, rex, herdr});
  t.after(async () => { chat.close(); await daemon.close(); });
  await chat.next(message => message.type === 'welcome');
  const status = (await requestDaemon(config.socket, {type: 'status'})).sessions[0];
  assert.deepEqual([status.herdr, status.rex], [true, false]);
  assert.deepEqual(created, {sources: [], hosts: []});
});

test('herdr beside Rex: a herdr-only chat after a Rex editor keeps Rex as a source, and a herdr inside Rex does not', {timeout: 20_000}, async t => {
  const rex = {server: '/run/rex.sock', session: 'session:1', block: 'block:2'};
  const herdr = {kind: 'herdr', socket: join(scratch('pair-rex-herdr-socket-'), 'none'), workspace: 'w1', pane: 'w1:p1'};
  const sources = async hellos => {
    const config = testConfig(scratch('pair-rex-herdr-beside-'));
    const project = scratch('pair-rex-project-');
    const {created, rexWith} = fakeRex();
    const logs = [];
    const daemon = await startDaemon(config, {...scriptedModels(), probe: async () => ({ok: true}), log: line => logs.push(line), rexWith});
    const clients = hellos.map(hello => client(config.socket, {type: 'hello', cwd: project, ...hello}));
    t.after(async () => { clients.forEach(one => one.close()); await daemon.close(); });
    for (const one of clients) await one.next(message => message.type === 'welcome');
    await until(() => logs.some(line => line.includes('watching herdr workspace')), 'herdr as the chat pane');
    const status = (await requestDaemon(config.socket, {type: 'status'})).sessions[0];
    return {created, herdr: status.herdr, rex: status.rex};
  };
  const beside = await sources([{role: 'editor', rex}, {role: 'chat', herdr}]);
  assert.deepEqual([beside.herdr, beside.rex], [true, true]);
  assert.equal(beside.created.sources.at(-1)?.socketPath, rex.server, 'the Rex editor\'s terminals are watched');
  assert.equal(beside.created.sources.at(-1)?.chatPane, null, 'the chat pane is herdr\'s');
  const inside = await sources([{role: 'editor', rex}, {role: 'chat', rex, herdr}]);
  assert.deepEqual([inside.herdr, inside.rex], [true, false]);
  assert.equal(inside.created.sources.length, 1, 'only the Rex source of the editor hello, stopped when the nested chat came');
});

test('herdr and Rex chats of one project: the Rex chat block is Pair\'s own pane, whichever chat came first', {timeout: 30_000}, async t => {
  const rex = {server: '/run/rex.sock', session: 'session:1', block: 'block:chat'};
  const herdr = {kind: 'herdr', socket: join(scratch('pair-rex-herdr-socket-'), 'none'), workspace: 'w1', pane: 'w1:p1'};
  for (const order of [[{rex}, {herdr}], [{herdr}, {rex}]]) {
    const config = testConfig(scratch('pair-rex-chats-'));
    const project = scratch('pair-rex-project-');
    const {created, rexWith} = fakeRex();
    const daemon = await startDaemon(config, {...scriptedModels(), probe: async () => ({ok: true}), log: () => {}, rexWith});
    const editor = client(config.socket, {type: 'hello', role: 'editor', cwd: project});
    const chats = [];
    t.after(async () => { editor.close(); chats.forEach(chat => chat.close()); await daemon.close(); });
    await editor.next(message => message.type === 'welcome');
    for (const extra of order) {
      chats.push(client(config.socket, {type: 'hello', role: 'chat', cwd: project, ...extra}));
      await chats.at(-1).next(message => message.type === 'welcome');
    }
    const name = JSON.stringify(order.map(one => Object.keys(one)[0]));
    await until(() => created.sources.length > 0, `a Rex source, ${name}`);
    const status = (await requestDaemon(config.socket, {type: 'status'})).sessions[0];
    assert.deepEqual([status.herdr, status.rex], [true, true], `herdr and Rex are sources, ${name}`);
    assert.equal(created.sources.at(-1).chatPane, 'rex:block:chat', `the Rex source leaves the chat block out, ${name}`);
    // Its shell has the user's hook: a command ended in the chat block is not a command of the user's.
    const command = (pane, cmd) => client(config.socket, {type: 'command', cwd: project, pane, tmux: null, shell: null, cmd, exit: 0});
    const hooks = [command('rex:block:chat', 'echo from Pair\'s chat'), command('rex:block:user', 'echo from the user')];
    t.after(() => hooks.forEach(hook => hook.close()));
    const chat = chats.at(-1);
    const card = async () => {
      const from = chat.received.length;
      chat.send({type: 'context'});
      return JSON.stringify(await chat.next(message => message.type === 'context' && chat.received.indexOf(message) >= from));
    };
    const end = Date.now() + 3000;
    let seen = await card();
    while (!seen.includes('echo from the user') && Date.now() < end) { await pause(50); seen = await card(); }
    assert.ok(seen.includes('echo from the user'), `the user's command is in the context, ${name}`);
    assert.ok(!seen.includes('echo from Pair'), `the Rex chat block is no terminal of the user, ${name}`);
  }
});

test('a tmux chat after a Rex chat takes over: its pane is Pair\'s, not a terminal of the user, and Scout moves to Neovim', {timeout: 20_000}, async t => {
  const config = testConfig(scratch('pair-rex-tmux-after-'));
  const project = scratch('pair-rex-project-');
  const {created, seen, rexWith} = fakeRex();
  const daemon = await startDaemon(config, {...scriptedModels(), probe: async () => ({ok: true}), log: () => {}, rexWith});
  const rex = {server: '/run/rex.sock', session: 'session:1', block: 'block:chat'};
  const tmux = {socket: join(scratch('pair-rex-tmux-socket-'), 'none'), pane: '%2'};
  const editor = client(config.socket, {type: 'hello', role: 'editor', cwd: project});
  // A Neovim that answers what Scout's host asks of it, and keeps the questions.
  const asked = [];
  const answering = setInterval(() => {
    for (const message of editor.received) {
      if (message.type !== 'pane' || asked.includes(message)) continue;
      asked.push(message);
      editor.send({type: 'reply', id: message.id, result: message.action === 'find' ? {buf: null} : {error: 'no pane in a test'}});
    }
  }, 20);
  const rexChat = client(config.socket, {type: 'hello', role: 'chat', cwd: project, rex});
  let tmuxChat;
  t.after(async () => { clearInterval(answering); editor.close(); rexChat.close(); tmuxChat?.close(); await daemon.close(); });
  await editor.next(message => message.type === 'welcome');
  await rexChat.next(message => message.type === 'welcome');
  await until(() => created.sources.at(-1)?.chatPane === 'rex:block:chat', 'the Rex chat as the chat pane');
  // Only now: were the two hellos sent together, the daemon could hear tmux first and never build a Rex source.
  tmuxChat = client(config.socket, {type: 'hello', role: 'chat', cwd: project, rex: {...rex, block: 'block:outer'}, tmux});
  await tmuxChat.next(message => message.type === 'welcome');
  await until(() => seen.stopped.length === 1, 'the Rex source stopped');
  const status = (await requestDaemon(config.socket, {type: 'status'})).sessions[0];
  assert.deepEqual([status.tmux, status.rex], [true, false]);
  assert.equal(created.sources.length, 1, 'no Rex source after tmux');

  // The shell hook of the tmux chat pane is Pair's own: not a command of the user's. Another tmux pane's is.
  const command = (pane, cmd) => client(config.socket, {type: 'command', cwd: project, pane: null, tmux: pane, shell: null, cmd, exit: 4});
  const hooks = [command('%2', 'echo from the chat pane'), command('%9', 'echo from the user')];
  t.after(() => hooks.forEach(hook => hook.close()));
  const card = async () => {
    const from = tmuxChat.received.length;
    tmuxChat.send({type: 'context'});
    return JSON.stringify(await tmuxChat.next(message => message.type === 'context' && tmuxChat.received.indexOf(message) >= from));
  };
  const end = Date.now() + 3000;
  let seenCard = await card();
  while (!seenCard.includes('echo from the user') && Date.now() < end) { await pause(50); seenCard = await card(); }
  assert.ok(seenCard.includes('echo from the user'), 'the user\'s command is in the context');
  assert.ok(!seenCard.includes('echo from the chat pane'), 'the chat pane is not a terminal of the user');

  // Scout's pane opens in Neovim, not in Rex beside the old chat.
  editor.send({type: 'role', role: 'scout'});
  await until(() => asked.length > 0, 'Scout asking Neovim for its pane');
  assert.deepEqual(seen.hostCalls, []);
});
