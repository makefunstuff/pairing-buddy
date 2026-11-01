// Search by meaning: a local index of each project Pair has a session in, and a search that ranks its chunks of code
// by what the words mean and by the words themselves, fused as lfm-pixel does (reciprocal rank). The index holds the
// files git lists (tracked and untracked, without what .gitignore leaves out), cut into chunks of a few dozen lines,
// each with 256 numbers from the embedder (see embedder.mjs); it lives in Pair's data folder, never in the project.
// A chunk is embedded again only when its text changed: a save re-reads that file, and the project is looked over
// again when its session loads and every few minutes, for changes made outside Neovim. Builds and searches go to the
// ledger.
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {statSync} from 'node:fs';
import {mkdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {isAbsolute, join, relative} from 'node:path';
import {
  DIMENSIONS, documentText, downloadModel, Embedder, meaningDir, MODEL, modelPath, modelReady, pythonOf, queryText, removeModel,
} from './embedder.mjs';

export const CHUNK = {lines: 60, chars: 1500}; // about 400 tokens at most: under the embedder's 512
const MAX_FILE_BYTES = 512 * 1024;
const MAX_LINE_AVERAGE = 300; // minified or generated: no lines worth reading
const BATCH = 4; // chunks per embedder call: a search waits for at most one batch
export const MAX_CHUNKS = 20_000; // per project, about 45 min of a first build on two cores; files past it are left out
const BOOKED_CHUNKS = 10; // a build this big gets its own ledger line; a save's few chunks do not
const SAVE_MS = 30_000; // a build in progress is written down this often, so a restart keeps most of it
export const RESCAN_MS = 10 * 60_000;
const HEAD_CHARS = 100;
const RRF_K = 60;
const LIST = 50; // of each ranking, how many go into the fusion
const MEANING_BAND = 0.1; // meaning hits further than this below the best are left out: unrelated code scores close, too
const MAGIC = 'PAIRMI1\n';
// Words of a question that say nothing about where to look: left out of the keyword ranking, not the meaning's.
const STOPWORDS = new Set('a an and are as at be but by can do does for from has have how i if in into is it its me my not of on or our so that the their them then there these this to was we were what when where which who why will with you your'.split(' '));

// Files whose text is no code or prose to search: pictures, sound, archives, fonts, lockfiles, source maps.
const SKIP = /\.(png|jpe?g|gif|webp|bmp|ico|icns|svg|pdf|mp3|mp4|m4a|wav|ogg|flac|webm|mov|avi|zip|gz|tgz|bz2|xz|zst|7z|rar|jar|war|class|o|a|so|dylib|dll|exe|bin|wasm|woff2?|ttf|otf|eot|sqlite3?|db|pyc|map|litertlm|gguf|onnx|safetensors|pt|npy|npz)$/i;
const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'Cargo.lock', 'go.sum', 'poetry.lock', 'uv.lock', 'Gemfile.lock', 'composer.lock', 'flake.lock']);

const run = (command, args, cwd) => new Promise(resolve => {
  execFile(command, args, {cwd, maxBuffer: 64 << 20}, (error, stdout) => resolve(error ? null : stdout));
});

/** Whether the file at `path` (relative to the project) is one to index, by its name alone. */
export function indexable(path) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return !SKIP.test(name) && !LOCKFILES.has(name) && !/\.min\.(js|css)$/.test(name);
}

/** The project's files to index, relative to `root`: git's list without what it ignores, else ripgrep's, else none. */
export async function projectFiles(root) {
  const git = await run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], root);
  // Without git, ripgrep keeps to .gitignore only when told to.
  const listed = git !== null ? git.split('\0') : (await run('rg', ['--files', '--null', '--no-require-git'], root))?.split('\0') ?? [];
  return [...new Set(listed.filter(Boolean))].filter(indexable).sort();
}

/**
 * Cuts `text` into chunks of at most CHUNK.lines lines and CHUNK.chars characters: `{from, to, text}`, lines counted
 * from 1. A chunk ends at a blank line when one is in its second half, so a function stays whole where it can; a
 * line longer than a chunk is cut. Blank chunks are left out.
 */
export function chunkText(text) {
  const lines = text.split('\n');
  const chunks = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let chars = 0;
    while (end < lines.length && end - start < CHUNK.lines && chars + lines[end].length + 1 <= CHUNK.chars) chars += lines[end++].length + 1;
    if (end === start) end = start + 1; // one line longer than a chunk: cut below
    else if (end < lines.length) {
      for (let i = end - 1; i > start + (end - start) / 2; i--) {
        if (!lines[i].trim()) { end = i + 1; break; }
      }
    }
    const body = lines.slice(start, end).join('\n').slice(0, CHUNK.chars);
    if (body.trim()) chunks.push({from: start + 1, to: end, text: body});
    start = end;
  }
  return chunks;
}

const hashOf = text => createHash('sha1').update(text).digest('hex');

/** The words of `text` for keyword search: lower case, with identifiers split too (retryCount, retry_count: retry, count). */
export function words(text) {
  const found = [];
  for (const token of text.match(/[\p{L}\p{N}_]+/gu) ?? []) {
    const lower = token.toLowerCase();
    if (lower.length > 1) found.push(lower);
    const parts = token.split(/_+|(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u).filter(part => part.length > 1);
    if (parts.length > 1) for (const part of parts) found.push(part.toLowerCase());
  }
  return found;
}

/** The first line of `text` that has something on it, as the picker shows it. */
const headOf = text => {
  const line = text.split('\n').find(candidate => candidate.trim()) ?? '';
  return line.trim().slice(0, HEAD_CHARS);
};

/** Reciprocal rank fusion of ranked lists of keys: each key scores 1/(k + rank) in every list it is in. */
export function fuse(lists, k = RRF_K) {
  const scores = new Map();
  for (const list of lists) list.forEach((key, rank) => scores.set(key, (scores.get(key) ?? 0) + 1 / (k + rank + 1)));
  return [...scores].sort((a, b) => b[1] - a[1]).map(([key]) => key);
}

const dot = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
};

/**
 * One project's index: its chunks (`{file, from, to, hash, head, words}`), their vectors by hash, and the chunks still
 * waiting for theirs. `embed(texts, {urgent})` is the embedder's.
 */
export class ProjectIndex {
  constructor({root, path, embed, log = () => {}, now = Date.now}) {
    Object.assign(this, {root, path, embed, log, now});
    this.files = new Map(); // relative path -> {size, mtimeMs, chunks}
    this.vectors = new Map(); // chunk hash -> Float32Array
    this.loaded = false;
    this.scannedAt = 0;
    this.dirty = false; // vectors not yet written down
    this.savedAt = 0;
    this.skipped = new Map(); // files read and found not worth indexing (binary, minified): path -> {size, mtimeMs}
    this.waiting = null; // the chunks still without a vector, worked through by step(); null once the files change
    this.saving = Promise.resolve(); // one write of the index file at a time
    this.capped = false; // the project has more chunks than MAX_CHUNKS: some files are left out
  }

  /** The vectors written down before, if any were made by this model; a file another model wrote is left to be made again. */
  async load() {
    if (this.loaded) return;
    this.loaded = true;
    let bytes;
    try { bytes = await readFile(this.path); } catch { return; }
    try {
      if (bytes.subarray(0, MAGIC.length).toString() !== MAGIC) throw new Error('not an index');
      const length = bytes.readUInt32LE(MAGIC.length);
      const start = MAGIC.length + 4;
      const header = JSON.parse(bytes.subarray(start, start + length).toString());
      if (header.model !== MODEL.revision || header.dimensions !== DIMENSIONS) return;
      const base = start + length;
      const all = new Float32Array(bytes.buffer.slice(bytes.byteOffset + base, bytes.byteOffset + base + header.hashes.length * DIMENSIONS * 4));
      header.hashes.forEach((hash, i) => this.vectors.set(hash, all.subarray(i * DIMENSIONS, (i + 1) * DIMENSIONS)));
    } catch (error) {
      this.log(`meaning: ${this.path} could not be read (${error.message}); it is made again`);
    }
  }

  /** Writes the vectors of the project's chunks down, in one go: a crash leaves the last whole file. One at a time. */
  save() {
    this.saving = this.saving.catch(() => {}).then(() => this.write());
    return this.saving;
  }

  async write() {
    const hashes = [...new Set([...this.files.values()].flatMap(file => file.chunks.map(chunk => chunk.hash)))].filter(hash => this.vectors.has(hash));
    const header = Buffer.from(JSON.stringify({model: MODEL.revision, dimensions: DIMENSIONS, root: this.root, hashes, savedAt: this.now()}));
    const vectors = new Float32Array(hashes.length * DIMENSIONS);
    hashes.forEach((hash, i) => vectors.set(this.vectors.get(hash), i * DIMENSIONS));
    const length = Buffer.alloc(4);
    length.writeUInt32LE(header.length);
    await mkdir(join(this.path, '..'), {recursive: true, mode: 0o700});
    const part = `${this.path}.part`;
    await writeFile(part, Buffer.concat([Buffer.from(MAGIC), length, header, Buffer.from(vectors.buffer)]), {mode: 0o600});
    await rename(part, this.path);
    this.dirty = false;
    this.savedAt = this.now();
  }

  /** Reads `file` (relative) again if it changed: its chunks, by their text's hash. Gone or not to index, it leaves. */
  async read(file) {
    const path = join(this.root, file);
    let info;
    try { info = await stat(path); } catch { return this.files.delete(file); }
    const known = this.files.get(file);
    if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) return;
    const skipped = this.skipped.get(file);
    if (!known && skipped && skipped.size === info.size && skipped.mtimeMs === info.mtimeMs) return;
    this.waiting = null;
    if (!info.isFile() || info.size > MAX_FILE_BYTES || !indexable(file)) return this.files.delete(file);
    let text;
    try { text = await readFile(path, 'utf8'); } catch { return this.files.delete(file); }
    const lines = text.split('\n').length;
    if (text.slice(0, 8192).includes('\0') || text.length / lines > MAX_LINE_AVERAGE) {
      this.skipped.set(file, {size: info.size, mtimeMs: info.mtimeMs});
      return this.files.delete(file);
    }
    const chunks = chunkText(text).map(chunk => {
      const document = documentText(file, chunk.text);
      const hash = hashOf(document);
      // A chunk's text is kept only until it has its vector; the keywords need its words alone.
      return {file, from: chunk.from, to: chunk.to, hash, document: this.vectors.has(hash) ? null : document, head: headOf(chunk.text), words: words(`${file} ${chunk.text}`)};
    });
    this.files.set(file, {size: info.size, mtimeMs: info.mtimeMs, chunks});
  }

  /** Looks the whole project over: files new, changed and gone. */
  async scan() {
    const listed = await projectFiles(this.root);
    const keep = new Set(listed);
    for (const file of this.files.keys()) if (!keep.has(file)) this.files.delete(file);
    let count = 0;
    this.capped = false;
    for (const file of listed) {
      if (count >= MAX_CHUNKS && !this.files.has(file)) { this.capped = true; continue; }
      await this.read(file);
      count += this.files.get(file)?.chunks.length ?? 0;
    }
    this.waiting = null;
    this.scannedAt = this.now();
    this.keywords = null;
  }

  /** A file saved in Neovim, by its path (relative to the project, or absolute). Outside it, or ignored, it changes nothing. */
  async saved(path) {
    const file = isAbsolute(path) ? relative(this.root, path) : path;
    if (file.startsWith('..') || !this.files.has(file) && !(await projectFiles(this.root)).includes(file)) return;
    await this.read(file);
    this.keywords = null;
  }

  get chunks() { return [...this.files.values()].flatMap(file => file.chunks); }

  /** The chunks still without a vector, oldest file first. */
  pending() { return this.chunks.filter(chunk => !this.vectors.has(chunk.hash)); }

  /** How far the index is: files, chunks, how many have vectors, the bytes on disk. */
  progress() {
    const chunks = this.chunks;
    const hashes = new Set(chunks.map(chunk => chunk.hash));
    const done = [...hashes].filter(hash => this.vectors.has(hash)).length;
    let bytes = 0;
    try { bytes = statSync(this.path).size; } catch {}
    return {root: this.root, files: this.files.size, chunks: hashes.size, embedded: done, bytes, capped: this.capped};
  }

  /** Embeds the next few chunks waiting; false when none waits. The list of those is made once per change of the files. */
  async step() {
    this.waiting ??= this.pending();
    const batch = [];
    const seen = new Set();
    while (this.waiting.length && batch.length < BATCH) {
      const chunk = this.waiting.shift();
      if (seen.has(chunk.hash) || this.vectors.has(chunk.hash)) continue;
      seen.add(chunk.hash);
      batch.push(chunk);
    }
    if (!batch.length) return false;
    const vectors = await this.embed(batch.map(chunk => chunk.document));
    batch.forEach((chunk, i) => this.vectors.set(chunk.hash, vectors[i]));
    for (const chunk of batch) chunk.document = null; // its text is in its file; only the words stay, for keywords
    this.dirty = true;
    return true;
  }

  /** Each chunk's words with how often it has them, and the average length, built once per change of the files. */
  keywordIndex() {
    if (this.keywords) return this.keywords;
    const chunks = this.chunks;
    const counts = chunks.map(chunk => {
      const count = new Map();
      for (const word of chunk.words) count.set(word, (count.get(word) ?? 0) + 1);
      return count;
    });
    const average = chunks.reduce((sum, chunk) => sum + chunk.words.length, 0) / (chunks.length || 1);
    this.keywords = {chunks, counts, average};
    return this.keywords;
  }

  /**
   * The chunks that have every word of the query, each as the start of one of theirs (`retr` finds `retryCount`;
   * a word of two letters only as a whole word),
   * best first by BM25, at most `limit`. Every word, as lfm-pixel's keyword search: a question in other words than
   * the code's then finds nothing here and is left to its meaning, and a name only the code has finds its chunk.
   */
  keywordRanking(query, limit = LIST) {
    const {chunks, counts, average} = this.keywordIndex();
    const terms = [...new Set(words(query))].filter(term => !STOPWORDS.has(term));
    if (!terms.length) return [];
    const frequencies = counts.map(count => terms.map(term => {
      let n = 0;
      for (const [word, times] of count) if (term.length > 2 ? word.startsWith(term) : word === term) n += times;
      return n;
    }));
    const df = terms.map((_, t) => frequencies.filter(tf => tf[t] > 0).length);
    const matching = chunks.map((chunk, i) => [chunk, frequencies[i]]).filter(([, tf]) => tf.every(f => f > 0));
    const n = chunks.length;
    const scored = matching.map(([chunk, tf]) => [chunk, tf.reduce((score, f, t) => score
      + Math.log(1 + (n - df[t] + 0.5) / (df[t] + 0.5)) * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * chunk.words.length / average)), 0)]);
    return scored.sort((a, b) => b[1] - a[1]).slice(0, limit).map(([chunk]) => chunk);
  }

  /** The chunks closest in meaning to the query's vector `q`, best first, within the band below the best. */
  meaningRanking(q, limit = LIST) {
    const scored = [];
    for (const chunk of this.chunks) {
      const vector = this.vectors.get(chunk.hash);
      if (vector) scored.push([chunk, dot(q, vector)]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    const best = scored[0]?.[1] ?? 0;
    return scored.filter(([, score]) => score >= best - MEANING_BAND).slice(0, limit);
  }

  /**
   * The project's chunks for `query`, best first: meaning and keywords fused by reciprocal rank. Each result is
   * `{file, from, to, head, meaning, keyword}` (`meaning` its similarity, or null for a chunk not embedded yet).
   */
  async search(query, {limit = 30} = {}) {
    // Asked even before anything is embedded: an embedder that cannot run is found now, and said.
    const [q] = await this.embed([queryText(query)], {urgent: true});
    const meaning = q ? this.meaningRanking(q) : [];
    const keyword = this.keywordRanking(query);
    const similarity = new Map(meaning.map(([chunk, score]) => [chunk, score]));
    const keywordSet = new Set(keyword);
    return fuse([meaning.map(([chunk]) => chunk), keyword]).slice(0, limit).map(chunk => ({
      file: chunk.file, from: chunk.from, to: chunk.to, head: chunk.head,
      meaning: similarity.has(chunk) ? Math.round(similarity.get(chunk) * 1000) / 1000 : null, keyword: keywordSet.has(chunk),
    }));
  }
}

/** The index file of the project at `root`, in Pair's data folder. */
export const indexPath = (dataDir, root) => join(meaningDir(dataDir), 'index', `${createHash('sha1').update(root).digest('hex').slice(0, 16)}.idx`);

const seconds = ms => `${Math.round(ms / 1000)} s`;

/**
 * Search by meaning for the daemon: off until its model is downloaded (`turnOn`), or for good with "meaning": false
 * in the config. Indexes the projects that have a session (`open`, and `leave` once it ends), one chunk batch at a time
 * across them, in the background. `book(root, kind, text, options)` puts a line in that project's ledger.
 */
export class Meaning {
  constructor({dataDir, config = {}, log = () => {}, book = () => {}, fetch = globalThis.fetch, embedder = null, now = Date.now}) {
    Object.assign(this, {dataDir, config, log, book, fetch, now});
    this.disabled = config === false;
    // The helper's Python is looked for each time it starts: a venv made while the daemon runs is found.
    this.embedder = embedder ?? new Embedder({python: () => pythonOf(config, dataDir), model: modelPath(dataDir), threads: config?.threads, log});
    this.indexes = new Map(); // root -> ProjectIndex
    this.wanted = new Set(); // the roots with a session, opened once search by meaning is on
    this.downloading = null; // {bytes} while the model comes
    this.problem = null; // why the embedder cannot run, until the next try
    this.problemAt = 0;
    this.working = false;
    this.timer = setInterval(() => this.rescan(), RESCAN_MS);
    this.timer.unref?.();
  }

  /** 'disabled', 'off' (no model yet), 'downloading' or 'on'. */
  get state() {
    if (this.disabled) return 'disabled';
    if (this.downloading) return 'downloading';
    return modelReady(this.dataDir) ? 'on' : 'off';
  }

  /** The project at `root` has a session: its index loads, is looked over and builds in the background. */
  open(root) {
    this.wanted.add(root);
    if (this.state !== 'on' || this.indexes.has(root)) return;
    const index = new ProjectIndex({root, path: indexPath(this.dataDir, root), embed: (texts, options) => this.embedder.embed(texts, options), log: this.log, now: this.now});
    this.indexes.set(root, index);
    index.ready = index.load().then(() => index.scan()).then(() => { this.work(); }, error => this.log(`meaning: ${root}: ${error.message}`));
  }

  /** The session at `root` ended: what was built is written down, and the index leaves memory. */
  async leave(root) {
    this.wanted.delete(root);
    const index = this.indexes.get(root);
    if (!index) return;
    this.indexes.delete(root);
    await index.ready;
    if (index.dirty) await index.save().catch(() => {});
  }

  /** A file saved in Neovim at `root`: its changed chunks are embedded again. */
  async saved(root, path) {
    const index = this.indexes.get(root);
    if (!index) return;
    await index.ready;
    await index.saved(path);
    this.work();
  }

  /** Projects looked over again every RESCAN_MS, for changes made outside Neovim (a checkout, a pull). */
  async rescan() {
    for (const index of this.indexes.values()) {
      await index.ready;
      await index.scan().catch(() => {});
      if (index.dirty && !this.working) await index.save().catch(() => {}); // a save's few chunks, written down now
    }
    this.work();
  }

  /**
   * Embeds what waits, one batch at a time, project after project, and again while any project has chunks waiting
   * (a save elsewhere meanwhile); stops at a problem with the embedder. A build of BOOKED_CHUNKS or more is written
   * down every SAVE_MS and at its end, with a ledger line; a save's few chunks are written down by the next rescan,
   * or when the session ends.
   */
  async work() {
    if (this.working || this.state !== 'on') return;
    if (this.problem && this.now() - this.problemAt < RESCAN_MS) return;
    this.working = true;
    this.problem = null;
    const write = index => index.save().catch(error => this.log(`meaning: ${index.path} not written: ${error.message}`));
    try {
      for (let more = true, passes = 0; more && passes < 10; passes++) { // a few passes at most: never a loop
        more = false;
        for (const index of [...this.indexes.values()]) {
          const waiting = index.pending().length;
          if (!waiting) continue;
          more = true;
          const build = {startedAt: this.now(), chunks: waiting};
          while (this.indexes.get(index.root) === index && await index.step()) {
            if (build.chunks >= BOOKED_CHUNKS && this.now() - index.savedAt > SAVE_MS) await write(index);
          }
          if (this.indexes.get(index.root) !== index || build.chunks < BOOKED_CHUNKS) continue;
          await write(index);
          const {files, chunks, bytes} = index.progress();
          this.book(index.root, 'indexed', `indexed ${build.chunks} chunk${build.chunks === 1 ? '' : 's'} by meaning in ${seconds(this.now() - build.startedAt)}: ${files} files, ${chunks} chunks, ${Math.round(bytes / 1024)} KB`);
        }
      }
    } catch (error) {
      this.problem = error.message;
      this.problemAt = this.now();
      this.log(`meaning: indexing stops: ${error.message}`);
    } finally {
      this.working = false;
    }
  }

  /** What a search in the project at `root` finds: `{type: 'meaning', query, results, ...why}`. */
  async search(root, query, {limit} = {}) {
    const state = this.state;
    const answer = {type: 'meaning', query, state, results: []};
    if (state !== 'on') return answer;
    if (!this.indexes.has(root)) this.open(root);
    const index = this.indexes.get(root);
    await index.ready;
    const started = this.now();
    try {
      answer.results = await index.search(query, {limit});
      if (this.problem) { // the embedder runs again (the runtime was installed, say): the build goes on
        this.problem = null;
        this.work();
      }
      if (index.capped) answer.capped = MAX_CHUNKS;
    } catch (error) {
      // The embedder cannot run: the keywords still rank, and the picker says why meaning is missing.
      this.problem = error.message;
      this.problemAt = this.now();
      answer.problem = error.message;
      answer.results = index.keywordRanking(query, limit ?? 30).map(chunk => ({file: chunk.file, from: chunk.from, to: chunk.to, head: chunk.head, meaning: null, keyword: true}));
    }
    const {chunks, embedded} = index.progress();
    Object.assign(answer, {ms: this.now() - started, chunks, embedded});
    const top = answer.results[0];
    this.book(root, 'searched', `by meaning "${query}": ${answer.results.length} result${answer.results.length === 1 ? '' : 's'}${top ? `, first ${top.file}:${top.from}` : ''}`, {
      detail: {output: answer.results.map(result => `${result.file}:${result.from}-${result.to}  ${result.meaning ?? '-'}${result.keyword ? ' +words' : ''}  ${result.head}`).join('\n')},
    });
    return answer;
  }

  /**
   * Downloads the model, once, then indexes the projects that have a session (`roots`). Resolves true when it
   * downloaded, false when the model was already there.
   */
  async turnOn(roots = [], {progress = () => {}} = {}) {
    if (this.disabled) throw new Error('search by meaning is turned off in the config ("meaning": false)');
    if (this.downloading) return this.downloading.done.then(() => false);
    this.problem = null;
    if (modelReady(this.dataDir)) {
      for (const root of new Set([...this.wanted, ...roots])) this.open(root);
      this.work(); // a build a problem stopped goes on
      return false;
    }
    const abort = new AbortController();
    this.downloading = {bytes: 0, abort};
    this.downloading.done = downloadModel(this.dataDir, {fetch: this.fetch, signal: abort.signal, progress: bytes => { this.downloading.bytes = bytes; progress(bytes); }})
      .finally(() => { this.downloading = null; });
    await this.downloading.done;
    for (const root of new Set([...this.wanted, ...roots])) this.open(root); // sessions started meanwhile too
    return true;
  }

  /** Off again: the helper stops, and the model and every index leave Pair's data folder. */
  async turnOff() {
    if (this.downloading) { // a download under way stops, and leaves nothing
      this.downloading.abort.abort(new Error('search by meaning was turned off'));
      await this.downloading.done.catch(() => {});
    }
    for (const root of [...this.indexes.keys()]) this.indexes.delete(root);
    this.embedder.fail(new Error('search by meaning was turned off')); // a batch under way is dropped, not waited for
    this.problem = null;
    await removeModel(this.dataDir);
    await rm(join(meaningDir(this.dataDir), 'index'), {recursive: true, force: true});
  }

  /** The index's ranking of `query` in `root` for the search trail: the top chunks, or null when it has none. */
  async trailHits(root, query, limit = 2) {
    const index = this.indexes.get(root);
    // Only while the helper runs: the trail does not wait for it to load.
    if (this.state !== 'on' || !index || !index.vectors.size || this.problem || !this.embedder.runtime) return null;
    await index.ready;
    const hits = (await index.search(query, {limit})).filter(result => result.meaning !== null);
    this.book(root, 'searched', `by meaning "${query}", for the search trail: ${hits.map(hit => `${hit.file}:${hit.from}`).join(', ') || 'nothing close'}`);
    return hits;
  }

  /** For `pair doctor` and the daemon's status. */
  snapshot() {
    return {
      state: this.state, model: MODEL.name, revision: MODEL.revision, problem: this.problem, downloading: this.downloading?.bytes ?? null,
      python: typeof this.embedder.python === 'function' ? this.embedder.python() : this.embedder.python, runtime: this.embedder.runtime?.runtime ?? null, msPerChunk: this.embedder.msPerText,
      indexes: [...this.indexes.values()].map(index => index.progress()),
    };
  }

  async close() {
    clearInterval(this.timer);
    for (const root of [...this.indexes.keys()]) await this.leave(root);
    this.embedder.close();
  }
}
