// Pair's panel opened without typing `pair` (src/herdr-panel.mjs, herdr/pair/bare.js): the props a panel opened bare
// takes from the focused terminal, `pair panel --props` filling in the rest, Pair in the + menu (`pair panel`), and
// `pair setup`'s key and + menu entry merged into the Herdr window's keys.json and programs.json, which `pair uninstall`
// takes out again.
import assert from 'node:assert/strict';
import {execFile, spawn} from 'node:child_process';
import {existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {createModels, fauxProvider} from '@earendil-works/pi-ai';
import {parseConfig} from '../src/config.mjs';
import {startDaemon} from '../src/daemon.mjs';
import {addLaunchers, appCommandOf, coreOf, installMod, KEY_CHOICES, MOD_SOURCE, OPEN_ACTION, pairArgv, panelFile, programEntry, removeLaunchers, removePanel, setUpPanel} from '../src/herdr-panel.mjs';
import {bareTarget, fullProps, isBare, ownPane, parseFilled} from '../herdr/pair/bare.js';
import {fakeApp} from './fake-core.mjs';
import {scratch} from './temp.mjs';

const BIN = fileURLToPath(new URL('../bin/pair.mjs', import.meta.url));
const ARGV = ['/usr/bin/node', '--disable-warning=ExperimentalWarning', '/opt/pair/bin/pair.mjs'];
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const backups = (dir, name) => readdirSync(dir).filter(file => file.startsWith(`${name}.pair-bak-`));

function rawConfig(dataDir) {
  const entry = {api: 'openai', baseUrl: 'http://unused', model: 'm'};
  return {dataDir, socket: join(dataDir, 'pair.sock'), typingPauseMs: 50, agents: false, plan: false, models: {watcher: entry, partner: entry}};
}

function models() {
  const partner = fauxProvider();
  const all = createModels();
  all.setProvider(partner.provider);
  return {pairModels: {models: all, watcher: partner.getModel(), partner: partner.getModel()}};
}

/** Runs bin/pair.mjs with `args` and `env` on top of this one's: {code, out, err}. */
function runPair(args, {env, cwd}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', BIN, ...args], {cwd, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, ...env}});
    let out = '';
    let err = '';
    child.stdout.on('data', data => { out += data; });
    child.stderr.on('data', data => { err += data; });
    child.on('exit', code => resolve({code, out, err}));
  });
}

test('a panel opened bare takes the focused terminal, its folder, space and tab; with a panel in the tab, that one', () => {
  assert.equal(isBare(null), true);
  assert.equal(isBare({mod: 'pair-dev'}), true);
  assert.equal(isBare({cwd: '/p', panel: '/run/pair.sock.panel'}), false);
  const panes = [
    {pane: 'p1', terminal: 't1', tab: 'tb1', cwd: '/home/me/shop/src'},
    {pane: 'p2', terminal: 't2', tab: 'tb1', cwd: '/home/me/shop'},
    {pane: 'p3', terminal: 't3', tab: 'tb2', cwd: '/elsewhere'},
  ];
  const focused = {space: 'sp1', tab: 'tb1', pane: 'p2', terminal: 't2', cwd: '/home/me/shop/web'};
  const at = bareTarget({focused, panes, mod: 'pair'});
  assert.deepEqual(at, {space: 'sp1', tab: 'tb1', before: ['p1', 'p2'], existing: null, target: {pane: 'p2', terminal: 't2', cwd: '/home/me/shop/web'}});
  // Focus on a pane that is no terminal (a Files panel): the tab's first terminal.
  const files = {pane: 'p4', mod: 'files', terminal: null, tab: 'tb1', cwd: null};
  assert.deepEqual(bareTarget({focused: {space: 'sp1', tab: 'tb1', pane: 'p4', terminal: null, cwd: null}, panes: [...panes, files], mod: 'pair'}).target,
    {pane: 'p1', terminal: 't1', cwd: '/home/me/shop/src'});
  // A panel already in the tab: that one is focused, no second one.
  const open = bareTarget({focused, panes: [...panes, {pane: 'p5', mod: 'pair', terminal: null, tab: 'tb1'}], mod: 'pair'});
  assert.equal(open.existing, 'p5');
  assert.equal(bareTarget({focused, panes: [...panes, {pane: 'p5', mod: 'pair-dev', terminal: null, tab: 'tb1'}], mod: 'pair'}).existing, null, 'another mod\'s copy is not this one');
  assert.equal(bareTarget({focused: null, panes, mod: 'pair'}).target, null);
  assert.equal(bareTarget({focused: {space: 'sp1', tab: 'tb9'}, panes, mod: 'pair'}).target, null, 'a tab with no terminal');
  // Its own pane: the one of this mod in the tab that was not there as it opened.
  assert.equal(ownPane({panes: [...panes, {pane: 'p6', mod: 'pair', tab: 'tb1'}], at, mod: 'pair'}), 'p6');
  assert.equal(ownPane({panes: [...panes, {pane: 'p6', mod: 'pair', tab: 'tb2'}], at, mod: 'pair'}), null);
  assert.equal(ownPane({panes, at, mod: 'pair'}), null);
  // The props of the panel that takes its place are the ones `pair` passes.
  const filled = {cwd: '/home/me/shop/web', terminal: 't2', core: '/run/user/1/herdr-core/default.sock', session: null, panel: '/run/user/1/pair.sock.panel', history: '/data/chat-history.json'};
  assert.deepEqual(fullProps(at, filled, 'pair'), {cwd: '/home/me/shop/web', terminal: 't2', space: 'sp1', tab: 'tb1', core: filled.core, session: null, panel: filled.panel, history: filled.history});
  assert.equal(fullProps(at, filled, 'pair-dev').mod, 'pair-dev', 'a copy under another name keeps its name');
  assert.deepEqual(parseFilled({code: 0, stdout: `${JSON.stringify(filled)}\n`, stderr: ''}), filled);
  assert.throws(() => parseFilled({code: 1, stdout: '{"error": "the daemon has no panel port yet"}\n', stderr: ''}), /no panel port/);
  assert.throws(() => parseFilled({code: 127, stdout: '', stderr: 'env: node: No such file or directory\n'}), /No such file/);
});

test('herdr-core\'s socket and session for a bare panel: the environment\'s, else the default socket', () => {
  assert.deepEqual(coreOf({HC_SOCKET: '/s.sock', HC_SESSION: 'work'}), {core: '/s.sock', session: 'work'});
  assert.deepEqual(coreOf({HC_TERMINAL_SOCKET: '/t.sock'}), {core: '/t.sock', session: null});
  assert.deepEqual(coreOf({XDG_RUNTIME_DIR: '/run/user/7'}), {core: '/run/user/7/herdr-core/default.sock', session: null});
});

test('the Herdr window runs this Pair: node and its script, with the setup\'s own config', () => {
  assert.deepEqual(pairArgv({execPath: '/n', script: '/p.mjs', env: {}}), ['/n', '--disable-warning=ExperimentalWarning', '/p.mjs']);
  assert.deepEqual(pairArgv({execPath: '/n', script: '/p.mjs', env: {PAIR_CONFIG: '/c.json', HOME: '/h'}}), ['env', 'PAIR_CONFIG=/c.json', '/n', '--disable-warning=ExperimentalWarning', '/p.mjs']);
});

test('pair setup merges the key and the + menu entry into keys.json and programs.json; uninstall takes out only those', () => {
  const home = scratch('pair-launch-');
  const env = {HERDR_APP_HOME: home, HOME: home};
  installMod({env, version: '1.0.0'});
  const keysPath = join(home, 'keys.json');
  const programsPath = join(home, 'programs.json');
  const keys = {global: {'ctrl-shift-t': 'tab.new'}, terminal: {'alt-p': 'terminal'}, 'mod:chat': {'ctrl-s': 'chat.send'}};
  const programs = {programs: {lazygit: {name: 'Git'}}, shells: ['xonsh']};
  writeFileSync(keysPath, JSON.stringify(keys));
  writeFileSync(programsPath, JSON.stringify(programs));

  const lines = addLaunchers({env, argv: ARGV});
  // Alt-p goes to the program in terminals here: the next key no section binds.
  const merged = read(keysPath);
  assert.deepEqual(merged, {...keys, global: {...keys.global, [KEY_CHOICES[1]]: OPEN_ACTION}});
  assert.deepEqual(OPEN_ACTION, {command: 'pane.split', args: {direction: 'right', mod: 'pair'}});
  assert.deepEqual(read(programsPath), {programs: {...programs.programs, pair: programEntry(ARGV)}, shells: ['xonsh']});
  assert.deepEqual(programEntry(ARGV).run, [...ARGV, 'panel']);
  assert.equal(backups(home, 'keys.json').length, 1, 'the old keys.json is kept');
  assert.deepEqual(read(join(home, backups(home, 'keys.json')[0])), keys);
  assert.equal(backups(home, 'programs.json').length, 1);
  assert.match(lines.join('\n'), /Key: alt-shift-p opens the panel/);

  // Again: nothing written, no second binding.
  const again = addLaunchers({env, argv: ARGV});
  assert.deepEqual(read(keysPath), merged);
  assert.equal(backups(home, 'keys.json').length, 1);
  assert.match(again.join('\n'), /Key: alt-shift-p opens the panel/);
  assert.match(again.join('\n'), /\+ menu: Pair is in it/);

  // An upgrade that runs Pair from elsewhere moves its own entry along.
  const moved = ['/usr/local/bin/node', '--disable-warning=ExperimentalWarning', '/new/pair.mjs'];
  addLaunchers({env, argv: moved});
  assert.deepEqual(read(programsPath).programs.pair, programEntry(moved));

  // Uninstall: Pair's own go, the rest of the files stays.
  assert.equal(removeLaunchers(env).length, 2);
  assert.deepEqual(read(keysPath), keys);
  assert.deepEqual(read(programsPath), {programs: programs.programs, shells: ['xonsh']});
  assert.deepEqual(removeLaunchers(env), [], 'twice: nothing more');
});

test('a binding or + menu entry the person changed, or had before, is left alone', () => {
  const home = scratch('pair-launch-');
  const env = {HERDR_APP_HOME: home, HOME: home};
  installMod({env, version: '1.0.0'});
  const keysPath = join(home, 'keys.json');
  const programsPath = join(home, 'programs.json');
  writeFileSync(keysPath, JSON.stringify({global: {}}));
  // No programs.json: one is made with only Pair's entry (it adds to Herdr's built-in table).
  addLaunchers({env, argv: ARGV});
  assert.deepEqual(read(keysPath).global, {'alt-p': OPEN_ACTION});
  assert.deepEqual(read(programsPath), {programs: {pair: programEntry(ARGV)}});
  // The person gives alt-p another job and renames the menu entry.
  writeFileSync(keysPath, JSON.stringify({global: {'alt-p': 'tab.next'}}));
  writeFileSync(programsPath, JSON.stringify({programs: {pair: {...programEntry(ARGV), name: 'My Pair'}}}));
  const said = removeLaunchers(env);
  assert.deepEqual(read(keysPath), {global: {'alt-p': 'tab.next'}});
  assert.equal(read(programsPath).programs.pair.name, 'My Pair');
  assert.match(said.join('\n'), /Left alt-p/);
  assert.match(said.join('\n'), /Left the "pair" entry/);

  // A "pair" entry of the person's own before setup: not replaced, nor removed.
  const other = scratch('pair-launch-');
  const env2 = {HERDR_APP_HOME: other, HOME: other};
  installMod({env: env2, version: '1.0.0'});
  writeFileSync(join(other, 'programs.json'), JSON.stringify({programs: {pair: {name: 'Pear'}}}));
  assert.match(addLaunchers({env: env2, argv: ARGV}).join('\n'), /has a "pair" entry of its own/);
  assert.deepEqual(read(join(other, 'programs.json')), {programs: {pair: {name: 'Pear'}}});
  // No keys.json yet: none is made (the window writes its own, with its default keys).
  assert.equal(existsSync(join(other, 'keys.json')), false);
  removeLaunchers(env2);
  assert.deepEqual(read(join(other, 'programs.json')), {programs: {pair: {name: 'Pear'}}});

  // Every key taken: no binding, and the file as it was.
  const full = scratch('pair-launch-');
  const env3 = {HERDR_APP_HOME: full, HOME: full};
  installMod({env: env3, version: '1.0.0'});
  const taken = {global: Object.fromEntries(KEY_CHOICES.map(key => [key, 'tab.next']))};
  writeFileSync(join(full, 'keys.json'), JSON.stringify(taken));
  assert.match(addLaunchers({env: env3, argv: ARGV}).join('\n'), /all taken/);
  assert.deepEqual(read(join(full, 'keys.json')), taken);
  // A keys.json that does not parse is not touched.
  writeFileSync(join(full, 'keys.json'), '{ "global": ');
  assert.match(addLaunchers({env: env3, argv: ARGV}).join('\n'), /No key for the panel/);
  assert.equal(readFileSync(join(full, 'keys.json'), 'utf8'), '{ "global": ');
});

test('pair setup\'s part in the window: the mod, how it runs Pair, the key and the + menu; uninstall\'s takes them out', () => {
  const home = scratch('pair-setup-');
  const env = {HOME: home, HERDR_APP_HOME: home};
  writeFileSync(join(home, 'keys.json'), JSON.stringify({global: {'ctrl-shift-t': 'tab.new'}}));
  const argv = pairArgv({execPath: '/n', script: '/p.mjs', env: {PAIR_CONFIG: '/c.json'}});
  const {done, lines} = setUpPanel({env, version: '1.0.0', argv});
  assert.equal(done, 'installed');
  assert.equal(lines.length, 2);
  assert.deepEqual(read(join(home, 'keys.json')).global['alt-p'], OPEN_ACTION);
  const entry = read(join(home, 'programs.json')).programs.pair;
  assert.deepEqual(entry.run, ['env', 'PAIR_CONFIG=/c.json', '/n', '--disable-warning=ExperimentalWarning', '/p.mjs', 'panel'], 'the menu runs Pair with the config it was set up with');
  assert.deepEqual(read(join(home, 'mods', 'pair', '.pair-command.json')).argv, entry.run.slice(0, -1), 'the panel runs the same Pair');
  assert.ok(existsSync(join(home, 'mods', 'pair', 'pair.svg')), 'the menu\'s icon');
  assert.equal(setUpPanel({env, version: '1.0.0', argv}).done, 'same', 'the hidden files Pair keeps there are no change');
  const said = removePanel(env);
  assert.equal(said.length, 3, said.join('\n'));
  assert.deepEqual(read(join(home, 'keys.json')), {global: {'ctrl-shift-t': 'tab.new'}});
  assert.deepEqual(read(join(home, 'programs.json')).programs, {});
  assert.equal(existsSync(join(home, 'mods', 'pair')), false);
});

test('pair panel --props: the daemon\'s panel file, herdr-core\'s socket and the chat history, for the terminal given', {timeout: 30_000}, async t => {
  const dataDir = scratch('pair-data-');
  const configPath = join(dataDir, 'config.json');
  writeFileSync(configPath, JSON.stringify({...rawConfig(dataDir), herdrPanel: true}));
  const config = parseConfig(rawConfig(dataDir));
  const daemon = await startDaemon(config, {...models(), probe: async () => ({ok: true}), log: () => {}, herdrPanel: true});
  t.after(() => daemon.close());
  const project = scratch('pair-project-');
  const env = {PAIR_CONFIG: configPath, HC_SOCKET: '', HC_TERMINAL_SOCKET: '', HC_TERMINAL_ID: '', HC_SESSION: '', XDG_RUNTIME_DIR: '/run/user/42'};
  const {code, out, err} = await runPair(['panel', '--props', '--cwd', project, '--terminal', 't7'], {env, cwd: project});
  assert.equal(code, 0, err);
  assert.deepEqual(JSON.parse(out), {cwd: project, terminal: 't7', core: '/run/user/42/herdr-core/default.sock', session: null, panel: panelFile(config), history: join(dataDir, 'chat-history.json')});
  const missing = await runPair(['panel', '--props', '--cwd', project], {env, cwd: project});
  assert.equal(missing.code, 1);
  assert.match(JSON.parse(missing.out).error, /--terminal/);
});

test('Pair in the + menu: the panel opens bare in the tab you came from, that tab is selected, the menu\'s tab closes', {timeout: 30_000}, async t => {
  const dataDir = scratch('pair-data-');
  const configPath = join(dataDir, 'config.json');
  writeFileSync(configPath, JSON.stringify({...rawConfig(dataDir), herdrPanel: true}));
  const daemon = await startDaemon(parseConfig(rawConfig(dataDir)), {...models(), probe: async () => ({ok: true}), log: () => {}, herdrPanel: true});
  t.after(() => daemon.close());
  const dir = scratch('pair-app-');
  // The menu's new tab (tb2, terminal t9) comes just after the tab you were in (tb1).
  const app = fakeApp(dir, {tabs: [
    {id: 'tb0', terminals: [{terminal: 't0', pane: 'p0'}]},
    {id: 'tb1', terminals: [{terminal: 't1', pane: 'p1'}]},
    {id: 'tb2', terminals: [{terminal: 't9', pane: 'p9'}]},
  ]});
  const env = {PAIR_CONFIG: configPath, HERDR_SOCKET_PATH: '', HC_SOCKET: join(dir, 'core.sock'), HC_TERMINAL_ID: 't9', PATH: `${dir}:${process.env.PATH}`};
  const {code, err} = await runPair(['panel'], {env, cwd: dataDir});
  assert.equal(code, 0, err);
  const done = app.calls().filter(args => args[0] === 'do');
  assert.deepEqual(done, [
    ['do', 'tab.select', '--id', 'tb1'],
    ['do', 'pane.split', '--direction', 'right', '--mod', 'pair'],
    ['do', 'tab.close', '--id', 'tb2', '--confirmed', 'true'],
  ]);
});

test('herdr-app check passes on the mod (where the Herdr app is installed)', async t => {
  const command = appCommandOf();
  if (!command) return t.skip('no herdr-app here');
  const result = await new Promise(resolve => execFile(command, ['check', MOD_SOURCE], {timeout: 60_000}, (error, stdout, stderr) => resolve({error, out: `${stdout}${stderr}`})));
  assert.equal(result.error, null, result.out);
  assert.match(result.out, /check passed/);
});
