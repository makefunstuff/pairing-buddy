// The Lua plugin in a headless Neovim against the daemon, with scripted models. Skips without nvim.
import assert from 'node:assert/strict';
import {execFile, execFileSync, spawn} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {connect} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall} from '@earendil-works/pi-ai';
import {parseConfig} from '../src/config.mjs';
import {startDaemon} from '../src/daemon.mjs';
import {readMessages, sendMessage} from '../src/protocol.mjs';
import {openStore} from '../src/store.mjs';
import {fakeHerdr} from './fake-herdr.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const hasNvim = (() => { try { execFileSync('nvim', ['--version']); return true; } catch { return false; } })();
const answers = async () => ({ok: true}); // the scripted models are not probed
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

/** Runs a command line in `cwd` with bash, as Pair's pane would: its output and exit code. */
const runIn = cwd => command => new Promise(resolve => {
  execFile('bash', ['-c', command], {cwd}, (error, stdout, stderr) => resolve({output: stdout + stderr, exit: error ? error.code ?? 1 : 0}));
});

/**
 * The daemon with scripted models, a fake herdr, a headless Neovim with the plugin editing a.js and running
 * `:Pair start <goal>`, and a chat client. With `testOnSave`, saving runs that command in the project, for real,
 * in the fake herdr's pane. With `thinks`, the Partner's model can think. `stop()` ends them all.
 */
async function pairInNvim(goal, {testOnSave, thinks = false} = {}) {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'pair-nvim-')));
  writeFileSync(join(project, 'a.js'), 'const x = 1\nconst y = 2\nconst z = 3\n');
  const dataDir = mkdtempSync(join(tmpdir(), 'pair-data-'));
  const config = parseConfig({
    dataDir,
    socket: join(dataDir, 'pair.sock'),
    testOnSave: testOnSave ? {[project]: testOnSave} : undefined,
    models: {watcher: {api: 'openai', baseUrl: 'http://unused', model: 'w'}, partner: {api: 'openai', baseUrl: 'http://unused', model: 'p'}},
  });
  const watcher = fauxProvider({provider: 'faux-watcher'});
  const partner = fauxProvider({provider: 'faux-partner', models: [{id: 'p', reasoning: thinks}]});
  const models = createModels();
  models.setProvider(watcher.provider);
  models.setProvider(partner.provider);
  const pairModels = {models, watcher: watcher.getModel(), partner: partner.getModel()};
  let daemon = await startDaemon(config, {pairModels, probe: answers, log: () => {}});
  const herdrSocket = join(dataDir, 'herdr.sock');
  const herdr = await fakeHerdr(herdrSocket, {commands: testOnSave ? runIn(project) : {}});

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
    project, dataDir, watcher, partner, messages, remote, keys,
    send: message => sendMessage(chat, message),
    lines: () => JSON.parse(remote('json_encode(getline(1, "$"))')),
    status: () => remote('luaeval("require(\'pair\').status()")'),
    /** Stops the daemon, waits `downMs`, and starts a new one that probes the models with `probe`. */
    async restartDaemon({downMs = 0, probe = answers} = {}) {
      await daemon.close();
      await sleep(downMs);
      daemon = await startDaemon(config, {pairModels, probe, log: () => {}});
    },
    async stop() {
      chat.destroy();
      nvim.kill();
      await daemon.close();
      await herdr.close();
    },
  };
}

test('the plugin reports edits, diagnostics and the selection, shows points, serves unsaved text and switches roles', {skip: hasNvim ? false : 'nvim not installed', timeout: 30_000}, async () => {
  const {project, watcher, partner, messages, remote, keys, send, status, stop} = await pairInNvim('make x two');
  try {
    watcher.setResponses(Array.from({length: 10}, () => fauxAssistantMessage([fauxText('0')]))); // nothing worth a remark
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
    const marks = await until(() => Number(remote(`luaeval("#vim.api.nvim_buf_get_extmarks(0, vim.api.nvim_create_namespace('pair'), 0, -1, {})")`)), 'the point extmarks');
    assert.equal(marks, 2, 'the marked lines, and the note');

    assert.equal(status(), '● reading a.js', 'the statusline names the file Pair just read');
    await until(() => status() === '● pair', 'the statusline to let it go again');
    keys('<Esc>:Pair scout<CR>');
    await until(() => status() === '● pair · scout', 'the statusline to show Scout');
    keys('<Esc>:Pair navigate<CR>');
    await until(() => status() === '● pair', 'the statusline to show Navigator again');
  } finally {
    await stop();
  }
});

test('the wrong turn: Pair\'s words show under your line, the jump key goes to the cause, and your next edit answers them', {skip: hasNvim ? false : 'nvim not installed', timeout: 30_000}, async () => {
  const {project, dataDir, watcher, partner, messages, remote, keys, send, status, stop} = await pairInNvim('retries pass');
  const extmarks = buffer => JSON.parse(remote(`luaeval("vim.json.encode(vim.api.nvim_buf_get_extmarks(${buffer}, vim.api.nvim_create_namespace('pair'), 0, -1, {details = true}))")`));
  const words = () => extmarks(0).filter(([, , , details]) => details.virt_lines)
    .map(([, row, , details]) => [row, details.virt_lines.map(line => line.map(chunk => chunk[0]).join('').trim())]);
  const remarks = () => {
    const store = openStore(join(dataDir, 'sessions.sqlite'));
    try { return store.remarks(0); } finally { store.close(); }
  };
  try {
    writeFileSync(join(project, 'worker.js'), 'export function run(elapsed, wait, budget) {\n  if (elapsed + wait >= budget) return false\n  return true\n}\n');
    watcher.setResponses([fauxAssistantMessage([fauxText('9')]), ...Array.from({length: 10}, () => fauxAssistantMessage([fauxText('0')]))]);
    partner.setResponses([
      fauxAssistantMessage([fauxToolCall('read', {file: 'a.js'}), fauxToolCall('read', {file: 'worker.js'})], {stopReason: 'toolUse'}),
      fauxAssistantMessage([fauxToolCall('point', {file: 'worker.js', line: 2, note: '7 + 8 = 15: still inside', code: '>='})], {stopReason: 'toolUse'}),
      fauxAssistantMessage([fauxText('The shift is fine.\nAttempt 5 lands at exactly 15, and `worker.js:2` gives up on `>=`.')]),
    ]);
    // The tests went red in the pane you were watching; the failure names worker.test.js.
    send({type: 'event', event: {kind: 'focus', target: 'terminal', pane: 'w1:p1'}});
    send({type: 'event', event: {kind: 'command_end', pane: 'w1:p1', cmd: 'npm test', exit: 1,
      output: '✖ retries five times (1.2ms)\n  worker.test.js:3: attempts = 4, want 5\nℹ tests 1\nℹ fail 1'}});
    await sleep(200);
    keys('3Gccconst z = 4<Esc>'); // a wrong turn in a.js
    const shown = await until(() => words().length && words(), 'Pair\'s words under the line');
    assert.deepEqual(shown, [[2, ['● The shift is fine.', 'Attempt 5 lands at exactly 15, and worker.js:2 gives up on >=.   M-j']]],
      'under the line you are on, the code without backticks, the jump key at the end');
    assert.equal(remote('mode()'), 'n', 'nothing moved you');
    assert.equal(remote('expand("%:t")'), 'a.js');

    keys('<M-j>');
    await until(() => remote('expand("%:t")') === 'worker.js', 'the jump to the cause');
    assert.deepEqual(JSON.parse(remote('json_encode(getpos("."))')).slice(1, 3), [2, 22], 'on the >=, which the point underlines');
    const marks = extmarks(0);
    assert.ok(marks.some(([, , , details]) => details.hl_group === 'PairSpan'), 'the code is underlined');
    assert.ok(marks.some(([, , , details]) => details.line_hl_group === 'PairPoint' && details.sign_text?.trim() === '▎'), 'the line is tinted and signed');
    assert.deepEqual(words(), [], 'its note fits after the line here, so nothing is under it');
    await until(() => remarks()[0].verdict === 'seen', 'going there to answer the remark: seen');

    keys('<C-o>');
    await until(() => remote('expand("%:t")') === 'a.js', 'Ctrl-O back');
    keys('2Gccconst y = 3<Esc>');
    await sleep(300);
    assert.equal(remarks()[0].trigger, 'edit_while_red');
    await until(() => status() === '● pair', 'the statusline back to rest');

    // A question about selected lines: the Partner gets them.
    let input;
    partner.setResponses([context => { input = context.messages.at(-1).content; return fauxAssistantMessage([fauxText('It sets z.')]); }]);
    keys(':2,3Pair ask what is this?<CR>');
    await until(() => messages.some(message => message.text === 'It sets z.'), 'the answer');
    assert.match(input, /About lines 2-3 of a\.js, which the user selected:\n2: const y = 3\n3: const z = 4/);
  } finally {
    await stop();
  }
});

test('a note that does not fit after its line goes under it, also when the window narrows; a strike starts at the code, not the indent', {skip: hasNvim ? false : 'nvim not installed', timeout: 30_000}, async () => {
  const {partner, messages, remote, keys, send, stop} = await pairInNvim('tidy up');
  const marks = namespace => JSON.parse(remote(`luaeval("vim.json.encode(vim.api.nvim_buf_get_extmarks(0, vim.api.nvim_create_namespace('${namespace}'), 0, -1, {details = true}))")`));
  const noteUnder = () => marks('pair').some(([, , , details]) => details.virt_lines);
  const noteAfter = () => marks('pair').some(([, , , details]) => details.virt_text_pos === 'eol');
  const answered = text => until(() => messages.some(message => message.text === text), `the answer "${text}"`);
  try {
    keys('ggO\t\tlet total = 0<Esc>');
    partner.setResponses([
      fauxAssistantMessage([fauxToolCall('point', {file: 'a.js', line: 2, note: 'x is the start value of the loop below, so it has to stay one'})], {stopReason: 'toolUse'}),
      fauxAssistantMessage([fauxText('See x.')]),
    ]);
    send({type: 'ask', text: 'what about x?'});
    await answered('See x.');
    await until(noteAfter, 'the note after the line, in a wide window');
    remote('execute("vsplit | vertical resize 40")');
    await until(noteUnder, 'the note under the line once the window is too narrow for it');
    assert.equal(noteAfter(), false);

    partner.setResponses([
      fauxAssistantMessage([fauxToolCall('suggest', {file: 'a.js', line: 1, new_text: '\t\tlet total = 1', note: 'start at one'})], {stopReason: 'toolUse'}),
      fauxAssistantMessage([fauxText('Start at one.')]),
    ]);
    send({type: 'ask', text: 'and total?'});
    await answered('Start at one.');
    const strike = await until(() => marks('pair_suggest').find(([, , , details]) => details.hl_group === 'PairSuggestDelete'), 'the struck line');
    assert.deepEqual([strike[1], strike[2], strike[3].end_col], [0, 2, 15], 'from the first character after the two tabs to the end');
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
    await until(() => ghosts() === 3, 'the ghost diff');
    assert.deepEqual(lines(), ['const x = 1', 'const y = 2', 'const z = 3']);
    keys('ggG<C-o><C-i>'); // the jumplist's Ctrl-I is <Tab> to a terminal: it must not accept
    await sleep(200);
    assert.deepEqual(lines(), ['const x = 1', 'const y = 2', 'const z = 3']);
    keys('<M-y>');
    await until(() => lines()[1] === 'const y = 20', 'the accepted suggestion');
    assert.equal(ghosts(), 0);

    // Editing the suggested lines yourself ignores the suggestion; accepting then does nothing.
    partner.setResponses([
      fauxAssistantMessage([fauxToolCall('suggest', {file: 'a.js', line: 3, new_text: 'const z = 30', note: 'thirty'})], {stopReason: 'toolUse'}),
      fauxAssistantMessage([fauxText('Try 30.')]),
    ]);
    send({type: 'ask', text: 'and z?'});
    await answered('Try 30.');
    await until(() => ghosts() === 3, 'the second ghost diff');
    keys('3Gccconst z = 4<Esc>');
    await until(() => ghosts() === 0, 'the ignored suggestion to go');
    keys(':Pair accept<CR>');
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
    await until(() => status() === '● pair', 'Pair to hand back');
    assert.equal(onDisk(), 'const x = 1\nconst y = 2\nconst z = 3\n', 'nothing was saved');
    keys('u');
    await until(() => lines()[0] === 'const x = 1', 'one undo to remove Pair\'s edit');
    assert.deepEqual(lines(), ['const x = 1', 'const y = 20', 'const z = 4'], 'and only Pair\'s edit');

    // Scrolling to watch Pair drive keeps the wheel with Pair; a key pressed takes it back before the edit lands.
    let refused;
    partner.setResponses([
      async () => {
        await until(() => status() === '◎ pair has the wheel · any key takes it back', 'the statusline to show the Driver');
        keys('<ScrollWheelDown><ScrollWheelUp>');
        await sleep(300);
        assert.equal(status(), '◎ pair has the wheel · any key takes it back', 'a scroll is not a key');
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
    assert.equal(status(), '● pair');
  } finally {
    await stop();
  }
});

test('the hand-over in plain sight: the edit is typed as ghost text, whole lines at a time; the tests run on the unsaved buffer; the hand-back line; a key halfway leaves no change', {skip: hasNvim ? false : 'nvim not installed', timeout: 40_000}, async () => {
  const {project, partner, messages, remote, keys, send, lines, status, stop} = await pairInNvim('tune the numbers', {testOnSave: 'node report.mjs'});
  const marks = namespace => JSON.parse(remote(`luaeval("vim.json.encode(vim.api.nvim_buf_get_extmarks(0, vim.api.nvim_create_namespace('${namespace}'), 0, -1, {details = true}))")`));
  const text = chunks => chunks.map(chunk => chunk[0]).join('');
  const answered = reply => until(() => messages.some(message => message.text === reply), `the answer "${reply}"`);
  const toolResult = context => context.messages.filter(message => message.role === 'toolResult').at(-1).content[0].text;
  try {
    // A test runner that reads a.js where it runs: in a copy of the project, with the buffer's text in it.
    writeFileSync(join(project, 'a.test.js'), "test('x is 100', () => {})\n");
    writeFileSync(join(project, 'report.mjs'), `import {readFileSync} from 'node:fs';
const ok = readFileSync('a.js', 'utf8').includes('const x = 100');
const failureMessages = ok ? [] : ['Error: x is not 100'];
console.log(JSON.stringify({testResults: [{name: process.cwd() + '/a.test.js', assertionResults: [{ancestorTitles: [], title: 'x is 100', status: ok ? 'passed' : 'failed', location: {line: 1}, failureMessages}]}]}));
`);
    execFileSync('git', ['init', '-q'], {cwd: project});
    execFileSync('git', ['add', '.'], {cwd: project});

    let reply;
    partner.setResponses([
      fauxAssistantMessage([fauxToolCall('edit', {file: 'a.js', line: 1, new_text: 'const x = 100\nconst w = 5'})], {stopReason: 'toolUse'}),
      context => { reply = toolResult(context); return fauxAssistantMessage([fauxText('x is 100 now, and w is new; the test passes.')]); },
    ]);
    send({type: 'drive', text: 'your turn'});
    // While Pair types: the old text struck, the new one growing after it with Pair's cursor, and never half a line in the buffer.
    const seen = new Set();
    const ghosts = new Set(); // how the text being typed showed: inline in a line it changes, or as a line of its own
    while (!messages.some(message => message.text === 'x is 100 now, and w is new; the test passes.')) {
      const now = lines();
      seen.add(now.join('|'));
      const typing = marks('pair_drive').find(([, , , details]) => (details.virt_text ?? details.virt_lines?.[0] ?? []).some(chunk => chunk[1] === 'PairCursor'));
      if (typing) ghosts.add(typing[3].virt_text ? `inline after column ${typing[2]}` : 'a line of its own');
      await sleep(20);
    }
    assert.deepEqual([...seen].filter(state => !['const x = 1|const y = 2|const z = 3', 'const x = 100|const y = 2|const z = 3', 'const x = 100|const w = 5|const y = 2|const z = 3'].includes(state)), [], 'only whole lines entered the buffer');
    assert.deepEqual([...ghosts], ['inline after column 11', 'a line of its own'], 'the ghost text with Pair\'s cursor');
    assert.match(reply, /`node report\.mjs` on the unsaved buffer: 1 passed\.$/);
    assert.deepEqual(lines(), ['const x = 100', 'const w = 5', 'const y = 2', 'const z = 3']);
    assert.equal(readFileSync(join(project, 'a.js'), 'utf8'), 'const x = 1\nconst y = 2\nconst z = 3\n', 'nothing was saved');
    assert.deepEqual(marks('pair_drive'), [], 'the typing leaves no marks behind');

    // Handed back: Pair's words under the lines it changed, ✓ in the margin and the statusline, and the key that undoes it.
    const words = await until(() => marks('pair').find(([, , , details]) => details.virt_lines), 'the hand-back line');
    assert.equal(words[1], 1, 'under the last line it changed');
    assert.deepEqual([words[3].sign_text.trim(), words[3].sign_hl_group], ['✓', 'PairStatusPass']);
    assert.equal(words[3].virt_lines.map(text).join('|').trim(), '● x is 100 now, and w is new; the test passes.   u undoes it');
    assert.ok(marks('pair').some(([, row, , details]) => row === 0 && details.end_row === 1 && details.sign_text.trim() === '▎'), 'the lines it changed keep its mark');
    await until(() => status() === '✓ node report.mjs (unsaved) · 1 test, 1 file', 'the run on the buffer in the statusline');
    keys('u');
    await until(() => lines().length === 3, 'one undo for the whole edit');
    assert.deepEqual(lines(), ['const x = 1', 'const y = 2', 'const z = 3']);
    await until(() => !marks('pair').some(([, , , details]) => details.virt_lines), 'the hand-back line to go with the undo');

    // A key halfway: what Pair typed so far is undone, the key itself does nothing, and the edit was none.
    partner.setResponses([
      fauxAssistantMessage([fauxToolCall('edit', {file: 'a.js', line: 2, end_line: 3, new_text: 'const y = 20 // the second of four lines\nconst z = 30 // the third of four lines\nconst v = 40 // the fourth of four lines'})], {stopReason: 'toolUse'}),
      context => { reply = toolResult(context); return fauxAssistantMessage([fauxText('Okay, yours.')]); },
    ]);
    keys(':Pair drive<CR>');
    await until(() => lines()[1] === 'const y = 20 // the second of four lines', 'Pair\'s first whole line');
    keys('x');
    await answered('Okay, yours.');
    assert.equal(reply, 'Not changed: the user has taken the wheel back.');
    assert.deepEqual(lines(), ['const x = 1', 'const y = 2', 'const z = 3'], 'none of it is left, and the x deleted nothing');
    assert.deepEqual(marks('pair_drive'), []);
    assert.ok(messages.some(message => message.text === 'You have the wheel back.'));
    assert.equal(messages.some(message => message.type === 'handback'), false);
  } finally {
    await stop();
  }
});

test('Alt-n rates an unasked remark as noise; accepting its suggestion rates it useful after all', {skip: hasNvim ? false : 'nvim not installed', timeout: 30_000}, async () => {
  const {project, dataDir, watcher, partner, messages, remote, keys, send, lines, stop} = await pairInNvim('tune the numbers');
  const mapped = key => remote(`maparg('${key}', 'n')`) !== '';
  const verdict = () => {
    const store = openStore(join(dataDir, 'sessions.sqlite'));
    try { return store.remarks(0).map(remark => remark.verdict); } finally { store.close(); }
  };
  try {
    assert.equal(mapped('<M-n>'), false, 'the feedback keys are mapped only while a remark waits for a verdict');
    watcher.setResponses([fauxAssistantMessage([fauxText('{"score": 9, "reason": "same failure twice"}')])]);
    partner.setResponses([
      fauxAssistantMessage([fauxToolCall('suggest', {file: 'a.js', line: 2, new_text: 'const y = 20', note: 'twenty'})], {stopReason: 'toolUse'}),
      fauxAssistantMessage([fauxText('y should be 20.')]),
    ]);
    const failure = {type: 'command', cwd: project, pane: null, cmd: 'npm test', exit: 1};
    send(failure);
    send(failure);
    await until(() => mapped('<M-n>') && mapped('<M-u>'), 'the feedback keys');

    keys('<M-n>');
    await until(() => messages.some(message => message.text === 'Noted: not useful.'), 'the verdict in the chat');
    assert.deepEqual(verdict(), ['dismissed']);
    assert.equal(mapped('<M-n>'), false, 'one verdict per remark: the keys are gone');

    keys('<M-y>');
    await until(() => lines()[1] === 'const y = 20', 'the accepted suggestion');
    await until(() => verdict()[0] === 'useful', 'accepting to count as useful');
  } finally {
    await stop();
  }
});

test('while the Partner thinks, the statusline says so, and lets it go with the answer', {skip: hasNvim ? false : 'nvim not installed', timeout: 30_000}, async () => {
  const {partner, messages, send, status, stop} = await pairInNvim('make x two', {thinks: true});
  try {
    let answer;
    partner.setResponses([() => new Promise(resolve => { answer = resolve; })]);
    send({type: 'ask', text: 'is it right?'});
    await until(() => /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] pair · thinking$/.test(status()), 'the statusline to show the thinking');
    answer(fauxAssistantMessage([fauxText('Looks right.')]));
    await until(() => messages.some(message => message.text === 'Looks right.'), 'the answer');
    await until(() => status() === '● pair', 'the statusline back to rest');
  } finally {
    await stop();
  }
});

test('as Driver, the statusline says it thinks while its model works and keeps the take-back hint while it types', {skip: hasNvim ? false : 'nvim not installed', timeout: 30_000}, async () => {
  const {partner, messages, send, status, lines, stop} = await pairInNvim('make x two', {thinks: true});
  const seen = [];
  const sampler = setInterval(() => { try { const now = status(); if (seen.at(-1) !== now) seen.push(now); } catch {} }, 20);
  try {
    partner.setResponses([
      async () => {
        await until(() => status() === '◎ pair has the wheel · thinking', 'the Driver thinking');
        return fauxAssistantMessage([fauxToolCall('edit', {file: 'a.js', line: 1, new_text: 'const x = 2'})], {stopReason: 'toolUse'});
      },
      fauxAssistantMessage([fauxText('Set x to 2.')]),
    ]);
    send({type: 'drive', text: 'your turn'});
    await until(() => messages.some(message => message.text === 'Set x to 2.'), 'the answer');
    await until(() => status() === '● pair', 'Pair to hand back');
    assert.equal(lines()[0], 'const x = 2');
    const hint = seen.indexOf('◎ pair has the wheel · any key takes it back');
    assert.ok(hint > seen.indexOf('◎ pair has the wheel · thinking'), `the hint while it types, after the thinking: ${JSON.stringify(seen)}`);
  } finally {
    clearInterval(sampler);
    await stop();
  }
});

test('after a daemon restart the plugin reconnects by itself; a model that is down shows in the statusline', {skip: hasNvim ? false : 'nvim not installed', timeout: 30_000}, async () => {
  const {partner, remote, status, restartDaemon, stop} = await pairInNvim('survive restarts');
  try {
    await until(() => status() === '● pair', 'the first connection');
    const down = async role => (role === 'partner' ? {ok: false, error: 'connect ECONNREFUSED'} : {ok: true});
    const restarted = restartDaemon({downMs: 1500, probe: down});
    await until(() => status() === '◌ pair · reconnecting', 'the statusline to say it is reconnecting');
    await restarted;
    await until(() => status() === '◌ pair · partner down', 'the reconnect, with the warning', 10_000);

    // The new daemon gets the editor's buffers again: a question reads the unsaved text.
    remote('execute("normal! ggccconst x = 5")');
    let read;
    partner.setResponses([
      fauxAssistantMessage([fauxToolCall('read', {file: 'a.js'})], {stopReason: 'toolUse'}),
      context => {
        read = context.messages.filter(message => message.role === 'toolResult').at(-1).content[0].text;
        return fauxAssistantMessage([fauxText('ok')]);
      },
    ]);
    remote('execute("Pair ask what is x?")');
    await until(() => read, 'the Partner to read the buffer through the new daemon');
    assert.match(read, /1: const x = 5/);
  } finally {
    await stop();
  }
});

test('saving runs the tests: the statusline spins, then names what fails; signs on the tests; Pair\'s fix is one jump and one key away', {skip: hasNvim ? false : 'nvim not installed', timeout: 40_000}, async () => {
  const command = 'sleep 0.6 && cat report.json';
  const {project, watcher, partner, remote, keys, status, stop} = await pairInNvim('totals', {testOnSave: command});
  const marks = namespace => JSON.parse(remote(`luaeval("vim.json.encode(vim.api.nvim_buf_get_extmarks(0, vim.api.nvim_create_namespace('${namespace}'), 0, -1, {details = true}))")`));
  const signs = () => marks('pair_tests').filter(([, , , details]) => details.sign_text).map(([, row, , details]) => [row + 1, details.sign_text.trim(), details.sign_hl_group]);
  const notes = () => marks('pair_tests').filter(([, , , details]) => details.virt_text).map(([, row, , details]) => [row + 1, details.virt_text.map(chunk => chunk[0]).join('')]);
  const report = name => writeFileSync(join(project, 'report.json'), readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8').replaceAll('/home/you/shop', project));
  try {
    mkdirSync(join(project, 'cart'));
    mkdirSync(join(project, 'tax'));
    writeFileSync(join(project, 'go.mod'), 'module example.com/shop\n');
    writeFileSync(join(project, 'cart/cart.go'), 'package cart\n\n// Total adds the prices, in cents.\nfunc Total(prices []int) int {\n\tsum := 0\n\tfor i := 1; i < len(prices); i++ {\n\t\tsum += prices[i]\n\t}\n\treturn sum\n}\n');
    writeFileSync(join(project, 'cart/cart_test.go'), `package cart\n\nimport "testing"\n\nfunc TestTotal(t *testing.T) {\n${'\t// a case\n'.repeat(15)}}\n\nfunc TestEmptyCart(t *testing.T) {\n}\n`);
    writeFileSync(join(project, 'tax/tax_test.go'), 'package tax\n\nimport "testing"\n\nfunc TestRate(t *testing.T) {\n}\n');
    watcher.setResponses([fauxAssistantMessage([fauxText('9')]), ...Array.from({length: 10}, () => fauxAssistantMessage([fauxText('0')]))]);
    partner.setResponses([
      fauxAssistantMessage([fauxToolCall('read', {file: 'cart/cart.go'})], {stopReason: 'toolUse'}),
      fauxAssistantMessage([fauxToolCall('suggest', {file: 'cart/cart.go', line: 6, new_text: '\tfor i := 0; i < len(prices); i++ {', note: 'the first price counts too'})], {stopReason: 'toolUse'}),
      fauxAssistantMessage([fauxText('`Total` starts at the second price: `cart.go:6`')]),
    ]);

    // The session's first run is green: the baseline the next run is compared with.
    report('go-test-pass');
    keys(':edit cart/cart_test.go<CR>:w<CR>');
    await until(() => /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] sleep 0\.6 && cat report\.json$/.test(status()), 'the spinner while the tests run');
    await until(() => status() === '✓ sleep 0.6 && cat report.json · 4 tests, 2 packages', 'the green baseline');
    report('go-test');
    keys(':w<CR>');
    await until(() => status() === '✗ 2 failing · TestRate +1', 'the run\'s failures in the statusline');
    assert.deepEqual(signs(), [[5, '✗', 'PairFail'], [23, '✓', 'PairPass']], 'a sign on each test function of this file');
    assert.deepEqual(notes(), [[17, '   ✗ Total([250 100]) = 100, want 350']], 'why it failed, after the line it failed on');

    // Pair's remark about the regression: its words under your line, and the jump key goes to its suggestion.
    const words = await until(() => marks('pair').find(([, , , details]) => details.virt_lines), 'Pair\'s words');
    assert.equal(words[3].virt_lines.map(line => line.map(chunk => chunk[0]).join('')).join('|').trim(), '● Total starts at the second price: cart.go:6   M-j');
    keys('<M-j>');
    await until(() => remote('expand("%:t")') === 'cart.go' && remote('line(".")') === '6', 'the jump to the suggestion');
    keys('<M-y>');
    await until(() => JSON.parse(remote('json_encode(getline(6))')) === '\tfor i := 0; i < len(prices); i++ {', 'the accepted fix');


    // Saving the fix: the run passes, the statusline says so for a moment, and the signs turn.
    report('go-test-pass');
    keys(':w<CR>:edit cart/cart_test.go<CR>');
    await until(() => status() === '✓ sleep 0.6 && cat report.json · 4 tests, 2 packages', 'the passing run in the statusline');
    await until(() => signs().every(([, sign]) => sign === '✓') && signs().length === 2, 'the signs to turn');
    assert.deepEqual(notes(), []);
  } finally {
    await stop();
  }
});

test('a thought that can wait: a dot where it points and a word in the statusline while you type; Alt-j shows it at once', {skip: hasNvim ? false : 'nvim not installed', timeout: 30_000}, async () => {
  const {watcher, partner, messages, remote, keys, status, stop} = await pairInNvim('count the lines');
  const marks = () => JSON.parse(remote(`luaeval("vim.json.encode(vim.api.nvim_buf_get_extmarks(0, vim.api.nvim_create_namespace('pair'), 0, -1, {details = true}))")`));
  const dot = () => marks().filter(([, , , details]) => details.sign_text?.trim() === '•').map(([, row]) => row);
  try {
    watcher.setResponses([fauxAssistantMessage([fauxText('9')]), ...Array.from({length: 10}, () => fauxAssistantMessage([fauxText('0')]))]);
    partner.setResponses([
      fauxAssistantMessage([fauxToolCall('point', {file: 'a.js', line: 1, note: '`n` is not declared', code: 'n'})], {stopReason: 'toolUse'}),
      fauxAssistantMessage([fauxText('Line 1 reads `n` before anything sets it.')]),
    ]);
    keys('ccconst x = n<Esc>');
    await sleep(300);
    remote(`luaeval("vim.diagnostic.set(vim.api.nvim_create_namespace('lsp'), 0, {{lnum = 0, col = 10, severity = 1, message = 'n is not defined'}}) or 0")`);
    keys('Go// and on'); // on down the file, still in Insert mode
    await until(() => dot().length, 'the dot in the margin', 12_000);
    assert.deepEqual(dot(), [0], 'on the line it points at');
    assert.equal(status(), '● pair · held thought · M-j');
    assert.ok(!messages.some(message => message.sender === 'pair'), 'nothing in the chat yet');
    assert.equal(remote('mode()'), 'i', 'nothing took you out of Insert mode');

    keys('<Esc><M-j>');
    await until(() => messages.some(message => message.text === 'Line 1 reads `n` before anything sets it.'), 'the thought, at once', 2000);
    await until(() => !dot().length && marks().some(([, , , details]) => details.virt_lines), 'its words under your line, and no dot');
    assert.equal(status(), '● pair');
  } finally {
    await stop();
  }
});

test('the chat pane gets the accent Neovim derived, and a new one when the colorscheme changes', {skip: hasNvim ? false : 'nvim not installed', timeout: 30_000}, async () => {
  const {messages, remote, stop} = await pairInNvim('one look');
  const accent = () => remote(`luaeval("require('pair.style').hex(vim.api.nvim_get_hl(0, {name = 'PairAccent', link = false}).fg)")`);
  // What the chat pane would print Pair in: the accent it was welcomed with, or the last one sent since.
  const chatAccent = () => messages.filter(message => message.type === 'accent' || message.accent).map(message => message.color ?? message.accent).at(-1);
  try {
    remote('execute("set termguicolors")');
    await until(() => chatAccent() === accent(), 'the accent');
    const first = accent();
    remote('execute("colorscheme shine")');
    await until(() => chatAccent() === accent() && accent() !== first, 'the new accent');
  } finally {
    await stop();
  }
});
