// Search by meaning as Pair runs it (search.mjs): semantic-grep's Meaning (whose own tests cover the pieces, the words,
// the index and the search) with what is Pair's: the index in .pair/ with "index": "project", EmbeddingGemma 2 turned
// on and off through Meaning's provider hook (the one model download and its checksum, the embedder's helper), an
// "embedding" model with its key read as Pair reads a model's, :Pair find off's note, the trail's "by meaning" lines,
// the config and `pair doctor`. A fake embedder stands in for EmbeddingGemma 2, and a fake server for the
// /v1/embeddings (see fake-embedder.mjs).
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {test} from 'node:test';
import {parseConfig} from '../src/config.mjs';
import {meaningCheck} from '../src/doctor.mjs';
import {indexPlace, projectFiles} from 'semantic-grep';
import {downloadModel, Embedder, meaningDir, MODEL, modelPath, modelReady} from '../src/embedder.mjs';
import {offNote, pairSearch, PROJECT_DIR} from '../src/search.mjs';
import {trailMatches} from '../src/trail.mjs';
import {fakeEmbedder, fakeEmbeddingServer, fakeModel} from './fake-embedder.mjs';
import {scratch} from './temp.mjs';

const hasRg = (() => { try { execFileSync('rg', ['--version']); return true; } catch { return false; } })();
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

/** Pair's search by meaning over `dataDir`, as the daemon makes it, with the tests' `with` (see search.mjs). */
const pairs = (config, given = {}) => pairSearch({config: {meaning: {}, embedding: null, ...config}, with: given}).meaning;

const embedded = (meaning, root) => until(() => {
  const index = meaning.indexes.get(root);
  return index && index.files.size && !meaning.working && !index.pending().length;
}, 'the index to be built');

test('"index": "project" keeps it in .pair/ of the repository, listed in .git/info/exclude and not in .gitignore', async () => {
  const root = project();
  const dataDir = scratch('meaning-data-');
  const place = await indexPlace({dataDir, root, where: 'project', projectDir: PROJECT_DIR});
  assert.equal(place.path, join(root, '.pair', 'index.sqlite'));
  const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
  assert.match(exclude, /^\.pair\/$/m);
  await indexPlace({dataDir, root, where: 'project', projectDir: PROJECT_DIR});
  assert.equal(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8'), exclude, 'listed once');
  assert.doesNotMatch(readFileSync(join(root, '.gitignore'), 'utf8'), /\.pair/);
  const meaning = pairs({dataDir, meaning: {index: 'project'}}, {embedder: fakeEmbedder()});
  try {
    meaning.open(root);
    await meaning.indexes.get(root).ready;
    assert.ok(existsSync(place.path));
    assert.equal(execFileSync('git', ['status', '--porcelain', '--', '.pair'], {cwd: root}).toString(), '', 'git does not see it');
    assert.ok(!(await projectFiles(root, PROJECT_DIR)).some(file => file.startsWith('.pair/')));
  } finally {
    await meaning.close();
  }
});

test(':Pair find off with an embedding model keeps it off until :Pair find on, by a note in Pair\'s data folder', async () => {
  const server = await fakeEmbeddingServer();
  const root = project();
  const dataDir = scratch('meaning-data-');
  const embedding = {api: 'openai', baseUrl: server.baseUrl, model: 'jina-embeddings-v2-base-code'};
  const meaning = pairs({dataDir, embedding});
  try {
    meaning.open(root);
    await embedded(meaning, root);
    await meaning.turnOff();
    assert.equal(meaning.state, 'off');
    assert.ok(existsSync(offNote(dataDir)));
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
    assert.ok(!existsSync(offNote(dataDir)));
  } finally {
    await meaning.close();
    server.close();
  }
  // Before semantic-grep the note was in <dataDir>/meaning/: it moves, and it is still off.
  const older = scratch('meaning-data-');
  mkdirSync(meaningDir(older), {recursive: true});
  writeFileSync(join(meaningDir(older), 'off'), 'off\n');
  const moved = pairs({dataDir: older, embedding});
  assert.equal(moved.state, 'off');
  assert.ok(existsSync(offNote(older)) && !existsSync(join(meaningDir(older), 'off')));
  await moved.close();
});

test('an "embedding" model at a /v1/embeddings: on at once, its prompts, its key read as a model\'s, vectors made unit length, and its failure said', async () => {
  const server = await fakeEmbeddingServer();
  const root = project();
  const dataDir = scratch('meaning-data-');
  process.env.PAIR_TEST_EMBED_KEY = 'test-key';
  const entry = {api: 'openai', baseUrl: server.baseUrl, model: 'nomic-embed-code', apiKeyEnv: 'PAIR_TEST_EMBED_KEY'};
  const meaning = pairs({dataDir, embedding: entry});
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
  } finally {
    delete process.env.PAIR_TEST_EMBED_KEY;
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

  const meaning = pairs({dataDir}, {embedder: fakeEmbedder(), fetch: async () => new Response(body)});
  await assert.rejects(meaning.turnOn(), /not the pinned/);
  assert.equal(meaning.state, 'off');
  await meaning.close();
  let open;
  const gated = pairs({dataDir}, {embedder: fakeEmbedder(), fetch: (url, {signal}) => new Promise((resolve, reject) => {
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
  const disabled = pairs({dataDir, meaning: false}, {embedder: fakeEmbedder()});
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
  assert.equal(off.text, 'words only: :Pair find on installs LiteRT-LM and downloads EmbeddingGemma 2 (text, 270M) (165 MB), once, for meaning, or set an "embedding" model');
  const ready = await meaningCheck(config, null, {runtime: there});
  assert.match(ready.text, /^words only: :Pair find on downloads EmbeddingGemma 2 \(text, 270M\) \(165 MB, once\) for meaning, or set an "embedding" model; LiteRT-LM 0\.19\.0 in python3 is ready$/);
  const own = await meaningCheck({dataDir, meaning: {python: '/opt/py/bin/python'}}, null, {runtime: async () => ({problem: '/opt/py/bin/python has no litert-lm-api'})});
  assert.match(own.text, /; \/opt\/py\/bin\/python has no litert-lm-api: \/opt\/py\/bin\/python -m pip install litert-lm-api==0\.19\.0, or leave meaning\.python out and :Pair find on installs it$/, 'the config\'s own Python is the user\'s to fill');
  const installing = await meaningCheck(config, {meaning: {state: 'installing', installing: 12 << 20, indexes: []}}, {runtime: none});
  assert.equal(installing.text, 'words only while :Pair find on installs LiteRT-LM (12 MiB so far)');
  fakeModel(dataDir);
  const broken = await meaningCheck(config, null, {runtime: none});
  assert.equal(broken.level, 'fail');
  assert.match(broken.text, /is downloaded, but python3 has no litert-lm-api: (:Pair find on installs it \(\d+ MB, in a venv in Pair's data folder\)|LiteRT-LM has no wheel for .*)$/);
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
