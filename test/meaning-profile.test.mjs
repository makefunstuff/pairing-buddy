// semantic-grep's model profiles and notes writer as Pair takes them (config.mjs, search.mjs): "meaning": {"profile":
// ...} names the "embedding" and "rerank" models, with the config's own entries over them; "meaning": {"notes": ...}
// a model that writes a note on each piece while nothing is searched. Configs without either are as they were. The
// keys of the models semantic-grep asks itself (a cross-encoder, the notes writer) are read as Pair reads a model's,
// so the variables `pair setup` stored for the service work there too. Fake servers stand in for /rerank and
// /chat/completions, and a fake embedder for EmbeddingGemma 2.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {test} from 'node:test';
import {PROFILES} from 'semantic-grep';
import {apiKeyOf, parseConfig, primeKeyCommands, withPairKey} from '../src/config.mjs';
import {createRerankEndpoints} from '../src/models.mjs';
import {pairReranker, pairSearch} from '../src/search.mjs';
import {keyVariables} from '../src/service-env.mjs';
import {fakeEmbedder, fakeModel} from './fake-embedder.mjs';
import {scratch} from './temp.mjs';

const MODELS = {model: {api: 'openai', baseUrl: 'http://127.0.0.1:8080/v1', model: 'm'}};

/** A server on 127.0.0.1 that answers each POST with `answer(path, body)`: `{baseUrl, asked, close()}`. */
async function fakeServer(answer) {
  const asked = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const parsed = JSON.parse(body);
      asked.push({url: request.url, authorization: request.headers.authorization, body: parsed});
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(JSON.stringify(answer(request.url, parsed)));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, asked,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
  };
}

function project() {
  const root = realpathSync(scratch('profile-project-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/cart.js'), '// The basket\'s sum.\nexport function total(cart) {\n  return cart.items.reduce((sum, item) => sum + item.cents, 0)\n}\n');
  writeFileSync(join(root, 'src/tip.js'), '// A tip on the price, for the waiter.\nexport function tip(cents) {\n  return Math.round(cents * 0.15)\n}\n');
  execFileSync('git', ['init', '-q'], {cwd: root});
  return root;
}

async function ready(meaning, root) {
  await meaning.indexOf(root);
  await meaning.indexes.get(root).ready;
  const end = Date.now() + 5000;
  while (Date.now() < end && (meaning.working || meaning.indexes.get(root).pending().length)) await new Promise(resolve => setTimeout(resolve, 20));
}

test('config: a profile names the embedding and rerank models; the config\'s own go over them; without one, nothing changes', () => {
  const plain = parseConfig(MODELS);
  assert.deepEqual([plain.meaning, plain.embedding, plain.rerank], [{}, null, null], 'EmbeddingGemma 2 on LiteRT-LM, no reranker, as before');

  const beefy = parseConfig({...MODELS, meaning: {profile: 'beefy'}});
  assert.deepEqual(beefy.meaning, {profile: 'beefy'});
  assert.deepEqual(beefy.embedding, PROFILES.beefy.embedding);
  assert.deepEqual(beefy.rerank.map(entry => [entry.api, entry.model, entry.top, entry.baseUrl]), [['rerank', 'qwen3-reranker-0.6b', 20, 'http://127.0.0.1:18121/v1']]);
  assert.equal(parseConfig({...MODELS, meaning: {profile: 'laptop'}}).rerank, null, 'the laptop has no reranker');

  const moved = parseConfig({...MODELS, meaning: {profile: 'beefy'}, embedding: {baseUrl: 'http://127.0.0.1:9000/v1'}, rerank: false});
  assert.deepEqual(moved.embedding, {...PROFILES.beefy.embedding, baseUrl: 'http://127.0.0.1:9000/v1'}, 'a baseUrl moves it, the model\'s settings stay');
  assert.equal(moved.rerank, null, 'rerank: false turns the profile\'s off');
  const other = parseConfig({...MODELS, meaning: {profile: 'beefy'}, embedding: {model: 'qwen3-embedding-4b'}}).embedding;
  assert.equal(other.model, 'qwen3-embedding-4b');
  assert.equal(other.baseUrl, PROFILES.beefy.embedding.baseUrl);
  assert.equal(other.band, undefined, 'another model drops the profile\'s settings for its own');

  const cloud = parseConfig({...MODELS, meaning: {profile: 'openrouter'}, embedding: {apiKeyFile: '~/.openrouter'}});
  assert.equal(cloud.embedding.apiKeyEnv, undefined, 'a key of its own replaces the profile\'s');
  assert.equal(cloud.embedding.apiKeyFile, '~/.openrouter');
  const decision = {api: 'system-one', baseUrl: 'http://127.0.0.1:8091/v1', model: 'd1-2B'};
  assert.equal(parseConfig({...MODELS, meaning: {profile: 'openrouter'}, rerank: decision}).rerank[0].api, 'system-one', 'a decision model of its own replaces the profile\'s');
  const own = parseConfig({...MODELS, meaning: {profile: 'beefy'}, embedding: {baseUrl: 'https://elsewhere.example/v1', auth: 'mine'}}).embedding;
  assert.equal(own.auth, 'mine', 'Pair\'s stored key, over the profile\'s');

  assert.throws(() => parseConfig({...MODELS, meaning: {profile: 'huge'}}), /meaning\.profile must be one of "laptop", "beefy", "cloud", "openrouter"/);
  assert.deepEqual(keyVariables(parseConfig({...MODELS, meaning: {profile: 'cloud', notes: true}})), ['VOYAGE_API_KEY', 'ANTHROPIC_API_KEY'], '`pair setup` stores their keys for the service');
});

test('config: notes are off by default; true is the profile\'s writer (the laptop\'s without one); code goes elsewhere only with sendCode', () => {
  assert.equal(parseConfig(MODELS).meaning.notes, undefined);
  assert.equal(parseConfig({...MODELS, meaning: {notes: false}}).meaning.notes, undefined);
  const laptop = parseConfig({...MODELS, meaning: {notes: true}}).meaning.notes;
  assert.equal(laptop.model, PROFILES.laptop.notes.model);
  assert.equal(laptop.baseUrl, 'http://127.0.0.1:18122/v1');
  const cloud = parseConfig({...MODELS, meaning: {profile: 'cloud', notes: true}}).meaning.notes;
  assert.deepEqual([cloud.api, cloud.sendCode], ['anthropic', true]);
  assert.equal(parseConfig({...MODELS, meaning: {notes: {model: 'qwen3.5-9b'}}}).meaning.notes.model, 'qwen3.5-9b', 'an entry over the writer');
  assert.throws(() => parseConfig({...MODELS, meaning: {notes: {api: 'openai', baseUrl: 'https://writer.example/v1', model: 'w'}}}), /config: meaning\.notes: https:\/\/writer\.example\/v1 is not this machine.*"sendCode": true/, 'said as JSON');
  assert.throws(() => parseConfig({...MODELS, meaning: {notes: {concurrency: 'many'}}}), /config: meaning\.notes\.concurrency/);
  assert.throws(() => parseConfig({...MODELS, meaning: {notes: 'yes'}}), /config: meaning\.notes must be true, false or a notes writer entry/);
  const stored = parseConfig({...MODELS, meaning: {profile: 'cloud', notes: {auth: 'anthropic'}}});
  assert.deepEqual([stored.meaning.notes.auth, stored.meaning.notes.apiKeyEnv], ['anthropic', undefined], 'Pair\'s stored key replaces the profile\'s');
  assert.deepEqual(keyVariables(stored), ['VOYAGE_API_KEY'], 'nothing for `pair setup` to store for the writer');
});

test('config: apiKeyCommand is for search by meaning\'s models only, and must be a command', () => {
  assert.throws(() => parseConfig({model: {...MODELS.model, apiKeyCommand: 'pass show llm'}}), /apiKeyCommand is for search by meaning/);
  assert.throws(() => parseConfig({...MODELS, decision: {api: 'system-one', baseUrl: 'http://h/v1', model: 'd1-2B', apiKeyEnv: 'K', apiKeyCommand: 'x'}}), /apiKeyCommand is for search by meaning/);
  assert.throws(() => parseConfig({...MODELS, embedding: {api: 'openai', baseUrl: 'http://h/v1', model: 'e', apiKeyCommand: ' '}}), /embedding\.apiKeyCommand must be a command/);
  assert.equal(parseConfig({...MODELS, embedding: {api: 'openai', baseUrl: 'http://h/v1', model: 'e', apiKeyCommand: 'pass show e'}}).embedding.apiKeyCommand, 'pass show e');
});

test('a key a command prints is read in the background, never waited for, and kept a while', async () => {
  const runs = join(scratch('key-command-'), 'runs');
  const entry = {apiKeyCommand: `echo run >> '${runs}'; sleep 0.2; echo sk-from-command`};
  const started = Date.now();
  assert.equal(apiKeyOf(entry), undefined, 'not there yet: the request goes without, rather than the daemon waiting');
  assert.ok(Date.now() - started < 100, 'the command does not block');
  await primeKeyCommands([entry]);
  assert.equal(apiKeyOf(entry), 'sk-from-command');
  assert.equal(apiKeyOf(entry), 'sk-from-command');
  assert.equal(readFileSync(runs, 'utf8'), 'run\n', 'run once, then kept');
});

test('a key semantic-grep reads for a cross-encoder or a writer is Pair\'s: never in a snapshot or a log', () => {
  process.env.PROFILE_TEST_KEY = 'sk-test';
  try {
    const entry = withPairKey({api: 'rerank', baseUrl: 'https://rerank.example/v1', model: 'r', apiKeyEnv: 'PROFILE_TEST_KEY'});
    assert.equal(entry.apiKey, 'sk-test');
    assert.doesNotMatch(JSON.stringify(entry), /sk-test/);
    assert.equal(withPairKey(null), null);
  } finally {
    delete process.env.PROFILE_TEST_KEY;
  }
});

test('a profile\'s cross-encoder reranks with the key Pair reads; the notes writer writes a note per piece while nothing is searched', async () => {
  // The key only in the file `pair setup` stores for the service, as when the daemon runs as one.
  const home = scratch('profile-config-');
  const before = process.env.PAIR_CONFIG;
  process.env.PAIR_CONFIG = join(home, 'config.json');
  writeFileSync(join(home, 'service.env'), 'PROFILE_TEST_KEY=sk-rerank\n', {mode: 0o600});
  const rerank = await fakeServer((url, body) => ({results: body.documents.map((text, index) => ({index, relevance_score: text.includes('waiter') ? 0.9 : 0.1}))}));
  const writer = await fakeServer(() => ({choices: [{message: {content: 'Adds a tip to a price for the waiter.'}}], usage: {prompt_tokens: 10, completion_tokens: 5}}));
  const root = project();
  const dataDir = scratch('profile-data-');
  const config = parseConfig({...MODELS, meaning: {profile: 'beefy', notes: {baseUrl: writer.baseUrl, idleMs: 1}}, rerank: {baseUrl: rerank.baseUrl, apiKeyEnv: 'PROFILE_TEST_KEY'}});
  const booked = [];
  const reranker = pairReranker(createRerankEndpoints(config, {credentials: {read: async () => null}}));
  const {meaning} = pairSearch({config: {...config, dataDir, embedding: null}, reranker, book: (where, kind, text) => booked.push([kind, text]), with: {embedder: fakeEmbedder()}});
  try {
    fakeModel(dataDir);
    await ready(meaning, root);
    const answer = await meaning.search(root, 'price cents', {book: false});
    assert.equal(answer.rerank.applied, true);
    assert.equal(answer.results[0].file, 'src/tip.js');
    assert.equal(rerank.asked[0].authorization, 'Bearer sk-rerank', 'the key from the service\'s file, not written in the config');
    assert.equal(rerank.asked[0].body.model, 'qwen3-reranker-0.6b', 'the profile\'s model at the config\'s baseUrl');

    assert.equal(await meaning.writeNotes({idle: () => true}), 2, 'a note for each piece');
    assert.equal(writer.asked[0].url, '/v1/chat/completions');
    assert.equal(writer.asked[0].body.model, PROFILES.beefy.notes.model, 'the beefy profile\'s writer, moved');
    assert.match(JSON.stringify(booked), /"noted","wrote 2 notes with/, 'the ledger books it');
    const {pending, noted} = await meaning.pendingNotes(root);
    assert.deepEqual([pending, noted], [0, 2]);
  } finally {
    if (before === undefined) delete process.env.PAIR_CONFIG;
    else process.env.PAIR_CONFIG = before;
    await meaning.close();
    await rerank.close();
    await writer.close();
  }
});
