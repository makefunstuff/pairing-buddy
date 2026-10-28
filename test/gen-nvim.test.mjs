// /gen in a headless Neovim against the daemon, with a scripted Partner. Twice: once with a stand-in that replaces
// vim.ui.input and vim.ui.select (as snacks.nvim, dressing.nvim and noice.nvim do), once with Neovim's own prompt
// on the command line, driven by keys. Skips without nvim.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {fauxAssistantMessage, fauxText, fauxToolCall} from '@earendil-works/pi-ai';
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
    if item.shape == answer then return on_choice(item, i) end
  end
  on_choice(nil, nil)
end
`;

const virtLines = marks => marks.filter(([, , , details]) => details.virt_lines)
  .map(([, row, , details]) => [row, details.virt_lines.map(line => line.map(chunk => chunk[0]).join('')).join('\n')]);

/** Pair in Neovim, with what `pairInNvim` gives and helpers for /gen's ghost lines, its dialogs and the ledger. */
async function genInNvim(goal, {stub = false} = {}) {
  const pair = await pairInNvim(goal);
  const {remote, messages, send, watcher} = pair;
  watcher.setResponses(Array.from({length: 100}, () => fauxAssistantMessage([fauxText('0')]))); // no moment worth a remark
  if (stub) {
    const file = join(scratch('pair-stub-'), 'stub.lua');
    writeFileSync(file, STUB);
    remote(`luaeval("dofile('${file}') or 0")`);
  }
  const extmarks = ns => JSON.parse(remote(`luaeval("vim.json.encode(vim.api.nvim_buf_get_extmarks(0, vim.api.nvim_create_namespace('${ns}'), 0, -1, {details = true}))")`));
  return {
    ...pair,
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
      'file      new files to review  (not built yet)',
      'scaffold  many files, in Pair\'s copy  (not built yet)',
      'try       a sample outside the project  (not built yet)',
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
    await until(() => status() === '● pair', 'the statusline to settle');
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
