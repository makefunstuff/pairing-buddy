// Search by meaning: the pieces (tree-sitter's functions with their doc comments, else blocks at blank lines), the
// words, the fusion, which files go in (what .gitignore leaves out does not), the SQLite index in Pair's data folder or
// the project, shared by worktrees, a save embedding only what changed, the word search without a model, the hybrid
// search, the ledger, the one model download and its checksum, the embedder's helper, an embedding model at a
// /v1/embeddings, the trail's "by meaning" lines, the config and `pair doctor`. A fake embedder stands in for
// EmbeddingGemma 2, and a fake server for the /v1/embeddings (see fake-embedder.mjs).
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {test} from 'node:test';
import {parseConfig} from '../src/config.mjs';
import {meaningCheck} from '../src/doctor.mjs';
import {downloadModel, Embedder, HttpEmbedder, MODEL, modelPath, modelReady} from '../src/embedder.mjs';
import {indexPlace} from '../src/index-store.mjs';
import {fuse, indexable, Meaning, ProjectIndex, projectFiles, searchTerms, words} from '../src/meaning.mjs';
import {blocks, cut, PIECE, piecesOf, TreeSitter} from '../src/pieces.mjs';
import {trailMatches} from '../src/trail.mjs';
import {fakeEmbedder, fakeEmbeddingServer, fakeModel, fakeVector} from './fake-embedder.mjs';
import {scratch} from './temp.mjs';

const hasRg = (() => { try { execFileSync('rg', ['--version']); return true; } catch { return false; } })();
const hasNvim = (() => { try { execFileSync('nvim', ['--version']); return true; } catch { return false; } })();
const until = async (check, what, timeoutMs = 5000) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const RETRY = `export function deliver(job) {
  let tries = 0;
  while (tries < 5) {
    tries += 1;
    if (send(job)) return true;
    sleep(backoff(tries));
  }
  return false;
}
`;
const PRICES = `export function total(cart) {
  return cart.items.reduce((sum, item) => sum + item.cents * item.quantity, 0);
}
`;

/** A git repo with a retry loop, a price total, an ignored file and an untracked one. */
function project() {
  const root = realpathSync(scratch('meaning-project-'));
  const git = (...args) => execFileSync('git', args, {cwd: root, stdio: 'ignore'});
  git('init', '-q');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'deliver.js'), RETRY);
  writeFileSync(join(root, 'src', 'cart.js'), PRICES);
  writeFileSync(join(root, '.gitignore'), 'secret.txt\nbuild/\n');
  writeFileSync(join(root, 'secret.txt'), 'retry the payment again with the saved card\n');
  mkdirSync(join(root, 'build'));
  writeFileSync(join(root, 'build', 'out.js'), RETRY);
  writeFileSync(join(root, 'logo.png'), 'not text');
  writeFileSync(join(root, 'package-lock.json'), '{}\n');
  git('add', 'src', '.gitignore');
  writeFileSync(join(root, 'NOTES.md'), '# Notes\n\nThe cart shows prices in cents.\n'); // untracked, not ignored
  return root;
}

test('a file is cut at a piece\'s size, at a blank line where it can; blocks between blank lines go together', () => {
  const lines = Array.from({length: 130}, (_, i) => (i % 20 === 19 ? '' : `line ${i + 1}`));
  const chunks = cut(lines);
  assert.ok(chunks.every(chunk => chunk.to - chunk.from + 1 <= PIECE.lines));
  assert.deepEqual(chunks[0], {from: 1, to: 60}, 'the blank line 60 ends the first');
  assert.ok(chunks.slice(1).every((chunk, i) => chunk.from === chunks[i].to + 1), 'no line left out or counted twice');
  assert.deepEqual(cut([`${'x'.repeat(PIECE.chars * 2)}`, 'short']), [{from: 1, to: 1}, {from: 2, to: 2}], 'a line longer than a piece is one of its own');
  const prose = ['# Title', '', 'one', 'two', '', '}', '', 'three'];
  assert.deepEqual(blocks(prose), [{from: 1, to: 8}], 'small blocks go together, up to a piece');
  assert.deepEqual(blocks(['}', '', ')']), [], 'nothing but punctuation is no piece');
});

test('pieces: tree-sitter\'s definitions where it found them, blocks between them, and a long one cut', () => {
  const text = ['import x from "y";', '', '// Adds.', 'function add(a, b) {', '  return a + b;', '}', '', 'const z = 1;', ''].join('\n');
  const found = [{from: 3, to: 6, kind: 'function_declaration', name: 'add'}];
  assert.deepEqual(piecesOf(text, found).map(piece => [piece.from, piece.to, piece.kind, piece.name]), [
    [1, 1, 'block', null], [3, 6, 'function_declaration', 'add'], [8, 8, 'block', null],
  ]);
  assert.deepEqual(piecesOf(text).map(piece => [piece.from, piece.to]), [[1, 8]], 'no parser: blocks at blank lines');
  const long = Array.from({length: 150}, (_, i) => `  step${i}();`).join('\n');
  const parts = piecesOf(long, [{from: 1, to: 150, kind: 'function_declaration', name: 'big'}]);
  assert.ok(parts.length === 3 && parts.every(piece => piece.name === 'big' && piece.to - piece.from < PIECE.lines), 'each part keeps its name');
});

test('tree-sitter in a headless Neovim finds functions with their doc comments; a file it has no parser for goes by blank lines', {skip: !hasNvim && 'nvim not installed'}, async () => {
  const root = scratch('meaning-pieces-');
  // Lua and C: parsers every Neovim has.
  writeFileSync(join(root, 'team.lua'), [
    'local M = {}', '', '--- Takes a user off a team.', '--- Their tasks stay.', 'function M.remove_user(team, user)', '  team.users[user] = nil', 'end', '',
    'local function helper()', '  return 1', 'end', '', 'return M', ''].join('\n'));
  writeFileSync(join(root, 'arena.c'), ['#include <stdlib.h>', '', '/* Gives memory back to the arena. */', 'void arena_free(void *p) {', '  free(p);', '}', ''].join('\n'));
  writeFileSync(join(root, 'notes.unknownext'), 'plain words\n');
  const sitter = new TreeSitter();
  const found = await sitter.definitions(['team.lua', 'arena.c', 'notes.unknownext'].map(file => join(root, file)));
  assert.deepEqual(found.get(join(root, 'team.lua')).map(piece => [piece.from, piece.to, piece.name]), [[3, 7, 'M.remove_user'], [9, 11, 'helper']], 'the doc comment above goes with its function');
  assert.deepEqual(found.get(join(root, 'arena.c')).map(piece => [piece.from, piece.to]), [[3, 6]]);
  assert.equal(found.get(join(root, 'notes.unknownext')), null);
  const missing = new TreeSitter({nvim: join(root, 'no-nvim')});
  assert.equal((await missing.definitions([join(root, 'team.lua')])).get(join(root, 'team.lua')), null);
  assert.ok(missing.missing, 'no Neovim: blank lines from then on');
});

test('the words of code: lower case, with identifiers split as well; a search\'s small words are left out', () => {
  assert.deepEqual(words('retryCount = max_tries; HTTPServer'), ['retrycount', 'retry', 'count', 'max_tries', 'max', 'tries', 'httpserver', 'http', 'server']);
  assert.deepEqual(searchTerms('the method that removes a user'), ['method', 'removes', 'user']);
});

test('rankings fuse by reciprocal rank: what both rank high goes first', () => {
  assert.deepEqual(fuse([['a', 'b', 'c'], ['b', 'c']]), ['b', 'c', 'a']);
  assert.deepEqual(fuse([[], ['x']]), ['x']);
});

test('the files indexed are git\'s, without what .gitignore leaves out, pictures or lockfiles', async () => {
  const root = project();
  assert.deepEqual(await projectFiles(root), ['.gitignore', 'NOTES.md', 'src/cart.js', 'src/deliver.js']);
  assert.ok(!indexable('assets/logo.png') && !indexable('web/app.min.js') && !indexable('Cargo.lock') && indexable('src/main.rs') && !indexable('.pair/index.sqlite'));
});

/** Waits until every piece of `root` has its vector. */
const embedded = (meaning, root) => until(() => {
  const index = meaning.indexes.get(root);
  return index && index.files.size && !meaning.working && !index.pending().length;
}, 'the index to be built');

test('the index: SQLite in Pair\'s data folder, words without a model, meaning once on, a changed piece embedded again only', async () => {
  const root = project();
  const dataDir = scratch('meaning-data-');
  const booked = [];
  const told = [];
  const embedder = fakeEmbedder();
  const meaning = new Meaning({dataDir, embedder, book: (where, kind, text, options) => booked.push({where, kind, text, options}), progress: (where, how) => told.push(how)});
  try {
    assert.equal(meaning.state, 'off');
    const words = await meaning.words(root, 'quant item');
    assert.equal(words.state, 'off');
    await meaning.indexes.get(root).ready;
    assert.deepEqual((await meaning.words(root, 'quant item')).results.map(result => result.file), ['src/cart.js'], 'the words work without a model, each the start of one of the code\'s');
    assert.equal(embedder.calls.length, 0, 'nothing is embedded while it is off');
    assert.equal(told[0].phase, 'reading', 'a first build says it reads');
    const [{path}] = meaning.snapshot().indexes;
    assert.match(path, new RegExp(`^${dataDir}/index/meaning-project-\\w+-[0-9a-f]{8}\\.sqlite$`), 'in Pair\'s data folder, named after the repository');
    assert.ok(!readdirSync(root).includes('.pair'));
    const db = readFileSync(path).toString('latin1');
    assert.ok(!db.includes('item.cents * item.quantity'), 'no copy of the code: positions, hashes and words');

    for (let i = 0; i < 10; i++) writeFileSync(join(root, `note${i}.md`), `Note ${i} about the release.\n`);
    await meaning.rescan(); // the notes, read for their words
    fakeModel(dataDir);
    await meaning.turnOn();
    await embedded(meaning, root);
    const build = booked.find(entry => entry.kind === 'indexed');
    assert.match(build.text, /^indexed 14 pieces by meaning in \d+ s: 14 files, 14 pieces, \d+ KB$/);
    assert.ok(embedder.calls.every(call => !call.urgent), 'the build\'s batches are not urgent');
    assert.equal(told.at(-1).phase, 'done');

    const answer = await meaning.search(root, 'try again when sending fails');
    assert.equal(answer.results[0].file, 'src/deliver.js', 'no word of the search is in the code, but its meaning is');
    assert.equal(answer.results[0].line, 1);
    assert.equal(answer.results[0].head, 'export function deliver(job) {');
    assert.equal(answer.results[0].words, false);
    assert.equal(embedder.calls.at(-1).urgent, true, 'a search goes before the index\'s batches');
    assert.deepEqual([answer.chunks, answer.embedded], [14, 14]);
    const searched = booked.find(entry => entry.kind === 'searched');
    assert.match(searched.text, /^by meaning "try again when sending fails": \d+ results?, first src\/deliver\.js:1$/);
    const alone = await meaning.meaningOnly(root, 'what does the cart cost');
    assert.equal(alone.phase, 'meaning');
    assert.ok(alone.results.slice(0, 2).some(result => result.file === 'src/cart.js'));
    assert.ok(alone.results.every(result => result.meaning !== null && result.words === false));
    assert.deepEqual((await meaning.words(root, 'quantity tries')).results, [], 'every word, or none: the meaning ranks a question in other words');
    assert.deepEqual((await meaning.words(root, 'how is it')).results, [], 'the small words of a question are no words to search');

    embedder.failWith = 'python3 has no litert-lm-api';
    const fallback = await meaning.search(root, 'quantity');
    assert.equal(fallback.problem, 'python3 has no litert-lm-api', 'the answer says why meaning is missing');
    assert.equal(fallback.results[0].file, 'src/cart.js', 'and the words still rank');
    assert.equal(await meaning.trailHits(root, 'retry'), null, 'the trail leaves meaning out while the embedder fails');
    embedder.failWith = null;
    await meaning.search(root, 'cart');
    assert.equal(meaning.problem, null, 'the embedder answers again: the problem is gone');

    const calls = embedder.calls.length;
    await meaning.close();
    const again = new Meaning({dataDir, embedder});
    again.open(root);
    await again.indexes.get(root).ready;
    assert.equal(again.indexes.get(root).pending().length, 0, 'a restart embeds nothing again');
    writeFileSync(join(root, 'src', 'cart.js'), `${PRICES}\nexport const free = cart => total(cart) === 0;\n`);
    await again.saved(root, join(root, 'src', 'cart.js'));
    await embedded(again, root);
    assert.deepEqual(embedder.calls.slice(calls).flatMap(call => call.texts).map(text => text.replace(/^title: (\S+) .*$/s, '$1')), ['src/cart.js'], 'only the changed file\'s piece is embedded');
    await again.saved(root, join(root, 'secret.txt'));
    assert.ok(!again.indexes.get(root).files.has('secret.txt'), 'a file git ignores is not indexed when saved');
    assert.equal(await again.turnOn(), false, 'on again downloads nothing');
    await again.turnOff();
    assert.equal(again.state, 'off');
    assert.ok(!existsSync(modelPath(dataDir)) && !existsSync(path), 'off deletes the model and the indexes');
    await again.close();
  } finally {
    await meaning.close();
  }
});

test('worktrees of one repository share one index file and each piece\'s vector', async () => {
  const root = project();
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'one'], {cwd: root});
  const tree = join(realpathSync(scratch('meaning-tree-')), 'feature');
  execFileSync('git', ['worktree', 'add', '-q', tree], {cwd: root});
  const dataDir = scratch('meaning-data-');
  fakeModel(dataDir);
  const embedder = fakeEmbedder();
  const meaning = new Meaning({dataDir, embedder});
  try {
    meaning.open(root);
    await meaning.indexes.get(root).ready;
    await embedded(meaning, root);
    const first = embedder.calls.flatMap(call => call.texts).length;
    writeFileSync(join(tree, 'src', 'cart.js'), `${PRICES}// on the branch\n`);
    meaning.open(tree);
    await meaning.indexes.get(tree).ready;
    await embedded(meaning, tree);
    const [one, two] = meaning.snapshot().indexes;
    assert.equal(one.path, two.path, 'one file for both');
    assert.deepEqual(embedder.calls.flatMap(call => call.texts).slice(first).map(text => text.replace(/^title: (\S+) .*$/s, '$1')), ['src/cart.js'], 'the second embeds only what it changed');
    assert.equal((await meaning.search(tree, 'quantity')).results[0].file, 'src/cart.js');
    assert.equal((await meaning.words(root, 'branch')).results.length, 0, 'each worktree finds its own pieces');
    assert.equal((await meaning.words(tree, 'branch')).results.length, 1);
    await meaning.rebuild(tree);
    await meaning.indexes.get(tree).ready;
    await embedded(meaning, tree);
    assert.ok(meaning.indexes.get(root) && meaning.indexes.get(tree), ':Pair index rebuild makes both again');
    assert.equal((await meaning.words(root, 'quantity')).results.length, 1);
  } finally {
    await meaning.close();
  }
});

test('"index": "project" keeps it in .pair/ of the repository, listed in .git/info/exclude and not in .gitignore', async () => {
  const root = project();
  const dataDir = scratch('meaning-data-');
  const place = await indexPlace({dataDir, root, where: 'project'});
  assert.equal(place.path, join(root, '.pair', 'index.sqlite'));
  const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
  assert.match(exclude, /^\.pair\/$/m);
  await indexPlace({dataDir, root, where: 'project'});
  assert.equal(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8'), exclude, 'listed once');
  assert.doesNotMatch(readFileSync(join(root, '.gitignore'), 'utf8'), /\.pair/);
  const meaning = new Meaning({dataDir, config: {index: 'project'}, embedder: fakeEmbedder()});
  try {
    meaning.open(root);
    await meaning.indexes.get(root).ready;
    assert.ok(existsSync(place.path));
    assert.equal(execFileSync('git', ['status', '--porcelain', '--', '.pair'], {cwd: root}).toString(), '', 'git does not see it');
    assert.ok(!(await projectFiles(root)).some(file => file.startsWith('.pair/')));
  } finally {
    await meaning.close();
  }
});

test('an index file that cannot be opened: the words say so, the rescan goes on, and :Pair index rebuild makes it again', async () => {
  const root = project();
  const dataDir = scratch('meaning-data-');
  const {path} = await indexPlace({dataDir, root});
  mkdirSync(join(dataDir, 'index'), {recursive: true});
  writeFileSync(path, 'not a database, not at all, but long enough to be read as one '.repeat(100));
  const logged = [];
  const meaning = new Meaning({dataDir, embedder: fakeEmbedder(), log: line => logged.push(line)});
  try {
    const answer = await meaning.words(root, 'quantity');
    assert.match(answer.problem, /cannot be opened .*:Pair index rebuild/);
    await meaning.rescan(); // once crashed the daemon
    assert.ok(logged.some(line => line.includes(root)));
    await meaning.rebuild(root);
    await meaning.indexes.get(root).ready;
    assert.equal((await meaning.words(root, 'quantity')).results[0].file, 'src/cart.js');
  } finally {
    await meaning.close();
  }
});

test('a session that ends while its batch embeds: the batch is dropped, and the other projects build on', async () => {
  const one = project();
  const two = project();
  const dataDir = scratch('meaning-data-');
  fakeModel(dataDir);
  const embedder = fakeEmbedder();
  const embed = embedder.embed;
  embedder.embed = async (texts, options) => { await new Promise(resolve => setTimeout(resolve, 20)); return embed(texts, options); };
  const meaning = new Meaning({dataDir, embedder});
  try {
    meaning.open(one);
    await until(() => embedder.calls.length > 0, 'a batch under way');
    await meaning.leave(one);
    meaning.open(two);
    await embedded(meaning, two);
    assert.equal(meaning.problem, null);
  } finally {
    await meaning.close();
  }
});

test('without a model the index keeps no text of the code in memory; Scout\'s search asks it by meaning, within a path', async () => {
  const root = project();
  const dataDir = scratch('meaning-data-');
  const meaning = new Meaning({dataDir, embedder: fakeEmbedder()});
  try {
    meaning.open(root);
    await meaning.indexes.get(root).ready;
    assert.equal(meaning.indexes.get(root).documents.size, 0);
    fakeModel(dataDir);
    await meaning.turnOn();
    await embedded(meaning, root);
    const {PairSession} = await import('../src/session.mjs');
    const session = Object.assign(Object.create(PairSession.prototype), {role: 'scout', record: {root}, findCode: (query, options) => meaning.search(root, query, options)});
    const answer = await session.searchByMeaning('try again when sending fails', 'src');
    assert.match(answer, /^Pair's index, by meaning and words, best first:\nsrc\/deliver\.js:1: export function deliver\(job\) \{/);
    assert.doesNotMatch(answer, /NOTES\.md/, 'only within the path');
    const navigator = Object.assign(Object.create(PairSession.prototype), {role: 'navigator', record: {root}, findCode: () => null});
    await assert.rejects(navigator.searchByMeaning('x'), /needs the Scout role/);
  } finally {
    await meaning.close();
  }
});

test('a save during a scan: one read at a time, and the newer text is the one kept', async () => {
  const root = project();
  const dataDir = scratch('meaning-data-');
  const meaning = new Meaning({dataDir, embedder: fakeEmbedder()});
  try {
    meaning.open(root);
    const index = meaning.indexes.get(root);
    await index.ready;
    const sitter = index.treeSitter;
    const definitions = sitter.definitions.bind(sitter);
    let slow = true;
    sitter.definitions = async paths => { if (slow) { slow = false; await new Promise(resolve => setTimeout(resolve, 100)); } return definitions(paths); };
    writeFileSync(join(root, 'src', 'cart.js'), 'export const middleName = 1;\n');
    const scanning = index.scan();
    await new Promise(resolve => setTimeout(resolve, 20));
    writeFileSync(join(root, 'src', 'cart.js'), '\n\nexport const newestName = 2;\n');
    await Promise.all([scanning, meaning.saved(root, join(root, 'src', 'cart.js'))]);
    const [hit] = (await meaning.words(root, 'newestName')).results;
    assert.deepEqual([hit?.file, hit?.line], ['src/cart.js', 3]);
    assert.deepEqual((await meaning.words(root, 'middleName')).results, []);
  } finally {
    await meaning.close();
  }
});

test('a file changed without a new size or time is read again once, never in a loop', async () => {
  const root = project();
  const dataDir = scratch('meaning-data-');
  const meaning = new Meaning({dataDir, embedder: fakeEmbedder()});
  try {
    meaning.open(root);
    const index = meaning.indexes.get(root);
    await index.ready;
    const path = join(root, 'src', 'cart.js');
    const {atime, mtime} = statSync(path);
    writeFileSync(path, PRICES.replace('cents', 'pence'));
    utimesSync(path, atime, mtime);
    fakeModel(dataDir);
    await meaning.turnOn();
    await embedded(meaning, root);
    assert.equal((await meaning.words(root, 'pence')).results[0].file, 'src/cart.js', 'read again: its new words');
  } finally {
    await meaning.close();
  }
});

test(':Pair find off with an embedding model keeps it off until :Pair find on', async () => {
  const server = await fakeEmbeddingServer();
  const root = project();
  const dataDir = scratch('meaning-data-');
  const meaning = new Meaning({dataDir, embedding: {api: 'openai', baseUrl: server.baseUrl, model: 'jina-embeddings-v2-base-code'}});
  try {
    meaning.open(root);
    await embedded(meaning, root);
    await meaning.turnOff();
    assert.equal(meaning.state, 'off');
    const asked = server.requests.length;
    meaning.open(root); // the word index, made again from the files
    await meaning.indexes.get(root).ready;
    const answer = await meaning.search(root, 'quantity');
    assert.equal(answer.state, 'off');
    assert.equal(answer.results[0].file, 'src/cart.js', 'the words still work');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(server.requests.length, asked, 'nothing is embedded');
    await meaning.turnOn();
    assert.equal(meaning.state, 'on');
  } finally {
    await meaning.close();
    server.close();
  }
});

test('the brute-force search over every vector stays quick for many pieces', () => {
  const pieces = Array.from({length: 20_000}, (_, i) => ({id: i, file: 'f.js', from: i + 1, to: i + 1, hash: `h${i}`}));
  const index = new ProjectIndex({root: '/project', store: null, embedder: {id: 'fake'}});
  index.byFile = new Map([['f.js', pieces]]);
  index.vectors = new Map(pieces.map(piece => [piece.hash, fakeVector(`piece ${piece.id} retry ${piece.id % 7}`)]));
  const q = fakeVector('try again');
  index.meaningRanking(q); // the vectors go in one array once
  const started = performance.now();
  const ranked = index.meaningRanking(q);
  const ms = performance.now() - started;
  assert.ok(ranked.length > 0 && ranked[0][1] >= ranked.at(-1)[1]);
  assert.ok(ms < 250, `20,000 pieces in ${ms.toFixed(1)} ms`);
});

test('an embedder that cannot run from the start: the search still says why meaning is missing', async () => {
  const root = project();
  const dataDir = scratch('meaning-data-');
  fakeModel(dataDir);
  const embedder = fakeEmbedder();
  embedder.failWith = 'python3 has no litert-lm-api';
  const meaning = new Meaning({dataDir, embedder});
  try {
    meaning.open(root);
    await meaning.indexes.get(root).ready;
    await until(() => meaning.problem, 'the build to stop at the embedder');
    for (let i = 0; i < 2; i++) {
      const answer = await meaning.search(root, 'quantity');
      assert.equal(answer.problem, 'python3 has no litert-lm-api');
      assert.equal(answer.results[0].file, 'src/cart.js');
    }
    const alone = await meaning.meaningOnly(root, 'quantity');
    assert.equal(alone.problem, 'python3 has no litert-lm-api');
  } finally {
    await meaning.close();
  }
});

test('an "embedding" model at a /v1/embeddings: on at once, its prompts, its key, vectors made unit length, and its failure said', async () => {
  const server = await fakeEmbeddingServer();
  const root = project();
  const dataDir = scratch('meaning-data-');
  const entry = {api: 'openai', baseUrl: server.baseUrl, model: 'nomic-embed-code', apiKey: 'test-key'};
  const meaning = new Meaning({dataDir, embedding: entry});
  try {
    assert.equal(meaning.state, 'on', 'no download: the model is there');
    meaning.open(root);
    await meaning.indexes.get(root).ready;
    await embedded(meaning, root);
    assert.equal(server.requests[0].url, '/v1/embeddings');
    assert.equal(server.requests[0].model, 'nomic-embed-code');
    assert.equal(server.requests[0].authorization, 'Bearer test-key');
    const answer = await meaning.search(root, 'try again when sending fails');
    assert.equal(answer.results[0].file, 'src/deliver.js');
    assert.ok(answer.results[0].meaning > 0.4 && answer.results[0].meaning <= 1, 'unit length, though the server sent longer');
    assert.equal(server.requests.at(-1).input[0], 'Represent this query for searching relevant code: try again when sending fails', 'the prompt the model was trained with');
    assert.equal(meaning.snapshot().indexes[0].embedded, 4);
    server.failWith = 503;
    const failing = await meaning.search(root, 'quantity');
    assert.match(failing.problem, /answered 503: .*model not loaded/);
    assert.equal(failing.results[0].file, 'src/cart.js');
    const http = new HttpEmbedder({entry: {...entry, baseUrl: 'http://127.0.0.1:1/v1'}});
    await assert.rejects(http.embed(['x']), /did not answer/);
  } finally {
    await meaning.close();
    server.close();
  }
});

test('the model is downloaded once, at its pinned revision, and kept only if its SHA-256 matches', async () => {
  const dataDir = scratch('meaning-data-');
  const body = Buffer.from('pretend model bytes');
  const asked = [];
  const fetch = async url => { asked.push(url); return new Response(body); };
  await assert.rejects(downloadModel(dataDir, {fetch}), /SHA-256 is .*, not the pinned/);
  assert.equal(asked[0], `https://huggingface.co/${MODEL.repo}/resolve/${MODEL.revision}/${MODEL.file}`);
  assert.ok(!existsSync(modelPath(dataDir)) && !existsSync(`${modelPath(dataDir)}.part`), 'a wrong download is not kept');
  assert.ok(!modelReady(dataDir));

  const model = {...MODEL, sha256: createHash('sha256').update(body).digest('hex')};
  await downloadModel(dataDir, {fetch, model});
  assert.ok(existsSync(modelPath(dataDir)));
  assert.ok(!modelReady(dataDir), 'only the pinned checksum counts as the model');
  await assert.rejects(downloadModel(dataDir, {fetch: async () => new Response('gone', {status: 404})}), /answered 404/);
  const stalled = async (url, {signal}) => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(3)); signal.addEventListener('abort', () => controller.error(signal.reason)); },
  }));
  await assert.rejects(downloadModel(dataDir, {fetch: stalled, stallMs: 50}), /got nothing for 0.05 s/);
  assert.ok(!existsSync(`${modelPath(dataDir)}.part`), 'a stalled download leaves nothing');

  const meaning = new Meaning({dataDir, embedder: fakeEmbedder(), fetch: async () => new Response(body)});
  await assert.rejects(meaning.turnOn(), /not the pinned/);
  assert.equal(meaning.state, 'off');
  await meaning.close();
  let open;
  const gated = new Meaning({dataDir, embedder: fakeEmbedder(), fetch: (url, {signal}) => new Promise((resolve, reject) => {
    open = () => resolve(new Response(body));
    signal.addEventListener('abort', () => reject(signal.reason));
  })});
  const on = assert.rejects(gated.turnOn(), /turned off/);
  await until(() => open, 'the download to start');
  assert.equal(gated.state, 'downloading');
  await gated.turnOff();
  await on;
  assert.equal(gated.state, 'off', 'off during the download stops it');
  assert.ok(!existsSync(modelPath(dataDir)) && !existsSync(`${modelPath(dataDir)}.part`));
  await gated.close();
  const disabled = new Meaning({dataDir, config: false, embedder: fakeEmbedder()});
  assert.equal(disabled.state, 'disabled');
  await assert.rejects(disabled.turnOn(), /turned off in the config/);
  await disabled.close();
});

/** A stand-in for Python running the helper: `-I helper.py MODEL THREADS MAX` runs `script` with Node instead. */
function fakePython(script) {
  const dir = scratch('meaning-python-');
  writeFileSync(join(dir, 'helper.mjs'), script);
  const python = join(dir, 'python');
  writeFileSync(python, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'helper.mjs')}" "$@"\n`);
  chmodSync(python, 0o755);
  return python;
}

test('the embedder\'s helper loads once, a search jumps the queue, and a helper that cannot load says why', async () => {
  const python = fakePython(`
    import {createInterface} from 'node:readline';
    console.log(JSON.stringify({ready: true, runtime: '0.19.0', loadMs: 5}));
    createInterface({input: process.stdin}).on('line', line => {
      const {id, texts} = JSON.parse(line);
      const vectors = texts.map(text => Buffer.from(new Float32Array(256).fill(text.length).buffer).toString('base64'));
      setTimeout(() => console.log(JSON.stringify({id, vectors})), 30);
    });
  `);
  const embedder = new Embedder({python, model: 'm.litertlm', idleMs: 50});
  await embedder.embed(['warm']); // loaded: from here a batch is under way while others wait
  const order = [];
  const first = embedder.embed(['a']).then(() => order.push('first'));
  const second = embedder.embed(['bb']).then(() => order.push('second'));
  const search = embedder.embed(['ccc'], {urgent: true}).then(vectors => { order.push('search'); return vectors; });
  const [vector] = await search;
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first', 'search', 'second'], 'the search waits for the batch under way only');
  assert.equal(vector.length, 256);
  assert.equal(vector[0], 3);
  assert.equal(embedder.runtime.runtime, '0.19.0');
  await until(() => !embedder.child, 'the idle helper to stop');

  const missing = new Embedder({python: fakePython(`console.log(JSON.stringify({fatal: "ModuleNotFoundError: No module named 'litert_lm'"}))`), model: 'm'});
  await assert.rejects(missing.embed(['x']), /has no litert-lm-api/);
  const absent = new Embedder({python: join(scratch('meaning-none-'), 'python3'), model: 'm'});
  await assert.rejects(absent.embed(['x']), /is not there/);
  embedder.close();
});

test('the search trail\'s matches add where the code has what the words mean, when search by meaning has it', {skip: !hasRg && 'ripgrep not installed'}, async () => {
  const root = project();
  const trail = [{query: 'give up'}];
  const without = await trailMatches(root, trail);
  assert.doesNotMatch(without, /by meaning/);
  const meaning = async () => [{file: 'src/deliver.js', from: 1, to: 9, head: 'export function deliver(job) {'}];
  const lines = await trailMatches(root, trail, {meaning});
  assert.match(lines, /"by meaning": the chunks closest to what the words mean/);
  assert.match(lines, /"give up": nothing in the project\n {2}by meaning: src\/deliver\.js:1-9 export function deliver\(job\) \{/);
  assert.doesNotMatch(await trailMatches(root, trail, {meaning: async () => null}), /by meaning/, 'none while it is off');
});

test('config: meaning is false, or its python, threads and index; embedding is a model at a /v1/embeddings', () => {
  const models = {model: {api: 'openai', baseUrl: 'http://x', model: 'm'}};
  assert.deepEqual(parseConfig(models).meaning, {});
  assert.equal(parseConfig({...models, meaning: false}).meaning, false);
  assert.deepEqual(parseConfig({...models, meaning: {python: '~/venv/bin/python', threads: 4, index: 'project'}}).meaning, {python: '~/venv/bin/python', threads: 4, index: 'project'});
  assert.throws(() => parseConfig({...models, meaning: {thread: 4}}), /meaning has no thread/);
  assert.throws(() => parseConfig({...models, meaning: {threads: 0}}), /whole number above 0/);
  assert.throws(() => parseConfig({...models, meaning: {index: 'repo'}}), /"data" .* or "project"/);
  assert.equal(parseConfig(models).embedding, null, 'EmbeddingGemma 2 without one');
  const embedding = {api: 'openai', baseUrl: 'http://127.0.0.1:8080/v1', model: 'jina-embeddings-v2-base-code', apiKeyEnv: 'EMBED_KEY'};
  assert.deepEqual(parseConfig({...models, embedding}).embedding, embedding);
  assert.throws(() => parseConfig({...models, embedding: {...embedding, baseUrl: undefined}}), /embedding\.baseUrl is missing/);
  assert.throws(() => parseConfig({...models, embedding: {...embedding, api: 'anthropic'}}), /embedding\.api must be "openai"/);
  assert.throws(() => parseConfig({...models, embedding: {...embedding, apiKey: 'k'}}), /takes one of apiKey, apiKeyEnv/);
});

test('pair doctor: off says what turning it on takes; on, the runtime must be there, and each index shows its size and age', async () => {
  const dataDir = scratch('meaning-data-');
  const config = {dataDir, meaning: {}};
  const none = async () => ({problem: 'python3 has no litert-lm-api'});
  const there = async () => ({version: '0.19.0'});
  assert.equal((await meaningCheck({dataDir, meaning: false}, null, {runtime: there})).text, 'search by meaning is off in the config ("meaning": false)');
  const off = await meaningCheck(config, null, {runtime: none});
  assert.equal(off.level, 'ok');
  assert.match(off.text, /^words only: :Pair find on downloads EmbeddingGemma 2 \(text, 270M\) \(165 MB, once\) for meaning, or set an "embedding" model; it also needs LiteRT-LM: python3 -m venv .*meaning\/venv && .*pip install litert-lm-api==0\.19\.0$/);
  fakeModel(dataDir);
  const broken = await meaningCheck(config, null, {runtime: none});
  assert.equal(broken.level, 'fail');
  assert.match(broken.text, /is downloaded, but python3 has no litert-lm-api/);
  const status = {meaning: {state: 'on', problem: null, msPerChunk: 140.4, indexes: [{root: '/src/shop', files: 12, chunks: 40, embedded: 30, bytes: 1 << 20, updatedAt: Date.now() - 3 * 3600_000}]}};
  const mute = await meaningCheck(config, status, {runtime: there, answers: async () => ({problem: 'the embedder stopped (exit 1)'})});
  assert.equal(mute.level, 'fail');
  assert.match(mute.text, /does not answer: the embedder stopped/);
  const on = await meaningCheck(config, status, {runtime: there, answers: async () => ({ms: 412})});
  assert.equal(on.level, 'ok');
  assert.match(on.text, /revision 9be6e8b, SHA-256 checked\) on LiteRT-LM 0\.19\.0 in python3 answers \(412 ms with loading\); shop: 12 files, 40 pieces \(75% embedded\), 1\.0 MB, updated 3 h ago, 140 ms a piece$/);
  mkdirSync(join(dataDir, 'index'));
  writeFileSync(join(dataDir, 'index', 'shop-0123abcd.sqlite'), Buffer.alloc(2 << 20));
  assert.match((await meaningCheck(config, null, {runtime: there, answers: async () => ({ms: 1})})).text, /; shop: 2\.0 MB, updated just now$/, 'without the daemon, the files in Pair\'s data folder');

  const server = await fakeEmbeddingServer();
  try {
    const embedding = {api: 'openai', baseUrl: server.baseUrl, model: 'jina-embeddings-v2-base-code'};
    const answers = await meaningCheck({dataDir, meaning: {}, embedding}, null);
    assert.equal(answers.level, 'ok');
    assert.match(answers.text, /^jina-embeddings-v2-base-code at http:\/\/127\.0\.0\.1:\d+\/v1 answers \(256 numbers, \d+ ms\); shop: 2\.0 MB/);
    server.failWith = 401;
    const refused = await meaningCheck({dataDir, meaning: {}, embedding}, null);
    assert.equal(refused.level, 'fail');
    assert.match(refused.text, /answered 401: .*: search by meaning has the word search only/);
  } finally {
    server.close();
  }
});
