// The agent relay end to end: the daemon reads a fake board (Shepherdr's command, faked) and a fake herdr, and the
// plugin in a headless Neovim shows the news at the next breakpoint, with the keys for what a task left behind.
// Skips without nvim.
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {mkdirSync, realpathSync, writeFileSync} from 'node:fs';
import {connect} from 'node:net';
import {basename, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {createModels, fauxAssistantMessage, fauxProvider, fauxText} from '@earendil-works/pi-ai';
import {parseConfig} from '../src/config.mjs';
import {startDaemon} from '../src/daemon.mjs';
import {readMessages, sendMessage} from '../src/protocol.mjs';
import {fakeHerdr} from './fake-herdr.mjs';
import {fakeShepherdr} from './fake-shepherdr.mjs';
import {scratch, socketDir} from './temp.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const hasNvim = (() => { try { execFileSync('nvim', ['--version']); return true; } catch { return false; } })();
const withoutHerdr = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('HERDR_')));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, what, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('another agent\'s news waits for your save, shows as one line in the statusline, Alt-a goes there; :Pair agents lists them all', {skip: hasNvim ? false : 'nvim not installed', timeout: 30_000}, async () => {
  const project = realpathSync(scratch('pair-agents-'));
  writeFileSync(join(project, 'probe.c'), 'int main(void) {\n  return 0;\n}\n');
  const dataDir = scratch('pair-data-');
  const repo = basename(project);

  // The board: the space of a repo named as the project, whose task #7 works in a worktree of its own.
  const boardHome = join(dataDir, 'board');
  const space = join(boardHome, 'repo');
  const worktree = join(boardHome, 'wt-7');
  mkdirSync(space, {recursive: true});
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {stdio: 'pipe'});
  git(space, 'init', '-q', '-b', 'main');
  writeFileSync(join(space, 'run.c'), 'int run;\n');
  git(space, 'add', '.');
  git(space, 'commit', '-q', '-m', 'first');
  git(space, 'worktree', 'add', '-q', '-b', 'work/7-read-every-run', worktree);
  writeFileSync(join(worktree, 'run.c'), 'int run;\nint every;\n');
  git(worktree, 'commit', '-q', '-am', 'every run');
  const pr = {number: 12, url: 'https://github.com/o/repo/pull/12'};
  const fake = fakeShepherdr(boardHome, {spaces: [{name: repo, key: 'REP', path: space}], tasks: []});
  const setTasks = (seven, eight = {status: 'work', sub: 'Reading the docs'}) => fake.set({spaces: [{name: repo, key: 'REP', path: space}], tasks: [
    {id: 'REP-7', title: 'Read every run', place: `p:here:${repo}`, branch: 'work/7-read-every-run', pr, sub: '', ...seven},
    {id: 'REP-8', title: 'Search trail', place: `p:here:${repo}`, ...eight},
  ]});
  setTasks({status: 'work'});
  const board = fake.command;

  const config = parseConfig({
    dataDir, socket: join(dataDir, 'pair.sock'), typingPauseMs: 400, board,
    models: {watcher: {api: 'openai', baseUrl: 'http://unused', model: 'w'}, partner: {api: 'openai', baseUrl: 'http://unused', model: 'p'}},
  });
  const watcher = fauxProvider({provider: 'faux-watcher'});
  watcher.setResponses(Array.from({length: 20}, () => fauxAssistantMessage([fauxText('0')]))); // no remark is worth it
  const partner = fauxProvider({provider: 'faux-partner'});
  const models = createModels();
  models.setProvider(watcher.provider);
  models.setProvider(partner.provider);
  const pairModels = {models, watcher: watcher.getModel(), partner: partner.getModel()};
  const daemon = await startDaemon(config, {pairModels, probe: async () => ({ok: true}), log: () => {}, agentsPollMs: 150});
  const herdrSocket = join(dataDir, 'herdr.sock');
  const herdr = await fakeHerdr(herdrSocket, {agents: [
    {pane_id: 'w7:p1', cwd: worktree, agent: 'claude', agent_status: 'working'},
    {pane_id: 'w9:p1', cwd: '/home/me/notes', agent: 'pi', agent_status: 'working', terminal_title_stripped: 'notes'},
  ]});

  const server = join(socketDir(), 'nvim.sock');
  const nvim = spawn('nvim', [
    '--headless', '--clean', '--listen', server,
    '--cmd', `set rtp+=${REPO}`,
    '-c', `lua require('pair').setup({socket = '${config.socket}', debounce_ms = 100})`,
    '-c', 'lua vim.ui.open = function(url) vim.g.pair_opened = url end', // the browser, faked
    '-c', `cd ${project}`,
    '-c', 'edit probe.c',
    '-c', 'Pair start poke the hash table',
  ], {stdio: 'ignore', env: {...withoutHerdr, XDG_STATE_HOME: dataDir}}); // the fake herdr, never the one the tests may run in
  const remote = expr => execFileSync('nvim', ['--server', server, '--remote-expr', expr], {encoding: 'utf8'}).trim();
  const keys = text => execFileSync('nvim', ['--server', server, '--remote-send', text]);
  const status = () => remote('luaeval("require(\'pair\').status()")');

  const chat = connect(config.socket);
  const messages = [];
  readMessages(chat, message => messages.push(message));
  chat.on('connect', () => sendMessage(chat, {type: 'hello', role: 'chat', cwd: project, herdr: {socket: herdrSocket, workspace: 'w1', pane: 'w1:p2'}}));
  try {
    await until(() => { try { return remote('1'); } catch { return false; } }, 'nvim to listen');
    await until(() => messages.some(message => message.text === 'Goal: poke the hash table'), 'the session');
    // The relay's first look at the board and herdr: what is there now is no news.
    const listed = statuses => {
      sendMessage(chat, {type: 'agents'});
      const list = messages.findLast(message => message.type === 'agent_list');
      return list?.items.map(item => item.status).join(' ') === statuses;
    };
    await until(() => listed('working working working'), 'the relay\'s first look');

    // You type; meanwhile #7 is ready to merge and the notes agent finishes.
    keys('o  int n = 0;');
    await sleep(200);
    setTasks({status: 'ready'});
    herdr.agents[1].agent_status = 'idle';
    for (let i = 0; i < 6; i++) {
      keys('x');
      await sleep(250);
    }
    // The daemon has heard both, and still says nothing while you type.
    await until(() => listed('ready done working'), 'the daemon to hear the news');
    keys('x');
    await sleep(200);
    assert.equal(status(), '● pair', 'nothing while you type');
    assert.ok(!messages.some(message => message.type === 'agents'));

    keys('<Esc>:w<CR>'); // a breakpoint
    const line = await until(() => (status().includes('◇') ? status() : null), 'the relayed line');
    assert.equal(line, `● pair  ◇ #7 ready to merge: Read every run +1  M-a · M-o opens · M-r reviews`);
    const relayed = await until(() => messages.find(message => message.type === 'agents'), 'the chat\'s copy of the line');
    assert.equal(relayed.text, '#7 ready to merge: Read every run');
    assert.equal(relayed.more, 1, 'the notes agent waits in the list: one line at a time');

    keys('<M-o>');
    await until(() => remote('get(g:, "pair_opened", "")') === pr.url, 'Alt-o to open its pull request');
    assert.match(status(), /M-a · M-o · M-r reviews$/, 'used once, the key needs no words');

    keys('<M-a>');
    await until(() => herdr.focused.length, 'the agent\'s pane to come to the front');
    assert.deepEqual(herdr.focused, ['w7:p1']);
    await until(() => status() === '● pair', 'the line to go once answered');

    keys(':Pair agents<CR>');
    await until(() => remote('bufname()') === 'pair://agents', 'the list');
    const lines = JSON.parse(remote('json_encode(getline(1, "$"))'));
    assert.deepEqual(lines.map(text => text.replace(/\s+/g, ' ').trim()), [
      'ready to merge #7 Read every run',
      'idle pi in notes notes',
      'working #8 Search trail · Reading the docs',
    ], 'what needs you first, what is done next, what still works last');
    assert.equal(remote('&l:winbar'), 'Enter goes · o report or PR · d diff · t terminal · r review · q closes');
    keys('1Gd');
    await until(() => remote('bufname()') === 'pair://agents/REP-7/diff', 'd: the diff of its branch');
    assert.deepEqual(JSON.parse(remote('json_encode([&l:filetype, &l:modifiable, &l:readonly])')), ['diff', 0, 1], 'read only');
    assert.ok(JSON.parse(remote('json_encode(getline(1, "$"))')).includes('+int every;'));
    keys('q');
    await until(() => remote('bufname()') === 'pair://agents', 'back in the list');
    keys('1Gt');
    await until(() => remote('&buftype') === 'terminal', 't: a terminal');
    assert.ok(remote('bufname()').startsWith(`term://${worktree}`), 'in the task\'s worktree');
    keys('<C-\\><C-n>:close<CR>');
    await until(() => remote('bufname()') === 'pair://agents', 'back in the list');
    // From the chat pane's relayed line, the diff opens in this Neovim.
    keys(':close<CR>');
    await until(() => remote('bufname()') !== 'pair://agents', 'the list to close');
    sendMessage(chat, {type: 'agent_link', key: 'task:REP-7', what: 'diff'});
    await until(() => remote('bufname()') === 'pair://agents/REP-7/diff', 'the chat\'s d: the diff in Neovim');
    keys('q:Pair agents<CR>');
    await until(() => remote('bufname()') === 'pair://agents', 'the list again');
    keys('3Gt');
    await until(() => remote('execute("messages")').includes('REP-8 has no worktree on this machine'), 'why there is none');
    keys('2G<CR>');
    await until(() => herdr.focused.length === 2, 'Enter on a line to go to that agent');
    assert.equal(herdr.focused[1], 'w9:p1');

    // #8 finishes; its agent's pane is gone. Alt-a cannot go there, and puts the line away.
    setTasks({status: 'ready'}, {status: 'done', sub: 'Merged'});
    await until(() => listed('ready done done'), 'the daemon to hear #8 finish');
    keys('<Esc>:w<CR>');
    await until(() => status().includes('#8 done'), 'the line about #8');
    assert.match(status(), /M-a · M-o$/, 'the key puts it away');
    keys('<M-a>');
    await until(() => status() === '● pair', 'the line to go');
    assert.equal(herdr.focused.length, 2, 'nothing was focused');
  } finally {
    chat.destroy();
    nvim.kill();
    await daemon.close();
    await herdr.close();
  }
});
