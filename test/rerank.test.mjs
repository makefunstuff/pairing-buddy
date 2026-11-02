// Search by meaning's reranker: a decision model reorders the first pieces of a settled search, by the probability it
// gives each as the answer to "which is the one they are looking for?". Off without a "rerank" entry; a model that is
// down, slow or answers oddly keeps the search's order, and is not asked again for a minute after a failure; the
// picker's rerank is stopped by a newer one; the ledger books each rerank; `pair doctor` says how it does. A fake System
// One server stands in for the model (see fake-reranker.mjs), and a fake embedder for EmbeddingGemma 2.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {foundLines} from '../src/chat.mjs';
import {parseConfig} from '../src/config.mjs';
import {rerankCheck} from '../src/doctor.mjs';
import {Meaning} from '../src/meaning.mjs';
import {configChanges} from '../src/reload.mjs';
import {pieceText, probabilitiesOf, RERANK_TIMEOUT_MS, RERANK_TOP, rerankQuestion, reorder} from '../src/rerank.mjs';
import {fakeEmbedder, fakeModel} from './fake-embedder.mjs';
import {fakeReranker, fakeRerankServer} from './fake-reranker.mjs';
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
  assert.deepEqual(config.rerank, {contextWindow: 32768, api: 'system-one', baseUrl: 'http://127.0.0.1:8080/v1', model: 'd1-2B', top: RERANK_TOP, timeoutMs: RERANK_TIMEOUT_MS});
  assert.equal(parseConfig({...MODELS, rerank: {api: 'llama-cpp', baseUrl: 'http://h/v1', model: 'm', top: 6, timeoutMs: 1500}}).rerank.top, 6);
  assert.throws(() => parseConfig({...MODELS, rerank: {api: 'system-one', baseUrl: 'http://h/v1', model: 'm', top: 1}}), /rerank\.top must be a whole number from 2 to 30/);
  assert.throws(() => parseConfig({...MODELS, rerank: {api: 'system-one', baseUrl: 'http://h/v1', model: 'm', timeoutMs: -1}}), /rerank\.timeoutMs/);
  assert.throws(() => parseConfig({...MODELS, rerank: {api: 'chat', baseUrl: 'http://h/v1', model: 'm'}}), /config: rerank needs a "provider", or an "api"/);
  assert.throws(() => parseConfig({...MODELS, rerank: {api: 'system-one', model: 'm'}}), /rerank\.baseUrl is missing/);
  assert.deepEqual(configChanges(parseConfig(MODELS), config), ['rerank'], 'taken without a restart');
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
    assert.match(logged[0], /^reranker: no answer within 200 ms; searches keep their order for a minute$/);

    server.set({mode: 'ok'});
    const asked = server.requests.length;
    const skipped = await meaning.search(root, 'price cents');
    assert.equal(skipped.rerank.why, 'down', 'not asked again for a minute');
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
      assert.equal(odd.rerank.why, mode === 'flat' ? 'flat' : 'error', 'pi-ai takes an answer without probabilities for a failure');
    }
    server.set({mode: 'ok'});
    assert.equal((await meaning.search(root, 'price cents')).rerank.applied, true, 'an odd answer costs that one rerank only');
    assert.equal(reranker.snapshot().kept, 4, 'slow, down, malformed and flat: the minute it was not asked is no call');
  } finally {
    await meaning.close();
    await server.close();
  }
});

test('the picker\'s settled list: its pieces reranked, a newer rerank stops an older one, and pieces outside the project are left out', async () => {
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
    const shown = (await meaning.search(root, 'price cents', {rerank: false, book: false})).results;
    const older = meaning.rerank(root, 'price', shown);
    await new Promise(resolve => setTimeout(resolve, 50));
    const newer = meaning.rerank(root, 'price cents', [...shown, {file: '../outside.js', from: 1, to: 2}, {file: '/etc/passwd', from: 1, to: 1}, {file: 'src/x.js', from: 'a', to: 2}]);
    const [first, second] = await Promise.all([older, newer]);
    assert.equal(first.rerank.why, 'aborted', 'the older one stops');
    assert.equal(second.phase, 'rerank');
    assert.equal(second.rerank.applied, true);
    assert.equal(second.results[0].file, 'src/tip.js');
    assert.equal(second.results.length, shown.length, 'only the project\'s pieces');
    assert.deepEqual(booked.filter(entry => entry.kind === 'reranked').map(entry => entry.text.replace(/\d+ ms/, 'N ms').replace(/\(was .*\)/, '(was …)')), ['"price cents" in the picker with fake-d1 in N ms: ' + `${second.rerank.moved} of 4 moved, first now src/tip.js:2 (was …)`], 'the stopped one is not booked');
    const none = await new Meaning({dataDir: scratch('rerank-none-'), embedder: fakeEmbedder()}).rerank(root, 'price', shown);
    assert.deepEqual([none.results, none.rerank], [[], null], 'without a reranker it reorders nothing');
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
  } finally {
    await server.close();
  }
});
