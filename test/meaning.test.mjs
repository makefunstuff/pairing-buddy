// Search by meaning: the chunks, the words, the fusion, which files go in (what .gitignore leaves out does not), the
// index built in the background and kept in Pair's data folder, a save embedding only what changed, the hybrid
// search, the ledger, the one model download and its checksum, the embedder's helper, the trail's "by meaning" lines,
// the config and `pair doctor`. A fake embedder stands in for EmbeddingGemma 2 (see fake-embedder.mjs).
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {test} from 'node:test';
import {parseConfig} from '../src/config.mjs';
import {meaningCheck} from '../src/doctor.mjs';
import {downloadModel, Embedder, MODEL, modelPath, modelReady} from '../src/embedder.mjs';
import {CHUNK, chunkText, fuse, indexable, indexPath, Meaning, ProjectIndex, projectFiles, words} from '../src/meaning.mjs';
import {trailMatches} from '../src/trail.mjs';
import {fakeEmbedder, fakeModel} from './fake-embedder.mjs';
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

test('a file is cut into chunks of at most so many lines and characters, at a blank line where it can', () => {
  const lines = Array.from({length: 130}, (_, i) => (i % 20 === 19 ? '' : `line ${i + 1}`));
  const chunks = chunkText(lines.join('\n'));
  assert.ok(chunks.every(chunk => chunk.to - chunk.from + 1 <= CHUNK.lines && chunk.text.length <= CHUNK.chars));
  assert.equal(chunks[0].from, 1);
  assert.equal(chunks[0].to, 60, 'the blank line 60 ends the first chunk');
  assert.ok(chunks.slice(1).every((chunk, i) => chunk.from === chunks[i].to + 1), 'no line left out or counted twice');
  const long = chunkText(`${'x'.repeat(CHUNK.chars * 2)}\nshort`);
  assert.deepEqual(long.map(chunk => [chunk.from, chunk.to, chunk.text.length]), [[1, 1, CHUNK.chars], [2, 2, 5]], 'a line longer than a chunk is cut');
  assert.deepEqual(chunkText('\n\n\n'), [], 'blank text has no chunks');
});

test('the words of code: lower case, with identifiers split as well', () => {
  assert.deepEqual(words('retryCount = max_tries; HTTPServer'), ['retrycount', 'retry', 'count', 'max_tries', 'max', 'tries', 'httpserver', 'http', 'server']);
});

test('rankings fuse by reciprocal rank: what both rank high goes first', () => {
  assert.deepEqual(fuse([['a', 'b', 'c'], ['b', 'c']]), ['b', 'c', 'a']);
  assert.deepEqual(fuse([[], ['x']]), ['x']);
});

test('the files indexed are git\'s, without what .gitignore leaves out, pictures or lockfiles', async () => {
  const root = project();
  assert.deepEqual(await projectFiles(root), ['.gitignore', 'NOTES.md', 'src/cart.js', 'src/deliver.js']);
  assert.ok(!indexable('assets/logo.png') && !indexable('web/app.min.js') && !indexable('Cargo.lock') && indexable('src/main.rs'));
});

test('the index finds code worded unlike the search, keeps its vectors in the data folder and embeds a changed chunk only', async () => {
  const root = project();
  const dataDir = scratch('meaning-data-');
  const embedder = fakeEmbedder();
  const index = new ProjectIndex({root, path: indexPath(dataDir, root), embed: (texts, options) => embedder.embed(texts, options)});
  await index.load();
  await index.scan();
  assert.equal(index.pending().length, 4);
  while (await index.step());
  await index.save();
  assert.ok(existsSync(indexPath(dataDir, root)) && !readdirSync(root).some(name => name.includes('idx')), 'the index lives in Pair\'s data folder, not in the project');

  const [first] = await index.search('try again when sending fails');
  assert.equal(first.file, 'src/deliver.js', 'no word of the search is in the code, but its meaning is');
  assert.equal(first.from, 1);
  assert.equal(first.head, 'export function deliver(job) {');
  assert.equal(first.keyword, false);
  assert.ok(first.meaning > 0.4);
  assert.equal(embedder.calls.at(-1).urgent, true, 'a search goes before the index\'s batches');
  const [byWord] = await index.search('quantity');
  assert.equal(byWord.file, 'src/cart.js', 'a word only the code has ranks it too');
  assert.equal(byWord.keyword, true);
  assert.deepEqual(index.keywordRanking('quant item').map(chunk => chunk.file), ['src/cart.js'], 'each word as the start of one of the code\'s');
  assert.deepEqual(index.keywordRanking('quantity tries'), [], 'every word, or none: the meaning ranks a question in other words');
  assert.deepEqual(index.keywordRanking('how is it'), [], 'the small words of a question are no keywords');

  const again = new ProjectIndex({root, path: indexPath(dataDir, root), embed: (texts, options) => embedder.embed(texts, options)});
  await again.load();
  await again.scan();
  assert.equal(again.pending().length, 0, 'a restart embeds nothing again');
  writeFileSync(join(root, 'src', 'cart.js'), `${PRICES}\nexport const free = cart => total(cart) === 0;\n`);
  writeFileSync(join(root, 'src', 'ignored.tmp'), 'x');
  await again.saved(join(root, 'src', 'cart.js'));
  assert.equal(again.pending().length, 1, 'only the changed file\'s chunk waits');
  await again.saved(join(root, 'secret.txt'));
  assert.ok(!again.files.has('secret.txt'), 'a file git ignores is not indexed when saved');
});

test('Meaning: off without its model; on, it builds in the background, searches, and books both in the ledger', async () => {
  const root = project();
  const dataDir = scratch('meaning-data-');
  const booked = [];
  const embedder = fakeEmbedder();
  const meaning = new Meaning({dataDir, embedder, book: (where, kind, text, options) => booked.push({where, kind, text, options})});
  try {
    assert.equal(meaning.state, 'off');
    meaning.open(root);
    assert.equal(meaning.indexes.size, 0, 'nothing is indexed while it is off');
    assert.equal((await meaning.search(root, 'retry')).state, 'off');

    for (let i = 0; i < 10; i++) writeFileSync(join(root, `note${i}.md`), `Note ${i} about the release.\n`);
    fakeModel(dataDir);
    assert.equal(meaning.state, 'on');
    meaning.open(root);
    await until(() => booked.some(entry => entry.kind === 'indexed'), 'the build\'s ledger line');
    assert.equal(booked[0].where, root);
    assert.match(booked[0].text, /^indexed 14 chunks by meaning in \d+ s: 14 files, 14 chunks, \d+ KB$/);
    assert.ok(embedder.calls.every(call => !call.urgent), 'the build\'s batches are not urgent');

    const answer = await meaning.search(root, 'what does the cart cost');
    assert.equal(answer.state, 'on');
    assert.deepEqual(answer.results.slice(0, 2).map(result => result.file).sort(), ['NOTES.md', 'src/cart.js'], 'the code and the note about prices');
    assert.deepEqual([answer.chunks, answer.embedded], [14, 14]);
    const searched = booked.find(entry => entry.kind === 'searched');
    assert.match(searched.text, /^by meaning "what does the cart cost": \d+ results?, first (src\/cart\.js|NOTES\.md):1$/);
    assert.match(searched.options.detail.output, /src\/cart\.js:1-4 /);

    embedder.failWith = 'python3 has no litert-lm-api';
    const fallback = await meaning.search(root, 'quantity');
    assert.equal(fallback.problem, 'python3 has no litert-lm-api', 'the picker says why meaning is missing');
    assert.equal(fallback.results[0].file, 'src/cart.js', 'and the words still rank');
    assert.equal(await meaning.trailHits(root, 'retry'), null, 'the trail leaves meaning out while the embedder fails');

    assert.equal(meaning.snapshot().indexes[0].chunks, 14);
    writeFileSync(join(root, 'src', 'cart.js'), `${PRICES}// changed\n`);
    embedder.failWith = null;
    await meaning.search(root, 'cart'); // the embedder answers again: the problem is gone
    assert.equal(meaning.problem, null);
    const lines = booked.length;
    const index = meaning.indexes.get(root);
    let writes = 0;
    const write = index.write.bind(index);
    index.write = () => { writes += 1; return write(); };
    await meaning.saved(root, join(root, 'src', 'cart.js'));
    await until(() => !meaning.working && meaning.indexes.get(root).pending().length === 0, 'the saved chunk embedded');
    assert.equal(booked.slice(lines).filter(entry => entry.kind === 'indexed').length, 0, 'a save\'s one chunk gets no ledger line of its own');
    assert.equal(writes, 0, 'nor a rewrite of the whole index');
    await meaning.rescan();
    assert.equal(writes, 1, 'the next rescan writes it down');
    assert.equal(await meaning.turnOn(), false, 'on again downloads nothing');
    await meaning.turnOff();
    assert.equal(meaning.state, 'off');
    assert.ok(!existsSync(modelPath(dataDir)) && !existsSync(indexPath(dataDir, root)), 'off deletes the model and the indexes');
  } finally {
    await meaning.close();
  }
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
  } finally {
    await meaning.close();
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

test('config: meaning is false, or its python and threads', () => {
  const models = {model: {api: 'openai', baseUrl: 'http://x', model: 'm'}};
  assert.deepEqual(parseConfig(models).meaning, {});
  assert.equal(parseConfig({...models, meaning: false}).meaning, false);
  assert.deepEqual(parseConfig({...models, meaning: {python: '~/venv/bin/python', threads: 4}}).meaning, {python: '~/venv/bin/python', threads: 4});
  assert.throws(() => parseConfig({...models, meaning: {thread: 4}}), /meaning has no thread/);
  assert.throws(() => parseConfig({...models, meaning: {threads: 0}}), /whole number above 0/);
});

test('pair doctor: off says what turning it on takes; on, the runtime must be there, and the indexes show', async () => {
  const dataDir = scratch('meaning-data-');
  const config = {dataDir, meaning: {}};
  const none = async () => ({problem: 'python3 has no litert-lm-api'});
  const there = async () => ({version: '0.19.0'});
  assert.equal((await meaningCheck({dataDir, meaning: false}, null, {runtime: there})).text, 'search by meaning is off in the config ("meaning": false)');
  const off = await meaningCheck(config, null, {runtime: none});
  assert.equal(off.level, 'ok');
  assert.match(off.text, /off: :Pair find on downloads EmbeddingGemma 2 \(text, 270M\) \(165 MB, once\); it also needs LiteRT-LM: python3 -m venv .*meaning\/venv && .*pip install litert-lm-api==0\.19\.0/);
  fakeModel(dataDir);
  const broken = await meaningCheck(config, null, {runtime: none});
  assert.equal(broken.level, 'fail');
  assert.match(broken.text, /is downloaded, but python3 has no litert-lm-api/);
  const status = {meaning: {problem: null, msPerChunk: 140.4, indexes: [{root: '/src/shop', files: 12, chunks: 40, embedded: 30, bytes: 1 << 20}]}};
  const on = await meaningCheck(config, status, {runtime: there});
  assert.equal(on.level, 'ok');
  assert.match(on.text, /revision 9be6e8b, SHA-256 checked\) on LiteRT-LM 0\.19\.0 in python3; shop: 12 files, 40 chunks \(75% built\), 1\.0 MB, 140 ms a chunk$/);
});
