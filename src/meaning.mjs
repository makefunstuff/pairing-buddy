// Search by meaning: an index of each project Pair has a session in, and a search that ranks its pieces of code by what
// the words mean and by the words themselves, fused as lfm-pixel does (reciprocal rank). The index holds the files git
// lists (tracked and untracked, without what .gitignore leaves out), cut into pieces (functions, classes and methods
// with their doc comments where Neovim has a tree-sitter parser, else blocks between blank lines; see pieces.mjs), the
// words of each piece for the word search, and a vector per piece from the embedding model (EmbeddingGemma 2 on
// LiteRT-LM, or an "embedding" model at a /v1/embeddings; see embedder.mjs). It is a SQLite file per repository, shared
// by its worktrees (see index-store.mjs). A piece is embedded again only when its text changed: a save reads that file
// again, and the project is looked over when its session loads and every few minutes, for changes made outside Neovim.
// The word search works without any embedding model. Builds and searches go to the ledger.
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {isAbsolute, join, relative} from 'node:path';
import {apiKeyOf} from './config.mjs';
import {downloadModel, Embedder, HttpEmbedder, meaningDir, MODEL, modelPath, modelReady, pythonOf, removeModel} from './embedder.mjs';
import {IndexStore, indexPlace, removeIndex} from './index-store.mjs';
import {Runtime, RUNTIME_VERSION} from './runtime.mjs';
import {piecesOf, TreeSitter} from './pieces.mjs';

const MAX_FILE_BYTES = 512 * 1024;
const MAX_LINE_AVERAGE = 300; // minified or generated: no lines worth reading
const BATCH = 4; // pieces per embedder call: a search waits for at most one batch
export const MAX_PIECES = 20_000; // per project, about 45 min of a first build on two cores; files past it are left out
const BOOKED_PIECES = 10; // a build this big gets its own ledger line; a save's few pieces do not
export const RESCAN_MS = 10 * 60_000;
const PARSE_GROUP = 200; // files per headless Neovim of tree-sitter
const PROGRESS_MS = 2000; // how often a build in progress tells the editors how far it is
const HEAD_CHARS = 100;
const RRF_K = 60;
const LIST = 50; // of each ranking, how many go into the fusion
const MEANING_BAND = 0.1; // meaning hits further than this below the best are left out: unrelated code scores close, too
// Words of a question that say nothing about where to look: left out of the word search, not the meaning's.
const STOPWORDS = new Set('a an and are as at be but by can do does for from has have how i if in into is it its me my not of on or our so that the their them then there these this to was we were what when where which who why will with you your'.split(' '));
// A line that is a comment, or only opens or closes one: a piece's head is the first line that is not.
const COMMENT = /^\s*(\/\/|\/\*|\*|#(?!\w)|--|;|"""|'''|<!--)|^\s*[-*]\/\s*$/;

// Files whose text is no code or prose to search: pictures, sound, archives, fonts, lockfiles, source maps.
const SKIP = /\.(png|jpe?g|gif|webp|bmp|ico|icns|svg|pdf|mp3|mp4|m4a|wav|ogg|flac|webm|mov|avi|zip|gz|tgz|bz2|xz|zst|7z|rar|jar|war|class|o|a|so|dylib|dll|exe|bin|wasm|woff2?|ttf|otf|eot|sqlite3?|sqlite-(wal|shm)|db|pyc|map|litertlm|gguf|onnx|safetensors|pt|npy|npz)$/i;
const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'Cargo.lock', 'go.sum', 'poetry.lock', 'uv.lock', 'Gemfile.lock', 'composer.lock', 'flake.lock']);

const run = (command, args, cwd) => new Promise(resolve => {
  execFile(command, args, {cwd, maxBuffer: 64 << 20}, (error, stdout) => resolve(error ? null : stdout));
});

/** Whether the file at `path` (relative to the project) is one to index, by its name alone. */
export function indexable(path) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return !SKIP.test(name) && !LOCKFILES.has(name) && !/\.min\.(js|css)$/.test(name) && !path.startsWith('.pair/');
}

/** The project's files to index, relative to `root`: git's list without what it ignores, else ripgrep's, else none. */
export async function projectFiles(root) {
  const git = await run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], root);
  // Without git, ripgrep keeps to .gitignore only when told to.
  const listed = git !== null ? git.split('\0') : (await run('rg', ['--files', '--null', '--no-require-git'], root))?.split('\0') ?? [];
  return [...new Set(listed.filter(Boolean))].filter(indexable).sort();
}

/** A piece is known by its file's path and its text: worktrees of a repository share its vector, a restart embeds nothing twice. */
export const pieceHash = (file, text) => createHash('sha1').update(`${file}\n${text}`).digest('hex');

/**
 * The words of `text` for the word search: lower case, with identifiers split too (removeUserFromTeam, retry_count:
 * remove, user, from, team; retry, count). Comments and strings are words like any other.
 */
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

/** The words of a search that say where to look: its own and its identifiers' parts, without a question's small words. */
export const searchTerms = query => [...new Set(words(query))].filter(term => !STOPWORDS.has(term));

/** Reciprocal rank fusion of ranked lists of keys: each key scores 1/(k + rank) in every list it is in. */
export function fuse(lists, k = RRF_K) {
  const scores = new Map();
  for (const list of lists) list.forEach((key, rank) => scores.set(key, (scores.get(key) ?? 0) + 1 / (k + rank + 1)));
  return [...scores].sort((a, b) => b[1] - a[1]).map(([key]) => key);
}

/** The lines of the project's files, kept for the few files read last: a piece's head and its text to embed. */
class Lines {
  constructor(root, size = 64) {
    Object.assign(this, {root, size});
    this.files = new Map(); // file -> {mtimeMs, lines}
  }

  async get(file) {
    let info;
    try { info = await stat(join(this.root, file)); } catch { return null; }
    const known = this.files.get(file);
    if (known?.mtimeMs === info.mtimeMs && known.size === info.size) {
      this.files.delete(file);
      this.files.set(file, known);
      return known.lines;
    }
    let text;
    try { text = await readFile(join(this.root, file), 'utf8'); } catch { return null; }
    this.files.set(file, {mtimeMs: info.mtimeMs, size: info.size, lines: text.split('\n')});
    if (this.files.size > this.size) this.files.delete(this.files.keys().next().value);
    return this.files.get(file).lines;
  }
}

/**
 * One project's index (one worktree: `root`), on the repository's `store`: its pieces (`{id, file, from, to, hash,
 * kind, name}`), their vectors by hash, and the pieces still waiting for theirs. `embedder` is the Meaning's: its
 * `id`, `document(file, text)`, `query(text)` and `embed(texts, {urgent})`.
 */
export class ProjectIndex {
  constructor({root, store, embedder, treeSitter, log = () => {}, now = Date.now, onProgress = () => {}, embedding = () => true}) {
    Object.assign(this, {root, store, embedder, treeSitter, log, now, onProgress, embedding});
    this.files = new Map(); // relative path -> {size, mtimeMs, skipped}, as last read
    this.byFile = new Map(); // relative path -> its pieces
    this.vectors = new Map(); // hash -> Float32Array, of the embedder's model
    this.documents = new Map(); // hash -> the text to embed, while it waits; read again from its file after a restart
    this.lines = new Lines(root);
    this.waiting = null; // the pieces still without a vector, worked through by step(); null once the files change
    this.matrix = null; // the vectors in one array, for the search; null once they change
    this.capped = false; // the project has more pieces than MAX_PIECES: some files are left out
    this.reading = null; // {done, total} while files are read and cut into pieces
    this.scannedAt = 0;
  }

  get model() { return this.embedder.id; }

  /** What the store has of this worktree: its files, pieces and their vectors, made here or in another worktree. */
  load() {
    this.files = this.store.files(this.root);
    this.byFile = new Map();
    for (const piece of this.store.pieces(this.root)) {
      if (!this.byFile.has(piece.file)) this.byFile.set(piece.file, []);
      this.byFile.get(piece.file).push(piece);
    }
    this.vectors = this.store.vectors(this.model, this.root);
    this.changed();
  }

  changed() {
    this.waiting = null;
    this.matrix = null;
  }

  get pieces() { return [...this.byFile.values()].flat(); }

  /** The vectors of texts the project no longer has leave memory too (the file keeps those other worktrees have). */
  trim() {
    const hashes = new Set(this.pieces.map(piece => piece.hash));
    for (const hash of [...this.vectors.keys()]) if (!hashes.has(hash)) this.vectors.delete(hash);
    this.matrix = null;
  }

  /** Looks the whole project over: files new, changed and gone. Read in groups, each cut into pieces by one Neovim. */
  async scan() {
    const listed = await projectFiles(this.root);
    const keep = new Set(listed);
    for (const file of [...this.files.keys()]) if (!keep.has(file)) this.forget(file);
    let count = this.pieces.length;
    this.capped = false;
    const changed = [];
    for (const file of listed) {
      let info;
      try { info = await stat(join(this.root, file)); } catch { this.forget(file); continue; }
      const known = this.files.get(file);
      if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) continue;
      if (!known && count >= MAX_PIECES) { this.capped = true; continue; }
      changed.push({file, info});
      count += Math.ceil(info.size / 1000); // about a piece a kilobyte, until it is read
    }
    if (changed.length) await this.readAll(changed);
    this.scannedAt = this.now();
  }

  /** A file saved in Neovim, by its path (relative to the project, or absolute). Outside it, or ignored, it changes nothing. */
  async saved(path, {force = false} = {}) {
    const file = isAbsolute(path) ? relative(this.root, path) : path;
    if (file.startsWith('..') || !this.files.has(file) && !(await projectFiles(this.root)).includes(file)) return;
    let info;
    try { info = await stat(join(this.root, file)); } catch { return this.forget(file); }
    const known = this.files.get(file);
    // `force`: its text changed though its size and time did not (cp -p, rsync -t, a coarse clock).
    if (!force && known && known.size === info.size && known.mtimeMs === info.mtimeMs) return;
    if (!force) this.forced?.delete(file); // saved anew: a mismatch may be read again
    await this.readAll([{file, info}]);
  }

  forget(file) {
    if (!this.files.has(file) && !this.byFile.has(file)) return;
    this.store.removeFile(this.root, file);
    this.files.delete(file);
    this.byFile.delete(file);
    this.changed();
  }

  /** Reads `changed` files (`{file, info}`) and cuts them into pieces: tree-sitter's where it can, blank lines elsewhere. */
  readAll(changed) {
    // One read at a time: a save during a scan waits for it, so the newer text is the one kept.
    const read = (this.readChain ?? Promise.resolve()).then(() => this.readNow(changed));
    this.readChain = read.catch(() => {});
    return read;
  }

  async readNow(changed) {
    if (this.closed) return;
    const total = changed.length;
    const reading = {done: 0, total};
    this.reading = reading;
    let told = this.now();
    try {
      for (let start = 0; start < changed.length; start += PARSE_GROUP) {
        const texts = [];
        for (const {file, info} of changed.slice(start, start + PARSE_GROUP)) {
          if (!info.isFile() || info.size > MAX_FILE_BYTES || !indexable(file)) { this.forget(file); continue; }
          let text;
          try { text = await readFile(join(this.root, file), 'utf8'); } catch { this.forget(file); continue; }
          const lines = text.split('\n').length;
          if (text.slice(0, 8192).includes('\0') || text.length / lines > MAX_LINE_AVERAGE) {
            this.store.putFile(this.root, file, {size: info.size, mtimeMs: info.mtimeMs, skipped: true});
            this.files.set(file, {size: info.size, mtimeMs: info.mtimeMs, skipped: true});
            this.byFile.delete(file);
            continue;
          }
          texts.push({file, info, text});
        }
        const found = await this.treeSitter.definitions(texts.map(({file}) => join(this.root, file)));
        if (this.closed) return; // the session ended, or the index is made again: its file is closed
        for (const {file, info, text} of texts) {
          const pieces = piecesOf(text, found.get(join(this.root, file))).map(piece => ({
            ...piece, hash: pieceHash(file, piece.text), words: words(`${file} ${piece.name ?? ''} ${piece.text}`).join(' '),
          }));
          for (const old of this.byFile.get(file) ?? []) this.documents.delete(old.hash); // a text gone from the file
          const stored = this.store.putFile(this.root, file, {size: info.size, mtimeMs: info.mtimeMs}, pieces);
          this.files.set(file, {size: info.size, mtimeMs: info.mtimeMs, skipped: false});
          this.byFile.set(file, stored);
          pieces.forEach(piece => {
            if (this.vectors.has(piece.hash)) return;
            const shared = this.store.vector(this.model, piece.hash); // made in another worktree of the repository
            if (shared) this.vectors.set(piece.hash, shared);
            // Kept to embed soon, only while there is a model: words alone read the file again when it comes.
            else if (this.embedding()) this.documents.set(piece.hash, this.embedder.document(file, piece.text));
          });
        }
        reading.done = Math.min(total, start + PARSE_GROUP);
        this.changed();
        if (this.now() - told > PROGRESS_MS) {
          told = this.now();
          this.onProgress({phase: 'reading', done: reading.done, total});
        }
      }
    } finally {
      if (this.reading === reading) this.reading = null;
    }
  }

  /** The pieces still without a vector, one per hash, oldest file first. */
  pending() {
    const seen = new Set();
    return this.pieces.filter(piece => !this.vectors.has(piece.hash) && !seen.has(piece.hash) && seen.add(piece.hash));
  }

  /** The text to embed for `piece`: kept since it was read, or read again from its file (after a restart). */
  async documentOf(piece) {
    if (this.documents.has(piece.hash)) return this.documents.get(piece.hash);
    const lines = await this.lines.get(piece.file);
    if (!lines) return null;
    const text = lines.slice(piece.from - 1, piece.to).join('\n');
    return pieceHash(piece.file, text) === piece.hash ? this.embedder.document(piece.file, text) : null; // changed since: the next scan reads it
  }

  /** Embeds the next few pieces waiting; false when none waits. The list of those is made again once it runs out, or the files change. */
  async step() {
    if (this.closed) return false;
    if (!this.waiting?.length) this.waiting = this.pending();
    const waiting = this.waiting; // a file read meanwhile makes a new list; this batch keeps to its own
    const batch = [];
    const stale = new Set();
    while (waiting.length && batch.length < (this.embedder.batch ?? BATCH)) {
      if (this.closed) return false;
      const piece = waiting.shift();
      if (this.vectors.has(piece.hash)) continue;
      const shared = this.store.vector(this.model, piece.hash); // another worktree embedded it meanwhile
      if (shared) {
        this.vectors.set(piece.hash, shared);
        this.matrix = null;
        continue;
      }
      const document = await this.documentOf(piece);
      if (document === null) stale.add(piece.file);
      else batch.push({hash: piece.hash, document});
    }
    // A file changed since it was read: read again now, its pieces wait in the next list.
    this.forced ??= new Set();
    let reread = false;
    for (const file of stale) {
      if (this.closed) return false;
      if (this.forced.has(file)) continue; // read again once already: left to the next save
      this.forced.add(file);
      reread = true;
      await this.saved(file, {force: true}).catch(() => {});
    }
    if (this.closed) return false;
    if (!batch.length) return reread;
    const vectors = await this.embed(batch.map(item => item.document));
    if (this.closed) return false; // the session ended, or the index is being made again: its file is closed
    const entries = batch.map((item, i) => [item.hash, vectors[i]]);
    this.store.putVectors(this.model, entries);
    for (const [hash, vector] of entries) {
      this.vectors.set(hash, vector);
      this.documents.delete(hash);
    }
    this.matrix = null;
    return true;
  }

  embed(texts, options) { return this.embedder.embed(texts, options); }

  /** The pieces that have every word of the query, each as the start of one of theirs (`retr` finds `retryCount`), best first by BM25. */
  wordRanking(query, limit = LIST) {
    const ids = this.store.wordSearch(this.root, searchTerms(query), limit);
    const byId = new Map(this.pieces.map(piece => [piece.id, piece]));
    return ids.map(id => byId.get(id)).filter(Boolean);
  }

  /** The vectors of the pieces that have one, in one array: compared with a search's vector in one pass. */
  matrixOf() {
    if (this.matrix) return this.matrix;
    const pieces = this.pieces.filter(piece => this.vectors.has(piece.hash));
    const size = pieces.length ? this.vectors.get(pieces[0].hash).length : 0;
    const data = new Float32Array(pieces.length * size);
    pieces.forEach((piece, i) => {
      const vector = this.vectors.get(piece.hash);
      if (vector.length === size) data.set(vector, i * size);
    });
    this.matrix = {pieces, size, data};
    return this.matrix;
  }

  /** The pieces closest in meaning to the query's vector `q`, best first, within the band below the best: `[piece, similarity]`. */
  meaningRanking(q, limit = LIST) {
    const {pieces, size, data} = this.matrixOf();
    if (!pieces.length || q.length !== size) return [];
    const scores = new Float32Array(pieces.length);
    let best = -Infinity;
    for (let i = 0; i < pieces.length; i++) {
      let sum = 0;
      for (let j = 0, at = i * size; j < size; j++) sum += q[j] * data[at + j];
      scores[i] = sum;
      if (sum > best) best = sum;
    }
    const near = [];
    for (let i = 0; i < pieces.length; i++) if (scores[i] >= best - MEANING_BAND) near.push([pieces[i], scores[i]]);
    return near.sort((a, b) => b[1] - a[1]).slice(0, limit);
  }

  /** The line a piece is shown and opened at: its first that is not a comment (its doc comment is above it), with its text. */
  async headOf(piece) {
    const lines = await this.lines.get(piece.file);
    const body = lines?.slice(piece.from - 1, piece.to) ?? [];
    const prose = /\.(md|markdown|txt|rst)$/i.test(piece.file); // a heading is no comment there
    let at = body.findIndex(line => line.trim() && (prose || !COMMENT.test(line)));
    if (at < 0) at = Math.max(0, body.findIndex(line => line.trim()));
    return {line: piece.from + at, head: (body[at] ?? '').trim().slice(0, HEAD_CHARS)};
  }

  /** A piece as a search answers it: `{file, line, from, to, head, kind, name, meaning, words}`. */
  async result(piece, {meaning = null, words = false} = {}) {
    const {line, head} = await this.headOf(piece);
    return {
      file: piece.file, line, from: piece.from, to: piece.to, head, kind: piece.kind, name: piece.name,
      meaning: meaning === null ? null : Math.round(meaning * 1000) / 1000, words,
    };
  }

  /** The word search alone: what shows on every key. */
  async wordSearch(query, {limit = 30} = {}) {
    return Promise.all(this.wordRanking(query, limit).map(piece => this.result(piece, {words: true})));
  }

  /** The meaning search alone: the query embedded once, against every vector. */
  async meaningSearch(query, {limit = 30} = {}) {
    const [q] = await this.embed([this.embedder.query(query)], {urgent: true});
    return Promise.all(this.meaningRanking(q, limit).map(([piece, score]) => this.result(piece, {meaning: score})));
  }

  /** Meaning and words fused by reciprocal rank, best first. */
  async search(query, {limit = 30} = {}) {
    // Asked even before anything is embedded: an embedder that cannot run is found now, and said.
    const [q] = await this.embed([this.embedder.query(query)], {urgent: true});
    const meaning = q ? this.meaningRanking(q, Math.max(LIST, limit)) : [];
    const keyword = this.wordRanking(query, Math.max(LIST, limit));
    const similarity = new Map(meaning);
    const keywordSet = new Set(keyword);
    const ranked = fuse([meaning.map(([piece]) => piece), keyword]).slice(0, limit);
    return Promise.all(ranked.map(piece => this.result(piece, {meaning: similarity.get(piece) ?? null, words: keywordSet.has(piece)})));
  }

  /** How far the index is: files, pieces (by hash), how many have vectors, the file's bytes and when it changed. */
  progress() {
    const hashes = new Set(this.pieces.map(piece => piece.hash));
    const embedded = [...hashes].filter(hash => this.vectors.has(hash)).length;
    const files = [...this.files.values()].filter(file => !file.skipped).length;
    return {root: this.root, files, chunks: hashes.size, embedded, ...this.store.stats(), capped: this.capped, reading: this.reading};
  }
}

const seconds = ms => `${Math.round(ms / 1000)} s`;
// `:Pair find off` with an "embedding" model: nothing to delete but the indexes, and this note that keeps it off.
const offPath = dataDir => join(meaningDir(dataDir), 'off');
const FAILED_MS = 60_000;
const UNOPENED = 'the search index cannot be opened (the daemon\'s log says why): :Pair index rebuild makes it again';

/**
 * Search by meaning for the daemon. The word search works once a project has a session; meaning needs a model: the
 * config's "embedding" one, else EmbeddingGemma 2 once downloaded, with LiteRT-LM installed in a venv of Pair's
 * (`turnOn`; see runtime.mjs). "meaning": false turns it all off.
 * Indexes the projects that have a session (`open`, and `leave` once it ends), one batch at a time across them, in the
 * background. `book(root, kind, text, options)` puts a line in that project's ledger; `progress(root, how)` tells its
 * editors how far a build is. An `embedder` of the tests' installs nothing, unless they give a `runtime` too.
 */
export class Meaning {
  constructor({dataDir, config = {}, embedding = null, log = () => {}, book = () => {}, progress = () => {}, fetch = globalThis.fetch, embedder = null, runtime = null, treeSitter = null, now = Date.now}) {
    Object.assign(this, {dataDir, config, embedding, log, book, fetch, now});
    this.tell = progress;
    this.disabled = config === false;
    this.parsers = []; // the tree-sitter parsers of the user's Neovim, as it says at its hello
    // EmbeddingGemma's Python is looked for each time its helper starts: a venv made while the daemon runs is found.
    this.embedder = embedder ?? (embedding
      ? new HttpEmbedder({entry: embedding, apiKey: () => apiKeyOf(embedding), fetch, log})
      : new Embedder({python: () => pythonOf(config, dataDir), model: modelPath(dataDir), threads: config?.threads, log}));
    // LiteRT-LM, for EmbeddingGemma: installed by turnOn, but never for the config's own meaning.python.
    // With an "embedding" model it installs nothing, but :Pair find off still deletes a venv Pair made before.
    this.keepVenv = () => false; // the daemon's: true while voice's LFM3-Omni needs the venv
    this.runtime = runtime ?? (embedder ? null : new Runtime({dataDir, python: () => pythonOf(config, dataDir), fetch, log}));
    this.treeSitter = treeSitter ?? new TreeSitter({parsers: () => this.parsers, log});
    this.indexes = new Map(); // root -> ProjectIndex
    this.failures = new Map(); // root -> {at, index}: an index file that could not be opened lately
    this.wanted = new Set(); // the roots with a session
    this.downloading = null; // {phase: 'runtime' or 'model', bytes, total} while LiteRT-LM installs or the model comes
    this.problem = null; // why the embedder cannot run, until the next try
    this.problemAt = 0;
    this.working = false;
    this.timer = setInterval(() => this.rescan().catch(error => log(`meaning: ${error.message}`)), RESCAN_MS);
    this.timer.unref?.();
    rm(join(meaningDir(dataDir), 'index'), {recursive: true, force: true}).catch(() => {}); // PAIR-5's, before SQLite
  }

  /** 'disabled', 'off' (words only: no model yet), 'installing' (LiteRT-LM), 'downloading' (the model) or 'on'. */
  get state() {
    if (this.disabled) return 'disabled';
    if (this.embedding) return existsSync(offPath(this.dataDir)) ? 'off' : 'on';
    if (this.downloading?.phase) return this.downloading.phase === 'runtime' ? 'installing' : 'downloading';
    return modelReady(this.dataDir) ? 'on' : 'off';
  }

  /** The model that gives the vectors, for people. */
  get modelName() { return this.embedding ? `${this.embedding.model} at ${this.embedding.baseUrl}` : MODEL.name; }

  /** The tree-sitter parsers a Neovim has (`parser/<lang>.so` paths): the pieces of their languages' files are found by them. */
  useParsers(paths) {
    if (Array.isArray(paths)) this.parsers = [...new Set([...this.parsers, ...paths.filter(path => typeof path === 'string')])];
  }

  /** The project at `root` has a session: its index loads, is looked over and builds in the background. */
  open(root) {
    if (this.disabled) return null;
    this.wanted.add(root);
    if (this.indexes.has(root)) return this.indexes.get(root);
    const failed = this.failures.get(root);
    if (failed && this.now() - failed.at < FAILED_MS) return failed.index; // not tried again on every key
    const index = new ProjectIndex({root, store: null, embedder: this.embedder, treeSitter: this.treeSitter, log: this.log, now: this.now, onProgress: how => this.tell(root, how), embedding: () => this.state === 'on'});
    this.indexes.set(root, index);
    index.loaded = (async () => {
      const place = await indexPlace({dataDir: this.dataDir, root, where: this.config?.index});
      index.store = IndexStore.open(place.path);
      index.store.forgetTrees(tree => tree === root || existsSync(tree));
      index.load();
    })();
    index.ready = index.loaded.then(async () => {
      // A first build tells the editors as it starts; its words take seconds, and need no ledger line of their own.
      const first = !index.files.size;
      if (first) this.tell(root, {phase: 'reading', done: 0, total: null});
      await index.scan();
      index.store.prune(index.model);
      if (first) {
        const {chunks, embedded} = index.progress();
        index.told = this.state === 'on' && embedded < chunks;
        this.tell(root, {phase: index.told ? 'embedding' : 'done', done: embedded, total: chunks});
      }
    }).then(() => { this.work(); }, error => {
      // An index file that cannot be opened (or read): this project goes without, and the next search tries again.
      this.log(`meaning: ${root}: ${error.message}`);
      index.closed = true;
      index.store?.release();
      if (this.indexes.get(root) === index) this.indexes.delete(root);
      index.failure = error;
      this.failures.set(root, {at: this.now(), index});
    });
    return index;
  }

  /** The session at `root` ended: the index leaves memory (it is on disk already). */
  async leave(root) {
    this.wanted.delete(root);
    const index = this.indexes.get(root);
    if (!index) return;
    this.indexes.delete(root);
    index.closed = true; // a batch under way is dropped, not written to a closed file
    await index.ready;
    if (!index.failure) index.store?.release();
  }

  /** A file saved in Neovim at `root`: its changed pieces are embedded again. */
  async saved(root, path) {
    const index = this.indexes.get(root);
    if (!index) return;
    await index.ready;
    await index.saved(path);
    this.work();
  }

  /** Projects looked over again every RESCAN_MS, for changes made outside Neovim (a checkout, a pull). */
  async rescan() {
    for (const index of [...this.indexes.values()]) {
      await index.ready;
      if (this.indexes.get(index.root) !== index || index.closed) continue;
      try {
        await index.scan();
        if (!index.closed) {
          index.store.prune(index.model);
          index.store.checkpoint();
          index.trim();
        }
      } catch (error) {
        this.log(`meaning: ${index.root}: ${error.message}`);
      }
    }
    this.work();
  }

  /**
   * Embeds what waits, one batch at a time, project after project, and again while any project has pieces waiting
   * (a save elsewhere meanwhile); stops at a problem with the embedder. A build of BOOKED_PIECES or more gets a
   * ledger line, and tells the project's editors how far it is.
   */
  async work() {
    if (this.working || this.state !== 'on') return;
    if (this.problem && this.now() - this.problemAt < RESCAN_MS) return;
    this.working = true;
    this.problem = null;
    let index = null;
    try {
      for (let more = true, passes = 0; more && passes < 10; passes++) { // a few passes at most: never a loop
        more = false;
        for (index of [...this.indexes.values()]) {
          const waiting = index.pending().length;
          if (!waiting) continue;
          more = true;
          const build = {startedAt: this.now(), chunks: waiting, toldAt: this.now()};
          // Each step embeds a batch or reads a changed file again: bounded all the same, never a spin.
          let steps = 0;
          const most = waiting + 50;
          const step = () => index.step().catch(error => {
            if (index.closed) return false; // closed under it: the session ended, or a rebuild
            throw error;
          });
          while (this.indexes.get(index.root) === index && steps++ < most && await step()) {
            if (build.chunks >= BOOKED_PIECES && this.now() - build.toldAt > PROGRESS_MS) {
              build.toldAt = this.now();
              index.told = true;
              const {chunks, embedded} = index.progress();
              this.tell(index.root, {phase: 'embedding', done: embedded, total: chunks});
            }
          }
          if (this.indexes.get(index.root) !== index) continue;
          if (build.chunks < BOOKED_PIECES) {
            if (index.told && !index.pending().length) { // the editors heard it start: they hear it end
              index.told = false;
              const {chunks, embedded} = index.progress();
              this.tell(index.root, {phase: 'done', done: embedded, total: chunks});
            }
            continue;
          }
          index.told = false;
          index.store.checkpoint();
          const {files, chunks, embedded, bytes} = index.progress();
          this.tell(index.root, {phase: 'done', done: embedded, total: chunks});
          this.book(index.root, 'indexed', `indexed ${build.chunks} piece${build.chunks === 1 ? '' : 's'} by meaning in ${seconds(this.now() - build.startedAt)}: ${files} files, ${chunks} pieces, ${Math.round(bytes / 1024)} KB`);
        }
      }
    } catch (error) {
      this.problem = error.message;
      this.problemAt = this.now();
      this.log(`meaning: indexing stops: ${error.message}`);
      if (index) this.tell(index.root, {phase: 'failed', text: error.message});
    } finally {
      this.working = false;
    }
  }

  /** The index of `root`, opened if it had no session yet, with what is on disk loaded (its scan may still run). */
  async indexOf(root) {
    const index = this.open(root);
    if (!index) return null;
    try {
      await index.loaded; // what is on disk; a scan under way is not waited for
    } catch {
      return null; // its file cannot be opened: said in the log, tried again at the next search
    }
    if (index.closed) return null; // its scan failed and closed it: tried again a minute later
    if (!this.working) index.ready.then(() => this.work()); // pieces still waiting (the model came since) are embedded
    return index;
  }

  /** How far the index of `root` is, for a search's answer. */
  about(index) {
    const {chunks, embedded, capped, reading} = index.progress();
    return {chunks, embedded, ...(capped ? {capped: MAX_PIECES} : {}), ...(reading ? {reading} : {})};
  }

  /** The word search in `root`: what a picker shows on every key. `{type: 'found', phase: 'words', results, ...}`. */
  async words(root, query, {limit = 30} = {}) {
    const answer = {phase: 'words', query, state: this.state, results: []};
    const index = await this.indexOf(root);
    if (!index) return this.disabled ? answer : {...answer, problem: UNOPENED};
    answer.results = await index.wordSearch(query, {limit});
    return Object.assign(answer, this.about(index));
  }

  /** The meaning search alone in `root`: what a picker adds once typing stops. Off, or failing, it says why. */
  async meaningOnly(root, query, {limit = 30} = {}) {
    const answer = {phase: 'meaning', query, state: this.state, results: []};
    if (this.state !== 'on') return answer;
    const index = await this.indexOf(root);
    if (!index) return {...answer, problem: UNOPENED};
    const started = this.now();
    try {
      answer.results = await index.meaningSearch(query, {limit});
      this.recovered();
    } catch (error) {
      this.failed(error);
      answer.problem = error.message;
    }
    return Object.assign(answer, {ms: this.now() - started}, this.about(index));
  }

  recovered() {
    if (!this.problem) return;
    this.problem = null; // the embedder runs again (the runtime was installed, say): the build goes on
    this.work();
  }

  failed(error) {
    this.problem = error.message;
    this.problemAt = this.now();
  }

  /**
   * What a search in the project at `root` finds, meaning and words fused: `{query, state, results, ...why}`. Without
   * meaning (off, or its model failing), the words alone, and why.
   */
  async search(root, query, {limit = 30, book = true} = {}) {
    const state = this.state;
    const answer = {query, state, results: []};
    const index = await this.indexOf(root);
    if (!index) return this.disabled ? answer : {...answer, problem: UNOPENED};
    const started = this.now();
    if (state !== 'on') answer.results = await index.wordSearch(query, {limit});
    else {
      try {
        answer.results = await index.search(query, {limit});
        this.recovered();
      } catch (error) {
        // The embedder cannot run: the words still rank, and the answer says why meaning is missing.
        this.failed(error);
        answer.problem = error.message;
        answer.results = await index.wordSearch(query, {limit});
      }
    }
    Object.assign(answer, {ms: this.now() - started}, this.about(index));
    if (book) this.booked(root, query, answer.results);
    return answer;
  }

  /** A search in the ledger, with its ranking behind ⏎. */
  booked(root, query, results, how = '') {
    const top = results[0];
    this.book(root, 'searched', `by meaning "${query}"${how}: ${results.length} result${results.length === 1 ? '' : 's'}${top ? `, first ${top.file}:${top.line}` : ''}`, {
      detail: {output: results.map(result => `${result.file}:${result.line}  ${result.meaning ?? '-'}${result.words ? ' +words' : ''}  ${result.head}`).join('\n')},
    });
  }

  /** `:Pair index rebuild`: the repository's index file is deleted and made again from the files, every vector too. */
  async rebuild(root) {
    if (this.disabled) return null;
    this.failures.delete(root);
    const index = this.indexes.get(root);
    if (index) await index.ready;
    // Its file, though it could not be opened: a broken one is what a rebuild is for.
    const path = index?.store?.path ?? (await indexPlace({dataDir: this.dataDir, root, where: this.config?.index})).path;
    const roots = [...new Set([root, ...[...this.indexes.values()].filter(each => each.store?.path === path).map(each => each.root)])];
    for (const each of roots) await this.leave(each);
    removeIndex(path);
    for (const each of roots) this.open(each);
    return path;
  }

  /**
   * What `turnOn` would fetch: `{runtime}` when LiteRT-LM is to be installed (with its wheel's size, or null without
   * one for this machine) and `model` when EmbeddingGemma is to be downloaded. Nothing for an "embedding" model.
   */
  async needs() {
    if (this.disabled || this.embedding) return {runtime: null, model: false};
    const model = !modelReady(this.dataDir);
    if (!this.runtime || this.config?.python) return {runtime: null, model}; // the config's Python is the user's to fill
    const found = await this.runtime.check();
    return {runtime: found.version === RUNTIME_VERSION ? null : {bytes: this.runtime.bytes}, model}; // an older one is installed again
  }

  /**
   * Installs LiteRT-LM and downloads the model, each once and only if missing, then indexes the projects that have a
   * session now. `progress({phase, bytes, total})` hears how far. Resolves `{runtime, model}`: what pip installed
   * (`{python, version, pythonVersion, made}`) or null, and whether the model was downloaded. Either failing, what it
   * half did is deleted (a venv it made, a .part file) and the word search goes on as before.
   */
  async turnOn({progress = () => {}} = {}) {
    if (this.disabled) throw new Error('search by meaning is turned off in the config ("meaning": false)');
    if (this.downloading) return this.downloading.done.then(() => ({runtime: null, model: false}));
    this.problem = null;
    const abort = new AbortController();
    const turning = this.downloading = {phase: null, bytes: 0, total: null, abort}; // a second :Pair find on waits for this one
    const told = (phase, bytes, total) => {
      Object.assign(turning, {phase, bytes, total});
      progress({phase, bytes, total});
    };
    turning.done = (async () => {
      await rm(offPath(this.dataDir), {force: true});
      const needs = await this.needs();
      if (abort.signal.aborted) throw abort.signal.reason;
      let runtime = null;
      if (needs.runtime) {
        told('runtime', 0, needs.runtime.bytes);
        runtime = await this.runtime.install({signal: abort.signal, progress: (bytes, total) => told('runtime', bytes, total)});
        this.log(`meaning: installed ${runtime.version} of LiteRT-LM in ${runtime.python}`);
      }
      if (needs.model) {
        told('model', 0, MODEL.bytes);
        await downloadModel(this.dataDir, {fetch: this.fetch, signal: abort.signal, progress: bytes => told('model', bytes, MODEL.bytes)});
      }
      return {runtime, model: needs.model};
    })().finally(() => { this.downloading = null; });
    const result = await turning.done;
    for (const root of [...this.wanted]) this.open(root); // the sessions open now, started meanwhile too
    this.work(); // a build a problem stopped goes on
    return result;
  }

  /**
   * Off again: the helper stops, and the model, every index and the venv Pair made leave Pair's data folder (and the
   * open projects). Resolves `{venv}`: whether Pair's venv went.
   */
  async turnOff() {
    if (this.downloading) { // a download under way stops, and leaves nothing
      this.downloading.abort.abort(new Error('search by meaning was turned off'));
      await this.downloading.done.catch(() => {});
    }
    const indexes = [...this.indexes.values()];
    this.indexes.clear();
    this.failures.clear();
    this.embedder.fail(new Error('search by meaning was turned off')); // a batch under way is dropped, not waited for
    this.problem = null;
    const paths = new Set();
    for (const index of indexes) {
      index.closed = true;
      await index.ready;
      if (index.store) paths.add(index.store.path);
      if (!index.failure) index.store?.release();
    }
    for (const path of paths) removeIndex(path);
    if (!this.embedding) await removeModel(this.dataDir); // the config's model is not Pair's to delete, nor is it asked any more
    const venv = !!await this.runtime?.remove({keep: this.keepVenv()}); // only a venv Pair made: never meaning.python; not while voice uses it
    await rm(join(this.dataDir, 'index'), {recursive: true, force: true});
    if (this.embedding) {
      await mkdir(meaningDir(this.dataDir), {recursive: true, mode: 0o700});
      await writeFile(offPath(this.dataDir), 'search by meaning was turned off (:Pair find off); :Pair find on turns it on\n');
    }
    await rm(join(meaningDir(this.dataDir), 'index'), {recursive: true, force: true}); // PAIR-5's, before SQLite
    return {venv};
  }

  /** The index's ranking of `query` in `root` for the search trail: the top pieces, or null when it has none. */
  async trailHits(root, query, limit = 2) {
    const index = this.indexes.get(root);
    // Only while the embedder answers at once: the trail does not wait for a model to load.
    if (this.state !== 'on' || !index || !index.vectors.size || this.problem || !this.embedder.ready) return null;
    await index.loaded;
    const hits = (await index.search(query, {limit})).filter(result => result.meaning !== null);
    this.book(root, 'searched', `by meaning "${query}", for the search trail: ${hits.map(hit => `${hit.file}:${hit.line}`).join(', ') || 'nothing close'}`);
    return hits;
  }

  /** For `pair doctor` and the daemon's status. */
  snapshot() {
    return {
      state: this.state, model: this.modelName, embedding: this.embedding ? {model: this.embedding.model, baseUrl: this.embedding.baseUrl} : null,
      revision: MODEL.revision, problem: this.problem, downloading: this.downloading?.phase === 'model' ? this.downloading.bytes : null,
      installing: this.downloading?.phase === 'runtime' ? this.downloading.bytes : null,
      python: typeof this.embedder.python === 'function' ? this.embedder.python() : this.embedder.python, runtime: this.embedder.runtime?.runtime ?? null, msPerChunk: this.embedder.msPerText,
      treeSitter: this.treeSitter.missing ? 'no nvim' : 'nvim',
      indexes: [...this.indexes.values()].filter(index => index.store).map(index => index.progress()),
    };
  }

  async close() {
    clearInterval(this.timer);
    for (const root of [...this.indexes.keys()]) await this.leave(root);
    this.embedder.close();
  }
}
