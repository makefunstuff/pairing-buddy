// Search by meaning's reranker: a decision model reorders the first pieces of a settled search, by the probability it
// gives each as the answer to "which is the one they are looking for?". Off without a "rerank" entry; a model that is
// down, slow or answers oddly keeps the search's order, and is not asked again for a minute after a failure; the
// picker's rerank is stopped by a newer one; the ledger books each rerank; `pair doctor` says how it does. A fake System
// One server stands in for the model (see fake-reranker.mjs), and a fake embedder for EmbeddingGemma 2.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, realpathSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {join} from 'node:path';
import {test} from 'node:test';
import {foundLines} from '../src/chat.mjs';
import {parseConfig} from '../src/config.mjs';
import {rerankCheck} from '../src/doctor.mjs';
import {Meaning} from '../src/meaning.mjs';
import {configChanges} from '../src/reload.mjs';
import {FALLBACK_TIMEOUT_MS, pieceText, probabilitiesOf, RERANK_TIMEOUT_MS, RERANK_TOP, rerankQuestion, reorder} from '../src/rerank.mjs';
import {fakeEmbedder, fakeModel} from './fake-embedder.mjs';
import {fakeRerankChain, fakeReranker, fakeRerankServer} from './fake-reranker.mjs';
import {scratch} from './temp.mjs';

const MODELS = {model: {api: 'openai', baseUrl: 'http://127.0.0.1:8080/v1', model: 'm'}};

/** A git repo of a few functions that all cost money in some way, so the words find them all and the model picks. */
function project() {
  const root = realpathSync(scratch('rerank-project-'));
  mkdirSync(join(root, 'src'));
  const files = {
    'src/cart.js': '// The basket\'s sum.\nexport function total(cart) {\n  return cart.items.reduce((sum, item) => sum + item.cents, 0)\n}\n',
    'src/invoice.js': '// The price on the invoice, taxes in.\nexport function invoicePrice(order) {\n  return order.cents * 1.2\n}\n',
    'src/refund.js': '// Money back for a returned item.\nexport function refund(item) {\n  return -item.cents\n}\n',
    'src/tip.js': '// A tip on the price, for the waiter.\nexport function tip(cents) {\n  return Math.round(cents * 0.15)\n}\n',
  };
  for (const [file, text] of Object.entries(files)) writeFileSync(join(root, file), text);
  execFileSync('git', ['init', '-q'], {cwd: root});
  return root;
}

async function ready(meaning, root) {
  await meaning.indexOf(root);
  await meaning.indexes.get(root).ready;
  const end = Date.now() + 5000;
  while (Date.now() < end && (meaning.working || meaning.indexes.get(root).pending().length)) await new Promise(resolve => setTimeout(resolve, 20));
}

test('the question: each piece an answer "1" to "N" with where it is and its text on one line; the answers reorder the first N', () => {
  assert.equal(pieceText({file: 'a.js', line: 3, head: 'x'}, '// doc\nfunction  add(a, b) {\n  return a + b\n}'), 'a.js:3  // doc function add(a, b) { return a + b }');
  assert.match(pieceText({file: 'a.js', from: 1}, 'x'.repeat(500)), /^a\.js:1  x{160}…$/, 'cut short: the model reads it all');
  const question = rerankQuestion(['a.js:1  one', 'b.js:2  two']);
  assert.equal(question.type, 'choice');
  assert.deepEqual(question.criteria, {1: 'a.js:1  one', 2: 'b.js:2  two'});

  const results = ['a', 'b', 'c', 'd'].map(file => ({file, from: 1}));
  assert.deepEqual(reorder(results, [0.1, 0.6, 0.3]).map(result => result.file), ['b', 'c', 'a', 'd'], 'the rest stay where they were');
  assert.deepEqual(reorder(results, [0.4, 0.2, 0.4]).map(result => result.file), ['a', 'c', 'b', 'd'], 'equal ones keep their order');
  assert.equal(reorder(results, [0.1, 0.6, 0.3])[0].rerank, 0.6);

  assert.deepEqual(probabilitiesOf({type: 'choice', probabilities: {1: 0.2, 2: 0.8}}, 2), {values: [0.2, 0.8]});
  assert.equal(probabilitiesOf({type: 'choice', choice: '1'}, 2).why, 'malformed');
  assert.equal(probabilitiesOf({type: 'choice', probabilities: {1: 0.2}}, 2).why, 'malformed', 'a piece without its probability');
  assert.equal(probabilitiesOf({type: 'choice', probabilities: {1: 0.2, 2: 7}}, 2).why, 'malformed');
  assert.equal(probabilitiesOf({type: 'bool', probability: 0.5}, 2).why, 'malformed');
  assert.equal(probabilitiesOf({type: 'choice', probabilities: {1: 0.5, 2: 0.495}}, 2).why, 'flat', 'no preference: no reorder');
});

test('config: "rerank" is a decision model entry next to "embedding", with top and timeoutMs; off without it; it reloads', () => {
  assert.equal(parseConfig(MODELS).rerank, null);
  const config = parseConfig({...MODELS, rerank: {api: 'system-one', baseUrl: 'http://127.0.0.1:8080/v1', model: 'd1-2B'}});
  assert.deepEqual(config.rerank, [{contextWindow: 32768, api: 'system-one', baseUrl: 'http://127.0.0.1:8080/v1', model: 'd1-2B', top: RERANK_TOP, timeoutMs: RERANK_TIMEOUT_MS}], 'one model is a list of one');
  assert.equal(parseConfig({...MODELS, rerank: {api: 'llama-cpp', baseUrl: 'http://h/v1', model: 'm', top: 6, timeoutMs: 1500}}).rerank[0].top, 6);
  assert.throws(() => parseConfig({...MODELS, rerank: {api: 'system-one', baseUrl: 'http://h/v1', model: 'm', top: 1}}), /rerank\.top must be a whole number from 2 to 30/);
  assert.throws(() => parseConfig({...MODELS, rerank: {api: 'system-one', baseUrl: 'http://h/v1', model: 'm', timeoutMs: -1}}), /rerank\.timeoutMs/);
  assert.throws(() => parseConfig({...MODELS, rerank: {api: 'chat', baseUrl: 'http://h/v1', model: 'm'}}), /config: rerank needs a "provider", or an "api"/);
  assert.throws(() => parseConfig({...MODELS, rerank: {api: 'system-one', model: 'm'}}), /rerank\.baseUrl is missing/);
  assert.deepEqual(configChanges(parseConfig(MODELS), config), ['rerank'], 'taken without a restart');

  // A list, best first: a model another follows waits 1 s by default, the last 3 s.
  const listed = parseConfig({...MODELS, rerank: [
    {api: 'system-one', baseUrl: 'http://127.0.0.1:8081/v1', model: 'gpu', top: 15},
    {api: 'system-one', baseUrl: 'http://127.0.0.1:8082/v1', model: 'cpu'},
  ]}).rerank;
  assert.deepEqual(listed.map(entry => [entry.model, entry.top, entry.timeoutMs]), [['gpu', 15, FALLBACK_TIMEOUT_MS], ['cpu', RERANK_TOP, RERANK_TIMEOUT_MS]]);
  assert.equal(FALLBACK_TIMEOUT_MS, 1000);
  assert.equal(parseConfig({...MODELS, rerank: [{api: 'system-one', baseUrl: 'http://h/v1', model: 'a', timeoutMs: 500}, {api: 'system-one', baseUrl: 'http://h/v1', model: 'b'}]}).rerank[0].timeoutMs, 500);
  assert.throws(() => parseConfig({...MODELS, rerank: []}), /config: rerank lists no model/);
  assert.throws(() => parseConfig({...MODELS, rerank: [{api: 'system-one', baseUrl: 'http://h/v1', model: 'a'}, {api: 'system-one', model: 'b'}]}), /config: rerank\[1\]\.baseUrl is missing/);
  assert.throws(() => parseConfig({...MODELS, rerank: [{api: 'system-one', baseUrl: 'http://h/v1', model: 'a', top: 50}]}), /config: rerank\[0\]\.top must be/);
});

test('/find and the search tool: the first pieces reranked by the model, the ledger books it with the order before and after', async () => {
  const server = await fakeRerankServer({favourite: 'waiter'});
  const root = project();
  const dataDir = scratch('rerank-data-');
  const booked = [];
  const reranker = fakeReranker(server.baseUrl);
  const meaning = new Meaning({dataDir, embedder: fakeEmbedder(), reranker, book: (where, kind, text, options) => booked.push({kind, text, options})});
  try {
    fakeModel(dataDir);
    await ready(meaning, root);
    const plain = await meaning.search(root, 'price cents', {book: false, rerank: false});
    assert.equal(plain.rerank, undefined, 'not asked, no rerank');
    assert.equal(server.requests.length, 0);
    assert.notEqual(plain.results[0].file, 'src/tip.js');

    const answer = await meaning.search(root, 'price cents');
    assert.equal(answer.results[0].file, 'src/tip.js', 'the piece the model favours goes first');
    assert.deepEqual(answer.results.map(result => result.file).sort(), plain.results.map(result => result.file).sort(), 'the same pieces, reordered');
    assert.equal(answer.rerank.applied, true);
    assert.equal(answer.rerank.model, 'fake-d1');
    assert.ok(answer.rerank.moved >= 1);
    assert.ok(answer.results[0].rerank > 0.5);
    const [request] = server.requests;
    assert.equal(request.state, 'Search: price cents');
    const texts = Object.values(request.questions.best.criteria);
    assert.equal(texts.length, plain.results.length, 'each piece, as many as the list has up to top');
    assert.ok(texts.some(text => text.startsWith('src/tip.js:2  // A tip on the price, for the waiter. export function tip(cents)')), 'where it is, and its text from its doc comment');
    const line = booked.find(entry => entry.kind === 'reranked');
    assert.match(line.text, /^"price cents" with fake-d1 in \d+ ms: \d of 4 moved, first now src\/tip\.js:2 \(was src\/\w+\.js:2\)$/);
    assert.match(line.options.detail.output, /^before:\n[\s\S]*\n\nafter \(the model's probability\):\nsrc\/tip\.js:2  0\.\d+  export function tip/);
    assert.ok(booked.some(entry => entry.kind === 'searched' && /first src\/tip\.js:2$/.test(entry.text)), 'the search\'s own line has the order shown');
    assert.match(foundLines({...answer, state: 'on'})[0], /, reranked by fake-d1, \d+ ms:$/, '/find says so');
    assert.equal(meaning.snapshot().rerank.calls, 1);
  } finally {
    await meaning.close();
    await server.close();
  }
});

test('a model that is slow, down or answers oddly keeps the search\'s order; after a failure it is not asked for a minute', async () => {
  const server = await fakeRerankServer({favourite: 'waiter', mode: 'slow', delayMs: 2000});
  const root = project();
  const dataDir = scratch('rerank-data-');
  const booked = [];
  let now = Date.now();
  const logged = [];
  const reranker = fakeReranker(server.baseUrl, {timeoutMs: 200}, {now: () => now, log: line => logged.push(line)});
  const meaning = new Meaning({dataDir, embedder: fakeEmbedder(), reranker, book: (where, kind, text, options) => booked.push({kind, text, options})});
  try {
    fakeModel(dataDir);
    await ready(meaning, root);
    const order = (await meaning.search(root, 'price cents', {rerank: false, book: false})).results.map(result => result.file);
    const started = Date.now();
    const slow = await meaning.search(root, 'price cents');
    assert.ok(Date.now() - started < 1500, 'the search does not wait past the timeout');
    assert.deepEqual(slow.results.map(result => result.file), order, 'too slow: the order stays');
    assert.equal(slow.rerank.applied, false);
    assert.equal(slow.rerank.why, 'timeout');
    assert.match(booked.find(entry => entry.kind === 'reranked').text, /^"price cents": kept the search's order, fake-d1 too slow \(no answer within 200 ms\)$/);
    assert.match(logged[0], /^reranker: fake-d1 at http:\/\/127\.0\.0\.1:\d+\/v1: no answer within 200 ms; searches keep their order for a minute$/);

    server.set({mode: 'ok'});
    const asked = server.requests.length;
    const skipped = await meaning.search(root, 'price cents');
    assert.equal(skipped.rerank, undefined, 'not asked again for a minute, nor booked each time');
    assert.equal(booked.filter(entry => entry.kind === 'reranked').length, 1);
    assert.equal(server.requests.length, asked);
    now += 61_000;
    assert.equal((await meaning.search(root, 'price cents')).rerank.applied, true, 'a minute later it is asked, and reranks');

    server.set({mode: 'down'});
    now += 61_000;
    const down = await meaning.search(root, 'price cents');
    assert.deepEqual(down.results.map(result => result.file), order);
    assert.equal(down.rerank.why, 'error');
    assert.match(down.rerank.problem, /500|loading/);

    for (const mode of ['malformed', 'flat']) {
      server.set({mode});
      now += 61_000;
      const odd = await meaning.search(root, 'price cents');
      assert.deepEqual(odd.results.map(result => result.file), order, `${mode}: the order stays`);
      assert.equal(odd.rerank.why, mode, 'an answer of the wrong shape (pi-ai checks it) or with no preference');
    }
    server.set({mode: 'ok'});
    assert.equal((await meaning.search(root, 'price cents')).rerank.applied, true, 'an odd answer costs that one rerank only');
    assert.equal(reranker.snapshot().kept, 4, 'slow, down, malformed and flat: the minute it was not asked is no call');
  } finally {
    await meaning.close();
    await server.close();
  }
});

test('the picker\'s settled search: the fused ranking\'s first pieces reranked, and each Neovim\'s newer rerank stops its older one', async () => {
  const server = await fakeRerankServer({favourite: 'waiter', mode: 'slow', delayMs: 300});
  const root = project();
  const dataDir = scratch('rerank-data-');
  const booked = [];
  const meaning = new Meaning({dataDir, embedder: fakeEmbedder(), reranker: fakeReranker(server.baseUrl), book: (where, kind, text) => booked.push({kind, text})});
  try {
    fakeModel(dataDir);
    await ready(meaning, root);
    const alone = await meaning.meaningOnly(root, 'price cents');
    assert.equal(alone.reranker, 'fake-d1', 'meaning\'s answer says a rerank may follow');
    const fused = (await meaning.search(root, 'price cents', {rerank: false, book: false})).results;
    const older = meaning.rerank(root, 'price', {who: 'nvim-1'});
    await new Promise(resolve => setTimeout(resolve, 50));
    const other = meaning.rerank(root, 'price cents', {who: 'nvim-2'});
    const newer = meaning.rerank(root, 'price cents', {who: 'nvim-1'});
    const [first, second, third] = await Promise.all([older, other, newer]);
    assert.equal(first.rerank.why, 'aborted', 'the same Neovim\'s older one is not used');
    assert.equal(second.rerank.applied, true, 'another Neovim\'s waits its turn, and is asked');
    assert.equal(third.phase, 'rerank');
    assert.equal(third.rerank.applied, true);
    assert.equal(third.results[0].file, 'src/tip.js');
    assert.deepEqual(third.results.map(result => result.file).sort(), fused.map(result => result.file).sort(), 'the fused ranking\'s pieces, as /find\'s');
    assert.equal(booked.filter(entry => entry.kind === 'reranked' && entry.text.includes('in the picker')).length, 2, 'the stopped one is not booked');
    assert.match(booked.find(entry => entry.kind === 'reranked').text, /^"price cents" in the picker with fake-d1 in \d+ ms: \d of 4 moved, first now src\/tip\.js:2 \(was src\/\w+\.js:2\)$/);
    assert.equal(meaning.reranker.snapshot().calls, 3, 'the older one was asked already: its answer is not used, the question not cut off');
    const none = await new Meaning({dataDir: scratch('rerank-none-'), embedder: fakeEmbedder()}).rerank(root, 'price');
    assert.deepEqual([none.results, none.rerank], [[], null], 'without a reranker it reorders nothing');
    server.set({mode: 'down'});
    await meaning.search(root, 'price cents', {book: false});
    assert.equal((await meaning.meaningOnly(root, 'price cents')).reranker, undefined, 'down: the picker is not told to ask for a minute');
  } finally {
    await meaning.close();
    await server.close();
  }
});

test('a question that timed out may still run on the server: nothing else is sent for a minute, a check\'s nor a new config\'s', async () => {
  const server = await fakeRerankServer({mode: 'slow', delayMs: 400});
  const results = ['a', 'b', 'c'].map(file => ({file, from: 1, line: 1, head: file}));
  try {
    const reranker = fakeReranker(server.baseUrl, {timeoutMs: 150});
    const probe = await reranker.probe();
    assert.match(probe.error, /no answer within 150 ms/);
    const after = await reranker.rerank('q', results, {wait: true});
    assert.equal(after.why, 'down', 'the server may still be on the check\'s question');
    assert.match((await reranker.probe()).error, /^not asked: it failed \d+ s ago/);
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(server.flight.most, 1);

    server.set({mode: 'slow', delayMs: 200});
    const old = fakeReranker(server.baseUrl);
    const running = old.rerank('q', results);
    await new Promise(resolve => setTimeout(resolve, 20));
    const next = fakeReranker(server.baseUrl);
    next.follow(old); // the config changed while a question is under way
    assert.equal((await next.rerank('q', results)).why, 'busy');
    const waited = await next.rerank('q', results, {wait: true});
    assert.equal((await running).ok, true);
    assert.equal(waited.ok, true, 'it waits for the old one\'s question, then asks');
    assert.equal(server.flight.most, 1);
    assert.equal(next.running, null);
    const tired = fakeReranker(server.baseUrl, {timeoutMs: 150});
    server.set({mode: 'slow', delayMs: 400});
    await tired.rerank('q', results);
    const changed = fakeReranker(server.baseUrl);
    changed.follow(tired); // a config saved right after a timeout
    assert.equal((await changed.rerank('q', results)).why, 'down', 'it keeps the minute of rest');
  } finally {
    await server.close();
  }
});

test('a key before the picker\'s rerank is even registered still drops it; a Neovim that goes is forgotten', async () => {
  const server = await fakeRerankServer({favourite: 'waiter'});
  const root = project();
  const dataDir = scratch('rerank-data-');
  const meaning = new Meaning({dataDir, embedder: fakeEmbedder(), reranker: fakeReranker(server.baseUrl)});
  try {
    fakeModel(dataDir);
    await ready(meaning, root);
    const asked = meaning.rerank(root, 'price', {who: 'nvim'});
    meaning.dropRerank('nvim'); // in the same tick: before the index is looked up
    assert.equal((await asked).rerank.why, 'aborted');
    assert.equal(server.requests.length, 0, 'the model was not asked');
    meaning.forget('nvim');
    assert.equal(meaning.reranking.size, 0);
  } finally {
    await meaning.close();
    await server.close();
  }
});

test('pair doctor: off says how to add one; on, it reranks a search\'s worth of pieces in its time, or says why not', async () => {
  const server = await fakeRerankServer({favourite: 'a warning'});
  try {
    const off = await rerankCheck(parseConfig(MODELS), null, {read: async () => null});
    assert.equal(off.level, 'ok');
    assert.match(off.text, /^off: searches keep the order of meaning and words; a "rerank" decision model reorders/);
    const config = parseConfig({...MODELS, rerank: {api: 'system-one', baseUrl: server.baseUrl, model: 'fake-d1'}});
    const on = await rerankCheck(config, {meaning: {rerank: {calls: 4, kept: 1, down: null}}}, {read: async () => null});
    assert.equal(on.level, 'warn', 'the matching piece was not first: the fake favours another');
    server.set({favourite: 'The sum of a and b'});
    const right = await rerankCheck(config, {meaning: {rerank: {calls: 4, kept: 1, down: null}}}, {read: async () => null});
    assert.equal(right.level, 'ok');
    assert.match(right.text, new RegExp(`^fake-d1 at ${server.baseUrl.replace(/[./]/g, '\\$&')} reranks 10 pieces in \\d\\.\\d s \\(a search waits up to 3\\.0 s\\); since the daemon started it reranked 3 of 4 searches and kept the order of 1$`));
    assert.equal(Object.keys(server.requests.at(-1).questions.best.criteria).length, 10, 'as many pieces as a search');
    server.set({mode: 'down'});
    const failing = await rerankCheck(config, null, {read: async () => null});
    assert.equal(failing.level, 'fail');
    assert.match(failing.text, /fails: .*\. Searches keep their own order$/);
    server.set({mode: 'slow', delayMs: 500});
    const slow = await rerankCheck(parseConfig({...MODELS, rerank: {api: 'system-one', baseUrl: server.baseUrl, model: 'fake-d1', timeoutMs: 100}}), null, {read: async () => null});
    assert.match(slow.text, /no answer within 100 ms\. Searches keep their own order; fewer pieces \("top", now 10\) or a higher "timeoutMs" lets it rerank$/);
    assert.match((await rerankCheck({...config, meaning: false}, null)).text, /search by meaning is off in the config/);

    // While the daemon runs with this model, the daemon asks it, in turn with the searches' reranks.
    const socket = join(scratch('rerank-socket-'), 'pair.sock');
    const asked = [];
    const daemon = createServer(stream => stream.on('data', data => {
      asked.push(JSON.parse(String(data)));
      stream.write(`${JSON.stringify({type: 'rerank_probe', ok: true, ms: 1200, pieces: 10, right: true})}\n`);
    }));
    await new Promise(resolve => daemon.listen(socket, resolve));
    const before = server.requests.length;
    const viaDaemon = await rerankCheck(config, {meaning: {rerank: {model: `fake-d1 at ${server.baseUrl}`, calls: 0}}}, {read: async () => null}, {socket});
    daemon.close();
    assert.deepEqual(asked.map(message => message.type), ['rerank_probe']);
    assert.equal(server.requests.length, before, 'doctor sent no question of its own');
    assert.match(viaDaemon.text, /reranks 10 pieces in 1\.2 s/);
  } finally {
    await server.close();
  }
});

test('one rerank at a time on the server: a search while one runs keeps its order, and a picker\'s rerank waits its turn, the latest only', async () => {
  const server = await fakeRerankServer({favourite: 'waiter', mode: 'slow', delayMs: 200});
  const root = project();
  const dataDir = scratch('rerank-data-');
  const booked = [];
  const meaning = new Meaning({dataDir, embedder: fakeEmbedder(), reranker: fakeReranker(server.baseUrl), book: (where, kind, text) => booked.push({kind, text})});
  try {
    fakeModel(dataDir);
    await ready(meaning, root);
    const shown = (await meaning.search(root, 'price cents', {rerank: false, book: false})).results;
    const find = meaning.search(root, 'price cents', {book: false});
    await new Promise(resolve => setTimeout(resolve, 30));
    const busy = await meaning.search(root, 'price cents', {book: false});
    assert.equal(busy.rerank.why, 'busy', 'a search does not wait for another\'s rerank');
    assert.deepEqual(busy.results.map(result => result.file), shown.map(result => result.file));
    const older = meaning.rerank(root, 'price', {who: 'nvim'});
    await new Promise(resolve => setTimeout(resolve, 50)); // the /find's rerank still runs
    const newer = meaning.rerank(root, 'price cents', {who: 'nvim'});
    const elsewhere = meaning.rerank(root, 'price cents', {who: 'other-nvim'});
    assert.equal((await find).rerank.applied, true);
    const [a, b, c] = await Promise.all([older, newer, elsewhere]);
    assert.equal(a.rerank.why, 'aborted', 'a newer one from the same Neovim drops the one waiting');
    assert.equal(b.rerank.applied, true);
    assert.equal(c.rerank.applied, true, 'another Neovim\'s waits its turn');
    assert.deepEqual(server.requests.map(request => request.state), ['Search: price cents', 'Search: price cents', 'Search: price cents'], 'the stale one never reached the model');
    assert.equal(server.flight.most, 1, 'never two questions on the server at once');

    const running = meaning.rerank(root, 'price', {who: 'nvim'});
    await new Promise(resolve => setTimeout(resolve, 50));
    meaning.dropRerank('nvim'); // a key in the picker while the model works
    const dropped = await running;
    assert.equal(dropped.rerank.why, 'aborted', 'the answer that came is not used');
    assert.equal(server.flight.most, 1, 'and the question was not cut off: the server finished it first');
    assert.ok(!booked.some(entry => /"price" in the picker/.test(entry.text)), 'nor booked');

    await meaning.reranker.probe();
    assert.equal(server.flight.most, 1);
    meaning.reranker = null; // the config's rerank entry removed meanwhile
    assert.deepEqual((await meaning.rerank(root, 'price', {who: 'nvim'})).rerank, null);
  } finally {
    await meaning.close();
    await server.close();
  }
});

test('a list of models, best first: the next is asked when one is down or slow, and one that failed is skipped for a minute', async () => {
  const gpu = await fakeRerankServer({favourite: 'waiter', mode: 'down'});
  const cpu = await fakeRerankServer({favourite: 'waiter'});
  const root = project();
  const dataDir = scratch('rerank-data-');
  const booked = [];
  const logged = [];
  let now = Date.now();
  const reranker = fakeRerankChain([{baseUrl: gpu.baseUrl, model: 'fake-d3', timeoutMs: 150}, {baseUrl: cpu.baseUrl}], {now: () => now, log: line => logged.push(line)});
  const meaning = new Meaning({dataDir, embedder: fakeEmbedder(), reranker, book: (where, kind, text) => booked.push({kind, text})});
  try {
    fakeModel(dataDir);
    await ready(meaning, root);
    assert.equal((await meaning.meaningOnly(root, 'price cents')).reranker, 'fake-d3', 'the picker is told the first');

    const fell = await meaning.search(root, 'price cents');
    assert.equal(fell.results[0].file, 'src/tip.js');
    assert.equal(fell.rerank.applied, true);
    assert.equal(fell.rerank.model, 'fake-d1', 'the one that answered');
    assert.deepEqual(fell.rerank.skipped.map(skip => [skip.model, skip.why]), [['fake-d3', 'error']]);
    assert.match(fell.rerank.skipped[0].problem, /500|loading/);
    assert.match(booked.find(entry => entry.kind === 'reranked').text, /^"price cents" with fake-d1 \(after fake-d3 failed \(.*\)\) in \d+ ms: \d of 4 moved/);
    assert.match(logged[0], /^reranker: fake-d3 at http:\S+: .*; fake-d1 is asked instead for a minute$/);
    assert.match(foundLines({...fell, state: 'on'})[0], /, reranked by fake-d1 \(fake-d3 not answering\), \d+ ms:$/);
    assert.equal(gpu.requests.length, 1);

    gpu.set({mode: 'ok'});
    const rested = await meaning.search(root, 'price cents');
    assert.equal(gpu.requests.length, 1, 'the one that failed is not asked for a minute: a search does not pay its wait each time');
    assert.equal(rested.rerank.model, 'fake-d1');
    assert.deepEqual(rested.rerank.skipped.map(skip => [skip.model, skip.why]), [['fake-d3', 'down']]);
    assert.equal((await meaning.meaningOnly(root, 'price cents')).reranker, 'fake-d1', 'meanwhile the picker is told the one asked first');

    now += 61_000;
    const back = await meaning.search(root, 'price cents');
    assert.equal(back.rerank.model, 'fake-d3', 'a minute later the first is asked again, and answers');
    assert.equal(back.rerank.skipped, undefined);
    assert.equal(cpu.requests.length, 2, 'the next is not asked when the first answers');

    gpu.set({mode: 'slow', delayMs: 600});
    const started = Date.now();
    const slow = await meaning.search(root, 'price cents');
    assert.ok(Date.now() - started < 600, 'the first one\'s wait is its own short timeout');
    assert.equal(slow.rerank.model, 'fake-d1');
    assert.deepEqual(slow.rerank.skipped.map(skip => [skip.model, skip.why, skip.problem]), [['fake-d3', 'timeout', 'no answer within 150 ms']]);

    cpu.set({mode: 'down'});
    now += 61_000;
    gpu.set({mode: 'down'});
    const none = await meaning.search(root, 'price cents');
    assert.equal(none.rerank.applied, false, 'all fail: the search\'s order stays');
    assert.deepEqual([none.rerank.model, none.rerank.why, none.rerank.skipped.map(skip => skip.model)], ['fake-d1', 'error', ['fake-d3']]);
    assert.match(booked.findLast(entry => entry.kind === 'reranked').text, /^"price cents": kept the search's order, fake-d1 failed \(.*\) \(after fake-d3 failed \(.*\)\)$/);
    assert.equal(reranker.available, false);
    assert.equal((await meaning.search(root, 'price cents')).rerank, undefined, 'both rest: not asked, nor booked');
    assert.match(reranker.snapshot().down, /^fake-d3: .*; fake-d1: /);

    gpu.set({mode: 'malformed'});
    cpu.set({mode: 'ok'});
    now += 61_000;
    const odd = await meaning.search(root, 'price cents');
    assert.deepEqual([odd.rerank.model, odd.rerank.why], ['fake-d3', 'malformed'], 'an odd answer is an answer: the next is not asked');
    const snapshot = reranker.snapshot();
    assert.deepEqual(snapshot.endpoints.map(endpoint => [endpoint.model, endpoint.answered]), [['fake-d3', 1], ['fake-d1', 3]]);
    assert.equal(snapshot.model, `fake-d3 at ${gpu.baseUrl}, then fake-d1 at ${cpu.baseUrl}`);
  } finally {
    await meaning.close();
    await gpu.close();
    await cpu.close();
  }
});

test('a list of models: one question at a time across them, a new config keeps each one\'s rest, a stale picker stops before the next', async () => {
  const gpu = await fakeRerankServer({mode: 'slow', delayMs: 400});
  const cpu = await fakeRerankServer({mode: 'slow', delayMs: 100});
  const results = ['a', 'b', 'c'].map(file => ({file, from: 1, line: 1, head: file}));
  try {
    const chain = () => fakeRerankChain([{baseUrl: gpu.baseUrl, model: 'fake-d3', timeoutMs: 100}, {baseUrl: cpu.baseUrl}]);
    const old = chain();
    let stale = false;
    const first = old.rerank('q', results, {stale: () => stale});
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal((await old.rerank('q', results)).why, 'busy', 'the second model is not asked while the first works');
    stale = true; // a key in the picker while the first model works
    const dropped = await first;
    assert.equal(dropped.why, 'aborted', 'the next model is not asked for a search that moved on');
    assert.equal(cpu.requests.length, 0);

    const next = chain();
    next.follow(old); // the config saved again
    const asked = await next.rerank('q', results);
    assert.equal(asked.ok, true);
    assert.deepEqual(asked.skipped.map(skip => [skip.model, skip.why]), [['fake-d3', 'down']], 'the first keeps its minute of rest');
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(gpu.requests.length, 1);
    assert.equal(gpu.flight.most, 1);
    assert.equal(cpu.flight.most, 1);

    const check = await chain().probe();
    assert.equal(check.ok, true);
    assert.equal(check.model, 'fake-d1');
    assert.deepEqual(check.skipped.map(skip => [skip.model, skip.why]), [['fake-d3', 'timeout']]);
  } finally {
    await gpu.close();
    await cpu.close();
  }
});

test('pair doctor with a list: it names the model that answered, why the ones before it did not, and what follows', async () => {
  const gpu = await fakeRerankServer({favourite: 'The sum of a and b'});
  const cpu = await fakeRerankServer({favourite: 'The sum of a and b'});
  try {
    const config = parseConfig({...MODELS, rerank: [
      {api: 'system-one', baseUrl: gpu.baseUrl, model: 'fake-d3', top: 15},
      {api: 'system-one', baseUrl: cpu.baseUrl, model: 'fake-d1'},
    ]});
    const first = await rerankCheck(config, {meaning: {rerank: {calls: 5, kept: 1, down: null, endpoints: [{model: 'fake-d3', answered: 3}, {model: 'fake-d1', answered: 1}]}}}, {read: async () => null});
    assert.equal(first.level, 'ok');
    assert.equal(first.text.replace(/\d\.\d s \(it/, 'N s (it'), `fake-d3 at ${gpu.baseUrl} reranks 10 pieces in N s (it is set to 15: more take longer) (a search waits up to 1.0 s); fake-d1 if it fails; since the daemon started it reranked 4 of 5 searches (fake-d3 3, fake-d1 1) and kept the order of 1`);
    assert.equal(cpu.requests.length, 0);

    gpu.set({mode: 'down'});
    const fell = await rerankCheck(config, null, {read: async () => null});
    assert.equal(fell.level, 'ok', 'the next one reranks');
    assert.match(fell.text, new RegExp(`^fake-d1 at ${cpu.baseUrl.replace(/[./]/g, '\\$&')} reranks 10 pieces in \\d\\.\\d s \\(a search waits up to 3\\.0 s\\); first fake-d3 at \\S+ failed \\(.*(500|loading).*\\)$`));

    cpu.set({mode: 'slow', delayMs: 500});
    const slowConfig = parseConfig({...MODELS, rerank: [
      {api: 'system-one', baseUrl: gpu.baseUrl, model: 'fake-d3'},
      {api: 'system-one', baseUrl: cpu.baseUrl, model: 'fake-d1', timeoutMs: 100},
    ]});
    const failing = await rerankCheck(slowConfig, null, {read: async () => null});
    assert.equal(failing.level, 'fail');
    assert.match(failing.text, /^fake-d3 at \S+ failed \(.*\); fake-d1 at \S+ fails: no answer within 100 ms\. Searches keep their own order; fewer pieces \("top", now 10\) or a higher "timeoutMs" lets it rerank$/);
  } finally {
    await gpu.close();
    await cpu.close();
  }
});
