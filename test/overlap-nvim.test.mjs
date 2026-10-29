// Pair and the board's working tasks end to end: the daemon reads a fake board (Shepherdr's command, faked) and the
// branches of its tasks in a real git repo, a headless Neovim shows the winbar note on a file a task also changes, an
// edit of yours on its lines is the overlap remark through the speak gate (scripted models), and :Pair brief sync
// tells the branch's own task only on the pick that names it. Skips without nvim.
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {mkdirSync, realpathSync, writeFileSync} from 'node:fs';
import {connect} from 'node:net';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {createModels, fauxAssistantMessage, fauxProvider, fauxText} from '@earendil-works/pi-ai';
import {parseConfig} from '../src/config.mjs';
import {startDaemon} from '../src/daemon.mjs';
import {readMessages, sendMessage} from '../src/protocol.mjs';
import {openStore} from '../src/store.mjs';
import {fakeShepherdr} from './fake-shepherdr.mjs';
import {scratch, socketDir} from './temp.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const hasNvim = (() => { try { execFileSync('nvim', ['--version']); return true; } catch { return false; } })();
const withoutHerdr = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('HERDR_')));
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

test('a file a working task changes says so in the winbar; your edit on its lines is the overlap remark; :Pair brief sync tells on the pick', {skip: hasNvim ? false : 'nvim not installed', timeout: 60_000}, async () => {
  // The repo: you are on the branch of SHO-74; SHO-71 works on work/71-fold in a worktree of its own.
  const home = realpathSync(scratch('pair-overlap-'));
  const project = join(home, 'shop');
  mkdirSync(project);
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {stdio: 'pipe'});
  git(project, 'init', '-q', '-b', 'main');
  writeFileSync(join(project, 'a.js'), 'const x = 1\nconst y = 2\nconst z = 3\n');
  writeFileSync(join(project, 'b.js'), 'const b = 1\n');
  writeFileSync(join(project, 'NOTES.md'), '# Shop\n\nMoney in integer cents, never floats.\nStatuses: new, paid, shipped.\n');
  git(project, 'add', '.');
  git(project, 'commit', '-q', '-m', 'first');
  const worktree = join(home, 'wt-71');
  git(project, 'worktree', 'add', '-q', '-b', 'work/71-fold', worktree);
  writeFileSync(join(worktree, 'a.js'), 'const x = 1\nconst y = fold(2)\nconst z = 3\n');
  git(worktree, 'commit', '-q', '-am', 'fold');
  git(project, 'checkout', '-q', '-b', 'work/74-orders');

  const dataDir = scratch('pair-data-');
  const boardHome = join(dataDir, 'board');
  mkdirSync(boardHome);
  const space = {name: 'shop', key: 'SHO', path: project};
  const brief74 = 'Build the orders.\n\n> Money in integer cents, never floats. (NOTES.md:3)';
  const tasks = seventyOne => [
    {id: 'SHO-71', title: 'Fold the footer', status: seventyOne, place: 'p:here:shop', branch: 'work/71-fold'},
    {id: 'SHO-74', title: 'Orders', status: 'work', place: 'p:here:shop', branch: 'work/74-orders', desc: brief74},
  ];
  const fake = fakeShepherdr(boardHome, {spaces: [space], tasks: tasks('work')});

  const config = parseConfig({
    dataDir, socket: join(dataDir, 'pair.sock'), typingPauseMs: 400, board: fake.command, agents: false,
    models: {watcher: {api: 'openai', baseUrl: 'http://unused', model: 'w'}, partner: {api: 'openai', baseUrl: 'http://unused', model: 'p'}},
  });
  const watched = []; // what the Watcher was asked to score
  const score = value => context => { watched.push(context.messages.at(-1).content); return fauxAssistantMessage([fauxText(value)]); };
  const watcher = fauxProvider({provider: 'faux-watcher'});
  watcher.setResponses(Array.from({length: 30}, () => context => score(/\boverlap\b|another agent's board task/.test(context.messages.at(-1).content) ? '9' : '0')(context)));
  const asked = []; // what the Partner was asked
  const partner = fauxProvider({provider: 'faux-partner'});
  partner.setResponses(Array.from({length: 10}, () => context => {
    asked.push(context.messages.findLast(message => message.role === 'user').content);
    return fauxAssistantMessage([fauxText('SHO-71 also changes line 2 to fold(2): whichever merges second meets a conflict.')]);
  }));
  const models = createModels();
  models.setProvider(watcher.provider);
  models.setProvider(partner.provider);
  const pairModels = {models, watcher: watcher.getModel(), partner: partner.getModel()};
  const daemon = await startDaemon(config, {pairModels, probe: async () => ({ok: true}), log: () => {}, taskChangesPollMs: 200});

  const server = join(socketDir(), 'nvim.sock');
  const nvim = spawn('nvim', [
    '--headless', '--clean', '--listen', server,
    '--cmd', `set rtp+=${REPO}`,
    '-c', `lua require('pair').setup({socket = '${config.socket}', debounce_ms = 100})`,
    // A picker plugin, as snacks or dressing: :Pair brief sync's pick answered from g:pair_pick.
    '-c', 'lua vim.ui.select = function(items, opts, done) vim.g.pair_picked = vim.tbl_map(opts.format_item, items); done(items[vim.g.pair_pick or 1]) end',
    '-c', `cd ${project}`,
    '-c', 'edit a.js',
    '-c', 'Pair start fold the footer',
  ], {stdio: 'ignore', env: {...withoutHerdr, XDG_STATE_HOME: dataDir}});
  const remote = expr => execFileSync('nvim', ['--server', server, '--remote-expr', expr], {encoding: 'utf8'}).trim();
  const keys = text => execFileSync('nvim', ['--server', server, '--remote-send', text]);
  const chat = connect(config.socket);
  const messages = [];
  readMessages(chat, message => messages.push(message));
  chat.on('connect', () => sendMessage(chat, {type: 'hello', role: 'chat', cwd: project}));
  const remarks = () => {
    const store = openStore(join(dataDir, 'sessions.sqlite'));
    try { return store.remarks(0); } finally { store.close(); }
  };
  try {
    await until(() => { try { return remote('1'); } catch { return false; } }, 'nvim to listen');
    await until(() => messages.some(message => message.text === 'Goal: fold the footer'), 'the session');

    const note = '◇ SHO-71 is changing this file · work/71-fold · :Pair agents'; // remote() trims its spaces
    assert.equal(await until(() => remote('&l:winbar') || null, 'the winbar note'), note);
    keys(':split b.js<CR>');
    await until(() => remote('bufname()') === 'b.js', 'b.js');
    assert.equal(remote('&l:winbar'), '', 'a file no task changes has none');
    keys(':close<CR>');
    await until(() => remote('bufname()') === 'a.js', 'back in a.js');
    assert.equal(remote('&l:winbar'), note);
    assert.ok(fake.calls().every(args => ['list', 'show'].includes(args[1]) || args[0] === 'space'), 'the board is only read');

    // Your edit on line 2, which SHO-71 changes too, then a save: the overlap, at your break.
    keys('2Gccconst y = 20<Esc>:w<CR>');
    await until(() => remarks().some(remark => remark.trigger === 'overlap'), 'the overlap remark');
    assert.match(watched.find(prompt => /overlap/.test(prompt)), /another agent's board task \(SHO-71\) changes 2-2 of that file on its own branch/);
    assert.match(asked.find(prompt => prompt.startsWith('[watch] overlap')), /Board task SHO-71 \("Fold the footer"\), whose agent is at work on branch work\/71-fold, also changes a\.js:2 on its branch, where it writes:\n {2}const y = fold\(2\)/);
    assert.ok(!asked.some(prompt => /^\[watch\] overlap: [^\n]*Board task SHO-74/.test(prompt)), 'your own branch\'s task is no overlap');

    // :Pair brief sync: SHO-74's brief lacks a line of the note. The pick names the tell; only it tells.
    keys(':Pair brief sync<CR>');
    await until(() => fake.calls().some(args => args[1] === 'tell'), 'the tell on the pick');
    const picked = JSON.parse(remote('json_encode(g:pair_picked)'));
    assert.deepEqual(picked, ['tell SHO-74: its agent is at work, so this goes as a message, not a new brief', 'copy the command, run nothing', 'nothing']);
    const tell = fake.calls().find(args => args[1] === 'tell');
    assert.deepEqual(tell.slice(0, 3), ['task', 'tell', 'SHO-74']);
    assert.match(tell[3], /It says now:\n- Statuses: new, paid, shipped\. \(NOTES\.md:4\)/);
    const tells = fake.calls().filter(args => args[1] === 'tell').length;
    keys(':let g:pair_pick = 2<CR>:Pair brief sync<CR>');
    await until(() => remote('getreg(\'"\')').includes('shepherdr task tell SHO-74'), 'c: the command copied');
    assert.equal(fake.calls().filter(args => args[1] === 'tell').length, tells, 'copied, not told');

    // SHO-71 is merged: its note goes.
    fake.set({spaces: [space], tasks: tasks('done')});
    await until(() => remote('&l:winbar') === '', 'the note to go');
    assert.ok(fake.calls().every(args => ['list', 'show', 'tell'].includes(args[1]) || args[0] === 'space'), 'nothing but reads, and the tell you picked');
  } finally {
    chat.destroy();
    nvim.kill();
    await daemon.close();
  }
});
