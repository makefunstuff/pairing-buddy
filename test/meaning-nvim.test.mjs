// Search by meaning in Neovim: Alt-s and :Pair find open a live picker. In Telescope (a stand-in here that drives the
// picker's finder as the real one does, with the entries it gets) the words show on every key and meaning's pieces join
// below them once typing stops, the selection staying where it was; the entries carry what the previewer, Enter and
// <C-q> need. Without a model the words still work and the title says how to add meaning. vim.ui.select gets the fused
// ranking, and choosing a piece opens it at its line. The daemon's fake embedder stands in for EmbeddingGemma 2.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {fauxAssistantMessage, fauxText} from '@earendil-works/pi-ai';
import {pythonOf} from '../src/embedder.mjs';
import {Runtime, WHEELS} from '../src/runtime.mjs';
import {fakeEmbedder, fakeModel} from './fake-embedder.mjs';
import {fakeRerankChain, fakeReranker, fakeRerankServer} from './fake-reranker.mjs';
import {fakePython, fakeWheel} from './fake-python.mjs';
import {fzfLua} from './fzf-lua.mjs';
import {hasNvim, pairInNvim, until} from './nvim-harness.mjs';
import {scratch} from './temp.mjs';

const DELIVER = 'export function deliver(job) {\n  let tries = 0\n  while (tries < 5) {\n    tries += 1\n    if (send(job)) return true\n    sleep(backoff(tries))\n  }\n}\n';
const CART = 'export function total(cart) {\n  return cart.items.reduce((sum, item) => sum + item.cents * item.quantity, 0)\n}\n';
const INVOICE = '// What the order comes to.\nexport function bill(order) {\n  return order.price\n}\n';

/**
 * A Telescope that runs a picker's finder as the real one does: `_G.type_prompt(text)` types a prompt, and
 * `refresh` runs the finder again for it; `_G.telescoped` keeps the spec's title, sorter and previewer, the
 * entries shown, how many times they were made, the picker's own mappings (`maps.i['<C-q>']`) and whether it closed.
 */
function fakeTelescope() {
  const dir = scratch('meaning-telescope-');
  mkdirSync(join(dir, 'lua', 'telescope', 'actions'), {recursive: true});
  const module = (name, body) => writeFileSync(join(dir, 'lua', 'telescope', `${name}.lua`), body);
  module('pickers', `return {new = function(_, spec)
    local picker = {prompt = spec.default_text or '', callbacks = {}, prompt_border = {change_title = function(_, title) _G.telescoped.title = title end}}
    _G.telescoped = {title = spec.prompt_title, sorter = spec.sorter and spec.sorter.highlighter_only, previewer = spec.previewer ~= nil, shown = {}, runs = 0, maps = {i = {}, n = {}}}
    function picker:run()
      local shown = {}
      spec.finder(self.prompt, function(entry) shown[#shown + 1] = entry end, function()
        _G.telescoped.shown = shown
        _G.telescoped.runs = _G.telescoped.runs + 1
        _G.selected = shown[1] -- as Telescope's refresh, unless the picker selects another
        for _, callback in ipairs(self.callbacks) do callback(self) end
      end)
    end
    function picker:find() spec.attach_mappings(1, function(mode, lhs, action) _G.telescoped.maps[mode][lhs] = action end); self:run() end
    function picker:refresh() self:run() end
    function picker:register_completion_callback(callback) table.insert(self.callbacks, callback) end
    picker.manager = {num_results = function() return #_G.telescoped.shown end, get_entry = function(_, i) return _G.telescoped.shown[i] end}
    function picker:get_row(index) return index - 1 end
    function picker:set_selection(row) _G.selected = _G.telescoped.shown[row + 1] end
    _G.type_prompt = function(text) picker.prompt = text; picker:run() end
    return picker
  end}`);
  module('finders', 'return {}');
  module('sorters', 'return {highlighter_only = function() return {highlighter_only = true} end}');
  module('config', 'return {values = {grep_previewer = function() return {} end}}');
  module('actions/state', 'return {get_selected_entry = function() return _G.selected end}');
  module('actions', `local post
    local close = setmetatable({enhance = function(_, how) post = how.post end}, {__call = function()
      _G.telescoped.closed = true
      if post then post() end
    end})
    return {select_default = {enhance = function() end}, close = close}`);
  return dir;
}

/**
 * A snacks.picker that runs a live picker's finder as the real one does, in a coroutine its async suspends and
 * resumes: `_G.type_search(text)` types a search. `_G.snacked` keeps the title, the items shown, the piece the
 * cursor is drawn on when the list is drawn again (before `on_done` may move it) and whether it closed;
 * `_G.snacked.selected` stands for the items you selected, and `_G.snacked.act(name)` runs one of the picker's actions.
 */
function fakeSnacks() {
  const dir = scratch('meaning-snacks-');
  mkdirSync(join(dir, 'plugin'), {recursive: true});
  writeFileSync(join(dir, 'plugin', 'snacks.lua'), `_G.Snacks = {picker = setmetatable({}, {__call = function(_, spec)
    local picker = {title = spec.title, search = spec.search or '', closed = false, shown = {}, cursor = 1}
    _G.snacked = {title = spec.title, shown = {}, selected = {}}
    picker.list = {set_target = function(_, index) picker.target = index end, view = function(_, index) picker.cursor = index end}
    function picker:update_titles() _G.snacked.title = self.title end
    function picker:current() return self.shown[self.cursor] end
    function picker:items() return self.shown end
    function picker:selected() return _G.snacked.selected end
    function picker:close() self.closed = true; _G.snacked.closed = true; spec.on_close() end
    function picker:find(opts)
      local co
      co = coroutine.create(function()
        local items = {}
        local ctx = {filter = {search = self.search}, async = {
          schedule = function(_, fn) vim.schedule(fn) end,
          suspend = function() coroutine.yield() end,
          resume = function() vim.schedule(function() if coroutine.status(co) == 'suspended' then coroutine.resume(co) end end) end,
        }}
        spec.finder(nil, ctx)(function(item) items[#items + 1] = item end)
        self.shown = items
        self.cursor = self.target or 1 -- as the real list: its target, set before, else the top
        self.target = nil
        _G.snacked.shown = vim.tbl_map(function(item) return item.text end, items)
        local on = self:current()
        _G.snacked.drawn = on and on.text
        if opts and opts.on_done then opts.on_done() end
        on = self:current()
        _G.snacked.on = on and on.text
      end)
      coroutine.resume(co)
    end
    _G.type_search = function(text) picker.search = text; picker:find() end
    _G.snacked.act = function(name) spec.actions[name](picker) end
    _G.snacked.go = function(index) picker.cursor = index end
    picker:find()
    return picker
  end})}`);
  return dir;
}

/** Asks the daemon for its status until the project's index is built: `send` and `messages` are the chat client's. */
async function built(send, messages) {
  send({type: 'find', query: 'deliver'}); // the first search opens the index, which builds in the background
  await until(() => {
    send({type: 'status'});
    const index = messages.findLast(message => message.type === 'status')?.meaning.indexes[0];
    return index && index.chunks > 0 && index.embedded === index.chunks;
  }, 'the index to be built');
}

/**
 * The project as a git repo with a retry loop and a cart in it, so search by meaning has something to find: saved in
 * Neovim, as the index hears of new files between its looks at the whole project.
 */
async function withCode(project, remote) {
  writeFileSync(join(project, 'deliver.js'), DELIVER);
  writeFileSync(join(project, 'cart.js'), CART);
  writeFileSync(join(project, 'invoice.js'), INVOICE);
  execFileSync('git', ['init', '-q'], {cwd: project});
  for (const file of ['deliver.js', 'cart.js', 'invoice.js']) remote(`execute("edit ${join(project, file)} | write")`);
  await new Promise(resolve => setTimeout(resolve, 300));
}

const shown = remote => JSON.parse(remote('json_encode(luaeval("vim.tbl_map(function(e) return e.display end, _G.telescoped.shown)"))'));

test('Telescope, live: the words on every key, meaning below them once typing stops, nothing moving; entries for the previewer and <C-q>', {skip: hasNvim ? false : 'nvim not installed', timeout: 40_000}, async () => {
  const {project, dataDir, watcher, messages, remote, send, stop} = await pairInNvim('deliver', {rtp: [fakeTelescope()], setup: 'meaning_debounce_ms = 400', meaningWith: {embedder: fakeEmbedder()}});
  try {
    watcher.setResponses(Array.from({length: 10}, () => fauxAssistantMessage([fauxText('0')])));
    await withCode(project, remote);
    fakeModel(dataDir);
    await built(send, messages);
    remote('execute("Pair find")');
    await until(() => remote('luaeval("_G.telescoped ~= nil")') === 'true', 'the Telescope picker');
    const picker = JSON.parse(remote('json_encode(luaeval("{sorter = _G.telescoped.sorter, previewer = _G.telescoped.previewer}"))'));
    assert.deepEqual(picker, {sorter: true, previewer: true}, 'Pair\'s order, and the hit at its line in the preview');

    remote('luaeval("_G.type_prompt(\'tota\')")');
    await until(() => shown(remote).length > 0, 'the word hits');
    const words = shown(remote);
    assert.deepEqual(words, ['cart.js:1  export function total(cart) {'], 'tota starts total, before meaning is asked');
    remote('luaeval("(function() _G.selected = _G.telescoped.shown[1] end)()")');
    await until(() => shown(remote).length > 1, 'meaning\'s hits');
    const merged = shown(remote);
    assert.deepEqual(merged.slice(0, words.length), words, 'what showed stays where it was');
    assert.ok(merged.includes('invoice.js:2  export function bill(order) {'), 'the price, by its meaning: shown at its line under its doc comment');
    assert.equal(remote('luaeval("_G.selected.display")'), words[0], 'and stays selected');
    const entry = JSON.parse(remote('json_encode(luaeval("_G.telescoped.shown[1]"))'));
    assert.equal(entry.filename, join(project, 'cart.js'));
    assert.equal(entry.lnum, 1);
    assert.equal(entry.text, 'export function total(cart) {', 'quickfix gets its line');

    remote('luaeval("_G.type_prompt(\'try again when sending fails\')")');
    await until(() => shown(remote)[0] === 'deliver.js:1  export function deliver(job) {', 'a question in other words, by meaning alone');
    assert.match(remote('luaeval("_G.telescoped.title")'), /^Find \(\d+ ms\)$/);
  } finally {
    await stop();
  }
});

test('Telescope with "rerank" models: once the list settles the fused ranking\'s first pieces go first in the order of the one that answered, and the title says so', {skip: hasNvim ? false : 'nvim not installed', timeout: 40_000}, async () => {
  const server = await fakeRerankServer({favourite: 'What the order comes to'});
  const down = await fakeRerankServer({mode: 'down'}); // the first of the list, a GPU's that is not up
  const reranker = fakeRerankChain([{baseUrl: down.baseUrl, model: 'fake-d3'}, {baseUrl: server.baseUrl}]);
  const {project, dataDir, watcher, messages, remote, send, stop} = await pairInNvim('deliver', {rtp: [fakeTelescope()], setup: 'meaning_debounce_ms = 100, meaning_rerank_delay_ms = 100', meaningWith: {embedder: fakeEmbedder(), reranker}});
  try {
    watcher.setResponses(Array.from({length: 10}, () => fauxAssistantMessage([fauxText('0')])));
    await withCode(project, remote);
    fakeModel(dataDir);
    await built(send, messages);
    server.requests.length = 0;
    remote('execute("Pair find")');
    await until(() => remote('luaeval("_G.telescoped ~= nil")') === 'true', 'the Telescope picker');
    remote('luaeval("_G.type_prompt(\'tota\')")');
    await until(() => /reranked by fake-d1/.test(remote('luaeval("_G.telescoped.title")')), 'the rerank');
    assert.match(remote('luaeval("_G.telescoped.title")'), /^Find \(\d+ ms · reranked by fake-d1 \(\d\.\d s; fake-d3 not answering\)\)$/);
    const list = shown(remote);
    assert.equal(list[0], 'invoice.js:2  export function bill(order) {', 'the model\'s pick first');
    assert.ok(list.includes('cart.js:1  export function total(cart) {'), 'the word hit stays in the list');
    assert.equal(remote('luaeval("_G.selected.display")'), 'cart.js:1  export function total(cart) {', 'the piece you were on stays selected: nothing moves under you');
    assert.equal(server.requests.length, 1, 'one rerank, once the list settled');
    assert.equal(server.requests[0].state, 'Search: tota');
    await until(() => {
      send({type: 'today'});
      return JSON.stringify(messages.findLast(message => message.type === 'ledger') ?? {}).includes('\\"tota\\" in the picker with fake-d1 (after fake-d3 failed');
    }, 'the rerank in the ledger, with the model that failed first');
  } finally {
    await stop();
    await server.close();
    await down.close();
  }
});

/** The current quickfix list: its id, title, how many lists the stack has, and each entry as file:line. */
function quickfix(remote) {
  remote('execute("lua _G.qf = function() local l = vim.fn.getqflist({id = 0, title = 0, items = 0}); l.stack = vim.fn.getqflist({nr = [[$]]}).nr; l.files = vim.tbl_map(function(e) return vim.fn.fnamemodify(vim.fn.bufname(e.bufnr), [[:t]]) .. [[:]] .. e.lnum end, l.items); l.items = nil; return l end")');
  return JSON.parse(remote('json_encode(luaeval("_G.qf()"))'));
}

const BILL = 'invoice.js:2  export function bill(order) {';
const TOTAL = 'cart.js:1  export function total(cart) {';

/** Pair in Neovim with the fake Telescope and a slow fake reranker that favours the bill: the index built. */
async function slowRerank(delayMs) {
  const server = await fakeRerankServer({favourite: 'What the order comes to', mode: 'slow', delayMs});
  const pair = await pairInNvim('deliver', {rtp: [fakeTelescope()], setup: 'meaning_debounce_ms = 100', meaningWith: {embedder: fakeEmbedder(), reranker: fakeReranker(server.baseUrl)}});
  pair.watcher.setResponses(Array.from({length: 10}, () => fauxAssistantMessage([fauxText('0')])));
  await withCode(pair.project, pair.remote);
  fakeModel(pair.dataDir);
  await built(pair.send, pair.messages);
  server.requests.length = 0;
  pair.remote('execute("Pair find")');
  await until(() => pair.remote('luaeval("_G.telescoped ~= nil")') === 'true', 'the Telescope picker');
  const title = () => pair.remote('luaeval("_G.telescoped.title")');
  return {...pair, server, title, async stop() { await pair.stop(); await server.close(); }};
}

test('Telescope, the rerank in the background: typing goes on, a key drops a stale one, and its order comes in place with the piece you are on still selected', {skip: hasNvim ? false : 'nvim not installed', timeout: 40_000}, async () => {
  const {remote, send, messages, server, title, stop} = await slowRerank(1500);
  try {
    remote('luaeval("_G.type_prompt(\'tota\')")');
    await until(() => /reranking/.test(title()), 'the rerank to start once meaning came');
    await until(() => server.requests.length === 1, 'the model asked as soon as meaning came, with no delay');
    assert.equal(shown(remote)[0], TOTAL, 'meanwhile the list is as the words and meaning left it');
    remote('luaeval("_G.type_prompt(\'price\')")'); // a key while the model works: answered at once, not after it
    await until(() => shown(remote).some(each => each.startsWith('invoice.js')), 'the new words, while the model still works');
    remote('luaeval("_G.type_prompt(\'tota\')")');
    await until(() => /reranking/.test(title()), 'a new rerank for the new prompt');
    remote('luaeval("(function() _G.selected = _G.telescoped.shown[1] end)()")'); // you are on the word hit
    await until(() => /reranked by fake-d1/.test(title()), 'the rerank', 10_000);
    const list = shown(remote);
    assert.equal(list[0], BILL, 'the model\'s pick first, the list redrawn in place');
    assert.ok(list.includes(TOTAL));
    assert.equal(remote('luaeval("_G.selected.display")'), TOTAL, 'the piece you were on is still the one selected, wherever it moved');
    await until(() => {
      send({type: 'today'});
      return JSON.stringify(messages.findLast(message => message.type === 'ledger') ?? {}).includes('\\"tota\\" in the picker with fake-d1');
    }, 'the rerank in the ledger');
    const ledger = JSON.stringify(messages.findLast(message => message.type === 'ledger'));
    assert.ok(!ledger.includes('\\"price\\" in the picker'), 'the one a key dropped is not booked, nor used');
  } finally {
    await stop();
  }
});

test('Telescope <C-q>: the reranked order if it came; if it is still running, quickfix now and the same list reordered in place when it comes', {skip: hasNvim ? false : 'nvim not installed', timeout: 40_000}, async () => {
  const {remote, server, title, stop} = await slowRerank(1500);
  try {
    remote('luaeval("_G.type_prompt(\'tota\')")');
    await until(() => /reranking/.test(title()), 'the rerank to start');
    remote('luaeval("_G.telescoped.maps.i[\'<C-q>\']()")');
    assert.equal(remote('luaeval("_G.telescoped.closed")'), 'true', 'the picker closes');
    const now = quickfix(remote);
    assert.equal(now.title, 'Find: tota');
    assert.equal(now.files[0], 'cart.js:1', 'at once, in the order the picker showed');
    assert.equal(remote('&buftype'), 'quickfix', 'and it opens');
    await until(() => /reranked/.test(quickfix(remote).title), 'the rerank to reorder it', 10_000);
    const after = quickfix(remote);
    assert.equal(after.title, 'Find: tota (reranked by fake-d1)');
    assert.equal(after.id, now.id, 'the same list');
    assert.equal(after.stack, now.stack, 'no new list on the stack');
    assert.equal(after.files[0], 'invoice.js:2', 'in the model\'s order');
    assert.deepEqual([...after.files].sort(), [...now.files].sort(), 'the same entries, none added');
    assert.equal(server.requests.length, 1, 'the rerank the picker started, not a second one');

    // Sent once the rerank came: the reranked order straight away.
    remote('execute("cclose | Pair find")');
    remote('luaeval("_G.type_prompt(\'tota\')")');
    await until(() => /reranked by/.test(title()), 'the rerank', 10_000);
    remote('luaeval("_G.telescoped.maps.n[\'<C-q>\']()")');
    const sent = quickfix(remote);
    assert.equal(sent.title, 'Find: tota (reranked by fake-d1)');
    assert.equal(sent.files[0], 'invoice.js:2');
  } finally {
    await stop();
  }
});

test('Telescope <C-q> while the rerank runs: a quickfix list you changed or replaced meanwhile is left as it is', {skip: hasNvim ? false : 'nvim not installed', timeout: 40_000}, async () => {
  const {remote, server, title, stop} = await slowRerank(1500);
  // The model answered, and Neovim had the time to hear it.
  const answered = async () => {
    await until(() => server.requests.length > 0 && server.flight.now === 0, 'the model to answer', 10_000);
    await new Promise(resolve => setTimeout(resolve, 500));
    server.requests.length = 0;
  };
  try {
    remote('luaeval("_G.type_prompt(\'tota\')")');
    await until(() => /reranking/.test(title()), 'the rerank to start');
    remote('luaeval("_G.telescoped.maps.i[\'<C-q>\']()")');
    const sent = quickfix(remote);
    remote('execute("call setqflist([{\'filename\': \'a.js\', \'lnum\': 2, \'text\': \'mine\'}], \'a\')")'); // you add to it
    await answered();
    const changed = quickfix(remote);
    assert.equal(changed.id, sent.id);
    assert.equal(changed.title, 'Find: tota', 'not reranked: the list is yours now');
    assert.deepEqual(changed.files, [...sent.files, 'a.js:2']);

    remote('execute("cclose | Pair find")');
    remote('luaeval("_G.type_prompt(\'tota\')")');
    await until(() => /reranking/.test(title()), 'the next rerank to start');
    remote('luaeval("_G.telescoped.maps.i[\'<C-q>\']()")');
    const second = quickfix(remote);
    remote('execute("call setqflist([], \' \', {\'title\': \'other\', \'items\': [{\'filename\': \'a.js\', \'lnum\': 1, \'text\': \'other\'}]})")'); // a new list
    await answered();
    assert.equal(quickfix(remote).title, 'other', 'the list you made stays the current one');
    const old = JSON.parse(remote(`json_encode(getqflist({'id': ${second.id}, 'title': 0}))`));
    assert.equal(old.title, 'Find: tota', 'and the one Pair sent is not reordered behind your back');
  } finally {
    await stop();
  }
});

test('snacks.picker: the rerank\'s order drawn in place with the cursor already on your piece, and <C-q> reordering the quickfix list in place', {skip: hasNvim ? false : 'nvim not installed', timeout: 40_000}, async () => {
  const server = await fakeRerankServer({favourite: 'What the order comes to', mode: 'slow', delayMs: 1500});
  const {project, dataDir, watcher, messages, remote, send, stop} = await pairInNvim('deliver', {rtp: [fakeSnacks()], setup: "meaning_picker = 'snacks', meaning_debounce_ms = 100", meaningWith: {embedder: fakeEmbedder(), reranker: fakeReranker(server.baseUrl)}});
  const snacked = what => JSON.parse(remote(`json_encode(luaeval("_G.snacked.${what}"))`));
  try {
    watcher.setResponses(Array.from({length: 10}, () => fauxAssistantMessage([fauxText('0')])));
    await withCode(project, remote);
    fakeModel(dataDir);
    await built(send, messages);
    remote('execute("Pair find")');
    await until(() => remote('luaeval("_G.snacked ~= nil")') === 'true', 'the snacks picker');
    remote('luaeval("_G.type_search(\'tota\')")');
    await until(() => /reranking/.test(snacked('title')), 'the rerank to start');
    const before = snacked('shown');
    const at = before.findIndex(text => text.startsWith('cart.js')) + 1;
    remote(`luaeval("_G.snacked.go(${at})")`); // you are on the word hit
    await until(() => /reranked by fake-d1/.test(snacked('title')), 'the rerank', 10_000);
    assert.equal(snacked('shown')[0], BILL, 'the model\'s pick first');
    assert.equal(snacked('drawn'), TOTAL, 'drawn with the cursor on your piece: it never shows on another');
    assert.equal(snacked('on'), TOTAL);

    // <C-q> while the next rerank runs: the items you selected, in the order shown, then reordered in place.
    remote('luaeval("_G.type_search(\'price\')")');
    remote('luaeval("_G.type_search(\'tota\')")');
    await until(() => /reranking/.test(snacked('title')), 'the next rerank');
    remote('luaeval("(function() _G.snacked.selected = {} end)()")');
    remote('luaeval("_G.snacked.act(\'qflist\')")');
    assert.equal(snacked('closed'), true);
    const sent = quickfix(remote);
    assert.equal(sent.title, 'Find: tota');
    assert.equal(sent.files[0], 'cart.js:1', 'all of the list, as it showed');
    await until(() => /reranked/.test(quickfix(remote).title), 'the rerank to reorder it', 10_000);
    const after = quickfix(remote);
    assert.equal(after.id, sent.id);
    assert.equal(after.stack, sent.stack);
    assert.equal(after.files[0], 'invoice.js:2');
  } finally {
    await stop();
    await server.close();
  }
});

const fzf = hasNvim ? fzfLua() : {skip: 'nvim not installed'};
test('fzf-lua ctrl-q: the list goes to quickfix at once, and the rerank\'s order replaces it in place when it comes', {skip: fzf.skip ?? false, timeout: 60_000}, async () => {
  const server = await fakeRerankServer({favourite: 'What the order comes to', mode: 'slow', delayMs: 1000});
  const {project, dataDir, watcher, messages, remote, keys, send, stop} = await pairInNvim('deliver', {rtp: [fzf.dir], setup: "meaning_picker = 'fzf-lua', meaning_debounce_ms = 100", meaningWith: {embedder: fakeEmbedder(), reranker: fakeReranker(server.baseUrl)}});
  const screen = () => JSON.parse(remote('json_encode(getline(1, "$"))'));
  try {
    watcher.setResponses(Array.from({length: 10}, () => fauxAssistantMessage([fauxText('0')])));
    await withCode(project, remote);
    fakeModel(dataDir);
    await built(send, messages);
    remote(`luaeval("require('fzf-lua').setup({}) and 0 or 0")`);
    server.requests.length = 0;
    remote('execute("Pair find")');
    await until(() => remote('&filetype') === 'fzf' && screen().some(line => /\d+\/\d+/.test(line)), 'fzf');
    keys('tota');
    await until(Object.assign(() => screen().some(line => /\b[2-9]\/\d+/.test(line)) && screen().some(line => line.includes('invoice.js')), {last: () => screen().join('\n')}), 'the words and meaning');
    assert.equal(server.requests.length, 0, 'the list only grows in fzf-lua: not reranked while it is open');
    keys('<C-q>'); // all of the list, as in Telescope
    await until(() => remote('&buftype') === 'quickfix', 'the quickfix list');
    const sent = quickfix(remote);
    assert.equal(sent.title, 'Find: tota');
    assert.equal(sent.files.length, 4, 'all of the list');
    assert.equal(sent.files[0], 'cart.js:1', 'in the order fzf showed it');
    await until(() => /reranked/.test(quickfix(remote).title), 'the rerank to reorder it', 10_000);
    const after = quickfix(remote);
    assert.equal(after.title, 'Find: tota (reranked by fake-d1)');
    assert.equal(after.id, sent.id, 'the same list');
    assert.equal(after.stack, sent.stack);
    assert.equal(after.files[0], 'invoice.js:2');
    assert.deepEqual([...after.files].sort(), [...sent.files].sort(), 'the lines it had, no others');
  } finally {
    await stop();
    await server.close();
  }
});

test('without a model the words still work, and the picker says how to add meaning', {skip: hasNvim ? false : 'nvim not installed', timeout: 40_000}, async () => {
  const fetched = [];
  const {project, watcher, remote, keys, stop} = await pairInNvim('deliver', {
    rtp: [fakeTelescope()],
    meaningWith: {embedder: fakeEmbedder(), fetch: async url => { fetched.push(url); return new Response('x'); }},
  });
  try {
    watcher.setResponses(Array.from({length: 10}, () => fauxAssistantMessage([fauxText('0')])));
    await withCode(project, remote);
    keys('<M-s>');
    await until(() => remote('luaeval("_G.telescoped ~= nil")') === 'true', 'the Telescope picker');
    await until(() => {
      remote('luaeval("_G.type_prompt(\'quantity\')")');
      return shown(remote).length > 0 && /words only/.test(remote('luaeval("_G.telescoped.title")'));
    }, 'the word hits');
    assert.deepEqual(shown(remote), ['cart.js:1  export function total(cart) {']);
    assert.equal(remote('luaeval("_G.telescoped.title")'), 'Find (words only: :Pair find on adds meaning)');
    assert.deepEqual(fetched, [], 'nothing is downloaded without :Pair find on');
  } finally {
    await stop();
  }
});

test('vim.ui.select gets the fused ranking; choosing a piece opens it at its line, and the ledger hears of it', {skip: hasNvim ? false : 'nvim not installed', timeout: 40_000}, async () => {
  const {project, dataDir, watcher, messages, remote, send, stop} = await pairInNvim('deliver', {setup: "meaning_picker = 'select'", meaningWith: {embedder: fakeEmbedder()}});
  try {
    watcher.setResponses(Array.from({length: 10}, () => fauxAssistantMessage([fauxText('0')])));
    await withCode(project, remote);
    fakeModel(dataDir);
    await built(send, messages);
    remote(`luaeval("(function() vim.ui.select = function(items, opts, choose) _G.picked = {prompt = opts.prompt, shown = vim.tbl_map(opts.format_item, items)}; choose(items[1]) end end)() or 0")`);
    remote('execute("Pair find try again when sending fails")');
    await until(() => remote('expand("%:t")') === 'deliver.js', 'the chosen piece to open');
    assert.equal(remote('line(".")'), '1');
    const picked = JSON.parse(remote('json_encode(luaeval("_G.picked"))'));
    assert.equal(picked.prompt, 'Find: try again when sending fails');
    assert.equal(picked.shown[0], 'deliver.js:1  export function deliver(job) {');
    await until(() => {
      send({type: 'today'});
      return JSON.stringify(messages.findLast(message => message.type === 'ledger') ?? {}).includes('in the picker');
    }, 'the choice in the ledger');
  } finally {
    await stop();
  }
});

test('/find in the chat: the fused ranking, with how it ranked', {skip: hasNvim ? false : 'nvim not installed', timeout: 40_000}, async () => {
  const {project, dataDir, watcher, messages, remote, send, stop} = await pairInNvim('deliver', {meaningWith: {embedder: fakeEmbedder()}});
  try {
    watcher.setResponses(Array.from({length: 10}, () => fauxAssistantMessage([fauxText('0')])));
    await withCode(project, remote);
    fakeModel(dataDir);
    await built(send, messages);
    send({type: 'find', query: 'try again when sending fails'});
    await until(() => messages.some(message => message.type === 'found' && message.query === 'try again when sending fails'), 'the answer');
    const found = messages.find(message => message.type === 'found' && message.query === 'try again when sending fails');
    assert.equal(found.id, undefined);
    assert.equal(found.state, 'on');
    assert.equal(found.results[0].file, 'deliver.js');
    assert.equal(found.results[0].path, join(project, 'deliver.js'));
  } finally {
    await stop();
  }
});

test(':Pair find on installs LiteRT-LM itself, says what comes and how big up front, tells how far, books it; off deletes Pair\'s venv', {skip: hasNvim ? false : 'nvim not installed', timeout: 40_000}, async () => {
  // The daemon's runtime, made once its data folder is known: with no Python first, then with a fake one.
  let real = null;
  const runtime = {bytes: WHEELS['linux x64'].bytes, check: () => real.check(), install: options => real.install(options), remove: () => real.remove()};
  const {dataDir, messages, send, stop} = await pairInNvim('deliver', {meaningWith: {embedder: fakeEmbedder(), runtime}});
  const said = () => messages.filter(message => message.type === 'meaning_state').map(message => message.text);
  const served = fakeWheel({bytes: 9 << 20});
  const runtimeWith = python => new Runtime({dataDir, python: () => pythonOf({}, dataDir), candidates: [python], ...served});
  try {
    fakeModel(dataDir); // the model is here: only LiteRT-LM is missing, as for someone who turned it on before
    real = runtimeWith(join(scratch('no-python-'), 'python3'));
    send({type: 'meaning_on'});
    await until(() => said().some(text => /stays off/.test(text)), 'the failure');
    assert.match(said()[0], /^Search by meaning: installing LiteRT-LM 0\.19\.0 \(33 MB from PyPI, SHA-256 pinned\) in a venv in Pair's data folder, once…$/, 'said once, up front, with its size');
    assert.match(said().at(-1), /^Search by meaning stays off: LiteRT-LM needs Python 3\.10 or later, and there is no python3 on PATH: install one, or set "meaning": \{"python": …\} to a Python with litert-lm-api==0\.19\.0, or an "embedding" model\. The word search works as before\.$/);
    assert.ok(!existsSync(join(dataDir, 'meaning', 'venv')));

    messages.length = 0;
    real = runtimeWith(fakePython({version: '3.12'}));
    send({type: 'meaning_on'});
    await until(() => said().some(text => /is on/.test(text)), 'search by meaning on');
    assert.deepEqual(said(), [
      'Search by meaning: installing LiteRT-LM 0.19.0 (33 MB from PyPI, SHA-256 pinned) in a venv in Pair\'s data folder, once…',
      'Downloading LiteRT-LM 0.19.0: 8 of 9 MiB…',
      'Search by meaning is on: Pair indexes this project in the background.',
    ]);
    await until(() => {
      send({type: 'today'});
      return JSON.stringify(messages.findLast(message => message.type === 'ledger') ?? {}).includes('LiteRT-LM 0.19.0 for search by meaning');
    }, 'the install in the ledger');
    const ledger = JSON.stringify(messages.findLast(message => message.type === 'ledger'));
    assert.match(ledger, /"installed","text":"LiteRT-LM 0\.19\.0 for search by meaning, in a venv Pair made with Python 3\.12","more":true/, 'what came, and ⏎ shows where');

    messages.length = 0;
    send({type: 'meaning_off'});
    await until(() => said().length, 'off');
    assert.equal(said()[0], 'Search by meaning is off: its model and indexes, and the venv with LiteRT-LM that Pair made are deleted.');
    assert.ok(!existsSync(join(dataDir, 'meaning', 'venv')), 'the venv Pair made is gone');
  } finally {
    await stop();
  }
});
