// Search by meaning's reranker as Pair runs it: semantic-grep's Reranker (whose own tests cover the question, a model
// down, slow or odd, a list of models and the picker's reranks) over Pair's "rerank" entries and pi-ai's decision
// models (search.mjs, pairReranker). Here: the config, /find and the search tool reranked with the ledger booking it,
// and `pair doctor`. A fake System One server stands in for the model (see fake-reranker.mjs), and a fake embedder for
// EmbeddingGemma 2, on through Pair's provider.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, realpathSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {join} from 'node:path';
import {test} from 'node:test';
import {foundLines} from '../src/chat.mjs';
import {parseConfig} from '../src/config.mjs';
import {rerankCheck} from '../src/doctor.mjs';
import {configChanges} from '../src/reload.mjs';
import {FALLBACK_TIMEOUT_MS, RERANK_TIMEOUT_MS, RERANK_TOP} from 'semantic-grep';
import {pairSearch} from '../src/search.mjs';
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
  const {meaning} = pairSearch({config: {dataDir, meaning: {}}, reranker, book: (where, kind, text, options) => booked.push({kind, text, options}), with: {embedder: fakeEmbedder()}});
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
