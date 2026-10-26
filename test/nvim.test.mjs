// The Lua plugin in a headless Neovim against the daemon, with scripted models. Skips without nvim.
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {connect} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall} from '@earendil-works/pi-ai';
import {parseConfig} from '../src/config.mjs';
import {startDaemon} from '../src/daemon.mjs';
import {readMessages, sendMessage} from '../src/protocol.mjs';
import {fakeHerdr} from './fake-herdr.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const hasNvim = (() => { try { execFileSync('nvim', ['--version']); return true; } catch { return false; } })();
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

/**
 * The daemon with scripted models, a fake herdr, a headless Neovim with the plugin editing a.js and running
 * `:Pair start <goal>`, and a chat client. `stop()` ends them all.
 */
async function pairInNvim(goal) {
  const project = mkdtempSync(join(tmpdir(), 'pair-nvim-'));
  writeFileSync(join(project, 'a.js'), 'const x = 1\nconst y = 2\nconst z = 3\n');
  const dataDir = mkdtempSync(join(tmpdir(), 'pair-data-'));
  const config = parseConfig({
    dataDir,
    socket: join(dataDir, 'pair.sock'),
    models: {watcher: {api: 'openai', baseUrl: 'http://unused', model: 'w'}, partner: {api: 'openai', baseUrl: 'http://unused', model: 'p'}},
  });
  const watcher = fauxProvider({provider: 'faux-watcher'});
  const partner = fauxProvider({provider: 'faux-partner'});
  const models = createModels();
  models.setProvider(watcher.provider);
  models.setProvider(partner.provider);
  const daemon = await startDaemon(config, {pairModels: {models, watcher: watcher.getModel(), partner: partner.getModel()}, log: () => {}});
  const herdrSocket = join(dataDir, 'herdr.sock');
  const herdr = await fakeHerdr(herdrSocket);

  const server = join(mkdtempSync('/tmp/pair-'), 'nvim.sock'); // short: socket paths max out near 100 bytes
  const nvim = spawn('nvim', [
    '--headless', '--clean', '--listen', server,
    '--cmd', `set rtp+=${REPO}`,
    '-c', `lua require('pair').setup({socket = '${config.socket}', debounce_ms = 100})`,
    '-c', `cd ${project}`,
    '-c', 'edit a.js',
    '-c', `Pair start ${goal}`,
  ], {stdio: 'ignore'});
  const remote = expr => execFileSync('nvim', ['--server', server, '--remote-expr', expr], {encoding: 'utf8'}).trim();
  const keys = text => execFileSync('nvim', ['--server', server, '--remote-send', text]);

  const chat = connect(config.socket);
  const messages = [];
  readMessages(chat, message => messages.push(message));
  chat.on('connect', () => sendMessage(chat, {type: 'hello', role: 'chat', cwd: project, herdr: {socket: herdrSocket, workspace: 'w1', pane: 'w1:p2'}}));
  await until(() => { try { return remote('1'); } catch { return false; } }, 'nvim to listen');
  await until(() => messages.some(message => message.text === `Goal: ${goal}`), 'the goal from :Pair start');

  return {
    project, partner, messages, remote, keys,
    send: message => sendMessage(chat, message),
    lines: () => JSON.parse(remote('json_encode(getline(1, "$"))')),
    status: () => remote('luaeval("require(\'pair\').status()")'),
    async stop() {
      chat.destroy();
      nvim.kill();
      await daemon.close();
      await herdr.close();
    },
  };
}

test('the plugin reports edits, diagnostics and the selection, shows points, serves unsaved text and switches roles', {skip: hasNvim ? false : 'nvim not installed', timeout: 30_000}, async () => {
  const {project, partner, messages, remote, keys, send, status, stop} = await pairInNvim('make x two');
  try {
    keys('ccconst x = 2<Esc>');
    remote(`luaeval("vim.diagnostic.set(vim.api.nvim_create_namespace('lsp'), 0, {{lnum = 0, col = 6, severity = 1, message = 'x is never read'}}) or 0")`);
    await sleep(500); // the plugin's 100 ms debounce, then the daemon folds the edit and the diagnostic
    keys('Vj');
    await sleep(600); // the selection is sent once it has been still for 300 ms, while still in Visual mode

    let seen;
    partner.setResponses([
      context => {
        seen = context.messages.at(-1).content;
        return fauxAssistantMessage([fauxToolCall('read', {file: 'a.js'}), fauxToolCall('point', {file: 'a.js', line: 1, note: 'two now'})], {stopReason: 'toolUse'});
      },
      context => {
        seen += context.messages.filter(message => message.role === 'toolResult').map(message => message.content[0].text).join('\n');
        return fauxAssistantMessage([fauxText('Looks right.')]);
      },
    ]);
    send({type: 'ask', text: 'is it right?'});
    await until(() => messages.some(message => message.text === 'Looks right.'), 'the answer');

    assert.match(seen, /Recent edits: a\.js:1-1/, 'the edit reached the session state');
    assert.match(seen, /a\.js:1 error: x is never read/, 'the diagnostic reached the session state');
    assert.match(seen, /cursor at line 2, selected lines 1-2/, 'the visual selection reached the session state');
    assert.match(seen, /1: const x = 2/, 'read returned the unsaved buffer text');
    assert.equal(readFileSync(join(project, 'a.js'), 'utf8'), 'const x = 1\nconst y = 2\nconst z = 3\n', 'nothing was written to disk');
    const marks = await until(() => Number(remote(`luaeval("#vim.api.nvim_buf_get_extmarks(0, vim.api.nvim_create_namespace('pair'), 0, -1, {})")`)), 'the point extmark');
    assert.equal(marks, 1);

    assert.equal(status(), 'Pair: navigator · normal');
    keys('<Esc>:Pair scout<CR>');
    await until(() => status() === 'Pair: scout · normal', 'the statusline to show Scout');
    keys('<Esc>:Pair navigate<CR>');
    await until(() => status() === 'Pair: navigator · normal', 'the statusline to show Navigator again');
  } finally {
    await stop();
  }
});

test('suggestions show as a ghost diff that one key accepts; handing over gives one undoable, unsaved edit; any key takes the wheel back', {skip: hasNvim ? false : 'nvim not installed', timeout: 40_000}, async () => {
  const {project, partner, messages, remote, keys, send, lines, status, stop} = await pairInNvim('tune the numbers');
  const ghosts = () => Number(remote(`luaeval("#vim.api.nvim_buf_get_extmarks(0, vim.api.nvim_create_namespace('pair_suggest'), 0, -1, {})")`));
  const answered = text => until(() => messages.some(message => message.text === text), `the answer "${text}"`);
  const onDisk = () => readFileSync(join(project, 'a.js'), 'utf8');
  const toolResult = context => context.messages.filter(message => message.role === 'toolResult').at(-1).content[0].text;
  try {
    // A suggestion changes nothing until the accept key.
    partner.setResponses([
      fauxAssistantMessage([fauxToolCall('suggest', {file: 'a.js', line: 2, new_text: 'const y = 20', note: 'twenty'})], {stopReason: 'toolUse'}),
      fauxAssistantMessage([fauxText('Try 20.')]),
    ]);
    send({type: 'ask', text: 'what should y be?'});
    await answered('Try 20.');
    await until(() => ghosts() === 2, 'the ghost diff');
    assert.deepEqual(lines(), ['const x = 1', 'const y = 2', 'const z = 3']);
    keys('<Tab>');
    await until(() => lines()[1] === 'const y = 20', 'the accepted suggestion');
    assert.equal(ghosts(), 0);

    // Editing the suggested lines yourself ignores the suggestion; the accept key then does nothing.
    partner.setResponses([
      fauxAssistantMessage([fauxToolCall('suggest', {file: 'a.js', line: 3, new_text: 'const z = 30', note: 'thirty'})], {stopReason: 'toolUse'}),
      fauxAssistantMessage([fauxText('Try 30.')]),
    ]);
    send({type: 'ask', text: 'and z?'});
    await answered('Try 30.');
    await until(() => ghosts() === 2, 'the second ghost diff');
    keys('3Gccconst z = 4<Esc>');
    await until(() => ghosts() === 0, 'the ignored suggestion to go');
    keys('<Tab>');
    await sleep(200);
    assert.deepEqual(lines(), ['const x = 1', 'const y = 20', 'const z = 4']);

    // "your turn": Pair reads, makes one edit as Driver, and hands back by itself.
    let read;
    partner.setResponses([
      fauxAssistantMessage([fauxToolCall('read', {file: 'a.js'})], {stopReason: 'toolUse'}),
      context => {
        read = toolResult(context);
        return fauxAssistantMessage([fauxToolCall('edit', {file: 'a.js', line: 1, new_text: 'const x = 100'})], {stopReason: 'toolUse'});
      },
      fauxAssistantMessage([fauxText('Set x to 100.')]),
    ]);
    send({type: 'drive', text: 'your turn'});
    await answered('Set x to 100.');
    assert.match(read, /3: const z = 4/, 'Pair read the unsaved buffer');
    assert.deepEqual(lines(), ['const x = 100', 'const y = 20', 'const z = 4']);
    await until(() => status() === 'Pair: navigator · normal', 'Pair to hand back');
    assert.equal(onDisk(), 'const x = 1\nconst y = 2\nconst z = 3\n', 'nothing was saved');
    keys('u');
    await until(() => lines()[0] === 'const x = 1', 'one undo to remove Pair\'s edit');
    assert.deepEqual(lines(), ['const x = 1', 'const y = 20', 'const z = 4'], 'and only Pair\'s edit');

    // A key pressed while Pair has the wheel takes it back before the edit lands.
    let refused;
    partner.setResponses([
      async () => {
        await until(() => status() === 'Pair: driver · normal', 'the statusline to show the Driver');
        keys('j');
        await until(() => messages.some(message => message.text === 'You have the wheel back.'), 'the take-back');
        return fauxAssistantMessage([fauxToolCall('edit', {file: 'a.js', line: 1, new_text: 'const x = 7'})], {stopReason: 'toolUse'});
      },
      context => { refused = toolResult(context); return fauxAssistantMessage([fauxText('Okay, yours.')]); },
    ]);
    keys(':Pair drive set x to 7<CR>');
    await answered('Okay, yours.');
    assert.match(refused, /only while the user hands you the wheel/, 'the policy refused the edit, with a reason');
    assert.equal(lines()[0], 'const x = 1');
    assert.equal(status(), 'Pair: navigator · normal');
  } finally {
    await stop();
  }
});
