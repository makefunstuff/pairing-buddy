// Search by meaning in Neovim: Alt-s and :Pair find open semantic-grep.nvim's live picker (its own tests cover the
// pickers: Telescope, snacks, fzf-lua, vim.ui.select, <C-q>, the rerank in place) with Pair's daemon as its source
// (lua/pair/meaning.lua). Here: the words on every key and meaning below them from the daemon's index, the daemon's
// reranker, the ledger hearing what was chosen, :SemanticGrep, its files view (:Pair files) and :checkhealth
// semantic-grep asking the daemon too, the words without a model, a clear message without semantic-grep.nvim, /find in
// the chat and :Pair find on. In Telescope a stand-in drives the picker's finder as the real one does. The daemon's
// fake embedder stands in for EmbeddingGemma 2.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {fauxAssistantMessage, fauxText} from '@earendil-works/pi-ai';
import {pythonOf} from '../src/embedder.mjs';
import {Runtime, WHEELS} from '../src/runtime.mjs';
import {fakeEmbedder, fakeModel} from './fake-embedder.mjs';
import {fakeRerankChain, fakeRerankServer} from './fake-reranker.mjs';
import {fakePython, fakeWheel} from './fake-python.mjs';
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
  module('config', 'return {values = {grep_previewer = function() return {} end, buffer_previewer_maker = function() end}}');
  module('previewers', 'return {new_buffer_previewer = function(spec) return spec end}');
  module('actions/state', 'return {get_selected_entry = function() return _G.selected end}');
  module('actions', `local post
    local close = setmetatable({enhance = function(_, how) post = how.post end}, {__call = function()
      _G.telescoped.closed = true
      if post then post() end
    end})
    return {select_default = {enhance = function() end}, close = close}`);
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

const quiet = watcher => watcher.setResponses(Array.from({length: 10}, () => fauxAssistantMessage([fauxText('0')])));
const ledgerHas = (send, messages, text) => until(() => {
  send({type: 'today'});
  return JSON.stringify(messages.findLast(message => message.type === 'ledger') ?? {}).includes(text);
}, `"${text}" in the ledger`);

test('Alt-s opens semantic-grep\'s picker over Pair\'s daemon: the words on every key, meaning below them, the choice in the ledger; :SemanticGrep asks it too', {skip: hasNvim ? false : 'nvim not installed', timeout: 40_000}, async () => {
  const {project, dataDir, watcher, messages, remote, keys, send, stop} = await pairInNvim('deliver', {rtp: [fakeTelescope()], setup: 'meaning_debounce_ms = 400', meaningWith: {embedder: fakeEmbedder()}});
  try {
    quiet(watcher);
    await withCode(project, remote);
    fakeModel(dataDir);
    await built(send, messages);
    assert.match(remote('luaeval("require(\'semantic-grep\').source().name")'), /^Pair's daemon/, 'registered once Pair connected');
    assert.equal(remote('luaeval("require(\'semantic-grep\').config.debounce_ms")'), '400', 'Pair\'s meaning_debounce_ms goes to the picker');
    keys('<M-s>');
    await until(() => remote('luaeval("_G.telescoped ~= nil")') === 'true', 'the Telescope picker');
    remote('luaeval("_G.type_prompt(\'tota\')")');
    await until(() => shown(remote).length > 0, 'the word hits');
    const words = shown(remote);
    assert.deepEqual(words, ['cart.js:1  export function total(cart) {'], 'tota starts total, before meaning is asked');
    remote('luaeval("(function() _G.selected = _G.telescoped.shown[1] end)()")');
    await until(() => shown(remote).length > 1, 'meaning\'s hits');
    const merged = shown(remote);
    assert.deepEqual(merged.slice(0, words.length), words, 'what showed stays where it was');
    assert.ok(merged.includes('invoice.js:2  export function bill(order) {'), 'the price, by its meaning');
    const entry = JSON.parse(remote('json_encode(luaeval("_G.telescoped.shown[1]"))'));
    assert.equal(entry.filename, join(project, 'cart.js'), 'the daemon gives each piece its path');
    assert.equal(entry.lnum, 1);

    // Enter in the picker tells the source what was chosen (the stand-in's select_default does not run it).
    remote('luaeval("require(\'semantic-grep\').source().request(\'chosen\', {query = \'tota\', results = {_G.selected.value}}, function() end) or 0")');
    await ledgerHas(send, messages, 'in the picker');

    remote('luaeval("(function() _G.telescoped = nil end)()")');
    remote('execute("SemanticGrep try again when sending fails")');
    await until(() => remote('luaeval("_G.telescoped ~= nil")') === 'true', ':SemanticGrep\'s picker');
    await until(() => shown(remote)[0] === 'deliver.js:1  export function deliver(job) {', 'a question in other words, by meaning, from the daemon');
  } finally {
    await stop();
  }
});

test(':Pair files opens semantic-grep\'s files view over Pair\'s daemon: the files a sentence is about, best first, each at its best line', {skip: hasNvim ? false : 'nvim not installed', timeout: 40_000}, async () => {
  const {project, dataDir, watcher, messages, remote, send, stop} = await pairInNvim('deliver', {rtp: [fakeTelescope()], meaningWith: {embedder: fakeEmbedder()}});
  try {
    quiet(watcher);
    await withCode(project, remote);
    fakeModel(dataDir);
    await built(send, messages);
    remote('execute("Pair files try again when sending fails")');
    await until(() => remote('luaeval("_G.telescoped ~= nil")') === 'true', 'the files view');
    await until(() => shown(remote).length > 0, 'the files');
    assert.match(shown(remote)[0], /^deliver\.js/, 'the file the sentence is about, by meaning, from the daemon');
    const entry = JSON.parse(remote('json_encode(luaeval("_G.telescoped.shown[1]"))'));
    assert.equal(entry.filename, join(project, 'deliver.js'));
  } finally {
    await stop();
  }
});

test('with "rerank" models in Pair\'s config, the picker\'s first pieces go in the order of the one that answered, and the ledger books it', {skip: hasNvim ? false : 'nvim not installed', timeout: 40_000}, async () => {
  const server = await fakeRerankServer({favourite: 'What the order comes to'});
  const down = await fakeRerankServer({mode: 'down'}); // the first of the list, a GPU's that is not up
  const reranker = fakeRerankChain([{baseUrl: down.baseUrl, model: 'fake-d3'}, {baseUrl: server.baseUrl}]);
  const {project, dataDir, watcher, messages, remote, send, stop} = await pairInNvim('deliver', {rtp: [fakeTelescope()], setup: 'meaning_debounce_ms = 100, meaning_rerank_delay_ms = 100', meaningWith: {embedder: fakeEmbedder(), reranker}});
  try {
    quiet(watcher);
    await withCode(project, remote);
    fakeModel(dataDir);
    await built(send, messages);
    server.requests.length = 0;
    remote('execute("Pair find")');
    await until(() => remote('luaeval("_G.telescoped ~= nil")') === 'true', 'the Telescope picker');
    remote('luaeval("_G.type_prompt(\'tota\')")');
    await until(() => /reranked by fake-d1/.test(remote('luaeval("_G.telescoped.title")')), 'the rerank');
    assert.match(remote('luaeval("_G.telescoped.title")'), /^SemanticGrep \(\d+ ms · reranked by fake-d1 \(\d\.\d s; fake-d3 not answering\)\)$/);
    assert.equal(shown(remote)[0], 'invoice.js:2  export function bill(order) {', 'the model\'s pick first');
    assert.equal(server.requests.length, 1, 'one rerank, once the list settled');
    assert.equal(server.requests[0].state, 'Search: tota');
    await ledgerHas(send, messages, '\\"tota\\" in the picker with fake-d1 (after fake-d3 failed');
  } finally {
    await stop();
    await server.close();
    await down.close();
  }
});

test(':checkhealth semantic-grep names Pair\'s daemon as the source and asks it for its models and this project\'s index', {skip: hasNvim ? false : 'nvim not installed', timeout: 60_000}, async () => {
  const {project, dataDir, watcher, messages, remote, send, stop} = await pairInNvim('deliver', {meaningWith: {embedder: fakeEmbedder()}});
  try {
    quiet(watcher);
    await withCode(project, remote);
    fakeModel(dataDir);
    await built(send, messages);
    // From the event loop, as when typed: inside a --remote-expr Neovim delivers no socket data to vim.wait.
    remote('execute("lua vim.defer_fn(function() vim.cmd(\'checkhealth semantic-grep\'); _G.healthy = true end, 10)")');
    await until(() => remote('luaeval("_G.healthy == true")') === 'true', 'the health check', 30_000);
    const text = JSON.parse(remote('json_encode(getline(1, "$"))')).join('\n');
    assert.match(text, /source: Pair's daemon/);
    assert.match(text, /it answers: search by meaning is on/);
    assert.match(text, /embedding: EmbeddingGemma 2 \(text, 270M\) answers in \d+ ms, 256 numbers a piece/, 'the daemon\'s embedder, asked once');
    assert.match(text, /rerank: off/);
    assert.match(text, /notes: off/);
    assert.match(text, new RegExp(`${project}: 4 files, 4 pieces, 4 with vectors \\(100%\\)`));
    assert.doesNotMatch(text, /Node v\d+/, 'no server of its own to check');
  } finally {
    await stop();
  }
});

test('without a model the words still work, and nothing is downloaded until :Pair find on', {skip: hasNvim ? false : 'nvim not installed', timeout: 40_000}, async () => {
  const fetched = [];
  const {project, watcher, remote, keys, stop} = await pairInNvim('deliver', {
    rtp: [fakeTelescope()],
    meaningWith: {embedder: fakeEmbedder(), fetch: async url => { fetched.push(url); return new Response('x'); }},
  });
  try {
    quiet(watcher);
    await withCode(project, remote);
    keys('<M-s>');
    await until(() => remote('luaeval("_G.telescoped ~= nil")') === 'true', 'the Telescope picker');
    await until(() => {
      remote('luaeval("_G.type_prompt(\'quantity\')")');
      return shown(remote).length > 0 && /words only/.test(remote('luaeval("_G.telescoped.title")'));
    }, 'the word hits');
    assert.deepEqual(shown(remote), ['cart.js:1  export function total(cart) {']);
    assert.deepEqual(fetched, [], 'nothing is downloaded without :Pair find on');
  } finally {
    await stop();
  }
});

test('vim.ui.select gets the daemon\'s fused ranking; choosing a piece opens it at its line, and the ledger hears of it', {skip: hasNvim ? false : 'nvim not installed', timeout: 40_000}, async () => {
  const {project, dataDir, watcher, messages, remote, send, stop} = await pairInNvim('deliver', {setup: "meaning_picker = 'select'", meaningWith: {embedder: fakeEmbedder()}});
  try {
    quiet(watcher);
    await withCode(project, remote);
    fakeModel(dataDir);
    await built(send, messages);
    remote(`luaeval("(function() vim.ui.select = function(items, opts, choose) _G.picked = {prompt = opts.prompt, shown = vim.tbl_map(opts.format_item, items)}; choose(items[1]) end end)() or 0")`);
    remote('execute("Pair find try again when sending fails")');
    await until(() => remote('expand("%:t")') === 'deliver.js', 'the chosen piece to open');
    assert.equal(remote('line(".")'), '1');
    const picked = JSON.parse(remote('json_encode(luaeval("_G.picked"))'));
    assert.equal(picked.prompt, 'SemanticGrep: try again when sending fails');
    assert.equal(picked.shown[0], 'deliver.js:1  export function deliver(job) {');
    await ledgerHas(send, messages, 'in the picker');
  } finally {
    await stop();
  }
});

test('without semantic-grep.nvim, Alt-s and :Pair find say what to install; Pair works on', {skip: hasNvim ? false : 'nvim not installed', timeout: 40_000}, async () => {
  const {remote, keys, stop} = await pairInNvim('deliver', {semanticGrep: false});
  try {
    remote('execute("lua _G.said = {}; vim.notify = function(text) table.insert(_G.said, text) end")');
    keys('<M-s>');
    await until(() => remote('luaeval("#_G.said")') !== '0', 'the message');
    remote('execute("Pair find retry")');
    await until(() => remote('luaeval("#_G.said")') === '2', 'the message again');
    const said = JSON.parse(remote('json_encode(luaeval("_G.said"))'));
    for (const text of said) assert.equal(text, 'Pair: search by meaning needs semantic-grep.nvim (makefunstuff/semantic-grep.nvim): install it next to Pair (docs/install.md)');
    assert.equal(remote('exists(":SemanticGrep")'), '0');
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
