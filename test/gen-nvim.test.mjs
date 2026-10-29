// /gen in a headless Neovim against the daemon, with a scripted Partner. Twice: once with a stand-in that replaces
// vim.ui.input and vim.ui.select (as snacks.nvim, dressing.nvim and noice.nvim do), once with Neovim's own prompt
// on the command line, driven by keys. Skips without nvim.
import assert from 'node:assert/strict';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {fauxAssistantMessage, fauxText, fauxToolCall} from '@earendil-works/pi-ai';
import {CHECK_PROMPT, CONFLICT_PROMPT} from '../src/brief.mjs';
import {hasNvim, pairInNvim, sleep, until} from './nvim-harness.mjs';
import {scratch} from './temp.mjs';

const skip = hasNvim ? false : 'nvim not installed';

// What a popup plugin does: vim.ui.input and vim.ui.select replaced. It answers from _G.gen_answers ('<Esc>' is
// Esc, and an empty list Esc too) and keeps what it was asked in _G.gen_asked.
const STUB = `
_G.gen_asked, _G.gen_answers = {}, {}
vim.ui.input = function(opts, on_confirm)
  table.insert(_G.gen_asked, {kind = 'input', prompt = opts.prompt, default = opts.default or ''})
  local answer = table.remove(_G.gen_answers, 1)
  on_confirm(answer ~= '<Esc>' and answer or nil)
end
vim.ui.select = function(items, opts, on_choice)
  local shown = {}
  for _, item in ipairs(items) do table.insert(shown, opts.format_item(item)) end
  table.insert(_G.gen_asked, {kind = 'select', prompt = opts.prompt, items = shown})
  local answer = table.remove(_G.gen_answers, 1)
  for i, item in ipairs(items) do
    if answer ~= nil and (item.shape == answer or item.key == answer or answer == i) then return on_choice(item, i) end
  end
  on_choice(nil, nil)
end
_G.notified = {}
local notify = vim.notify
vim.notify = function(text, ...) table.insert(_G.notified, text) return notify(text, ...) end
`;

const virtLines = marks => marks.filter(([, , , details]) => details.virt_lines)
  .map(([, row, , details]) => [row, details.virt_lines.map(line => line.map(chunk => chunk[0]).join('')).join('\n')]);

/**
 * Pair in Neovim, with what `pairInNvim` gives and helpers for /gen's ghost lines, its dialogs and the ledger. The
 * Partner's model answers the brief's checks with `brief(kind, content)` ('conflict' or 'check'; [] by default), apart
 * from the turns a test scripts with `partner.setResponses`, which come in their order.
 */
async function genInNvim(goal, {stub = false, brief = () => '[]', notes = null, runs = false} = {}) {
  const pair = await pairInNvim(goal, {runs});
  const {remote, messages, send, watcher} = pair;
  if (notes !== null) writeFileSync(join(pair.project, 'NOTES.md'), notes);
  const turns = [];
  const route = async (context, ...rest) => {
    const system = context.messages[0]?.role === 'system' ? context.messages[0].content : context.systemPrompt; // the provider's own form
    const kind = system === CONFLICT_PROMPT ? 'conflict' : system === CHECK_PROMPT ? 'check' : null;
    if (kind) return fauxAssistantMessage([fauxText(brief(kind, context.messages.at(-1).content))]);
    const step = turns.shift();
    if (!step) throw new Error('No more faux responses queued');
    return typeof step === 'function' ? step(context, ...rest) : step;
  };
  pair.partner.setResponses(Array.from({length: 500}, () => route));
  const partner = {...pair.partner, setResponses: list => { turns.splice(0, turns.length, ...list); }};
  watcher.setResponses(Array.from({length: 100}, () => fauxAssistantMessage([fauxText('0')]))); // no moment worth a remark
  if (stub) {
    const file = join(scratch('pair-stub-'), 'stub.lua');
    writeFileSync(file, STUB);
    remote(`luaeval("dofile('${file}') or 0")`);
  }
  const extmarks = ns => JSON.parse(remote(`luaeval("vim.json.encode(vim.api.nvim_buf_get_extmarks(0, vim.api.nvim_create_namespace('${ns}'), 0, -1, {details = true}))")`));
  return {
    ...pair,
    partner,
    /** The ghost lines in the current buffer: [row, the lines as text]. */
    ghosts: () => virtLines(extmarks('pair_suggest')),
    /** Pair's words under the lines, as the hand-back line draws them: [row, text]. */
    words: () => virtLines(extmarks('pair')),
    asked: () => JSON.parse(remote('luaeval("vim.json.encode(_G.gen_asked)")')),
    answer: (...answers) => remote(`luaeval("#vim.list_extend(_G.gen_answers, _A)", ${JSON.stringify(answers)})`),
    /** The floating windows: their buffers' line counts. */
    floats: () => JSON.parse(remote(`luaeval("vim.json.encode(vim.tbl_map(function(w) return vim.api.nvim_buf_line_count(vim.api.nvim_win_get_buf(w)) end, vim.tbl_filter(function(w) return vim.api.nvim_win_get_config(w).relative ~= '' end, vim.api.nvim_list_wins())))")`)),
    said: text => until(() => messages.some(message => message.type === 'message' && (typeof text === 'string' ? message.text === text : text.test(message.text))), `the chat to say ${text}`),
    async today() {
      const before = messages.filter(message => message.type === 'ledger').length;
      send({type: 'today'});
      await until(() => messages.filter(message => message.type === 'ledger').length > before, 'the ledger');
      return messages.filter(message => message.type === 'ledger').at(-1).rows;
    },
  };
}

test('/gen here with a popup input: the request, the shape guessed and shown, the code where you asked after you typed on, Alt-y, then /undo', {skip, timeout: 40_000}, async () => {
  const {partner, keys, lines, status, ghosts, words, asked, answer, said, today, send, messages, stop} = await genInNvim('add helpers', {stub: true});
  try {
    let input;
    partner.setResponses([
      async context => {
        input = context.messages.at(-1).content;
        keys('ggOconst top = 0<Esc>'); // you type on above the place while Pair writes
        await until(() => lines()[0] === 'const top = 0', 'the line typed above');
        return fauxAssistantMessage([fauxToolCall('propose', {file: 'a.js', line: 2, insert: true, text: 'const w = 4', note: 'w'})], {stopReason: 'toolUse'});
      },
      fauxAssistantMessage([fauxText('Added w, a number.')]),
    ]);
    answer('a w constant', 'here');
    keys('2G<M-g>');
    await said('gen #1 · here · 1 line at a.js:2: Added w, a number.');
    assert.match(typeof input === 'string' ? input : JSON.stringify(input), /\[gen\] gen #1, here\. The user asked: \\?"a w constant\\?"[\s\S]*cursor is on line 2 of a\.js/);
    const [request, shape] = asked();
    assert.deepEqual(request, {kind: 'input', prompt: 'gen · what should Pair write? ', default: ''});
    assert.equal(shape.prompt, 'gen #1 · at the cursor. Shape?');
    assert.deepEqual(shape.items, [
      'here      at the cursor, over a selection  (guessed)',
      'file      new files to review',
      'scaffold  many files, in Pair\'s copy',
      'try       a sample outside the project',
    ]);

    // It lands under the line you asked on, which your typing moved down one, once you pause.
    await until(() => ghosts().length === 1, 'the ghost lines');
    const [[row, text]] = ghosts();
    assert.equal(row, 2, 'under `const y = 2`, now line 3');
    assert.match(text, /^const w = 4\n.*gen #1 · w/);
    const ready = () => /gen #1 ready · M-y takes · :Pair dismiss/.test(status());
    ready.last = status;
    await until(ready, 'the statusline');
    assert.deepEqual(lines(), ['const top = 0', 'const x = 1', 'const y = 2', 'const z = 3']);

    keys('<M-y>');
    await until(() => lines().join('\n') === 'const top = 0\nconst x = 1\nconst y = 2\nconst w = 4\nconst z = 3', 'the code taken');
    await said(/^gen #1: 1 line taken into a\.js, unsaved/);
    assert.equal(ghosts().length, 0);
    const [[under, handback]] = words();
    assert.equal(under, 3, 'the hand-back line under the line taken');
    assert.match(handback, /gen #1: 1 line taken, unsaved/);

    // The edit is the request's: the Partner sees it as Pair's, not yours.
    let seen;
    partner.setResponses([context => { seen = JSON.stringify(context.messages.at(-1).content); return fauxAssistantMessage([fauxText('Fine.')]); }]);
    await sleep(300); // the plugin's debounce
    send({type: 'ask', text: 'ok?'});
    await said('Fine.');
    assert.match(seen, /a\.js:4-4 \([^)]*by Pair \(gen #1\)\)/);

    send({type: 'undo_last'});
    await until(() => lines().join('\n') === 'const top = 0\nconst x = 1\nconst y = 2\nconst z = 3', 'the request undone, your line kept');
    await said('Undid gen #1: took back 1 piece, unsaved.');
    const row1 = (await today()).find(one => one.kind === 'generated');
    assert.deepEqual([row1.text, row1.state], ['gen #1 · here · a w constant', 'undone']);

    // Esc on the request asks nothing; Esc on the shape leaves it waiting, and Alt-g shows it again.
    answer('<Esc>');
    keys('<M-g>');
    await until(() => asked().length === 3, 'the dialog');
    await sleep(200);
    assert.equal(messages.filter(message => message.text?.startsWith('/gen')).length, 1, 'no request sent');
    partner.setResponses([fauxAssistantMessage([fauxText('Nothing to add.')])]);
    answer('a v constant');
    keys('<M-g>');
    await until(() => /gen #2 asks · M-g/.test(status()), 'the question waiting');
    answer('here');
    keys('<M-g>');
    await said('gen #2 · here · nothing proposed: Nothing to add.');
    await until(() => status() === '● pair', 'the statusline to settle');
  } finally {
    await stop();
  }
});

test('/gen here with Neovim\'s own prompt: the request on the command line, the shape as a numbered list, a tall block in a preview, the compose window', {skip, timeout: 60_000}, async () => {
  const {project, partner, keys, remote, lines, status, ghosts, floats, said, today, messages, stop} = await genInNvim('a table');
  const routes = Array.from({length: 40}, (_, i) => `const r${i} = ${i}`).join('\n');
  try {
    partner.setResponses([
      fauxAssistantMessage([fauxToolCall('propose', {file: 'a.js', line: 1, insert: true, text: routes, note: 'the table'})], {stopReason: 'toolUse'}),
      fauxAssistantMessage([fauxText('Forty constants.')]),
    ]);
    keys(':Pair gen<CR>');
    await sleep(300);
    keys('here a table of constants<CR>'); // a shape you type is not asked
    await said(/^gen #1 · here · 40 lines at a\.js:1/);
    // Taller than gen_preview_lines: one line in place, the block in a preview window under it.
    const previewed = () => ghosts().length === 1 && floats().length === 1;
    previewed.last = () => JSON.stringify({ghosts: ghosts(), floats: floats(), messages: remote('execute("messages")').slice(0, 400)});
    await until(previewed, 'the preview');
    assert.deepEqual(floats(), [40]);
    // Line 1 is the window's first row and its hint the second: the preview's border starts below both.
    const top = Number(remote(`luaeval("vim.api.nvim_win_get_position(vim.tbl_filter(function(w) return vim.api.nvim_win_get_config(w).relative ~= '' end, vim.api.nvim_list_wins())[1])[1]")`));
    assert.ok(top >= 2, `the preview starts on screen row ${top}, under the hint`);
    assert.equal(ghosts()[0][1].split('\n').length, 1);
    assert.match(ghosts()[0][1], /gen #1 · 40 lines: the table.*M-y takes · M-j preview/);
    keys('<M-j>'); // into the preview, to scroll
    await until(() => remote('luaeval("vim.api.nvim_win_get_config(0).relative")') !== '', 'the preview entered');
    keys('q');
    await until(() => floats().length === 0, 'q to close it');
    keys('<M-y>');
    await until(() => lines().length === 43, 'all 40 lines taken');
    // Below gen_preview_lines, a block taller than its window goes to the preview too: it could not be read in place.
    const height = Number(remote('winheight(0)'));
    const tall = count => remote(`luaeval("require('pair.gen').too_tall(vim.fn['repeat']({'x'}, ${count}), vim.api.nvim_get_current_buf()) and 1 or 0")`);
    assert.ok(height < 30, `the headless window is ${height} rows`);
    assert.equal(tall(height - 2), '0');
    assert.equal(tall(height - 1), '1');
    assert.equal(lines()[1], 'const r0 = 0');

    // No shape word: the guess comes as a numbered list on the command line, where an empty Enter takes it.
    partner.setResponses([
      fauxAssistantMessage([fauxToolCall('propose', {file: 'a.js', line: 1, insert: false, end_line: 1, text: 'const x = 10', note: 'ten'})], {stopReason: 'toolUse'}),
      fauxAssistantMessage([fauxText('Ten.')]),
    ]);
    keys(':Pair gen<CR>');
    await sleep(300);
    keys('x as ten<CR>');
    await sleep(500);
    keys('<CR>');
    await said('gen #2 · here · 1 line at a.js:1: Ten.');
    await until(() => ghosts().length === 1, 'its ghost diff');
    keys(':Pair dismiss<CR>');
    await until(() => ghosts().length === 0, 'dismissed');
    await until(async () => (await today()).find(row => row.text === 'gen #2 · here · x as ten')?.note === '1 dropped', 'the piece dropped in the ledger');

    // An empty Enter opens the compose window; :w sends what it holds.
    partner.setResponses([fauxAssistantMessage([fauxText('Nothing.')])]);
    keys(':Pair gen<CR>');
    await sleep(300);
    keys('<CR>');
    await until(() => remote('bufname()') === 'pair://gen/compose', 'the compose window');
    keys('a sum<CR>of two numbers<Esc>:w<CR>');
    await sleep(500);
    keys('1<CR>');
    await said('gen #3 · here · nothing proposed: Nothing.');
    assert.ok(messages.some(message => message.text === '/gen a sum\nof two numbers'), 'both lines are the request');
    assert.equal(floats().length, 0, 'the compose window closed');
    assert.equal(readFileSync(join(project, 'a.js'), 'utf8'), 'const x = 1\nconst y = 2\nconst z = 3\n', 'nothing was saved');
    // The 40 lines taken are not yours yet: the statusline counts them.
    await until(() => status() === '● pair · ┊ 40 generated', 'the statusline to settle');
  } finally {
    await stop();
  }
});

test('/gen here from the chat goes to your Neovim cursor and asks in the chat; a question for Neovim waits for your pause in typing', {skip, timeout: 40_000}, async () => {
  const {partner, keys, lines, status, ghosts, asked, answer, said, send, messages, stop} = await genInNvim('statuses', {stub: true});
  const toolResult = context => context.messages.filter(message => message.role === 'toolResult').at(-1).content[0].text;
  try {
    // From the chat: the place is the cursor in Neovim, and Pair's question is asked in the chat.
    let answered;
    partner.setResponses([
      fauxAssistantMessage([fauxToolCall('ask', {question: 'which value?', default: '5'})], {stopReason: 'toolUse'}),
      context => {
        answered = toolResult(context);
        return fauxAssistantMessage([fauxToolCall('propose', {file: 'a.js', line: 3, insert: true, text: 'const v = 7', note: 'v'})], {stopReason: 'toolUse'});
      },
      fauxAssistantMessage([fauxText('v is 7.')]),
    ]);
    keys('3G');
    await sleep(200);
    send({type: 'gen', text: 'here a v constant'});
    const confirm = await until(() => messages.find(message => message.type === 'confirm'), 'the question in the chat');
    assert.equal(confirm.text, 'gen #1 asks: which value? y keeps `5`, n leaves it to Pair, or type your answer.');
    send({type: 'confirm', id: confirm.id, ok: false, text: '7'});
    await said('gen #1 · here · 1 line at a.js:3: v is 7.');
    assert.equal(answered, 'The user answered: "7"');
    assert.deepEqual(asked(), [], 'no dialog in Neovim');
    await until(() => ghosts().length === 1, 'the ghost lines');
    assert.equal(ghosts()[0][0], 2, 'under the cursor\'s line');
    // `a` on the request's line in the chat takes it in Neovim, as Alt-y does there.
    const shown = messages.find(message => message.text === 'gen #1 · here · 1 line at a.js:3: v is 7.');
    assert.deepEqual(shown.meta.suggestion.new, ['const v = 7']);
    send({type: 'accept', action: shown.meta.suggestion.action});
    await until(() => lines()[3] === 'const v = 7', 'taken');
    await until(() => messages.some(message => message.type === 'applied' && message.action === shown.meta.suggestion.action), 'the chat to hear it was taken');

    // From Neovim: the question is a dialog there, but not while you type.
    partner.setResponses([
      async () => {
        keys('A // still typing');
        await sleep(300);
        return fauxAssistantMessage([fauxToolCall('ask', {question: 'and u?', default: '8'})], {stopReason: 'toolUse'});
      },
      context => { answered = toolResult(context); return fauxAssistantMessage([fauxText('No code after all.')]); },
    ]);
    answer('9');
    keys(':Pair gen here a u constant<CR>');
    await said('gen #2 asks: and u? (default: 8; answer in Neovim)');
    await sleep(1000);
    assert.deepEqual(asked(), [], 'no dialog in Insert mode');
    assert.match(status(), /gen #2 asks · M-g/);
    keys('<Esc>');
    await said('gen #2 · here · nothing proposed: No code after all.');
    assert.deepEqual(asked(), [{kind: 'input', prompt: 'gen #2 asks: and u? ', default: '8'}]);
    assert.equal(answered, 'The user answered: "9"');
  } finally {
    await stop();
  }
});

test('a request that waited its turn is told where its mark is now, after you typed above it', {skip, timeout: 40_000}, async () => {
  const {partner, keys, lines, ghosts, said, stop} = await genInNvim('two at once');
  try {
    let release;
    let input;
    partner.setResponses([
      () => new Promise(resolve => { release = () => resolve(fauxAssistantMessage([fauxText('First, nothing.')])); }),
      context => {
        input = JSON.stringify(context.messages.at(-1).content);
        // By what it sees: below `const z = 3`, which is line 5 now.
        return fauxAssistantMessage([fauxToolCall('propose', {file: 'a.js', line: 5, insert: true, text: 'const w = 4', note: 'w'})], {stopReason: 'toolUse'});
      },
      fauxAssistantMessage([fauxText('Second.')]),
    ]);
    keys(':Pair gen here first<CR>');
    await until(() => release, 'the first request to run');
    keys('3G:Pair gen here after z<CR>');
    await said('gen #2 waits for gen #1.');
    keys('ggOconst a = 0<CR>const b = 0<Esc>');
    await until(() => lines().length === 5, 'two lines typed above');
    release();
    await said('gen #2 · here · 1 line at a.js:5: Second.');
    assert.match(input, /cursor is on line 5 of a\.js/);
    assert.match(input, /5: const z = 3/);
    await until(() => ghosts().length === 1, 'the ghost lines');
    assert.equal(ghosts()[0][0], 4, 'under `const z = 3`, shifted once, not twice');
  } finally {
    await stop();
  }
});

test('the brief in Neovim: :Pair brief pins the note, a request against it asks in a dialog, the debrief says what holds up', {skip, timeout: 60_000}, async () => {
  const bigint = JSON.stringify([{source: 'note', line: 3, quote: 'no BigInt', brief_says: 'plain numbers', asked: 'BigInt'}]);
  const logs = JSON.stringify([{source: 'note', line: 4, quote: 'Every helper is pure', brief_says: 'pure helpers', asked: 'logging'}]);
  const check = JSON.stringify([
    {kind: 'contradicts', source: 'note', line: 3, quote: 'no BigInt', piece: 1, piece_line: 1, text: 'uses BigInt'}, // the user chose that
    {kind: 'contradicts', source: 'note', line: 4, quote: 'Every helper is pure', piece: 1, piece_line: 1, text: 'logs w'},
    {kind: 'contradicts', source: 'note', line: 2, quote: 'made up', piece: 1, piece_line: 1, text: 'invented'},
    {kind: 'guessed', text: 'w is a BigInt literal'},
  ]);
  const seen = [];
  const brief = (kind, content) => {
    seen.push({kind, content});
    const request = content.split('The request:')[1] ?? '';
    if (kind === 'check') return check;
    return /log/.test(request) ? logs : /BigInt/.test(request) ? bigint : '[]';
  };
  const {project, partner, keys, remote, asked, answer, said, today, messages, stop} = await genInNvim('add helpers', {stub: true, brief, notes: '# Helpers\n\nNumbers are plain: no BigInt.\nEvery helper is pure.\n'});
  const notified = () => JSON.parse(remote('luaeval("vim.json.encode(_G.notified)")'));
  try {
    writeFileSync(join(project, 'plan.md'), '# Plan\n\nNumbers are plain: no BigInt.\n');
    keys(':edit plan.md<CR>:Pair brief<CR>');
    await said('The brief: plan.md (pinned) + goal "add helpers". Every /gen runs against it; Pair never edits it.');
    await until(() => notified().includes('Pair: The brief: plan.md (pinned) + goal "add helpers". Every /gen runs against it; Pair never edits it.'), 'Neovim to say it too');
    keys(':Pair brief off<CR>');
    await said('The brief leaves the note out now: goal "add helpers". /brief <note> pins one.');
    keys(':Pair brief NOTES.md<CR>');
    await said('The brief: NOTES.md (pinned) + goal "add helpers". Every /gen runs against it; Pair never edits it.');
    keys(':buffer a.js<CR>');

    // The request contradicts the brief: Neovim asks in a dialog, the brief's choice first.
    partner.setResponses([
      fauxAssistantMessage([fauxToolCall('propose', {file: 'a.js', line: 2, insert: true, text: 'const w = 4n', note: 'w'})], {stopReason: 'toolUse'}),
      fauxAssistantMessage([fauxText('w as a BigInt.')]),
    ]);
    answer('y');
    keys('2G:Pair gen here w as a BigInt<CR>');
    const debrief = '≠ brief "Every helper is pure." NOTES.md:4 · a.js:3 logs w\n? guessed w is a BigInt literal';
    await said(`gen #1 · here · 1 line at a.js:2: w as a BigInt.\n${debrief}`);
    const dialog = asked().find(one => one.kind === 'select');
    assert.deepEqual(dialog, {
      kind: 'select', prompt: 'gen #1 · the brief says plain numbers: "Numbers are plain: no BigInt." NOTES.md:3',
      items: ['follow the brief: plain numbers', 'as asked: BigInt', 'open NOTES.md:3'],
    });
    assert.ok(messages.some(message => message.text === 'gen #1: as asked, BigInt, against NOTES.md:3. Pair does not ask about that line again this session.'));
    assert.match(seen.find(call => call.kind === 'check').content, /The user chose the request over the brief's "Numbers are plain: no BigInt\."/);
    await until(() => notified().includes(`Pair · gen #1\n${debrief}`), 'the debrief in Neovim');
    const row = (await today()).find(one => one.kind === 'generated');
    assert.equal(row.note, '1 line proposed · ≠1');

    // The line the user went against is not asked about again this session.
    keys(':Pair dismiss<CR>');
    partner.setResponses([fauxAssistantMessage([fauxText('Nothing.')])]);
    keys(':Pair gen here v as a BigInt too<CR>');
    await said('gen #2 · here · nothing proposed: Nothing.');
    assert.equal(asked().filter(one => one.kind === 'select').length, 1, 'no second dialog');

    // e on another line opens the brief there, in a split, and the request ends.
    answer('e');
    keys(':Pair gen here v that logs<CR>');
    await said('gen #3 cancelled: NOTES.md:4 is open in Neovim. Change the brief or the request, then /gen again.');
    await until(() => remote('fnamemodify(bufname(), ":t")') === 'NOTES.md' && remote('line(".")') === '4', 'the note open at line 4');
  } finally {
    await stop();
  }
});

/** The pair://gen/<n>/… buffers in Neovim: name, buftype, modified, whether a window shows it, and its lines. */
const proposals = remote => JSON.parse(remote(`luaeval("vim.json.encode(vim.tbl_map(function(b) return {name = vim.api.nvim_buf_get_name(b), buftype = vim.bo[b].buftype, modified = vim.bo[b].modified, shown = vim.fn.bufwinid(b) ~= -1, lines = vim.api.nvim_buf_get_lines(b, 0, -1, false)} end, vim.tbl_filter(function(b) return vim.api.nvim_buf_is_loaded(b) and vim.api.nvim_buf_get_name(b):find('^pair://gen/%d') ~= nil end, vim.api.nvim_list_bufs())))")`));

test('/gen file: pair:// buffers to review; :wa skips them, quitting warns, :w takes one, the list drops another, /undo deletes the file; they come back after a restart', {skip, timeout: 60_000}, async () => {
  const {project, partner, keys, remote, status, said, send, asked, answer, restartDaemon, stop} = await genInNvim('orders', {stub: true});
  const notified = () => JSON.parse(remote('luaeval("vim.json.encode(_G.notified)")'));
  const listed = () => JSON.parse(remote(`luaeval("vim.json.encode(vim.api.nvim_buf_get_lines(vim.fn.bufnr('pair://gen/list'), 0, -1, false))")`));
  const migration = join(project, 'db/0007_status.sql');
  try {
    partner.setResponses([
      fauxAssistantMessage([fauxToolCall('draft', {path: 'db/0007_status.sql', text: 'ALTER TABLE orders ADD status TEXT;\n', note: 'migration'})], {stopReason: 'toolUse'}),
      fauxAssistantMessage([fauxToolCall('draft', {path: 'status.test.js', text: 'test(\'status\')\n', note: 'its test'})], {stopReason: 'toolUse'}),
      fauxAssistantMessage([fauxText('A migration and its test.')]),
    ]);
    keys(':Pair gen file a migration adding status, and its test<CR>');
    await said(/^gen #1 · file · 2 new files to review: db\/0007_status\.sql \+1, status\.test\.js \+1: A migration and its test\./);
    await until(() => proposals(remote).length === 2, 'the buffers');
    assert.deepEqual(proposals(remote), [
      {name: 'pair://gen/1/db/0007_status.sql', buftype: 'acwrite', modified: true, shown: false, lines: ['ALTER TABLE orders ADD status TEXT;']},
      {name: 'pair://gen/1/status.test.js', buftype: 'acwrite', modified: true, shown: false, lines: ['test(\'status\')']},
    ], 'loaded, not opened');
    assert.equal(remote('getbufvar("pair://gen/1/db/0007_status.sql", "&filetype")'), 'sql');
    const reviewing = () => /gen #1 · 2 to review · :Pair gen list/.test(status());
    reviewing.last = status;
    await until(reviewing, 'the statusline');

    // :wa in a.js writes a.js and skips them; quitting warns as for any change not written.
    keys(':wa<CR>');
    await until(() => notified().some(text => text === 'Pair: gen #1: 2 buffers not taken. :w in one takes it; :Pair gen list lists them'), 'the :wa message');
    assert.equal(existsSync(migration), false);
    assert.equal(proposals(remote).every(one => one.modified), true);
    assert.match(remote('luaeval("select(2, pcall(vim.cmd, \'qa\'))")'), /E37|E162/);

    // :Pair gen list, Enter opens the first one; :w in it takes it, and it is an ordinary buffer of the file then.
    keys(':Pair gen list<CR>');
    await until(() => listed().some(line => line.includes('db/0007_status.sql')), 'the list');
    const list = listed();
    assert.match(list[0], /^gen #1 · file · a migration adding status, and its test · \d\d:\d\d$/);
    assert.ok(list.some(line => /◌ db\/0007_status\.sql\s+\+1\s+⏎ open  w take  d drop/.test(line)), list.join('\n'));
    assert.match(list.at(-1), /W take all · D drop all · u undo the request · q close/);
    keys('<CR>');
    await until(() => remote('bufname()') === 'pair://gen/1/db/0007_status.sql', 'the file opened');
    assert.equal(remote('&winbar'), 'generated · gen #1 · :w takes it to db/0007_status.sql'); // the remote's answer is trimmed

    // :e! brings the draft back, still to review; :w to another name writes a copy there and takes nothing.
    keys('Goscratch<Esc>:e!<CR>');
    await sleep(300);
    assert.deepEqual(JSON.parse(remote('json_encode(getline(1, "$"))')), ['ALTER TABLE orders ADD status TEXT;']);
    assert.deepEqual([remote('&modified'), remote('bufname()')], ['1', 'pair://gen/1/db/0007_status.sql']);
    keys(':w copy.sql<CR>');
    await until(() => existsSync(join(project, 'copy.sql')), 'the copy');
    await sleep(300);
    assert.equal(existsSync(migration), false, 'not taken');
    assert.equal(remote('bufname()'), 'pair://gen/1/db/0007_status.sql');
    assert.equal(proposals(remote).length, 2);
    keys('Go-- reviewed<Esc>:w<CR>');
    await until(() => existsSync(migration), 'the file written');
    assert.equal(readFileSync(migration, 'utf8'), 'ALTER TABLE orders ADD status TEXT;\n-- reviewed\n', 'as you had it');
    await until(() => remote('bufname()') === 'db/0007_status.sql', 'the real file in its window');
    assert.deepEqual([remote('&buftype'), remote('&modified'), remote('&winbar')], ['', '0', '']);
    await said('gen #1: db/0007_status.sql written, taken; 1 more to review. /undo takes back the request.');

    // d in the list drops the other: its buffer goes, and nothing is left to warn about.
    await until(() => listed().some(line => /◌ status\.test\.js/.test(line)), 'the list again');
    keys(':Pair gen list<CR>');
    await until(() => remote('bufname()') === 'pair://gen/list' && /status\.test\.js/.test(remote('getline(".")')), 'the cursor on the file left');
    keys('d');
    await said('gen #1: status.test.js dropped.');
    await until(() => proposals(remote).length === 0, 'its buffer gone');
    keys('q');

    // /undo deletes the file you wrote, as you wrote it.
    send({type: 'undo_last'});
    await said('Undid gen #1: took back 1 piece, 1 file you wrote from it deleted.');
    assert.equal(existsSync(migration), false);

    // A file to review outlives a daemon restart with your change in its buffer, and a Neovim that lost it gets it again.
    partner.setResponses([
      fauxAssistantMessage([fauxToolCall('draft', {path: 'lib/status.js', text: 'export const STATUSES = []\n', note: 'statuses'})], {stopReason: 'toolUse'}),
      fauxAssistantMessage([fauxText('The statuses.')]),
    ]);
    keys(':Pair gen file the statuses in lib/status.js<CR>');
    await until(() => proposals(remote).length === 1, 'its buffer');
    remote(`luaeval("vim.api.nvim_buf_set_lines(vim.fn.bufnr(_A[1]), 0, -1, false, {_A[2]})", ['pair://gen/2/lib/status.js', "export const STATUSES = ['new']"])`);
    await restartDaemon();
    await until(() => /gen · 1 to review|gen #2 · 1 to review/.test(status()) && remote('luaeval("require(\'pair\').status()")') !== '', 'connected again');
    await sleep(500);
    assert.deepEqual(proposals(remote).map(one => one.lines), [['export const STATUSES = [\'new\']']], 'one buffer, your change kept');
    keys(':Pair stop<CR>:bwipeout! pair://gen/2/lib/status.js<CR>');
    await until(() => proposals(remote).length === 0, 'lost while away');
    keys(':Pair start<CR>');
    await until(() => proposals(remote).length === 1, 'made again when it connects');
    assert.deepEqual(proposals(remote)[0].lines, ['export const STATUSES = []']);

    // W in the list takes every file of the request, once you said yes.
    keys(':Pair gen list<CR>');
    await until(() => remote('bufname()') === 'pair://gen/list' && /lib\/status\.js/.test(remote('getline(".")')), 'the list on gen #2');
    answer('y');
    keys('W');
    await until(() => existsSync(join(project, 'lib/status.js')), 'taken');
    assert.match(asked().at(-1).prompt, /^Take all 1 file of gen #2\? Read them first\.$/);
    await until(() => proposals(remote).length === 0, 'nothing left to review');
  } finally {
    await stop();
  }
});

test('/gen try: the sample in a split outside the project; the run key writes and runs it again; :Pair keep moves it in, :w takes it; :Pair gen tries opens one', {skip, timeout: 60_000}, async () => {
  const {project, partner, keys, remote, said, messages, send, answer, asked, stop} = await genInNvim('lru', {stub: true, runs: true});
  const notified = () => JSON.parse(remote('luaeval("vim.json.encode(_G.notified)")'));
  // Without bubblewrap here, a run that may write asks first, as Scout's does: the test says yes.
  const yes = setInterval(() => {
    for (const message of messages.filter(one => one.type === 'confirm' && !one.answered)) {
      message.answered = true;
      send({type: 'confirm', id: message.id, ok: true});
    }
  }, 100);
  try {
    partner.setResponses([
      fauxAssistantMessage([fauxToolCall('write', {path: 'lru.js', text: 'const cache = new Map()\ncache.set("a", 1)\nconsole.log("get a:", cache.get("a"))\n'})], {stopReason: 'toolUse'}),
      fauxAssistantMessage([fauxToolCall('run', {command: 'node lru.js'})], {stopReason: 'toolUse'}),
      fauxAssistantMessage([fauxText('A Map keeps the order.')]),
    ]);
    keys(':Pair gen try a small LRU cache<CR>');
    await said(/^gen #1 · try · lru\.js \+3 · ✓ `node lru\.js`: A Map keeps the order\.$/);
    const sample = messages.find(message => message.type === 'message' && /^gen #1 · try/.test(message.text));
    assert.match(sample.meta.hint, /^In Neovim: lru\.js in a split, outside the project\./, 'how to take it, apart: the full pane has keys for it');
    assert.equal(existsSync(join(project, 'lru.js')), false, 'nothing in the project');

    // It opens in a split below; the cursor stays where it was.
    await until(() => Number(remote('winnr("$")')) === 2, 'the split');
    assert.equal(remote('bufname()'), 'a.js');
    keys('<C-w>j');
    await until(() => /\/try\/1\/lru\.js$/.test(remote('bufname()')), 'in the split');
    assert.equal(remote('&winbar'), 'try · gen #1 · outside the project · \\r runs it · :Pair keep moves it in');
    const dir = remote('expand("%:p:h")');
    assert.ok(!dir.startsWith(project), 'outside the project');

    // You change it; the run key writes it and runs it again in Pair's pane.
    keys('Goconsole.log("evicts b")<Esc>');
    keys('\\r');
    await until(() => notified().some(text => /^Pair: gen #1 · ✓ `node lru\.js`\n(get a: 1\n)?evicts b$/.test(text)), 'run again');
    assert.equal(readFileSync(join(dir, 'lru.js'), 'utf8').split('\n').at(-2), 'console.log("evicts b")', 'written before it ran');
    assert.equal(remote('&modified'), '0');

    // :Pair keep in it: a buffer to review in the project, in its window; :w takes it.
    keys(':Pair keep src/lru.js<CR>');
    await until(() => remote('bufname()') === 'pair://gen/1/src/lru.js', 'the kept buffer');
    assert.deepEqual([remote('&buftype'), remote('&modified'), remote('&winbar')], ['acwrite', '1', 'generated · gen #1 · :w takes it to src/lru.js']);
    assert.equal(JSON.parse(remote('json_encode(getline(1, "$"))')).at(-1), 'console.log("evicts b")', 'as you changed it');
    assert.equal(existsSync(join(project, 'src')), false, 'unsaved');
    await said('gen #1: src/lru.js opened, unsaved, generated. :w takes it; u on gen #1 in :Pair today takes it back.');
    keys(':w<CR>');
    await until(() => existsSync(join(project, 'src/lru.js')), 'written');
    await said('gen #1: src/lru.js written, taken. /undo takes back the request.');

    // :Pair gen tries lists the folders still kept; the one you pick opens.
    keys(':only<CR>');
    answer(1);
    keys(':Pair gen tries<CR>');
    await until(() => asked().some(one => one.prompt === 'Pair · the /gen tries'), 'the list');
    assert.deepEqual(asked().at(-1).items, ['gen #1 · a small LRU cache · lru.js · 7 days left']);
    await until(() => Number(remote('winnr("$")')) === 2, 'opened again');

    // With a mapping of your own on the run key, Pair maps nothing there, and the winbar names :Pair gen run.
    keys(':only<CR>');
    remote(`luaeval("vim.keymap.set('n', '<LocalLeader>r', ':echo 1<CR>') or 0")`);
    remote(`luaeval("require('pair.gentry').on_try({gen = 9, dir = _A[1], open = _A[2], words = 'x'}) or 0", [${JSON.stringify(dir.replace(/\/1$/, '/9'))}, ${JSON.stringify(join(dir.replace(/\/1$/, '/9'), 'x.js'))}])`);
    keys('<C-w>j');
    await until(() => /\/try\/9\/x\.js$/.test(remote('bufname()')), 'the other try');
    assert.equal(remote('&winbar'), 'try · gen #9 · outside the project · :Pair gen run runs it · :Pair keep moves it in');
  } finally {
    clearInterval(yes);
    await stop();
  }
});

test('/gen scaffold: built in Pair\'s copy; :Pair gen list opens a file of it with its winbar, k keeps a new file as a buffer and a change as suggestions in yours, x deletes the copy', {skip, timeout: 60_000}, async () => {
  const {project, partner, keys, remote, said, answer, asked, ghosts, status, stop} = await genInNvim('admin', {stub: true});
  const listed = () => JSON.parse(remote(`luaeval("vim.json.encode(vim.api.nvim_buf_get_lines(vim.fn.bufnr('pair://gen/list'), 0, -1, false))")`));
  const lines = () => JSON.parse(remote('json_encode(getbufline(bufnr("a.js"), 1, "$"))'));
  try {
    partner.setResponses([
      fauxAssistantMessage([fauxToolCall('write', {path: 'admin.js', text: 'export const admin = 1\n'})], {stopReason: 'toolUse'}),
      fauxAssistantMessage([fauxToolCall('propose', {file: 'a.js', line: 3, insert: true, text: 'const w = 4\n', note: 'w'})], {stopReason: 'toolUse'}),
      fauxAssistantMessage([fauxText('An admin module, wired into a.js.')]),
    ]);
    keys(':Pair gen scaffold an admin module<CR>');
    await said(/^gen #1 · scaffold · 2 files, 1 of yours changed · \d+s: An admin module, wired into a\.js\.\nin Pair's copy \S+\/gen\/\S+\/1\n/);
    assert.equal(existsSync(join(project, 'admin.js')), false, 'nothing in the project');
    assert.deepEqual(lines(), ['const x = 1', 'const y = 2', 'const z = 3']);
    const ready = () => /gen #1 · scaffold · :Pair gen list keeps it/.test(status());
    ready.last = status;
    await until(ready, 'the statusline');

    // The list: the copy's files, what each is, and the keys.
    keys(':Pair gen list<CR>');
    await until(() => listed().some(line => line.includes('admin.js')), 'the list');
    const list = listed();
    assert.match(list[0], /^gen #1 · scaffold · an admin module · \d\d:\d\d$/);
    assert.match(list[1], /^ {2}copy \S+\/1 · 0 of 2 kept/);
    assert.ok(list.some(line => /◌ \+ admin\.js\s+\+1\s+⏎ open {2}k keep {2}d drop/.test(line)), list.join('\n'));
    assert.ok(list.some(line => /◌ ~ a\.js\s+\+1 -0\s+⏎ diff {2}k as suggestions {2}d drop/.test(line)), list.join('\n'));
    assert.ok(list.includes('  t terminal in the copy · r run the check again · x delete the copy'));
    assert.match(list.at(-1), /k keep · d drop/);

    // Enter opens the new file of the copy, which says what it is.
    await until(() => /admin\.js/.test(remote('getline(".")')), 'the cursor on admin.js');
    keys('<CR>');
    await until(() => /\/gen\/[^/]+\/1\/admin\.js$/.test(remote('bufname()')), 'the copy\'s file');
    assert.equal(remote('&winbar'), 'scaffold · gen #1 · Pair\'s copy, not your file · \\r checks it · :Pair keep keeps it');

    // k on it: a buffer to review in the project; :w takes it.
    keys(':Pair gen list<CR>');
    await until(() => remote('bufname()') === 'pair://gen/list' && /admin\.js/.test(remote('getline(".")')), 'back in the list');
    keys('k');
    await said('gen #1: admin.js opened, unsaved, generated. :w takes it.');
    await until(() => remote('luaeval("vim.fn.bufnr(\'pair://gen/1/admin.js\')")') !== '-1', 'its buffer');

    // k on the change: a suggestion in a.js, which Alt-y takes.
    keys(':Pair gen list<CR>');
    await until(() => remote('bufname()') === 'pair://gen/list' && /a\.js/.test(remote('getline(".")')), 'the cursor on a.js, the next to keep');
    keys('k');
    await said('gen #1: a.js: 1 change, shown there as suggestions; Alt-y (:Pair accept) takes each.');
    keys(':q<CR>:only<CR>:buffer a.js<CR>');
    await until(() => remote('bufname()') === 'a.js' && ghosts().length === 1, 'the ghost lines');
    keys('3G<M-y>');
    await until(() => lines().length === 4, 'taken');
    assert.deepEqual(lines(), ['const x = 1', 'const y = 2', 'const z = 3', 'const w = 4']);

    // x deletes the copy, after a yes.
    keys(':Pair gen list<CR>');
    await until(() => remote('bufname()') === 'pair://gen/list' && listed().some(line => /2 of 2 kept/.test(line)), 'both kept');
    answer('y');
    keys('x');
    await said('gen #1: its copy is deleted. 2 files kept from it stay.');
    assert.match(asked().at(-1).prompt, /^Delete gen #1's copy\?$/);
    await until(() => listed().some(line => /copy deleted · 2 of 2 kept/.test(line)), 'the list again');
  } finally {
    await stop();
  }
});

const HANDLERS = 'function list(rows) {\n  return rows.slice(0, 50)\n}\n\nfunction get(rows, id) {\n  return rows.find(row => row.id === id)\n}';

test('owning in Neovim: ┊ on the lines taken, part by part; your edit makes a part yours; found again after :e; :Pair today, :Pair own; lines gone', {skip, timeout: 40_000}, async () => {
  const {project, partner, keys, remote, lines, status, ghosts, said, today, messages, stop} = await genInNvim('handlers');
  // The ┊ marks in the current buffer: [first row, last row], and their sign.
  const marks = () => JSON.parse(remote(`luaeval("vim.json.encode(vim.tbl_map(function(m) return {m[2], m[4].end_row, m[4].sign_text} end, vim.api.nvim_buf_get_extmarks(0, vim.api.nvim_create_namespace('pair_generated'), 0, -1, {details = true})))")`))
    .sort((a, b) => a[0] - b[0]);
  const rows = () => JSON.stringify(marks().map(([first, last]) => [first, last]));
  try {
    partner.setResponses([
      fauxAssistantMessage([fauxToolCall('propose', {file: 'a.js', line: 1, insert: true, text: HANDLERS, note: 'handlers'})], {stopReason: 'toolUse'}),
      fauxAssistantMessage([fauxText('Two handlers.')]),
    ]);
    keys(':Pair gen here two handlers<CR>');
    await said(/^gen #1 · here · 7 lines at a\.js:1/);
    await until(() => ghosts().length === 1, 'the ghost lines');
    keys('<M-y>');
    await until(() => lines().length === 10, 'the handlers taken');
    // Each part between blank lines is marked on its own, with a thin ┊.
    await until(() => rows() === '[[1,3],[5,7]]', 'the marks');
    assert.equal(marks()[0][2], '┊ ');
    await until(() => status() === '● pair · ┊ 6 generated', 'the statusline');

    // Typing above them moves them; it is no edit of theirs.
    keys('ggOconst top = 0<Esc>');
    await until(() => rows() === '[[2,4],[6,8]]', 'the marks moved');
    // A line of the first part changed by you: that part is yours, the other still Pair's.
    keys('4GA // fifty<Esc>');
    await until(() => rows() === '[[6,8]]', 'the first part yours');
    assert.equal(status(), '● pair · ┊ 3 generated');
    assert.equal((await today()).find(row => row.kind === 'generated').counts.lines.owned, 3, 'the ledger knows');

    // Saved and read again: found again by its text.
    keys(':w<CR>:e!<CR>');
    await sleep(300);
    await until(() => rows() === '[[6,8]]', 'found again after :e!');

    // :Pair today ends with what is not yours yet; :Pair own makes the file's yours.
    keys(':Pair today<CR>');
    await until(() => /^┊ not yours yet: 1 file · 3 lines$/.test(remote('getline("$")')), 'the line in :Pair today');
    keys('q');
    await until(() => remote('bufname()').endsWith('a.js'), 'back in a.js');
    keys(':Pair own<CR>');
    await said('3 lines of generated code are yours now.');
    await until(() => rows() === '[]', 'no marks left');
    assert.equal(status(), '● pair');

    // Code taken that changed while it was not loaded is gone, neither yours nor Pair's.
    partner.setResponses([
      fauxAssistantMessage([fauxToolCall('propose', {file: 'a.js', line: 1, insert: true, text: 'const w = 4', note: 'w'})], {stopReason: 'toolUse'}),
      fauxAssistantMessage([fauxText('A w.')]),
    ]);
    keys('gg:Pair gen here a w<CR>');
    await said(/^gen #2 · here · 1 line at a\.js:1/);
    await until(() => ghosts().length === 1, 'the ghost line');
    keys('<M-y>');
    await until(() => rows() === '[[1,1]]', 'its mark');
    keys(':w<CR>');
    await sleep(200);
    writeFileSync(join(project, 'a.js'), readFileSync(join(project, 'a.js'), 'utf8').replace('const w = 4', 'const w = 5'));
    keys(':e!<CR>');
    await until(() => rows() === '[]', 'gone');
    await until(async () => (await today()).find(row => row.text === 'gen #2 · here · a w')?.counts.lines.gone === 1, 'gone in the ledger');
    assert.equal(messages.filter(message => message.type === 'ledger').at(-1).generated.lines, 0);

    // :'<,'>Pair own owns the parts on those lines; a formatter on save that changes a part owns it too.
    partner.setResponses([
      fauxAssistantMessage([fauxToolCall('propose', {file: 'a.js', line: 1, insert: true, text: 'const v = 6\n\nconst u = 7', note: 'v, u'})], {stopReason: 'toolUse'}),
      fauxAssistantMessage([fauxText('A v and a u.')]),
    ]);
    keys('gg:Pair gen here a v and a u<CR>');
    await said(/^gen #3 · here · 3 lines at a\.js:1/);
    await until(() => ghosts().length === 1, 'the ghost lines');
    keys('<M-y>');
    await until(() => rows() === '[[1,1],[3,3]]', 'its marks');
    keys('2GV:Pair own<CR>');
    await said('1 line of generated code is yours now.');
    await until(() => rows() === '[[3,3]]', 'the v yours');
    remote(`luaeval("vim.api.nvim_create_autocmd('BufWritePre', {buffer = 0, callback = function() vim.api.nvim_buf_set_lines(0, 3, 4, false, {'const u = 8'}) end}) and 0")`);
    keys(':w<CR>');
    await until(() => rows() === '[]', 'the formatted u yours');
    await until(async () => (await today()).find(row => row.text === 'gen #3 · here · a v and a u')?.counts.lines.owned === 2, 'both owned in the ledger');
  } finally {
    await stop();
  }
});

test('the gen card\'s keys from the chat: k opens the next file to review in the window you work in, Enter opens :Pair gen list', {skip, timeout: 40_000}, async () => {
  const {partner, keys, remote, said, send, messages, stop} = await genInNvim('orders', {stub: true});
  try {
    partner.setResponses([
      fauxAssistantMessage([fauxToolCall('draft', {path: 'db/0007_status.sql', text: 'ALTER TABLE orders ADD status TEXT;\n', note: 'migration'})], {stopReason: 'toolUse'}),
      fauxAssistantMessage([fauxText('A migration.')]),
    ]);
    keys(':Pair gen file a migration adding status<CR>');
    await said(/^gen #1 · file · 1 new file to review/);
    await until(() => proposals(remote).length === 1, 'its buffer');
    const card = messages.filter(message => message.type === 'gen_card' && message.gen === 1).at(-1);
    assert.deepEqual([card.state, card.keys], ['ready', {k: 'keep one', d: 'drop all', enter: 'open the list', u: 'undo'}]);
    send({type: 'gen_open', action: card.action, what: 'next'});
    await until(() => remote('bufname()') === 'pair://gen/1/db/0007_status.sql', 'the file to review, opened');
    send({type: 'gen_open', action: card.action});
    await until(() => remote('bufname()') === 'pair://gen/list', ':Pair gen list');
  } finally {
    await stop();
  }
});
