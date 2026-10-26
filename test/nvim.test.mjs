// The Lua plugin in a headless Neovim against the daemon, with scripted models. Skips without nvim.
import assert from 'node:assert/strict';
import {execFile, execFileSync, spawn} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {connect, createServer} from 'node:net';
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
import {bashWithoutCores} from './no-core.mjs';

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

/** Runs a command line in `cwd` with bash, as Pair's pane would (without core dumps): its output and exit code. */
const runIn = cwd => command => new Promise(resolve => {
  execFile(...bashWithoutCores(command), {cwd}, (error, stdout, stderr) => resolve({output: stdout + stderr, exit: error ? error.code ?? 1 : 0}));
});

/**
 * The daemon with scripted models, a fake herdr, a headless Neovim with the plugin editing a.js and running
 * `:Pair start <goal>`, and a chat client. With `testOnSave`, saving runs that command in the project, for real,
 * in the fake herdr's pane. With `thinks`, the Partner's model can think. `voice` is the config's. `knownKeys`
 * (labels such as M-j) are the keys the plugin remembers you have used, which show without their first-use hints.
 * `stop()` ends them all.
 */
async function pairInNvim(goal, {testOnSave, thinks = false, voice, rtp = [], knownKeys = []} = {}) {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'pair-nvim-')));
  writeFileSync(join(project, 'a.js'), 'const x = 1\nconst y = 2\nconst z = 3\n');
  const dataDir = mkdtempSync(join(tmpdir(), 'pair-data-'));
  const config = parseConfig({
    dataDir,
    socket: join(dataDir, 'pair.sock'),
    testOnSave: testOnSave ? {[project]: testOnSave} : undefined,
    voice,
    agents: false, // never the real board of the machine running the tests
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
  // Its own state directory, where the plugin keeps the keys you have used (lua/pair/hints.lua).
  const state = mkdtempSync(join(tmpdir(), 'pair-state-'));
  if (knownKeys.length) {
    mkdirSync(join(state, 'nvim', 'pair'), {recursive: true});
    writeFileSync(join(state, 'nvim', 'pair', 'keys.json'), JSON.stringify(Object.fromEntries(knownKeys.map(key => [key, true]))));
  }
  const nvim = spawn('nvim', [
    '--headless', '--clean', '--listen', server,
    '--cmd', `set rtp+=${[REPO, ...rtp].join(',')}`,
    '-c', `lua require('pair').setup({socket = '${config.socket}', debounce_ms = 100})`,
    '-c', `cd ${project}`,
    '-c', 'edit a.js',
    '-c', `Pair start ${goal}`,
  ], {stdio: 'ignore', env: {...process.env, XDG_STATE_HOME: state}});
  const remote = expr => execFileSync('nvim', ['--server', server, '--remote-expr', expr], {encoding: 'utf8'}).trim();
  const keys = text => execFileSync('nvim', ['--server', server, '--remote-send', text]);

  const chat = connect(config.socket);
  const messages = [];
  readMessages(chat, message => messages.push(message));
  chat.on('connect', () => sendMessage(chat, {type: 'hello', role: 'chat', cwd: project, herdr: {socket: herdrSocket, workspace: 'w1', pane: 'w1:p2'}}));
  await until(() => { try { return remote('1'); } catch { return false; } }, 'nvim to listen');
  await until(() => messages.some(message => message.text === `Goal: ${goal}`), 'the goal from :Pair start');

  return {
    project, dataDir, state, watcher, partner, messages, remote, keys,
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
    assert.deepEqual(shown, [[2, ['● The shift is fine.', 'Attempt 5 lands at exactly 15, and worker.js:2', 'gives up on >=.   M-j goes there · M-? why']]],
      'under the line you are on, the code without backticks, the keys at the end, with what they do the first time');
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
  const {project, partner, messages, remote, keys, send, lines, status, stop} = await pairInNvim('tune the numbers', {testOnSave: 'node report.mjs', knownKeys: ['M-?']});
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

test('Alt-? on Pair\'s words asks for the idea behind them, shows it under them and then opens its link; a key says what it does until you use it', {skip: hasNvim ? false : 'nvim not installed', timeout: 30_000}, async () => {
  const {project, dataDir, state, watcher, partner, messages, remote, keys, send, stop} = await pairInNvim('grow the table');
  const extmarks = () => JSON.parse(remote(`luaeval("vim.json.encode(vim.api.nvim_buf_get_extmarks(0, vim.api.nvim_create_namespace('pair'), 0, -1, {details = true}))")`));
  // Every virtual line under the line, in the order Neovim draws them: by extmark.
  const words = () => extmarks().filter(([, , , details]) => details.virt_lines).sort(([a], [b]) => a - b)
    .flatMap(([, , , details]) => details.virt_lines.map(line => line.map(chunk => chunk[0]).join('').trim()));
  const verdicts = () => {
    const store = openStore(join(dataDir, 'sessions.sqlite'));
    try { return store.remarks(0).map(remark => remark.verdict); } finally { store.close(); }
  };
  try {
    writeFileSync(join(project, 'table.c'), 'int should_grow(int len, int cap) {\n    return len / cap > 0.7;\n}\n');
    watcher.setResponses([fauxAssistantMessage([fauxText('9')])]);
    partner.setResponses([
      fauxAssistantMessage([fauxToolCall('point', {file: 'table.c', line: 2, note: 'always 0 below a full table', code: 'len / cap'})], {stopReason: 'toolUse'}),
      fauxAssistantMessage([fauxText('`len / cap` is integer division in `table.c:2`: 0 until the table is full, so it never grows.')]),
    ]);
    const failure = {type: 'command', cwd: project, pane: null, cmd: 'make run', exit: 134};
    send(failure);
    send(failure);
    await until(() => words().length, 'the remark under the line');
    assert.match(words().at(-1), /\.   M-j goes there · M-\? why$/, 'the first time, each key says what it does');

    let input;
    partner.setResponses([context => {
      input = context.messages.at(-1).content;
      return fauxAssistantMessage([fauxText('C divides two ints as ints, before any compare with a double: scale instead, as `len * 10 > cap * 7`.\nhttps://en.cppreference.com/w/c/language/operator_arithmetic')]);
    }]);
    remote(`luaeval("(function() vim.ui.open = function(url) vim.g.opened = url end end)() or 0")`); // no browser here
    keys('<M-?>');
    await until(() => input, 'the teach request reaching the Partner');
    assert.match(input, /^\[teach\] The user asks for the idea behind what you said: "`len \/ cap` is integer division in `table.c:2`/);
    const taught = await until(() => words().some(line => line.startsWith('∴ C divides')) && words(), 'the idea under the words');
    assert.deepEqual(taught.slice(-4), [
      'table is full, so it never grows.   M-j goes there',
      '∴ C divides two ints as ints, before any',
      'compare with a double: scale instead, as',
      'len * 10 > cap * 7.   M-? opens en.cppreference.com',
    ], 'after the words, without the hint it no longer needs; the link apart, as the key that opens it');
    assert.ok(messages.some(message => message.sender === 'pair' && message.text.startsWith('C divides')), 'the chat has it too, link and all');
    await until(() => verdicts()[0] === 'seen', 'asking about a remark to count as having seen it');
    assert.deepEqual(JSON.parse(readFileSync(join(state, 'nvim', 'pair', 'keys.json'), 'utf8')), {'M-?': true}, 'the plugin remembers the key you used');

    keys('<M-?>');
    await until(() => remote('get(g:, "opened", "")') === 'https://en.cppreference.com/w/c/language/operator_arithmetic', 'the link opened');

    keys('3Go<Esc>');
    await until(() => words().length === 0, 'your edit taking the words and the idea away');
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
  const {project, watcher, partner, remote, keys, status, stop} = await pairInNvim('totals', {testOnSave: command, knownKeys: ['M-j', 'M-?', 'M-y']});
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

test('the ledger: :Pair today lists what Pair did; u undoes its edit after your later edits, and again makes it again; a clash changes nothing; <CR> shows output', {skip: hasNvim ? false : 'nvim not installed', timeout: 40_000}, async () => {
  const {project, partner, messages, remote, keys, send, lines, stop} = await pairInNvim('tune the numbers', {testOnSave: 'cat a.js'});
  const ledgerLines = () => JSON.parse(remote('luaeval("vim.json.encode(vim.api.nvim_buf_get_lines(vim.fn.bufnr(\'pair://today\'), 0, -1, false))")'));
  const hints = () => JSON.parse(remote('luaeval("vim.json.encode(vim.tbl_map(function(m) return m[4].virt_text[1][1] end, vim.api.nvim_buf_get_extmarks(vim.fn.bufnr(\'pair://today\'), vim.api.nvim_create_namespace(\'pair_ledger\'), 0, -1, {details = true, type = \'virt_text\'})))")'));
  const row = text => ledgerLines().findIndex(line => line.includes(text)) + 1;
  const a = () => JSON.parse(remote('json_encode(getbufline(bufnr("a.js"), 1, "$"))'));
  try {
    execFileSync('git', ['init', '-q'], {cwd: project});
    execFileSync('git', ['add', '.'], {cwd: project});
    partner.setResponses([
      fauxAssistantMessage([fauxToolCall('read', {file: 'a.js'})], {stopReason: 'toolUse'}),
      fauxAssistantMessage([fauxToolCall('edit', {file: 'a.js', line: 1, new_text: 'const x = 100\nconst w = 5'})], {stopReason: 'toolUse'}),
      fauxAssistantMessage([fauxText('x is 100, and w is new.')]),
    ]);
    send({type: 'drive', text: 'your turn'});
    await until(() => messages.some(message => message.text === 'x is 100, and w is new.'), 'the hand-back');
    keys('Gccconst z = 30<Esc>'); // your own edit, after Pair's
    assert.deepEqual(lines(), ['const x = 100', 'const w = 5', 'const y = 2', 'const z = 30']);

    keys(':Pair today<CR>');
    await until(() => row('typed'), 'the ledger');
    const [read, typed, ran, said] = ['read', 'typed', 'ran', 'said'].map(row);
    assert.ok(read < typed && typed < ran && ran < said, ledgerLines().join('\n'));
    assert.match(ledgerLines()[read - 1], /^\d\d:\d\d {2}read {10}a\.js 1-3$/);
    assert.match(ledgerLines()[typed - 1], /typed {9}2 lines in a\.js {3}one undo step$/);
    assert.match(ledgerLines()[ran - 1], /ran {11}cat a\.js {3}✓ passed · unsaved$/);
    assert.deepEqual(hints(), ['⏎ go', 'u undo', '⏎ output', '⏎ all'], 'the key that acts on each');
    assert.equal(remote('&buftype'), 'nofile', 'the cursor is in the ledger');
    assert.match(remote('&statusline'), /pair · today%=\d things · 0 remarks, 0 useful · \d+ min$/);

    // u on Pair's edit: its lines go, yours stay, and nothing is saved.
    keys(`${typed}Gu`);
    await until(() => a().length === 3, 'the undo, merged with your edit');
    assert.deepEqual(a(), ['const x = 1', 'const y = 2', 'const z = 30']);
    assert.equal(readFileSync(join(project, 'a.js'), 'utf8'), 'const x = 1\nconst y = 2\nconst z = 3\n', 'nothing was saved');
    await until(() => hints()[typed - 1] === 'undone · u again redoes', 'the entry to say so');
    // u again makes it again.
    keys('u');
    await until(() => a().length === 4, 'the edit made again');
    assert.deepEqual(a(), ['const x = 100', 'const w = 5', 'const y = 2', 'const z = 30']);
    await until(() => hints()[typed - 1] === 'u undo', 'the entry back to undoable');

    // You change one of Pair's lines: undoing it would undo yours, so nothing changes, and Pair says why.
    remote('execute("call setbufline(bufnr(\'a.js\'), 2, \'const w = 6\')")');
    keys('u');
    await until(() => messages.some(message => message.text === 'Pair\'s change in a.js was not undone: you changed those lines since.'), 'why not');
    assert.deepEqual(a(), ['const x = 100', 'const w = 6', 'const y = 2', 'const z = 30']);

    // <CR> on a run shows its output in the ledger's window; q goes back to the list, and q again closes it.
    keys(`${ran}G<CR>`);
    await until(() => remote('bufname()').startsWith('pair://today/'), 'the output');
    assert.deepEqual(JSON.parse(remote('json_encode(getline(1, "$"))')), ['const x = 100', 'const w = 5', 'const y = 2', 'const z = 3'], 'what cat printed on the unsaved buffer');
    keys('q');
    await until(() => remote('bufname()') === 'pair://today', 'back to the list');
    keys(`${read}G<CR>`);
    await until(() => remote('bufname()') === 'a.js', '<CR> going to what Pair read');
    keys(':Pair today<CR>');
    await until(() => remote('bufname()') === 'pair://today', 'the ledger again');
    keys('q');
    await until(() => remote('winnr("$")') === '1', 'q to close it');
  } finally {
    await stop();
  }
});

test('green after a regression: the sign that turned glows and settles, the statusline lights up once, one line says what passes; sounds only while away', {skip: hasNvim ? false : 'nvim not installed', timeout: 40_000}, async () => {
  const {project, watcher, remote, keys, status, stop} = await pairInNvim('totals', {testOnSave: 'cat report.json'});
  const lua = expr => JSON.parse(remote(`luaeval("vim.json.encode(${expr})")`));
  const marks = namespace => lua(`vim.api.nvim_buf_get_extmarks(0, vim.api.nvim_create_namespace('${namespace}'), 0, -1, {details = true})`);
  const sign = line => marks('pair_tests').find(([, row]) => row === line - 1)?.[3];
  const words = () => marks('pair').map(([, , , details]) => details.virt_lines?.map(chunks => chunks.map(chunk => chunk[0]).join('')).join('|').trim()).find(Boolean);
  const report = name => writeFileSync(join(project, 'report.json'), readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8').replaceAll('/home/you/shop', project));
  try {
    mkdirSync(join(project, 'cart'));
    mkdirSync(join(project, 'tax'));
    writeFileSync(join(project, 'go.mod'), 'module example.com/shop\n');
    writeFileSync(join(project, 'cart/cart_test.go'), 'package cart\n\nimport "testing"\n\nfunc TestTotal(t *testing.T) {\n}\n\nfunc TestEmptyCart(t *testing.T) {\n}\n');
    writeFileSync(join(project, 'tax/tax_test.go'), 'package tax\n\nimport "testing"\n\nfunc TestRate(t *testing.T) {\n}\n');
    watcher.setResponses(Array.from({length: 20}, () => fauxAssistantMessage([fauxText('0')]))); // the regression raises no remark
    remote('execute("set termguicolors")'); // the glow needs true colours

    report('go-test-pass');
    keys(':edit cart/cart_test.go<CR>:w<CR>');
    await until(() => status().startsWith('✓'), 'the green baseline');
    report('go-test');
    keys(':w<CR>');
    await until(() => status().startsWith('✗') && sign(5)?.sign_hl_group === 'PairFail', 'the regression');

    report('go-test-pass');
    keys(':w<CR>');
    await until(() => status().startsWith('✓'), 'green again');
    await until(() => /^PairSettle/.test(sign(5)?.sign_hl_group ?? ''), 'the sign that turned green to glow');
    assert.match(sign(5).line_hl_group, /^PairFadePairGlowLine/, 'its line lit too');
    assert.equal(sign(8).sign_hl_group, 'PairPass', 'the test that passed already is just there');
    assert.match(remote('luaeval("require(\'pair\').statusline()")'), /^%#PairSettlePairStatusGlowPairStatusPass\d\d#✓ %#PairSettlePairStatusGlowPairStatusDim\d\d#cat report.json/, 'the statusline lights up');
    assert.equal(words(), '● TestRate and TestTotal/two_items pass again: the regression is fixed.');
    await until(() => sign(5)?.sign_hl_group === 'PairPass' && !sign(5).line_hl_group, 'the glow to settle');
    await until(() => /^%#PairStatusPass#/.test(remote('luaeval("require(\'pair\').statusline()")')), 'the statusline to settle');
    await until(() => words() === undefined, 'the line to go after a few seconds', 8000);

    // Sounds: off by default; on, they play only while Neovim does not have the focus.
    const command = () => lua("require('pair.earcons').command('green') or vim.NIL");
    assert.equal(command(), null, 'off by default');
    keys(':lua require("pair.earcons").enabled = true<CR>');
    assert.equal(command(), null, 'not while Neovim has the focus');
    keys(':doautocmd FocusLost<CR>');
    const away = await until(command, 'a sound while away');
    assert.match(away.at(-1), /\/sounds\/green\.wav$/);
    assert.ok(readFileSync(away.at(-1)).length > 1000);
    keys(':doautocmd FocusGained<CR>');
    await until(() => command() === null, 'silence once back');
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

test('another remark leaves a held thought\'s dot and Alt-j alone; its own remark takes them away', {skip: hasNvim ? false : 'nvim not installed', timeout: 20_000}, async () => {
  // A stand-in daemon: it greets Neovim and sends what the test says.
  const dir = mkdtempSync('/tmp/pair-');
  let editor;
  const received = [];
  const server = createServer(socket => {
    editor = socket;
    readMessages(socket, message => received.push(message));
  });
  await new Promise(resolve => server.listen(join(dir, 'pair.sock'), resolve));
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'pair-nvim-')));
  writeFileSync(join(project, 'a.c'), 'int a;\nint b;\nint c;\nint d;\n');
  const nvimSocket = join(dir, 'nvim.sock');
  const nvim = spawn('nvim', ['--headless', '--clean', '--listen', nvimSocket, '--cmd', `set rtp+=${REPO}`,
    '-c', `lua require('pair').setup({socket = '${join(dir, 'pair.sock')}'})`, '-c', `cd ${project}`, '-c', 'edit a.c', '-c', 'Pair start'], {stdio: 'ignore'});
  const remote = expr => execFileSync('nvim', ['--server', nvimSocket, '--remote-expr', expr], {encoding: 'utf8'}).trim();
  const dot = () => JSON.parse(remote(`luaeval("vim.json.encode(vim.api.nvim_buf_get_extmarks(0, vim.api.nvim_create_namespace('pair'), 0, -1, {details = true}))")`))
    .filter(([, , , details]) => details.sign_text?.trim() === '•').map(([, row]) => row);
  const mapped = () => remote(`maparg('<M-j>', 'n')`) !== '';
  try {
    await until(() => editor && received.some(message => message.type === 'hello'), 'the plugin to connect');
    sendMessage(editor, {type: 'welcome', root: project, level: 'normal', role: 'navigator', models: {}});
    sendMessage(editor, {type: 'held', id: 1, file: join(project, 'a.c'), line: 3});
    await until(() => dot().length, 'the dot');
    sendMessage(editor, {type: 'remark', id: 2, text: 'The failure is elsewhere.', target: null});
    await until(() => remote('luaeval("require(\'pair\').status()")').includes('held thought'), 'the statusline');
    await sleep(300);
    assert.deepEqual(dot(), [2], 'the dot stays');
    assert.equal(mapped(), true, 'and Alt-j with it');
    remote('execute("Pair jump")');
    await until(() => received.some(message => message.type === 'release'), 'Alt-j to ask for the held thought');
    sendMessage(editor, {type: 'remark', id: 1, text: 'Line 3 is the one.', target: null});
    await until(() => !dot().length, 'its own remark to take the dot');
  } finally {
    nvim.kill();
    server.close();
  }
});

test('push-to-talk: hold Alt-t, a meter under your line; let go, your words, then Pair\'s answer in their place; a tap listens until the next one', {skip: hasNvim ? false : 'nvim not installed', timeout: 30_000}, async () => {
  // The microphone is a loud tone, and whisper a script that hears one question.
  const bin = mkdtempSync(join(tmpdir(), 'pair-whisper-'));
  writeFileSync(join(bin, 'whisper-cli'), '#!/bin/sh\nprintf " Why does attempt 5 give up?\\n"\n', {mode: 0o755});
  const record = `node -e 'const b = Buffer.alloc(3200); for (let i = 0; i < 1600; i++) b.writeInt16LE(i % 8 < 4 ? 9000 : -9000, i * 2); setInterval(() => process.stdout.write(b), 100)'`;
  const voice = {model: 'unused.bin', whisper: join(bin, 'whisper-cli'), record};
  const {partner, messages, remote, status, stop} = await pairInNvim('retries pass', {voice, knownKeys: ['M-j', 'M-?']});
  const listenLine = () => {
    const marks = JSON.parse(remote(`luaeval("vim.json.encode(vim.api.nvim_buf_get_extmarks(0, require('pair.listen').ns, 0, -1, {details = true}))")`));
    const line = marks.find(([, , , details]) => details.virt_lines)?.[3].virt_lines[0];
    return line ? line.map(chunk => chunk[0]).join('').trim() : null;
  };
  const words = () => JSON.parse(remote(`luaeval("vim.json.encode(vim.api.nvim_buf_get_extmarks(0, vim.api.nvim_create_namespace('pair'), 0, -1, {details = true}))")`))
    .filter(([, , , details]) => details.virt_lines).map(([, row, , details]) => [row, details.virt_lines.map(line => line.map(chunk => chunk[0]).join('').trim())]);
  // A held key: pressed, then repeated every 40 ms, as a terminal sends it.
  const hold = ms => remote(`luaeval("(function() local n = 0; local t = vim.uv.new_timer(); t:start(0, 40, vim.schedule_wrap(function() n = n + 1; vim.api.nvim_input('<M-t>'); if n * 40 >= ${ms} then t:close() end end)) end)() or 0")`);
  try {
    let answer;
    partner.setResponses([
      () => new Promise(resolve => { answer = resolve; }),
      fauxAssistantMessage([fauxText('Attempt 5 lands at exactly 15, and `worker.js:2` gives up on `>=`.')]),
    ]);
    remote('cursor(2, 1)');
    hold(1200);
    await until(() => /^◉ [▁▂▃▄▅▆▇█]{10}  listening   let go to ask$/.test(listenLine() ?? ''), 'the meter under the line');
    await until(() => /[▅▆▇█]/.test(listenLine() ?? ''), 'the meter to move');
    assert.equal(status(), '◉ pair · listening');
    await until(() => listenLine() === '› Why does attempt 5 give up?', 'the words Pair heard, after you let go');
    await until(() => messages.some(message => message.sender === 'user' && message.text === 'Why does attempt 5 give up?'), 'the question in the chat');
    answer(fauxAssistantMessage([fauxToolCall('point', {file: 'a.js', line: 3, note: 'here'})], {stopReason: 'toolUse'}));
    await until(() => words().length, 'the answer');
    assert.deepEqual(words(), [[1, ['● Attempt 5 lands at exactly 15, and worker.js:2 gives up on >=.   M-j']]], 'under the line you asked on, with the key to where it pointed');
    assert.equal(listenLine(), null, 'in place of your words');
    await until(() => status() === '● pair', 'the statusline at rest');

    // A tap: Pair listens until the next press.
    partner.setResponses([fauxAssistantMessage([fauxText('Five.')])]);
    remote(`luaeval("vim.api.nvim_input('<M-t>') or 0")`);
    await until(() => /listening   M-t again to ask$/.test(listenLine() ?? ''), 'the tap hint');
    await sleep(300);
    assert.match(listenLine(), /M-t again to ask$/, 'still listening without the key');
    remote(`luaeval("vim.api.nvim_input('<M-t>') or 0")`);
    await until(() => words().some(([, lines]) => lines[0] === '● Five.'), 'the answer to the tapped question');

    // The model fails: the line says there is no answer, a moment, and the chat says why.
    partner.setResponses([() => { throw new Error('401 bad key'); }]);
    await until(() => status() === '● pair', 'the statusline at rest');
    await sleep(300); // a key pressed again within 0.22 s of the last one counts as still held
    hold(600);
    await until(() => listenLine() === '◌ no answer · the chat says why', 'no answer, said under the line');
    await until(() => messages.some(message => /Pair could not answer/.test(message.text ?? '')), 'why, in the chat');
    await until(() => listenLine() === null, 'the line to go after a moment');
  } finally {
    await stop();
  }
});

test('Telescope searches reach the trail with what you opened; :Pair trail shows them, and x forgets them', {skip: hasNvim ? false : 'nvim not installed', timeout: 30_000}, async () => {
  const {project, watcher, remote, keys, stop} = await pairInNvim('retries pass', {rtp: [join(REPO, 'test/fixtures/telescope')]});
  const panel = () => JSON.parse(remote('json_encode(getline(1, "$"))'));
  try {
    watcher.setResponses(Array.from({length: 10}, () => fauxAssistantMessage([fauxText('0')]))); // not worth a remark
    writeFileSync(join(project, 'backoff.js'), 'export const next = attempt => 2 ** attempt\n');
    const search = (...args) => remote(`luaeval("require('fake_search')(${args.map(arg => JSON.stringify(arg).replaceAll('"', "'")).join(', ')}) or 0")`);
    search('Live Grep', 'give up', 0);
    search('Live Grep', '   ', 3); // an empty prompt is no search
    search('Live Grep', 'dead letter', 1, 'a.js'); // the file you are in: nothing opened
    search('Find Files', 'retry', 2, 'backoff.js');
    assert.equal(remote('expand("%:t")'), 'backoff.js');

    keys(':Pair trail<CR>');
    const lines = await until(() => remote('&filetype') === '' && remote('win_gettype()') === 'popup' && panel(), 'the trail panel');
    assert.equal(lines[0], 'What the pair saw you look for, oldest first');
    assert.match(lines[2], /^\+ +0s {2}Live Grep {3}"give up" {6}0 results {2}closed, nothing opened$/);
    assert.match(lines[3], /^\+ +0s {2}Live Grep {3}"dead letter" {2}1 result {3}closed, nothing opened$/);
    assert.match(lines[4], /^\+ +0s {2}Find Files {2}"retry" {8}2 results {2}→ backoff\.js$/);
    assert.equal(lines[6], '3 searches in 0 s since your last edit; 2 closed with nothing opened.');
    assert.equal(lines.at(-1), 'q closes · x forgets this trail');

    keys('x');
    await until(() => remote('win_gettype()') === '', 'the panel to close');
    keys(':Pair trail<CR>');
    await until(() => remote('win_gettype()') === 'popup', 'the panel again');
    assert.deepEqual(panel(), ['What the pair saw you look for, oldest first', '', 'No searches since your last edit.', 'q closes']);
    keys('q');
    await until(() => remote('win_gettype()') === '', 'q to close it');
  } finally {
    await stop();
  }
});

test('a build or run on save: crashes and compiler errors on their lines, the jump key goes there, new warnings speak and old ones stay quiet', {skip: hasNvim ? false : 'nvim not installed', timeout: 40_000}, async () => {
  const {project, watcher, remote, keys, status, stop} = await pairInNvim('spread the keys', {testOnSave: 'cat run.out; exit $(cat run.exit)'});
  const marks = () => JSON.parse(remote('luaeval("vim.json.encode(vim.api.nvim_buf_get_extmarks(0, vim.api.nvim_create_namespace(\'pair_runs\'), 0, -1, {details = true}))")'));
  const signs = () => marks().filter(([, , , details]) => details.sign_text).map(([, row, , details]) => [row + 1, details.sign_text.trim(), details.sign_hl_group]);
  const notes = () => marks().filter(([, , , details]) => details.virt_text).map(([, row, , details]) => [row + 1, details.virt_text.map(chunk => chunk[0]).join('')]);
  const printing = (output, exit) => {
    writeFileSync(join(project, 'run.out'), output.replaceAll('/home/dev/probe', project));
    writeFileSync(join(project, 'run.exit'), String(exit));
  };
  const fixture = name => readFileSync(new URL(`./fixtures/runs/${name}.txt`, import.meta.url), 'utf8');
  try {
    writeFileSync(join(project, 'probe.c'), Array.from({length: 24}, (_, i) => `  int line${i + 1} = ${i + 1};`).join('\n') + '\n');
    watcher.setResponses(Array.from({length: 10}, () => fauxAssistantMessage([fauxText('0')])));

    printing(fixture('clang-errors').replaceAll('bad.c', 'probe.c'), 1);
    keys(':edit probe.c<CR>:w<CR>');
    await until(() => status() === '✗ does not build · probe.c:3 +1', 'the build error in the statusline');
    await until(() => signs().length === 2, 'the signs');
    assert.deepEqual(signs(), [[3, '✗', 'PairFail'], [4, '✗', 'PairFail']]);
    assert.deepEqual(notes(), [[3, '   ✗ use of undeclared identifier \'undefined_thing\''], [4, '   ✗ expected \';\' after expression']]);
    keys('gg<M-j>');
    await until(() => remote('line(".")') === '3' && remote('col(".")') === '11', 'the jump to the first error, at its column');

    printing(fixture('asan-segv'), 1);
    keys(':w<CR>');
    await until(() => status() === '✗ AddressSanitizer: SEGV · probe.c:10', 'the crash in the statusline');
    await until(() => signs().length === 1, 'the crash on its line');
    assert.deepEqual(notes(), [[10, '   ✗ AddressSanitizer: SEGV']]);
    keys('gg<M-j>');
    await until(() => remote('line(".")') === '10', 'the jump to the frame in the project\'s code');

    // The command ran before in this session and you edit probe.c, so a warning it prints there now is news;
    // printed again, it is not.
    const warning = 'probe.c:21:7: warning: unused variable \'spare\'\n';
    printing(warning, 0);
    keys('21GA // spare<Esc>');
    await sleep(400); // the edit reaches the daemon after debounce_ms
    keys(':w<CR>');
    await until(() => status() === '✓ cat run.out; exit $(cat run.exit) · 1 new warning', 'the new warning in the statusline');
    await until(() => signs().length === 1 && signs()[0][0] === 21, 'the warning on its line');
    assert.deepEqual(signs(), [[21, '△', 'PairWarn']]);
    assert.deepEqual(notes(), [[21, '   △ unused variable \'spare\'']]);
    printing(warning, 0);
    keys(':w<CR>');
    await until(() => signs()[0]?.[2] === 'PairWarnQuiet', 'the same warning again: quiet');
    assert.deepEqual(notes(), [], 'no words for a warning that is no news');

    printing('190000 keys  load 0.72  avg probe 1.3\n', 0);
    keys(':w<CR>');
    await until(() => signs().length === 0, 'a clean run to clear the marks');
    assert.equal(remote('maparg("<M-j>", "n")'), '', 'the jump key went with the run\'s places');
  } finally {
    await stop();
  }
});

test('notes in the margin: five marks in a note, a fixed line loses its mark, a decision goes to the log and tasks only on a yes', {skip: hasNvim ? false : 'nvim not installed', timeout: 60_000}, async () => {
  const {project, watcher, partner, remote, keys, status, stop} = await pairInNvim('dead letters');
  const note = readFileSync(new URL('../docs/captures/notes/dead-letters.md', import.meta.url), 'utf8');
  const marks = () => JSON.parse(remote(`luaeval("vim.json.encode(vim.api.nvim_buf_get_extmarks(0, vim.api.nvim_create_namespace('pair_margin'), 0, -1, {details = true}))")`))
    .filter(([, , , details]) => details.virt_lines)
    .map(([, row, , details]) => [row + 1, details.sign_text.trim(), details.virt_lines.map(line => line.map(chunk => chunk[0]).join('')).join('|')]);
  const reply = (system, text) => context => fauxAssistantMessage([fauxText(context.messages[0].content.includes(system) ? text : '[]')]);
  try {
    mkdirSync(join(project, 'docs'));
    writeFileSync(join(project, 'docs', 'dead-letters.md'), note.replace('still gets the webhook.', 'still gets the webhoo'));
    watcher.setResponses(Array.from({length: 20}, () => fauxAssistantMessage([fauxText('0')])));
    partner.setResponses([reply('in its margin', JSON.stringify([
      {kind: 'code', line: 4, text: 'Deliver returns ErrBudget and the caller drops it.', file: 'a.js', file_line: 2},
      {kind: 'contradiction', line: 14, text: 'Line 14 says 5 attempts, line 20 says 6.', other_line: 20},
      {kind: 'question', line: 17, text: 'Replay as attempt 1 with full budget: does the 5-attempt cap apply again?'},
      {kind: 'question', line: 20, text: 'Does a receiver down for a minute reach 6 attempts inside 15 s?'},
    ]))]);
    keys(':edit docs/dead-letters.md<CR>21GAk.<Esc>');

    // At the pause, the rule's repeat; once you stop writing, the model's marks: five, the most there are.
    await until(() => marks().length === 1, 'the repeat the rule finds');
    assert.deepEqual(marks()[0], [26, '≈', '≈ Says again what line 9 says.   line 9']);
    await until(() => marks().length === 5, 'the model\'s marks', 20_000);
    assert.deepEqual(marks().map(([line, sign]) => [line, sign]), [[4, '→'], [14, '≠'], [17, '?'], [20, '?'], [26, '≈']]);
    assert.equal(marks()[0][2], '→ Deliver returns ErrBudget and the caller drops it.   M-l a.js');
    assert.equal(marks()[1][2], '≠ Line 14 says 5 attempts, line 20 says 6.   line 20');
    assert.equal(status(), '● pair · 5 notes in the margin');

    // The link key opens the code the mark names, in a split.
    keys('4G<M-l>');
    await until(() => remote('expand("%:t")') === 'a.js' && remote('line(".")') === '2', 'the code the mark links to');
    keys(':close<CR>');

    // You fix line 20: its own mark goes, and so does the contradiction that names it.
    keys('20G0f6r5');
    await until(() => marks().length === 3, 'the marks of the fixed line to go');
    assert.deepEqual(marks().map(([line]) => line), [4, 17, 26]);

    // A decision: the rule marks it, and the decide key logs it with the question it answers.
    partner.setResponses(Array.from({length: 4}, () => reply('as tasks', JSON.stringify([
      {title: 'Park failed webhooks in dead_letters after the last attempt', lines: 'lines 3-4, line 8'},
      {title: 'Decide how long dead letters are kept', lines: 'line 26', open: true},
    ]))));
    keys('19GoDecision: replay keeps the attempt cap; it gets the budget back, not new attempts<Esc>');
    await until(() => marks().some(([line, sign]) => line === 20 && sign === '◆'), 'the decision\'s mark');
    assert.equal(marks().find(([line]) => line === 20)[2], '◆ A decision for the log.   M-d logs it');
    keys('<M-d>');
    await until(() => status() === '◆ logged · docs/decisions.md', 'the log in the statusline');
    const log = JSON.parse(remote('json_encode(getbufline(bufnr("docs/decisions.md"), 1, "$"))'));
    assert.match(log[2], /^## \d{4}-\d\d-\d\d · replay keeps the attempt cap; it gets the budget back, not new attempts$/);
    assert.deepEqual(log.slice(3), ['', '- Status: decided', '- Where: docs/dead-letters.md:20 (## How)', '- Asked: "Replay as attempt 1 with full budget: does the 5-attempt cap apply again?"', '- Consequences:']);
    assert.equal(remote('expand("%:t")'), 'dead-letters.md', 'your cursor stays in the note');
    assert.throws(() => readFileSync(join(project, 'docs', 'decisions.md')), 'the log is a buffer you save, not a file Pair wrote');
    await until(() => !marks().some(([line]) => line === 17 || line === 20), 'the answered question\'s mark and the decision\'s to go');

    // Tasks only when asked, and nothing happens until the yes.
    keys(':Pair tasks<CR>');
    await until(() => remote('&filetype') === '' && remote('expand("%")') === '', 'the tasks panel');
    const panel = JSON.parse(remote('json_encode(getline(1, "$"))'));
    assert.deepEqual(panel, [
      'From docs/dead-letters.md, as you asked. Nothing is added until you say so.', '',
      '1  Park failed webhooks in dead_letters after the last attempt', '   lines 3-4, line 8',
      '2  Decide how long dead letters are kept', '   open question, line 26', '',
      'y copies them as a checklist · e edits the list · q cancels',
    ]);
    keys('y');
    await until(() => remote('expand("%:t")') === 'dead-letters.md', 'the panel to close');
    assert.deepEqual(JSON.parse(remote('json_encode(getreg(\'"\', 1, 1))')), [
      '- [ ] Park failed webhooks in dead_letters after the last attempt (lines 3-4, line 8)',
      '- [ ] Decide how long dead letters are kept (open question, line 26)',
    ]);
  } finally {
    await stop();
  }
});
