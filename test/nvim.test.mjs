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

test('the plugin reports edits, diagnostics and the selection, shows points and serves unsaved text to read', {skip: hasNvim ? false : 'nvim not installed', timeout: 30_000}, async () => {
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

  const server = join(mkdtempSync('/tmp/pair-'), 'nvim.sock'); // short: socket paths max out near 100 bytes
  const nvim = spawn('nvim', [
    '--headless', '--clean', '--listen', server,
    '--cmd', `set rtp+=${REPO}`,
    '-c', `lua require('pair').setup({socket = '${config.socket}', debounce_ms = 100})`,
    '-c', `cd ${project}`,
    '-c', 'edit a.js',
    '-c', 'Pair start make x two',
  ], {stdio: 'ignore'});
  const remote = expr => execFileSync('nvim', ['--server', server, '--remote-expr', expr], {encoding: 'utf8'}).trim();

  const chat = connect(config.socket);
  const messages = [];
  readMessages(chat, message => messages.push(message));
  chat.on('connect', () => sendMessage(chat, {type: 'hello', role: 'chat', cwd: project}));

  try {
    await until(() => { try { return remote('1'); } catch { return false; } }, 'nvim to listen');
    await until(() => messages.some(message => message.text === 'Goal: make x two'), 'the goal from :Pair start');
    execFileSync('nvim', ['--server', server, '--remote-send', 'ccconst x = 2<Esc>']);
    remote(`luaeval("vim.diagnostic.set(vim.api.nvim_create_namespace('lsp'), 0, {{lnum = 0, col = 6, severity = 1, message = 'x is never read'}}) or 0")`);
    await sleep(500); // the plugin's 100 ms debounce, then the daemon folds the edit and the diagnostic
    execFileSync('nvim', ['--server', server, '--remote-send', 'Vj']);
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
    sendMessage(chat, {type: 'ask', text: 'is it right?'});
    await until(() => messages.some(message => message.text === 'Looks right.'), 'the answer');

    assert.match(seen, /Recent edits: a\.js:1-1/, 'the edit reached the session state');
    assert.match(seen, /a\.js:1 error: x is never read/, 'the diagnostic reached the session state');
    assert.match(seen, /cursor at line 2, selected lines 1-2/, 'the visual selection reached the session state');
    assert.match(seen, /1: const x = 2/, 'read returned the unsaved buffer text');
    assert.equal(readFileSync(join(project, 'a.js'), 'utf8'), 'const x = 1\nconst y = 2\nconst z = 3\n', 'nothing was written to disk');
    const marks = await until(() => Number(remote(`luaeval("#vim.api.nvim_buf_get_extmarks(0, vim.api.nvim_create_namespace('pair'), 0, -1, {})")`)), 'the point extmark');
    assert.equal(marks, 1);
  } finally {
    chat.destroy();
    nvim.kill();
    await daemon.close();
  }
});
