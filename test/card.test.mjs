// :Pair context in a headless Neovim against the daemon: the card, live, and trimmed with x. Skips without nvim.
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {createModels, fauxProvider} from '@earendil-works/pi-ai';
import {parseConfig} from '../src/config.mjs';
import {startDaemon} from '../src/daemon.mjs';

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

test(':Pair context shows the goal and every source, where you have been, and x hides a source and brings it back', {skip: hasNvim ? false : 'nvim not installed', timeout: 30_000}, async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'pair-card-')));
  execFileSync('git', ['init', '-q', '-b', 'work/3-faster-hash'], {cwd: project});
  writeFileSync(join(project, 'probe.c'), 'int probe(int n) {\n  return n * 31;\n}\n');
  writeFileSync(join(project, 'main.c'), 'int main(void) {\n  return probe(3);\n}\n');
  execFileSync('git', ['-c', 'user.name=dev', '-c', 'user.email=dev@example.com', 'commit', '-q', '--allow-empty', '-m', 'start'], {cwd: project});
  const dataDir = mkdtempSync(join(tmpdir(), 'pair-data-'));
  const config = parseConfig({
    dataDir, socket: join(dataDir, 'pair.sock'), board: null, agents: false,
    models: {watcher: {api: 'openai', baseUrl: 'http://unused', model: 'w'}, partner: {api: 'openai', baseUrl: 'http://unused', model: 'p'}},
  });
  const watcher = fauxProvider({provider: 'faux-watcher'});
  const partner = fauxProvider({provider: 'faux-partner'});
  const models = createModels();
  models.setProvider(watcher.provider);
  models.setProvider(partner.provider);
  const daemon = await startDaemon(config, {pairModels: {models, watcher: watcher.getModel(), partner: partner.getModel()}, probe: async () => ({ok: true}), log: () => {}});

  const server = join(mkdtempSync('/tmp/pair-'), 'nvim.sock');
  const nvim = spawn('nvim', [
    '--headless', '--clean', '--listen', server,
    '--cmd', `set rtp+=${REPO}`,
    '-c', `lua require('pair').setup({socket = '${config.socket}', debounce_ms = 100})`,
    '-c', `cd ${project}`,
    '-c', 'edit main.c',
    '-c', 'Pair start',
  ], {stdio: 'ignore'});
  const remote = expr => execFileSync('nvim', ['--server', server, '--remote-expr', expr], {encoding: 'utf8'}).trim();
  const keys = text => execFileSync('nvim', ['--server', server, '--remote-send', text]);
  const cardLines = () => JSON.parse(remote('luaeval("vim.json.encode(vim.bo.filetype == \'paircard\' and vim.api.nvim_buf_get_lines(0, 0, -1, false) or {})")'));
  try {
    await until(() => { try { return remote('1'); } catch { return false; } }, 'nvim to listen');
    keys(':edit probe.c<CR>2G');
    await sleep(300);
    keys(':Pair context<CR>');
    const lines = await until(() => cardLines().length && cardLines(), 'the card');
    const text = lines.join('\n');
    assert.match(text, /^ :Pair context$/m);
    assert.match(text, /^ {3}goal {6}faster hash · from the branch work\/3-faster-hash$/m, 'the goal, from the branch: nothing was asked');
    assert.match(text, /^ git\n {3}branch {4}work\/3-faster-hash$/m);
    assert.match(text, /^ {3}buffers {3}probe\.c {2}main\.c$/m, 'the buffers, the one used last first');
    assert.match(text, /^ {3}jumps {5}main\.c:1$/m, 'where you jumped from');
    assert.doesNotMatch(text, /^ board$/m, 'no board configured: no board source');

    const gitLine = lines.findIndex(line => line === ' git') + 1;
    keys(`${gitLine}Gx`);
    await until(() => cardLines().includes(' git  hidden for this session · x brings it back'), 'git hidden');
    keys(`${gitLine}Gx`);
    await until(() => cardLines().includes(' git'), 'git back');
    keys('q');
    await until(() => remote('&filetype') === 'c', 'the card closed');
  } finally {
    nvim.kill();
    await daemon.close();
  }
});

test(':Pair context before Neovim is connected says so instead of doing nothing', {skip: hasNvim ? false : 'nvim not installed', timeout: 10_000}, () => {
  const out = execFileSync('nvim', [
    '--headless', '--clean', '--cmd', `set rtp+=${REPO}`,
    '-c', 'lua require(\'pair\').setup({socket = \'/nonexistent/pair.sock\'})',
    '-c', 'Pair context',
    '-c', 'lua io.stdout:write(vim.fn.execute("messages"))',
    '-c', 'qa!',
  ], {encoding: 'utf8'});
  assert.match(out, /Pair: not connected, so there is no card; :Pair start connects/);
});
