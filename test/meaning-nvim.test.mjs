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
import {fakePython, fakeWheel} from './fake-python.mjs';
import {hasNvim, pairInNvim, until} from './nvim-harness.mjs';
import {scratch} from './temp.mjs';

const DELIVER = 'export function deliver(job) {\n  let tries = 0\n  while (tries < 5) {\n    tries += 1\n    if (send(job)) return true\n    sleep(backoff(tries))\n  }\n}\n';
const CART = 'export function total(cart) {\n  return cart.items.reduce((sum, item) => sum + item.cents * item.quantity, 0)\n}\n';
const INVOICE = '// What the order comes to.\nexport function bill(order) {\n  return order.price\n}\n';

/**
 * A Telescope that runs a picker's finder as the real one does: `_G.type_prompt(text)` types a prompt, and
 * `refresh` runs the finder again for it; `_G.telescoped` keeps the spec's title, sorter and previewer, the
 * entries shown, and how many times they were made.
 */
function fakeTelescope() {
  const dir = scratch('meaning-telescope-');
  mkdirSync(join(dir, 'lua', 'telescope', 'actions'), {recursive: true});
  const module = (name, body) => writeFileSync(join(dir, 'lua', 'telescope', `${name}.lua`), body);
  module('pickers', `return {new = function(_, spec)
    local picker = {prompt = spec.default_text or '', callbacks = {}, prompt_border = {change_title = function(_, title) _G.telescoped.title = title end}}
    _G.telescoped = {title = spec.prompt_title, sorter = spec.sorter and spec.sorter.highlighter_only, previewer = spec.previewer ~= nil, shown = {}, runs = 0}
    function picker:run()
      local shown = {}
      spec.finder(self.prompt, function(entry) shown[#shown + 1] = entry end, function()
        _G.telescoped.shown = shown
        _G.telescoped.runs = _G.telescoped.runs + 1
        for _, callback in ipairs(self.callbacks) do callback(self) end
      end)
    end
    function picker:find() spec.attach_mappings(1); self:run() end
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
  module('actions', `local enhance = function() return {enhance = function() end} end
    return {select_default = {enhance = function() end}, close = {enhance = function() end}}`);
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
