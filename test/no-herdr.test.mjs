// Pair without herdr, all inside Neovim: Scout's pane and the tests on save in a :terminal buffer, the Driver's
// `type` into one of your :terminal buffers, and the chat in one. A headless Neovim with the plugin against the
// daemon with scripted models; no herdr anywhere. Skips without nvim.
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall} from '@earendil-works/pi-ai';
import {parseConfig} from '../src/config.mjs';
import {startDaemon} from '../src/daemon.mjs';
import {client} from './daemon-client.mjs';
import {scratch, socketDir} from './temp.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const hasNvim = (() => { try { execFileSync('nvim', ['--version']); return true; } catch { return false; } })();
const skip = hasNvim ? false : 'nvim not installed';
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

/** A new folder removed when test `t` ends; a short one with `socket`, as socket paths max out near 100 bytes. */
function tempDir(t, prefix, {socket = false} = {}) {
  const dir = realpathSync(socket ? socketDir(prefix) : scratch(prefix));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

/**
 * The daemon with scripted models and a headless Neovim with the plugin in a scratch project, outside herdr,
 * with `:Pair start`. `chat()` connects a chat client as `pair chat` outside herdr does, `secondNvim()` starts one
 * more Neovim there. All end with test `t`.
 */
async function pairWithoutHerdr(t, {testOnSave} = {}) {
  const project = tempDir(t, 'pair-nvim-');
  writeFileSync(join(project, 'a.js'), 'const x = 1\n');
  const dataDir = tempDir(t, 'pair-data-', {socket: true});
  const raw = {
    dataDir,
    socket: join(dataDir, 'pair.sock'),
    testOnSave: testOnSave ? {[project]: testOnSave} : undefined,
    scoutPane: {sandbox: false},
    agents: false,
    board: null,
    models: {watcher: {api: 'openai', baseUrl: 'http://unused', model: 'w'}, partner: {api: 'openai', baseUrl: 'http://unused', model: 'p'}},
  };
  const config = parseConfig(raw);
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify(raw));
  const watcher = fauxProvider({provider: 'faux-watcher'});
  const partner = fauxProvider({provider: 'faux-partner', models: [{id: 'p'}]});
  const models = createModels();
  models.setProvider(watcher.provider);
  models.setProvider(partner.provider);
  watcher.setResponses(Array.from({length: 20}, () => fauxAssistantMessage([fauxText('0')]))); // no remarks
  const daemon = await startDaemon(config, {pairModels: {models, watcher: watcher.getModel(), partner: partner.getModel()}, probe: async () => ({ok: true}), log: () => {}});

  // No herdr in its environment, as in a plain terminal; PAIR_CONFIG for the `pair chat` that :Pair chat starts.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('HERDR_')));
  const status = () => new Promise(resolve => {
    const asking = client(config.socket, {type: 'status'});
    asking.next(message => message.type === 'status').then(reply => { asking.close(); resolve(reply); });
  });
  const nvims = [];
  const chats = [];
  t.after(async () => {
    for (const chat of chats) chat.close();
    for (const nvim of nvims) nvim.kill();
    await daemon.close();
  });
  /** One more headless Neovim in the project, the `count`th to connect: `{remote, lua, keys}` to drive it. */
  async function openNvim(count) {
    const server = join(dataDir, `nvim${count}.sock`);
    nvims.push(spawn('nvim', [
      '--headless', '--clean', '--listen', server,
      '--cmd', `set rtp+=${REPO}`,
      '-c', `lua require('pair').setup({socket = '${config.socket}', debounce_ms = 100})`,
      '-c', `cd ${project}`,
      '-c', 'edit a.js',
      '-c', 'Pair start no herdr',
    ], {stdio: 'ignore', env: {...env, PAIR_CONFIG: join(dataDir, 'config.json'), XDG_STATE_HOME: dataDir}}));
    const remote = expr => execFileSync('nvim', ['--server', server, '--remote-expr', expr], {encoding: 'utf8'}).trim();
    const vimString = text => `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
    const lua = code => JSON.parse(remote(`luaeval(${vimString(`vim.json.encode((function() ${code} end)())`)})`));
    const keys = text => execFileSync('nvim', ['--server', server, '--remote-send', text]);
    await until(() => { try { return remote('1'); } catch { return false; } }, 'nvim to listen');
    await until(async () => (await status()).sessions[0]?.editors === count, 'the plugin to connect');
    return {remote, lua, keys};
  }
  const {remote, lua, keys} = await openNvim(1);
  return {
    project, partner, remote, lua, keys, status,
    secondNvim: () => openNvim(2),
    async chat() {
      const chat = client(config.socket, {type: 'hello', role: 'chat', cwd: project, herdr: null});
      chats.push(chat);
      await chat.next(message => message.type === 'welcome');
      return chat;
    },
  };
}

const PANES = `local found = {} for _, buf in ipairs(vim.api.nvim_list_bufs()) do if vim.b[buf].pair_pane then table.insert(found, buf) end end return found`;
const toolResults = context => context.messages.filter(message => message.role === 'toolResult').map(message => message.content[0].text).join('\n');

test('without herdr, Scout runs its commands in a :terminal pane in Neovim, which closes with the switch back', {skip, timeout: 40_000}, async t => {
  const {partner, lua, remote, chat: openChat} = await pairWithoutHerdr(t);
  const chat = await openChat();
  chat.send({type: 'role', role: 'scout'});
  await chat.next(message => message.type === 'role' && message.role === 'scout');
  const [pane] = lua(PANES);
  assert.ok(pane, 'Pair\'s pane is a terminal buffer of the Neovim');
  assert.equal(remote('expand("%:t")'), 'a.js', 'you stay in your window');

  let result;
  partner.setResponses([
    fauxAssistantMessage([fauxToolCall('run', {command: 'echo from the pane; printf "a\\nb\\n" | wc -l; false'})], {stopReason: 'toolUse'}),
    context => { result = toolResults(context); return fauxAssistantMessage([fauxText('Ran it.')]); },
  ]);
  chat.send({type: 'ask', text: 'run it'});
  await chat.next(message => message.text === 'Ran it.');
  assert.match(result, /exit 1/);
  assert.match(result, /from the pane\n2/, 'the whole output, read from the shell\'s own files');
  const screen = lua(`return vim.api.nvim_buf_get_lines(${pane}, 0, -1, false)`).join('\n');
  assert.match(screen, /scout\[1\] exit 0 \$ echo from the pane/, 'the command is typed where you see it');

  chat.send({type: 'role', role: 'navigator'});
  await chat.next(message => message.type === 'role' && message.role === 'navigator');
  await until(() => lua(PANES).length === 0, 'the pane to close');
});

test('without herdr, the tests on save run in Neovim\'s pane and the statusline shows them', {skip, timeout: 40_000}, async t => {
  const {keys, remote} = await pairWithoutHerdr(t, {testOnSave: 'printf "ℹ tests 1\\nℹ pass 1\\nℹ fail 0\\n"'});
  const statusline = () => remote('luaeval("require(\'pair\').status()")');
  keys(':w<CR>');
  await until(() => /^✓ printf .* · 1 test$/.test(statusline()), 'the passing run in the statusline');
});

test('without herdr, the Driver types into the :terminal you used last, or another one you name, never with Enter', {skip, timeout: 40_000}, async t => {
  const {partner, lua, keys, chat: openChat} = await pairWithoutHerdr(t);
  const chat = await openChat();
  const shell = 'bash --norc --noprofile';
  keys(`:terminal ${shell}<CR>`);
  const first = await until(() => lua('return vim.bo.buftype == "terminal" and vim.api.nvim_get_current_buf() or false'), 'the first terminal');
  keys(`<C-\\><C-n>:terminal ${shell}<CR>`);
  const second = await until(() => lua(`local buf = vim.api.nvim_get_current_buf() return vim.bo.buftype == "terminal" and buf ~= ${first} and buf or false`), 'the second terminal');
  keys(`<C-\\><C-n>:buffer ${first}<CR>`);
  await sleep(300);
  keys('<C-\\><C-n>:edit a.js<CR>');
  const line = buf => lua(`return table.concat(vim.api.nvim_buf_get_lines(${buf}, 0, -1, false), "\\n")`);

  let reply;
  partner.setResponses([
    fauxAssistantMessage([fauxToolCall('type', {text: 'echo typed by pair'})], {stopReason: 'toolUse'}),
    context => { reply = toolResults(context); return fauxAssistantMessage([fauxText('Typed.')]); },
    fauxAssistantMessage([fauxToolCall('type', {text: 'echo second'})], {stopReason: 'toolUse'}),
    fauxAssistantMessage([fauxText('Typed there.')]),
  ]);
  chat.send({type: 'drive', text: 'type the command'});
  const question = await chat.next(message => message.type === 'confirm');
  assert.match(question.text, new RegExp(`into your terminal \\(pane nvim:${first}\\), without pressing Enter\\. Allow\\? \\(y, or another terminal: nvim:${second}\\)`));
  chat.send({type: 'confirm', id: question.id, ok: true, text: 'y'});
  await chat.next(message => message.text === 'Typed.');
  assert.match(reply, /^Typed\./);
  await until(() => /echo typed by pair$/m.test(line(first)), 'the text at the first terminal\'s prompt');
  await sleep(300);
  assert.doesNotMatch(line(first), /^typed by pair$/m, 'Enter stays with you: it did not run');

  chat.send({type: 'drive', text: 'again'});
  const again = await chat.next(message => message.type === 'confirm' && message.id !== question.id);
  chat.send({type: 'confirm', id: again.id, ok: false, text: `nvim:${second}`});
  await chat.next(message => message.text === 'Typed there.');
  await until(() => /echo second$/m.test(line(second)), 'the text in the terminal named in the answer');
  assert.doesNotMatch(line(first), /echo second/);
});

test(':Pair chat opens the chat in a terminal buffer, connected to the daemon outside herdr', {skip, timeout: 40_000}, async t => {
  const {keys, lua, status} = await pairWithoutHerdr(t);
  keys('<Esc>:Pair chat<CR>');
  await until(async () => (await status()).sessions[0]?.chats === 1, 'the chat in Neovim to connect');
  const chat = await until(() => lua('for _, buf in ipairs(vim.api.nvim_list_bufs()) do if vim.b[buf].pair_chat then return buf end end return false'), 'the chat buffer');
  const screen = () => lua(`return table.concat(vim.api.nvim_buf_get_lines(${chat}, 0, -1, false), "\\n")`);
  // The full-screen pane: its header names the project, the goal and the role; the prompt waits below.
  await until(() => /^ pair · \S+ · no herdr +navigator · normal/m.test(screen()) && /^› /m.test(screen()), 'the chat\'s header and prompt');
  assert.equal((await status()).sessions[0].herdr, false, 'not a herdr chat pane');
});

test('two Neovims with a :terminal in the same buffer: the question tells them apart, and the answer types into the one it names', {skip, timeout: 40_000}, async t => {
  const {partner, lua, keys, secondNvim, chat: openChat} = await pairWithoutHerdr(t);
  const other = await secondNvim();
  const chat = await openChat();
  const shell = 'bash --norc --noprofile';
  const opened = async nvim => {
    nvim.keys(`:terminal ${shell}<CR>`);
    return until(() => nvim.lua('return vim.bo.buftype == "terminal" and vim.api.nvim_get_current_buf() or false'), 'a terminal');
  };
  const otherBuf = await opened(other);
  const buf = await opened({lua, keys}); // the first Neovim's, used last: the target
  assert.equal(buf, otherBuf, 'the same buffer number in both');
  const [pid, otherPid] = [lua('return vim.fn.getpid()'), other.lua('return vim.fn.getpid()')];
  const screen = nvim => nvim.lua(`return table.concat(vim.api.nvim_buf_get_lines(${buf}, 0, -1, false), "\\n")`);

  partner.setResponses([
    fauxAssistantMessage([fauxToolCall('type', {text: 'echo hi'})], {stopReason: 'toolUse'}),
    fauxAssistantMessage([fauxText('Typed there.')]),
  ]);
  chat.send({type: 'drive', text: 'type it'});
  const question = await chat.next(message => message.type === 'confirm');
  assert.match(question.text, new RegExp(`\\(pane nvim:${pid}:${buf}\\), without pressing Enter\\. Allow\\? \\(y, or another terminal: nvim:${otherPid}:${buf}\\)$`));
  chat.send({type: 'confirm', id: question.id, ok: false, text: `nvim:${otherPid}:${buf}`});
  await chat.next(message => message.text === 'Typed there.');
  await until(() => /echo hi$/m.test(screen(other)), 'the text in the other Neovim\'s terminal');
  assert.doesNotMatch(screen({lua}), /echo hi/, 'not in the target the question named first');
});

test('without herdr, Pair reads the commands you run in your own :terminal and their output', {skip, timeout: 60_000}, async t => {
  const {keys, lua, chat: openChat, project} = await pairWithoutHerdr(t);
  const chat = await openChat();
  const card = async () => { // the context card as it is now: chat.next would find the first one again
    const from = chat.received.length;
    chat.send({type: 'context'});
    return JSON.stringify(await until(() => chat.received.slice(from).find(message => message.type === 'context'), 'the card'));
  };
  // Its history goes to the project, not to yours.
  keys(`:terminal env HISTFILE=${join(project, '.history')} bash --norc --noprofile<CR>`);
  await until(() => lua('return vim.bo.buftype == "terminal"'), 'the terminal');
  keys('i');
  await until(() => /\$ $/.test(lua('return table.concat(vim.api.nvim_buf_get_lines(0, 0, -1, false), "\\n")').trimEnd() + ' '), 'the prompt');
  await sleep(1000); // Pair reads it, as you would before typing
  // Seen running (sleep is the shell's foreground process), then read from the buffer when the prompt is back.
  keys('sleep 1; echo some error here<CR>');
  await until(async () => /sleep 1; echo some error here` failed: some error here/.test(await card()), 'the command and its output on the card');

  // With the shell hook: the exit code, and the output of the terminal its shell's pid names.
  keys(`source <lt>(${process.execPath} ${join(REPO, 'bin', 'pair.mjs')} shell-hook bash)<CR>`);
  await sleep(500);
  keys('echo from the hooked shell; (exit 3)<CR>');
  await until(async () => /echo from the hooked shell; \(exit 3\)` failed \(exit 3\): from the hooked shell/.test(await card()), 'the hook\'s command with its output');
});
