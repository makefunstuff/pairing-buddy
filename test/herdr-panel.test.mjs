// Pair's panel in the Herdr window (src/herdr-panel.mjs, herdr/pair/): the daemon's loopback port and its token, the
// panel's line to it across a restart, the window's focus pushed by the panel in place of polling `herdr-app status`,
// `pair setup`'s install of the mod and `pair uninstall`'s removal, and `pair` opening the panel beside its terminal.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {connect} from 'node:net';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {createModels, fauxProvider} from '@earendil-works/pi-ai';
import {parseConfig} from '../src/config.mjs';
import {startDaemon} from '../src/daemon.mjs';
import {CorePanes, HerdrApp} from '../src/herdr-core.mjs';
import {panelChecks} from '../src/doctor.mjs';
import {installedModVersion, installMod, modDir, panelFile, panelWanted, removeMod, startPanelListener} from '../src/herdr-panel.mjs';
import {VERSION} from '../src/version.mjs';
import {PaneWatch} from '../src/pane-watch.mjs';
import {requestDaemon} from '../src/protocol.mjs';
import {openLink} from '../herdr/pair/link.js';
import {client} from './daemon-client.mjs';
import {fakeApp, fakeCore, SPACE_ID, TAB_ID} from './fake-core.mjs';
import {scratch} from './temp.mjs';

const BIN = fileURLToPath(new URL('../bin/pair.mjs', import.meta.url));
const answers = async () => ({ok: true});

function models() {
  const partner = fauxProvider();
  const all = createModels();
  all.setProvider(partner.provider);
  return {partner, pairModels: {models: all, watcher: partner.getModel(), partner: partner.getModel()}};
}

function rawConfig(dataDir) {
  const entry = {api: 'openai', baseUrl: 'http://unused', model: 'm'};
  return {dataDir, socket: join(dataDir, 'pair.sock'), typingPauseMs: 50, agents: false, plan: false, models: {watcher: entry, partner: entry}};
}

async function until(check, what, ms = 4000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A TCP socket as Herdr's `net` module gives it to the panel: write(text), read() (bytes, null at the end), close(). */
function herdrSocket(host, port) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, host);
    const chunks = [];
    let ended = false;
    let waiting = null;
    const give = value => { const resolveRead = waiting; waiting = null; resolveRead?.(value); };
    socket.on('data', data => (waiting ? give(new Uint8Array(data)) : chunks.push(new Uint8Array(data))));
    socket.on('close', () => { ended = true; give(null); });
    socket.on('error', () => {});
    socket.once('error', reject);
    socket.once('connect', () => resolve({
      write: text => new Promise(done => socket.write(text, () => done())),
      read: () => (chunks.length ? Promise.resolve(chunks.shift()) : ended ? Promise.resolve(null) : new Promise(done => { waiting = done; })),
      close: () => socket.destroy(),
    }));
  });
}

/** What the port answers to `lines` written raw, until it closes or `ms` pass: {text, closed}. */
function rawExchange(port, lines, ms = 1500) {
  return new Promise(resolve => {
    const socket = connect(port, '127.0.0.1');
    let text = '';
    const timer = setTimeout(() => { socket.destroy(); resolve({text, closed: false}); }, ms);
    socket.on('data', data => { text += data; });
    socket.on('error', () => {});
    socket.on('close', () => { clearTimeout(timer); resolve({text, closed: true}); });
    socket.on('connect', () => socket.write(lines.map(line => `${JSON.stringify(line)}\n`).join('')));
  });
}

/** A panel client of the port, as the mod is: the token first, then its messages. */
function panelClient(port, token, hello) {
  const socket = connect(port, '127.0.0.1');
  const received = [];
  let buffer = '';
  socket.on('data', data => {
    buffer += data;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) if (line.trim()) received.push(JSON.parse(line));
  });
  socket.on('error', () => {});
  socket.on('connect', () => socket.write(`${JSON.stringify({type: 'auth', token})}\n${JSON.stringify(hello)}\n`));
  const send = message => socket.write(`${JSON.stringify(message)}\n`);
  return {received, send, close: () => socket.destroy(), next: async match => { await until(() => received.find(match), 'a message'); return received.find(match); }};
}

test('"herdrPanel": the port opens with the Herdr window installed, or when the config says so', () => {
  const none = {HOME: scratch('pair-home-'), PATH: ''};
  assert.equal(panelWanted({herdrPanel: 'auto'}, none), false, 'no Herdr window here');
  assert.equal(panelWanted({herdrPanel: true}, none), true);
  const home = scratch('pair-home-');
  mkdirSync(join(home, '.config', 'herdr-app'), {recursive: true});
  writeFileSync(join(home, '.config', 'herdr-app', 'AGENTS.md'), '# Herdr app\n');
  assert.equal(panelWanted({herdrPanel: 'auto'}, {HOME: home, PATH: ''}), true, 'the folder the window writes on every start');
  assert.equal(panelWanted({herdrPanel: false}, {HOME: home, PATH: ''}), false);
  assert.throws(() => parseConfig({...rawConfig(home), herdrPanel: 'yes'}), /herdrPanel must be true, false or "auto"/);
});

test('the panel\'s port: no token or a wrong one closes it; the token opens the socket\'s protocol, with the notes\' text', {timeout: 20_000}, async () => {
  const config = parseConfig(rawConfig(scratch('pair-data-')));
  const project = scratch('pair-project-');
  const daemon = await startDaemon(config, {...models(), probe: answers, log: () => {}, herdrPanel: true});
  let closed = false;
  try {
    const file = panelFile(config);
    assert.equal(statSync(file).mode & 0o777, 0o600, 'the token is readable by you only');
    const {port, token} = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(Number.isInteger(port) && token.length >= 32);

    assert.deepEqual(await rawExchange(port, [{type: 'status'}]), {text: '', closed: true}, 'no token: closed, nothing said');
    assert.deepEqual(await rawExchange(port, [{type: 'auth', token: 'nope'}, {type: 'status'}]), {text: '', closed: true}, 'a wrong token');
    assert.deepEqual(await rawExchange(port, [{type: 'status', token: `${token.slice(0, -1)}x`}]), {text: '', closed: true}, 'one character off');
    const opened = await rawExchange(port, [{type: 'auth', token}, {type: 'status'}], 800);
    const overPort = JSON.parse(opened.text.split('\n')[0]);
    const overSocket = await requestDaemon(config.socket, {type: 'status'});
    assert.deepEqual(Object.keys(overPort).sort(), Object.keys(overSocket).sort(), 'the same answer as on the socket');
    assert.equal(overPort.pid, overSocket.pid);
    assert.equal(overSocket.panel.port, port, '`pair doctor` reads the port from the daemon');
    const withHello = await rawExchange(port, [{type: 'status', token}], 800);
    assert.equal(JSON.parse(withHello.text.split('\n')[0]).type, 'status', 'the token may come with the first message itself');

    // A chat over the port and one over the socket: the same session, the same welcome.
    const panel = panelClient(port, token, {type: 'hello', role: 'chat', cwd: project, panel: true});
    const chat = client(config.socket, {type: 'hello', role: 'chat', cwd: project});
    const [a, b] = [await panel.next(m => m.type === 'welcome'), await chat.next(m => m.type === 'welcome')];
    for (const key of ['root', 'level', 'role', 'model', 'watcher', 'goal']) assert.deepEqual(a[key], b[key], key);
    await panel.next(m => m.type === 'message' && /What are we doing this session\?/.test(m.text));
    panel.send({type: 'today'});
    chat.send({type: 'today'});
    const [ledgerA, ledgerB] = [await panel.next(m => m.type === 'ledger'), await chat.next(m => m.type === 'ledger')];
    assert.equal(typeof ledgerA.text, 'string', 'the panel gets the words the terminal\'s chat writes itself');
    assert.equal(ledgerB.text, undefined, 'the socket\'s clients get what they always did');
    assert.deepEqual({...ledgerA, text: undefined}, {...ledgerB, text: undefined});
    panel.send({type: 'remarks'});
    assert.match((await panel.next(m => m.type === 'remarks')).text, /no remark here yet/);
    panel.close();
    chat.close();
    await daemon.close();
    closed = true;
    assert.equal(existsSync(file), false, 'the port\'s file goes with the daemon');
  } finally {
    if (!closed) await daemon.close();
  }
});

test('the panel\'s line: hello with the token, and hello again with resume once a restarted daemon is back', {timeout: 30_000}, async () => {
  const config = parseConfig(rawConfig(scratch('pair-data-')));
  const project = scratch('pair-project-');
  const start = () => startDaemon(config, {...models(), probe: answers, log: () => {}, herdrPanel: true});
  const states = [];
  const welcomes = [];
  const heard = [];
  const errors = [];
  let closed = false;
  const link = openLink({
    connect: herdrSocket, readText: path => readFile(path, 'utf8'), sleep: pause, decode: bytes => Buffer.from(bytes).toString('utf8'),
    file: panelFile(config), retryMs: 100, downMs: 100,
    hello: resume => ({type: 'hello', role: 'chat', cwd: project, resume, panel: true}),
    onState: state => states.push(state), onMessage: message => {
      // A message the panel fails on leaves the line open (it once closed it, and the panel's focus pushes stopped).
      if (message.type === 'presence') throw new Error('cannot draw it');
      (message.type === 'welcome' ? welcomes : heard).push(message);
    },
    onError: (error, message) => errors.push([error.message, message.type]), closed: () => closed,
  });
  let daemon = null;
  try {
    await until(() => states.includes('down'), 'no daemon yet');
    daemon = await start();
    await until(() => welcomes.length === 1, 'the welcome');
    assert.equal(welcomes[0].reconnected, false);
    await until(() => errors.length, 'a message the panel fails on');
    assert.deepEqual(errors[0], ['cannot draw it', 'presence']);
    assert.equal(link.send({type: 'goal', text: 'make the cart total right'}), true, 'the line is still up');
    await until(() => heard.some(message => message.type === 'goal'), 'the goal taken');
    await daemon.close();
    daemon = null;
    await until(() => states.at(-1) === 'away', 'the daemon gone');
    assert.equal(link.send({type: 'today'}), false, 'nothing goes while it is away');
    daemon = await start();
    await until(() => welcomes.length === 2, 'the welcome again');
    assert.equal(welcomes[1].reconnected, true, 'a resumed hello');
    assert.equal(welcomes[1].goal, 'make the cart total right');
    assert.deepEqual(states.filter((state, i) => state !== states[i - 1]), ['connecting', 'down', 'up', 'away', 'up'], 'away only when the daemon went');
    // The session ends (/end, or by itself): the panel says hello again, as the terminal's chat does, and goes on.
    link.send({type: 'end'});
    await until(() => heard.some(message => message.type === 'ended'), 'the end');
    assert.equal(link.hello(), true);
    await until(() => welcomes.length === 3, 'the next session\'s welcome');
    assert.equal(welcomes[2].reconnected, false, 'a new session, not a reconnect');
    assert.equal(link.send({type: 'goal', text: 'next'}), true);
    await until(() => heard.some(message => message.type === 'goal' && message.goal === 'next'), 'the next session takes messages');
  } finally {
    closed = true;
    link.close();
    if (daemon) await daemon.close();
    await link.done;
  }
});

/** A fake core and Herdr window in a folder of the test's own. */
async function herdrSetUp(t) {
  const dir = scratch('pair-core-');
  const socketPath = join(dir, 'core.sock');
  const core = await fakeCore(socketPath);
  mkdirSync(join(dir, 'app'));
  const app = fakeApp(join(dir, 'app'));
  t.after(() => core.close());
  const statusCalls = () => app.calls().filter(args => args[0] === 'status').length;
  return {dir, socketPath, core, app, statusCalls};
}

test('the panel\'s focus push replaces asking `herdr-app status`; once it stops, the window is asked again', async t => {
  const {socketPath, app, statusCalls} = await herdrSetUp(t);
  const events = [];
  const source = new CorePanes({socketPath, chatPane: null, space: SPACE_ID, app: new HerdrApp({command: app.command}), focusMs: 50});
  const watch = new PaneWatch({source, chatPane: null, emit: event => events.push(event)});
  watch.start();
  t.after(() => watch.stop());
  const focus = () => events.filter(event => event.kind === 'focus').at(-1);
  await until(() => focus()?.pane === 't1', 'the polled focus');
  assert.deepEqual([...watch.panes.keys()].sort(), ['t1', 't2'], 'no chat terminal: every terminal of the space is the user\'s');
  source.pushed({space: SPACE_ID, terminal: 't2'});
  await until(() => focus()?.pane === 't2', 'the pushed focus');
  const asked = statusCalls();
  await pause(400);
  assert.equal(statusCalls(), asked, 'not asked while the panel pushes');
  source.pushed({space: 'sp2', terminal: 't3'});
  await until(() => focus()?.target === 'elsewhere', 'another space shown');
  source.pushed({space: SPACE_ID, terminal: 'vps/t7'});
  await pause(50);
  assert.equal(focus().target, 'elsewhere', 'another machine\'s terminal is none of the space\'s');
  source.pushed(null);
  await until(() => statusCalls() > asked + 2, 'asked again');
  await until(() => focus()?.pane === 't1', 'the polled focus again');
  // A panel that comes and goes while the window is being asked (a reload): still one loop asking, never two.
  const rate = async () => { const from = statusCalls(); await pause(1000); return statusCalls() - from; };
  const one = await rate();
  for (let i = 0; i < 5; i++) {
    source.pushed({space: SPACE_ID, terminal: 't1'});
    source.pushed(null);
    await pause(30);
  }
  const after = await rate();
  assert.ok(after <= one * 1.4 + 1, `one loop: ${one} calls a second before, ${after} after`);
});

test('a focus pushed before the chat terminal\'s space is known counts once it is', async t => {
  const {socketPath, app} = await herdrSetUp(t);
  const events = [];
  const source = new CorePanes({socketPath, chatPane: 't2', app: new HerdrApp({command: app.command}), focusMs: 50});
  source.pushed({space: SPACE_ID, terminal: 't1'}); // before start: the space is not asked yet
  const watch = new PaneWatch({source, chatPane: 't2', emit: event => events.push(event)});
  watch.start();
  t.after(() => watch.stop());
  await until(() => events.some(event => event.kind === 'focus' && event.pane === 't1'), 'the pushed focus');
});

test('a panel in the Herdr window: the daemon watches its space, takes its focus pushes, and polls again once it is gone', {timeout: 20_000}, async t => {
  const {socketPath, core, app, statusCalls} = await herdrSetUp(t);
  const config = parseConfig(rawConfig(scratch('pair-data-')));
  const project = scratch('pair-project-');
  const daemon = await startDaemon(config, {...models(), probe: answers, log: () => {}, herdrPanel: true, appCommand: app.command});
  t.after(() => daemon.close());
  const {port, token} = JSON.parse(readFileSync(panelFile(config), 'utf8'));
  const editor = client(config.socket, {type: 'hello', role: 'editor', cwd: project}); // keeps the session
  t.after(() => editor.close());
  const panel = panelClient(port, token, {
    type: 'hello', role: 'chat', cwd: project, panel: true,
    herdr: {kind: 'core', socket: socketPath, pane: null, beside: 't1', space: SPACE_ID, tab: TAB_ID, session: null, appHome: null},
  });
  await panel.next(m => m.type === 'welcome');
  const session = async () => (await requestDaemon(config.socket, {type: 'status'})).sessions[0];
  await until(async () => (await session())?.herdr, 'the space watched');
  await until(() => statusCalls() > 1, 'the window asked, before any push');
  panel.send({type: 'herdr_focus', space: SPACE_ID, tab: TAB_ID, pane: 'p1', terminal: 't1'});
  await until(async () => (await session()).focusPushed, 'the push taken');
  assert.equal((await session()).panels, 1);
  await pause(150);
  const asked = statusCalls();
  await pause(1200);
  assert.equal(statusCalls(), asked, 'no `herdr-app status` while the panel pushes');
  panel.close();
  await until(async () => !(await session()).focusPushed, 'the panel gone');
  await until(() => statusCalls() > asked, 'the window asked again');
  assert.ok(core.calls.includes('terminal.list'), 'the space\'s terminals were read');
});

test('pair setup installs the mod into the Herdr window, an upgrade updates only what changed, pair uninstall removes it', () => {
  const home = scratch('pair-app-');
  const env = {HERDR_APP_HOME: home, HOME: home, PATH: ''};
  assert.equal(installMod({env, version: '1.0.0'}), 'installed');
  const dir = modDir(env);
  assert.equal(dir, join(home, 'mods', 'pair'));
  for (const name of ['main.js', 'model.js', 'link.js', 'commands.js', 'keys.js', 'mod.json']) assert.ok(existsSync(join(dir, name)), name);
  assert.equal(existsSync(join(dir, 'gpui-kit.d.ts')), false, 'not what Herdr writes itself');
  assert.equal(installedModVersion(env), '1.0.0');
  assert.equal(installMod({env, version: '1.0.0'}), 'same', 'nothing written: a running window does not reload it');
  writeFileSync(join(dir, 'gone.js'), 'export {};\n');
  writeFileSync(join(dir, 'jsconfig.json'), '{}\n');
  writeFileSync(join(dir, 'main.js'), '// edited\n');
  assert.equal(installMod({env, version: '1.1.0'}), 'updated');
  assert.equal(existsSync(join(dir, 'gone.js')), false, 'a file the new version does not have goes');
  assert.equal(existsSync(join(dir, 'jsconfig.json')), true, 'Herdr\'s own stays');
  assert.match(readFileSync(join(dir, 'main.js'), 'utf8'), /export default class Pair/);
  assert.equal(installedModVersion(env), '1.1.0');
  assert.equal(removeMod(env), true);
  assert.equal(existsSync(dir), false);
  assert.equal(removeMod(env), false);
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, 'main.js'), '// someone else\'s pair mod\n');
  assert.equal(removeMod(env), false, 'a folder Pair did not install is left');
  assert.throws(() => installMod({env, version: '1.1.0'}), /holds a mod Pair did not install/, 'nor overwritten');
  assert.equal(readFileSync(join(dir, 'main.js'), 'utf8'), '// someone else\'s pair mod\n');
  assert.equal(existsSync(join(dir, 'main.js')), true);
});

/** Runs `pair` in herdr-core terminal t1 of the fake window: its exit code. */
function runPair({configPath, socketPath, appDir, appHome, cwd}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', BIN], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, PAIR_CONFIG: configPath, HERDR_SOCKET_PATH: '', HC_SOCKET: socketPath, HC_TERMINAL_ID: 't1', HERDR_APP_HOME: appHome, PATH: `${appDir}:${process.env.PATH}`},
    });
    let err = '';
    child.stderr.on('data', data => { err += data; });
    child.on('exit', code => resolve({code, err}));
  });
}

test('`pair` in a terminal of the Herdr window opens the panel beside it; without the mod, or refused, the chat terminal as before', {timeout: 30_000}, async t => {
  const {dir, socketPath, core, app} = await herdrSetUp(t);
  const dataDir = scratch('pair-data-');
  const configPath = join(dataDir, 'config.json');
  writeFileSync(configPath, JSON.stringify({...rawConfig(dataDir), herdrPanel: true}));
  const config = parseConfig(rawConfig(dataDir));
  const project = scratch('pair-project-');
  const daemon = await startDaemon(config, {...models(), probe: answers, log: () => {}, herdrPanel: true, appCommand: app.command});
  t.after(() => daemon.close());
  const appHome = join(dir, 'herdr-app');
  const run = () => runPair({configPath, socketPath, appDir: join(dir, 'app'), appHome, cwd: project});
  const splits = () => app.calls().filter(args => args[0] === 'do' && args[1] === 'pane.split');

  // No mod installed: the chat in a terminal the core starts in t1's space and tab, as before.
  assert.equal((await run()).code, 0);
  assert.deepEqual(splits(), []);
  assert.equal(core.started.length, 1);
  assert.deepEqual(core.started[0].labels, {'herdr.space': SPACE_ID, 'herdr.tab': TAB_ID});
  assert.equal(core.started[0].argv.at(-1), 'chat');

  installMod({env: {HERDR_APP_HOME: appHome}, version: 'test'});
  const {code, err} = await run();
  assert.equal(code, 0, err);
  assert.equal(core.started.length, 1, 'no chat terminal');
  const [split] = splits();
  assert.deepEqual(split.slice(0, 9), ['do', 'pane.split', '--direction', 'right', '--pane', 'p1', '--mod', 'pair', '--props']);
  assert.deepEqual(JSON.parse(split[9]), {cwd: project, terminal: 't1', space: 'sp1', tab: 'tb1', core: socketPath, session: null, panel: panelFile(config), history: join(dataDir, 'chat-history.json')});

  app.set({refuseSplit: true});
  assert.equal((await run()).code, 0);
  assert.equal(core.started.length, 2, 'the window refused the mod: the chat terminal');
});

test('pair doctor: a line for the panel\'s port and one for the mod, where the Herdr window is installed', () => {
  const lines = (config, status, env) => [...panelChecks(config, status, env)].map(({level, name, text}) => `${level} ${name}: ${text}`);
  assert.deepEqual(lines({herdrPanel: 'auto'}, null, {HOME: scratch('pair-home-'), PATH: ''}), [], 'no Herdr window: nothing to say');
  const home = scratch('pair-app-');
  writeFileSync(join(home, 'AGENTS.md'), '# Herdr app\n');
  const env = {HOME: home, HERDR_APP_HOME: home, PATH: ''};
  const status = {panel: {port: 4711, file: '/run/user/1/pairing-buddy.sock.panel', clients: 1}};
  let said = lines({herdrPanel: 'auto'}, status, env);
  assert.match(said[0], /^ok panel: the daemon listens for Pair's panel on 127\.0\.0\.1:4711, its token in .*\(yours only\); 1 panel connected$/);
  assert.match(said[1], /^warn mod: Pair's panel is not installed in the Herdr window: `pair setup` installs it/);
  installMod({env, version: '0.0.1'});
  assert.match(lines({herdrPanel: 'auto'}, status, env)[1], new RegExp(`^warn mod: .* is from Pair 0\\.0\\.1, this is ${VERSION.replace(/\./g, '\\.')}: \`pair setup\` updates it$`));
  installMod({env, version: VERSION});
  assert.match(lines({herdrPanel: 'auto'}, status, env)[1], /^ok mod: Pair's panel is installed in /);
  said = lines({herdrPanel: 'auto'}, {panel: null}, env);
  assert.match(said[0], /^warn panel: the daemon has no port for Pair's panel/);
  assert.match(lines({herdrPanel: false}, {panel: null}, env)[0], /^warn panel: off in the config/);
});

test('the token never goes to a folder others can write in: beside a socket in one, it goes to the data folder, or nowhere', async () => {
  const shared = scratch('pair-shared-');
  chmodSync(shared, 0o1777); // as /tmp, where the socket goes without XDG_RUNTIME_DIR
  const dataDir = scratch('pair-data-');
  chmodSync(dataDir, 0o700);
  const config = {socket: join(shared, 'pair.sock'), dataDir};
  assert.equal(panelFile(config), join(dataDir, 'herdr-panel.json'));
  const panel = await startPanelListener({config, accept: socket => socket.destroy()});
  assert.equal(panel.file, join(dataDir, 'herdr-panel.json'));
  assert.equal(statSync(panel.file).mode & 0o777, 0o600);
  await panel.close();
  assert.equal(existsSync(panel.file), false);
  const own = scratch('pair-run-');
  chmodSync(own, 0o700);
  assert.equal(panelFile({socket: join(own, 'pair.sock'), dataDir}), join(own, 'pair.sock.panel'), 'beside the socket in a folder of your own');
  chmodSync(dataDir, 0o777);
  await assert.rejects(startPanelListener({config, accept: socket => socket.destroy()}), /others can write in/, 'no folder of your own: no port');
  chmodSync(dataDir, 0o700);
});
