// The morning pick-up in a headless Neovim, against a stand-in daemon: an empty Neovim lands where you stopped, the
// statusline catches up, one line goes under that line, and Alt-j goes to the test that was failing. A Neovim
// opened on another file stays there. Skips without nvim.
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
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

/** A Neovim with the plugin, opened with `args`, connected to a stand-in daemon that greets it. */
async function nvimWith(project, args) {
  const dir = mkdtempSync('/tmp/pair-');
  let editor;
  const received = [];
  const server = createServer(socket => {
    editor = socket;
    readMessages(socket, message => received.push(message));
  });
  await new Promise(resolve => server.listen(join(dir, 'pair.sock'), resolve));
  const nvimSocket = join(dir, 'nvim.sock');
  const nvim = spawn('nvim', ['--headless', '--clean', '--listen', nvimSocket, '--cmd', `set rtp+=${REPO}`, '--cmd', `cd ${project}`,
    '-c', `lua require('pair').setup({socket = '${join(dir, 'pair.sock')}'})`, ...args, '-c', 'Pair start'], {stdio: 'ignore'});
  const remote = expr => execFileSync('nvim', ['--server', nvimSocket, '--remote-expr', expr], {encoding: 'utf8'}).trim();
  await until(() => editor && received.some(message => message.type === 'hello'), 'the plugin to connect');
  sendMessage(editor, {type: 'welcome', root: project, level: 'normal', role: 'navigator', models: {}});
  return {
    send: message => sendMessage(editor, message),
    remote,
    status: () => remote('luaeval("require(\'pair\').status()")'),
    /** The words under the lines of the current buffer: [row, text]. */
    words: () => JSON.parse(remote(`luaeval("vim.json.encode(vim.api.nvim_buf_get_extmarks(0, vim.api.nvim_create_namespace('pair'), 0, -1, {details = true}))")`))
      .filter(([, , , details]) => details.virt_lines)
      .map(([, row, , details]) => [row, details.virt_lines.map(line => line.map(chunk => chunk[0]).join('')).join('\n')]),
    stop() {
      nvim.kill();
      server.close();
    },
  };
}

function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pair-nvim-')));
  writeFileSync(join(root, 'queue.go'), 'package queue\n\nfunc New() *Queue {\n\treturn &Queue{ttl: cfg.Budget}\n}\n');
  writeFileSync(join(root, 'queue_test.go'), 'package queue\n\nfunc TestNoDoubleDelivery(t *testing.T) {\n\tt.Fatal("twice")\n}\n');
  writeFileSync(join(root, 'notes.md'), '# notes\n');
  return root;
}

test('an empty Neovim lands where you stopped; one line under it; Alt-j goes to the failing test', {skip: hasNvim ? false : 'nvim not installed', timeout: 20_000}, async () => {
  const root = project();
  const nvim = await nvimWith(root, []);
  try {
    const file = join(root, 'queue.go');
    nvim.send({type: 'land', file, line: 4});
    await until(() => nvim.remote('expand("%:t")') === 'queue.go', 'Neovim to land');
    assert.equal(nvim.remote('line(".")'), '4');
    assert.equal(nvim.remote('col(".")'), '2', 'on the code, past the indent');
    assert.match(nvim.status(), /pair · catching up/);
    nvim.send({type: 'pickup', file, line: 4, text: 'Morning. The lease still ends at `cfg.Budget`.', code: 'cfg.Budget', jump: {file: join(root, 'queue_test.go'), line: 4, what: 'the failing test'}});
    await until(() => nvim.words().length, 'the line under it');
    const [[row, text]] = nvim.words();
    assert.equal(row, 3);
    assert.match(text, /Morning\. The lease still ends at cfg\.Budget\.\s+M-j the failing test$/);
    assert.doesNotMatch(nvim.status(), /catching up/);
    nvim.remote('execute("Pair jump")');
    await until(() => nvim.remote('expand("%:t")') === 'queue_test.go', 'Alt-j to the failing test');
    assert.equal(nvim.remote('line(".")'), '4');

    // The day's end without a chat pane: a panel, which q closes.
    nvim.send({type: 'debrief', text: 'Day\'s end: 3 h 05 min in hookd.\n✓ leases outlast the last attempt\nTomorrow, first: give send() a context, in worker.go:27.'});
    await until(() => nvim.remote('win_gettype()') === 'popup', 'the debrief panel');
    assert.match(nvim.remote('join(getline(1, "$"), "|")'), /^Day's end: 3 h 05 min in hookd\.\|✓ leases outlast the last attempt\|Tomorrow, first: .*\|\|q closes/);
    nvim.remote('feedkeys("q", "x")');
    await until(() => nvim.remote('win_gettype()') === '', 'q to close it');
  } finally {
    nvim.stop();
  }
});

test('a Neovim opened on another file stays there; the line goes under yours, and Alt-j goes where you stopped', {skip: hasNvim ? false : 'nvim not installed', timeout: 20_000}, async () => {
  const root = project();
  const nvim = await nvimWith(root, ['-c', 'edit notes.md']);
  try {
    const file = join(root, 'queue.go');
    nvim.send({type: 'land', file, line: 4});
    nvim.send({type: 'pickup', file, line: 4, text: 'Where you stopped: lease past the last attempt.', jump: null});
    await until(() => nvim.words().length, 'the line under yours');
    assert.equal(nvim.remote('expand("%:t")'), 'notes.md', 'your cursor stays');
    assert.match(nvim.words()[0][1], /Where you stopped: lease past the last attempt\.\s+M-j where you stopped$/);
    nvim.remote('execute("Pair jump")');
    await until(() => nvim.remote('expand("%:t")') === 'queue.go', 'Alt-j to the place');
    assert.equal(nvim.remote('line(".")'), '4');
  } finally {
    nvim.stop();
  }
});
