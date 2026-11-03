// Search by meaning's own model, when the config has no "embedding" one (that is semantic-grep's HttpEmbedder; see
// search.mjs): EmbeddingGemma 2 (text, 270M, Apache-2.0) on LiteRT-LM, the runtime and file lfm-pixel
// measured (LFMP-10). The model is downloaded once, at a pinned revision, and kept only if its SHA-256 matches; nothing
// else reaches the network. LiteRT-LM runs it natively in a small Python helper (src/embed-helper.py) that the daemon
// starts on first use, at low priority, and stops once it has been idle a while; the helper needs `litert-lm-api` in
// the Python that runs it, which `:Pair find on` installs in a venv of Pair's (runtime.mjs). Each text becomes 256 numbers of unit
// length, so similarity is a dot product.
import {spawn, execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createWriteStream, existsSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {mkdir, rename, rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';
import {documentText, queryText} from 'semantic-grep';
import {readMessages} from './protocol.mjs';

export const MODEL = {
  name: 'EmbeddingGemma 2 (text, 270M)',
  repo: 'litert-community/embeddinggemma-2-text-270m-litert-lm',
  revision: '9be6e8b90982095dc05c2bd162e4b954ee4dbac7',
  file: 'embeddinggemma-2-text-270m.litertlm',
  bytes: 164_626_432,
  sha256: '2d079ee2f6f066b1f368e8d7c819f55214eaef1d0513b312321901f30ab286fb',
};
export const RUNTIME = 'litert-lm-api==0.19.0'; // the pip package the helper imports as litert_lm
export const DIMENSIONS = 256;
export const MAX_TOKENS = 512; // a chunk past this is cut; chunks are sized to stay under it (semantic-grep's pieces)
export const THREADS = 2; // background work: two cores, at nice 10
const HELPER = fileURLToPath(new URL('./embed-helper.py', import.meta.url));
const IDLE_MS = 3 * 60_000; // the helper holds ~320 MB; it goes once nothing was embedded for this long
const START_MS = 60_000;
const BATCH_MS = 120_000; // one batch is a few texts; past this the helper is stuck
const STALL_MS = 60_000; // a download that gets no bytes for this long is given up

// The prompts EmbeddingGemma was trained with, a chunk of the project and a search for one, are semantic-grep's.
export {documentText, queryText} from 'semantic-grep';

const expand = path => path.replace(/^~(?=\/|$)/, homedir());
export const modelUrl = (model = MODEL) => `https://huggingface.co/${model.repo}/resolve/${model.revision}/${model.file}`;

/** Where Pair keeps search by meaning's model, indexes and the helper's Python (runtime.mjs). */
export const meaningDir = dataDir => join(dataDir, 'meaning');
export const modelPath = dataDir => join(meaningDir(dataDir), MODEL.file);
const checkedPath = path => `${path}.sha256`;

/**
 * Whether the model is in `dataDir` as downloaded and checked: its checksum was taken when it came, and kept next to
 * it with the file's size and time, so a start does not read 165 MB again; a file changed since is not trusted.
 */
export const modelReady = dataDir => fileReady(modelPath(dataDir), MODEL);

/** Whether `path` is `model`'s file as downloaded and checked by downloadModel (see modelReady). */
export function fileReady(path, model) {
  try {
    const stat = statSync(path);
    const checked = JSON.parse(readFileSync(checkedPath(path), 'utf8'));
    return checked.sha256 === model.sha256 && checked.size === stat.size && checked.mtimeMs === stat.mtimeMs;
  } catch {
    return false;
  }
}

/**
 * Downloads `url` to `path`, once: written to a .part file while its SHA-256 is taken, and moved into place only if it
 * is `sha256`. `progress(bytes)` hears how far it got; `signal` stops it; `what` names it in what goes wrong.
 */
export async function downloadFile(url, path, {sha256: pinned, what, fetch = globalThis.fetch, progress = () => {}, stallMs = STALL_MS, signal = null}) {
  const part = `${path}.part`;
  const abort = new AbortController();
  if (signal?.aborted) throw signal.reason;
  signal?.addEventListener('abort', () => abort.abort(signal.reason), {once: true}); // turned off meanwhile
  let stall;
  const waiting = () => {
    clearTimeout(stall);
    stall = setTimeout(() => abort.abort(new Error(`the download got nothing for ${stallMs / 1000} s`)), stallMs);
  };
  waiting();
  const host = new URL(url).host;
  const response = await fetch(url, {redirect: 'follow', signal: abort.signal}).catch(error => {
    clearTimeout(stall);
    if (abort.signal.aborted) throw abort.signal.reason;
    throw new Error(`${host} could not be reached for ${what} (${error.cause?.code ?? error.message}): check the network, or its proxy`);
  });
  if (!response.ok || !response.body) {
    clearTimeout(stall);
    throw new Error(`${host} answered ${response.status} for ${what}`);
  }
  const hash = createHash('sha256');
  let bytes = 0;
  const body = Readable.fromWeb(response.body);
  body.on('data', chunk => {
    waiting();
    hash.update(chunk);
    bytes += chunk.length;
    progress(bytes);
  });
  try {
    await pipeline(body, createWriteStream(part, {mode: 0o600}));
    const sha256 = hash.digest('hex');
    if (sha256 !== pinned) throw new Error(`the download's SHA-256 is ${sha256}, not the pinned ${pinned}: not kept`);
    await rename(part, path);
  } catch (error) {
    await rm(part, {force: true});
    throw abort.signal.aborted ? abort.signal.reason : error;
  } finally {
    clearTimeout(stall);
  }
}

/**
 * Downloads the model into `dataDir`, once: the pinned revision from Hugging Face, kept only if its SHA-256 matches
 * (downloadFile). `progress(bytes)` hears how far it got; `signal` stops it. Another pinned file (`model`: {repo,
 * revision, file, sha256}) goes to `path`, as voice's LFM3-Omni does (omni.mjs).
 */
export async function downloadModel(dataDir, {fetch = globalThis.fetch, progress = () => {}, model = MODEL, path = modelPath(dataDir), stallMs = STALL_MS, signal = null} = {}) {
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  await downloadFile(modelUrl(model), path, {sha256: model.sha256, what: model.file, fetch, progress, stallMs, signal});
  const stat = statSync(path);
  writeFileSync(checkedPath(path), JSON.stringify({sha256: model.sha256, size: stat.size, mtimeMs: stat.mtimeMs, revision: model.revision}), {mode: 0o600});
}

/** Takes the model out of `dataDir`, with its checksum: search by meaning is off again until the next download. */
export async function removeModel(dataDir) {
  await rm(modelPath(dataDir), {force: true});
  await rm(checkedPath(modelPath(dataDir)), {force: true});
  await rm(`${modelPath(dataDir)}.part`, {force: true});
}

/**
 * The Python that runs the helper: the config's `meaning.python`, else the venv at <dataDir>/meaning/venv (that
 * `:Pair find on` makes, or the user did), else python3 on PATH.
 */
export function pythonOf(meaning, dataDir) {
  if (meaning?.python) return expand(meaning.python);
  const venv = join(meaningDir(dataDir), 'venv', 'bin', 'python');
  return existsSync(venv) ? venv : 'python3';
}

/** Which litert-lm-api `python` has, or why it has none: {version} or {problem}. */
export function runtimeOf(python) {
  const probe = 'import importlib.metadata as m, litert_lm; print(m.version("litert-lm-api"))';
  return new Promise(resolve => execFile(python, ['-I', '-c', probe], {timeout: 20_000}, (error, stdout, stderr) => {
    if (!error) return resolve({version: stdout.trim()});
    if (error.code === 'ENOENT') return resolve({problem: `${python} is not there`});
    resolve({problem: /No module named/.test(stderr) ? `${python} has no ${RUNTIME.split('==')[0]}` : (stderr.trim().split('\n').at(-1) || error.message)});
  }));
}

/** 256 little-endian float32 numbers, as the helper sends them. */
const vectorOf = text => {
  const bytes = Buffer.from(text, 'base64');
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4).slice();
};

/**
 * The helper, started when the first text needs embedding. One batch at a time; a search goes before the index's
 * batches still waiting, so it waits at most for the one under way. `embed(texts, {urgent})` resolves with a
 * Float32Array per text; a helper that cannot start rejects every waiting batch with why.
 */
export class Embedder {
  /** `python` is a path, or a function that finds one each time the helper starts. */
  constructor({python, model, threads = THREADS, maxTokens = MAX_TOKENS, idleMs = IDLE_MS, log = () => {}, helper = HELPER}) {
    Object.assign(this, {python, model, threads, maxTokens, idleMs, log, helper});
    this.child = null;
    this.queue = []; // batches not yet sent: {texts, resolve, reject}
    this.running = null; // the batch the helper works on
    this.nextId = 0;
    this.idleTimer = null;
    this.runtime = null; // what the helper said when it was ready: {runtime, loadMs}
    this.embedded = 0; // texts embedded since the daemon started, and how long they took, for `pair doctor`
    this.embedMs = 0;
  }

  embed(texts, {urgent = false} = {}) {
    if (!texts.length) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      const batch = {texts, resolve, reject};
      if (urgent) this.queue.unshift(batch);
      else this.queue.push(batch);
      this.next();
    });
  }

  /** Waiting batches, to know whether the index is still at work. */
  get busy() { return !!this.running || this.queue.length > 0; }

  next() {
    if (this.running || !this.queue.length) return;
    clearTimeout(this.idleTimer);
    if (!this.child) return this.start();
    if (!this.runtime) return; // still loading: ready sends the first batch
    const batch = this.queue.shift();
    this.running = {...batch, id: ++this.nextId, started: Date.now()};
    this.running.timer = setTimeout(() => this.fail(new Error(`the embedder took over ${BATCH_MS / 1000} s for one batch`)), BATCH_MS);
    this.child.stdin.write(`${JSON.stringify({id: this.running.id, texts: batch.texts})}\n`);
  }

  start() {
    const python = typeof this.python === 'function' ? this.python() : this.python;
    const child = spawn(python, ['-I', this.helper, this.model, String(this.threads), String(this.maxTokens)], {stdio: ['pipe', 'pipe', 'pipe']});
    this.child = child;
    let stderr = '';
    const startTimer = setTimeout(() => this.fail(new Error('the embedder did not load its model within a minute')), START_MS);
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.stdin.on('error', () => {});
    child.on('error', error => {
      clearTimeout(startTimer);
      this.fail(new Error(error.code === 'ENOENT' ? `${python} is not there` : error.message));
    });
    child.on('exit', code => {
      clearTimeout(startTimer);
      if (this.child !== child) return;
      const why = stderr.trim().split('\n').at(-1);
      this.fail(new Error(`the embedder stopped (exit ${code})${why ? `: ${why}` : ''}`));
    });
    readMessages(child.stdout, message => {
      if (this.child !== child) return;
      if (message.fatal) {
        clearTimeout(startTimer);
        return this.fail(new Error(/No module named 'litert_lm'/.test(message.fatal) ? `${python} has no ${RUNTIME.split('==')[0]}` : message.fatal));
      }
      if (message.ready) {
        clearTimeout(startTimer);
        this.runtime = {runtime: message.runtime, loadMs: message.loadMs};
        this.log(`embedder ready: LiteRT-LM ${message.runtime}, model loaded in ${message.loadMs} ms`);
        return this.next();
      }
      const batch = this.running;
      if (!batch || message.id !== batch.id) return;
      clearTimeout(batch.timer);
      this.running = null;
      if (message.error) batch.reject(new Error(message.error));
      else {
        this.embedded += batch.texts.length;
        this.embedMs += Date.now() - batch.started;
        batch.resolve(message.vectors.map(vectorOf));
      }
      this.idle();
      this.next();
    });
  }

  /** Once nothing waits, the helper goes after `idleMs`: its memory is back until the next search or save. */
  idle() {
    clearTimeout(this.idleTimer);
    if (this.busy) return;
    this.idleTimer = setTimeout(() => this.stopHelper(), this.idleMs);
    this.idleTimer.unref?.();
  }

  /** The helper went or could not start: every batch waiting hears why, and the next one starts it again. */
  fail(error) {
    const batches = [...(this.running ? [this.running] : []), ...this.queue];
    if (this.running) clearTimeout(this.running.timer);
    this.running = null;
    this.queue = [];
    this.stopHelper();
    this.log(`embedder: ${error.message}`);
    for (const batch of batches) batch.reject(error);
  }

  stopHelper() {
    clearTimeout(this.idleTimer);
    const {child} = this;
    this.child = null;
    this.runtime = null;
    if (child && child.exitCode === null) {
      child.stdin.end();
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2000).unref();
    }
  }

  /** Average milliseconds a text took, or null before the first. */
  get msPerText() { return this.embedded ? this.embedMs / this.embedded : null; }

  /** Whether a search gets its vector now, without waiting for the model to load: the search trail asks only then. */
  get ready() { return !!this.runtime; }

  /** The model's name in the index, so vectors of another model or revision are never compared with its own. */
  get id() { return `embeddinggemma-2@${MODEL.revision.slice(0, 8)}/${DIMENSIONS}`; }

  document(file, text) { return documentText(file, text); }

  query(text) { return queryText(text); }

  close() {
    this.fail(new Error('the daemon stops'));
  }
}
