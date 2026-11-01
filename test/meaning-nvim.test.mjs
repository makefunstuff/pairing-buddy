// Search by meaning in Neovim: off, Alt-s offers the one download and nothing comes without a yes; on, :Pair find
// shows the ranked chunks in Telescope (a stand-in here, with the entries the real one gets) or in vim.ui.select,
// and choosing one opens it at its line. The daemon's fake embedder stands in for EmbeddingGemma 2.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {fauxAssistantMessage, fauxText} from '@earendil-works/pi-ai';
import {fakeEmbedder, fakeModel} from './fake-embedder.mjs';
import {hasNvim, pairInNvim, until} from './nvim-harness.mjs';
import {scratch} from './temp.mjs';

const DELIVER = 'export function deliver(job) {\n  let tries = 0\n  while (tries < 5) {\n    tries += 1\n    if (send(job)) return true\n    sleep(backoff(tries))\n  }\n}\n';

/** A Telescope that only records what a picker gets: its title and its entries, as the real one would make them. */
function fakeTelescope() {
  const dir = scratch('meaning-telescope-');
  mkdirSync(join(dir, 'lua', 'telescope'), {recursive: true});
  const module = (name, body) => writeFileSync(join(dir, 'lua', 'telescope', `${name}.lua`), body);
  module('pickers', `return {new = function(_, spec)
    local entries = vim.tbl_map(spec.finder.entry_maker, spec.finder.results)
    _G.telescoped = {title = spec.prompt_title, entries = entries, sorter = spec.sorter ~= nil, previewer = spec.previewer ~= nil}
    return {find = function() end}
  end}`);
  module('finders', 'return {new_table = function(spec) return spec end}');
  module('config', 'return {values = {generic_sorter = function() return {} end, grep_previewer = function() return {} end}}');
  return dir;
}

/** Asks the daemon for its status until the project's index is built: `send` and `messages` are the chat client's. */
async function built(send, messages) {
  send({type: 'meaning', query: 'deliver'}); // the first search opens the index, which builds in the background
  await until(() => {
    send({type: 'status'});
    const index = messages.findLast(message => message.type === 'status')?.meaning.indexes[0];
    return index && index.chunks > 0 && index.embedded === index.chunks;
  }, 'the index to be built');
}

/** The project as a git repo with a retry loop in it, so search by meaning has something to find. */
function withCode(project) {
  writeFileSync(join(project, 'deliver.js'), DELIVER);
  execFileSync('git', ['init', '-q'], {cwd: project});
}

test('off, Alt-s offers the model\'s one download and a no leaves it off; on, :Pair find opens the chosen chunk at its line', {skip: hasNvim ? false : 'nvim not installed', timeout: 40_000}, async () => {
  const fetched = [];
  const {project, dataDir, watcher, messages, remote, keys, send, stop} = await pairInNvim('deliver', {
    setup: "meaning_picker = 'select'",
    meaningWith: {embedder: fakeEmbedder(), fetch: async url => { fetched.push(url); return new Response('x'); }},
  });
  try {
    watcher.setResponses(Array.from({length: 10}, () => fauxAssistantMessage([fauxText('0')])));
    withCode(project);
    remote(`luaeval("(function() vim.ui.input = function(_, done) done('try again when sending fails') end; vim.fn.confirm = function(text) _G.offered = text; return 2 end end)() or 0")`);
    keys('<M-s>');
    await until(() => remote('luaeval("_G.offered or \'\'")').includes('EmbeddingGemma 2'), 'the offer of the download');
    assert.match(remote('luaeval("_G.offered")'), /165 MB from Hugging Face, once, checked by its SHA-256/);
    assert.deepEqual(fetched, [], 'nothing is downloaded without a yes');

    fakeModel(dataDir); // as if the download had been taken: the rest is the daemon's (see meaning.test.mjs)
    await built(send, messages);
    remote(`luaeval("(function() vim.ui.select = function(items, opts, choose) _G.picked = {prompt = opts.prompt, shown = vim.tbl_map(opts.format_item, items)}; choose(items[1]) end end)() or 0")`);
    remote('execute("Pair find try again when sending fails")');
    await until(() => remote('expand("%:t")') === 'deliver.js', 'the chosen chunk to open');
    assert.equal(remote('line(".")'), '1');
    const picked = JSON.parse(remote('json_encode(luaeval("_G.picked"))'));
    assert.match(picked.prompt, /^By meaning: try again when sending fails/);
    assert.equal(picked.shown[0], 'deliver.js:1  export function deliver(job) {');
  } finally {
    await stop();
  }
});

test('Telescope first: its picker gets each chunk with its file and line, best first, a sorter and a previewer', {skip: hasNvim ? false : 'nvim not installed', timeout: 40_000}, async () => {
  const {project, dataDir, watcher, messages, remote, send, stop} = await pairInNvim('deliver', {rtp: [fakeTelescope()], meaningWith: {embedder: fakeEmbedder()}});
  try {
    watcher.setResponses(Array.from({length: 10}, () => fauxAssistantMessage([fauxText('0')])));
    withCode(project);
    fakeModel(dataDir);
    await built(send, messages);
    remote('execute("Pair find retry")'); // no word of the code, but its meaning
    await until(() => remote('luaeval("_G.telescoped ~= nil")') === 'true', 'the Telescope picker');
    const picker = JSON.parse(remote('json_encode(luaeval("_G.telescoped"))'));
    assert.match(picker.title, /^By meaning: retry/);
    assert.ok(picker.sorter && picker.previewer);
    const [first] = picker.entries;
    assert.equal(first.filename, join(project, 'deliver.js'));
    assert.equal(first.lnum, 1);
    assert.equal(first.display, 'deliver.js:1  export function deliver(job) {');
  } finally {
    await stop();
  }
});
