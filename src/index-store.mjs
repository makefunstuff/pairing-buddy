// Search by meaning's index on disk: one SQLite file per repository, shared by its worktrees. It holds where each piece
// of code is (its file and lines, the hash of its text, its kind and name), the words of each piece for the word search
// (an FTS5 index without the text it was made from), and a vector per piece's hash and embedding model: worktrees of
// one repository embed a piece of code they share once. No copy of the code is kept; its lines are read from the files.
// The file is in Pair's data folder (index/<repository>-<hash>.sqlite), or with "meaning": {"index": "project"} in the
// repository as .pair/index.sqlite, listed in .git/info/exclude rather than .gitignore.
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {appendFileSync, mkdirSync, readFileSync, rmSync, statSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const SCHEMA = 3;

const git = (args, cwd) => new Promise(resolve => {
  execFile('git', args, {cwd}, (error, stdout) => resolve(error ? null : stdout.trim()));
});

/**
 * Where the index of the project at `root` is: `{path, repository, tree}`. Worktrees of one repository share a file:
 * it is named by the repository's git folder. In the project (`where` "project"), it is .pair/index.sqlite in the
 * repository's main worktree, and .pair/ goes in the repository's info/exclude.
 */
export async function indexPlace({dataDir, root, where = 'data'}) {
  const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], root);
  const repository = common ? (basename(common) === '.git' ? dirname(common) : common) : root;
  if (where === 'project') {
    if (common) exclude(common);
    return {path: join(repository, '.pair', 'index.sqlite'), repository, tree: root};
  }
  const name = basename(repository).replace(/\.git$/, '').replace(/[^\w.-]+/g, '-') || 'project';
  const hash = createHash('sha1').update(common ?? root).digest('hex').slice(0, 8);
  return {path: join(dataDir, 'index', `${name}-${hash}.sqlite`), repository, tree: root};
}

/** Lists .pair/ in the repository's info/exclude, once: git leaves the index out, and .gitignore stays the team's. */
export function exclude(common) {
  const path = join(common, 'info', 'exclude');
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch {}
  if (text.split('\n').some(line => ['.pair/', '.pair', '/.pair/', '/.pair'].includes(line.trim()))) return false;
  mkdirSync(dirname(path), {recursive: true});
  appendFileSync(path, `${text && !text.endsWith('\n') ? '\n' : ''}# Pair's search index (see Pair's docs/meaning.md)\n.pair/\n`);
  return true;
}

const vectorOf = blob => new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));

/** The FTS5 query for `terms` (words already split and lower case): every one, each as the start of a word. */
export function matchOf(terms) {
  return terms.map(term => (term.length > 2 ? `"${term}"*` : `"${term}"`)).join(' AND ');
}

const opened = new Map(); // path -> {store, users}

/** One repository's index file. `IndexStore.open(path)` shares it between the worktrees open at once. */
export class IndexStore {
  static open(path) {
    let entry = opened.get(path);
    if (!entry) {
      entry = {store: new IndexStore(path), users: 0};
      opened.set(path, entry);
    }
    entry.users += 1;
    return entry.store;
  }

  constructor(path) {
    this.path = path;
    mkdirSync(dirname(path), {recursive: true, mode: 0o700});
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version !== SCHEMA) {
      // Made by another version of Pair (or empty): made again, from the files.
      this.db.exec('DROP TABLE IF EXISTS vectors; DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS pieces; DROP TABLE IF EXISTS words; DROP TABLE IF EXISTS meta');
      this.db.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
        CREATE TABLE vectors (model TEXT NOT NULL, hash TEXT NOT NULL, vector BLOB NOT NULL); -- rows of 1 KB and more: no WITHOUT ROWID
        CREATE UNIQUE INDEX vectors_key ON vectors (model, hash);
        CREATE TABLE files (tree TEXT NOT NULL, file TEXT NOT NULL, size INTEGER, mtime REAL, skipped INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tree, file)) WITHOUT ROWID;
        CREATE TABLE pieces (id INTEGER PRIMARY KEY, tree TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, last INTEGER NOT NULL, hash TEXT NOT NULL, kind TEXT, name TEXT);
        CREATE INDEX pieces_file ON pieces (tree, file);
        CREATE INDEX pieces_hash ON pieces (hash);
        CREATE VIRTUAL TABLE words USING fts5 (body, content = '', contentless_delete = 1, tokenize = 'porter unicode61');
        PRAGMA user_version = ${SCHEMA};
      `);
    }
    this.statements = {
      files: this.db.prepare('SELECT file, size, mtime, skipped FROM files WHERE tree = ?'),
      pieces: this.db.prepare('SELECT id, file, line, last, hash, kind, name FROM pieces WHERE tree = ? ORDER BY file, line'),
      piecesOf: this.db.prepare('SELECT id FROM pieces WHERE tree = ? AND file = ?'),
      deleteWords: this.db.prepare('DELETE FROM words WHERE rowid = ?'),
      deletePieces: this.db.prepare('DELETE FROM pieces WHERE tree = ? AND file = ?'),
      deleteFile: this.db.prepare('DELETE FROM files WHERE tree = ? AND file = ?'),
      putFile: this.db.prepare('INSERT OR REPLACE INTO files (tree, file, size, mtime, skipped) VALUES (?, ?, ?, ?, ?)'),
      putPiece: this.db.prepare('INSERT INTO pieces (tree, file, line, last, hash, kind, name) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      putWords: this.db.prepare('INSERT INTO words (rowid, body) VALUES (?, ?)'),
      vector: this.db.prepare('SELECT vector FROM vectors WHERE model = ? AND hash = ?'),
      vectors: this.db.prepare('SELECT v.hash, v.vector FROM vectors v WHERE v.model = ? AND v.hash IN (SELECT hash FROM pieces WHERE tree = ?)'),
      putVector: this.db.prepare('INSERT OR REPLACE INTO vectors (model, hash, vector) VALUES (?, ?, ?)'),
      search: this.db.prepare('SELECT p.id AS id FROM words JOIN pieces p ON p.id = words.rowid WHERE words MATCH ? AND p.tree = ? ORDER BY bm25(words) LIMIT ?'),
      getMeta: this.db.prepare('SELECT value FROM meta WHERE key = ?'),
      putMeta: this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),
    };
  }

  transaction(work) {
    this.db.exec('BEGIN');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** The files of worktree `tree` as last read: file -> {size, mtimeMs, skipped}. */
  files(tree) {
    return new Map(this.statements.files.all(tree).map(row => [row.file, {size: row.size, mtimeMs: row.mtime, skipped: !!row.skipped}]));
  }

  /** The pieces of worktree `tree`: `{id, file, from, to, hash, kind, name}`. */
  pieces(tree) {
    return this.statements.pieces.all(tree).map(row => ({id: row.id, file: row.file, from: row.line, to: row.last, hash: row.hash, kind: row.kind, name: row.name}));
  }

  /**
   * A file read again: its pieces (`{from, to, hash, kind, name, words}`) replace the ones it had, in one go; each comes
   * back with its id. `skipped` keeps a file found not worth indexing (binary, minified) from being read again.
   */
  putFile(tree, file, {size, mtimeMs, skipped = false}, pieces = []) {
    return this.transaction(() => {
      this.dropPieces(tree, file);
      this.statements.putFile.run(tree, file, size, mtimeMs, skipped ? 1 : 0);
      return pieces.map(piece => {
        const {lastInsertRowid} = this.statements.putPiece.run(tree, file, piece.from, piece.to, piece.hash, piece.kind ?? null, piece.name ?? null);
        this.statements.putWords.run(lastInsertRowid, piece.words);
        return {id: Number(lastInsertRowid), file, from: piece.from, to: piece.to, hash: piece.hash, kind: piece.kind ?? null, name: piece.name ?? null};
      });
    });
  }

  dropPieces(tree, file) {
    for (const {id} of this.statements.piecesOf.all(tree, file)) this.statements.deleteWords.run(id);
    this.statements.deletePieces.run(tree, file);
  }

  /** A file gone from worktree `tree`. */
  removeFile(tree, file) {
    this.transaction(() => {
      this.dropPieces(tree, file);
      this.statements.deleteFile.run(tree, file);
    });
  }

  /** The vectors of `model` for the pieces of worktree `tree`: hash -> Float32Array. */
  vectors(model, tree) {
    return new Map(this.statements.vectors.all(model, tree).map(row => [row.hash, vectorOf(row.vector)]));
  }

  /** The vector of `model` for one hash, made in any worktree; or null. */
  vector(model, hash) {
    const row = this.statements.vector.get(model, hash);
    return row ? vectorOf(row.vector) : null;
  }

  putVectors(model, entries) {
    this.transaction(() => {
      for (const [hash, vector] of entries) this.statements.putVector.run(model, hash, new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));
    });
    this.touch();
  }

  /** The ids of worktree `tree`'s pieces that have every one of `terms`, best first by BM25. */
  wordSearch(tree, terms, limit) {
    if (!terms.length) return [];
    return this.statements.search.all(matchOf(terms), tree, limit).map(row => row.id);
  }

  /** Vectors no piece of any worktree has any more, or of another model, leave. */
  prune(model) {
    this.db.prepare('DELETE FROM vectors WHERE model != ? OR hash NOT IN (SELECT hash FROM pieces)').run(model);
  }

  /** Worktrees whose folders are gone leave the index, with their pieces. */
  forgetTrees(exists) {
    const trees = this.db.prepare('SELECT DISTINCT tree FROM files').all().map(row => row.tree);
    for (const tree of trees.filter(tree => !exists(tree))) {
      this.transaction(() => {
        for (const {file} of this.statements.files.all(tree)) this.dropPieces(tree, file);
        this.db.prepare('DELETE FROM files WHERE tree = ?').run(tree);
      });
    }
  }

  meta(key, value) {
    if (value === undefined) return this.statements.getMeta.get(key)?.value ?? null;
    this.statements.putMeta.run(key, String(value));
  }

  touch() { this.meta('updatedAt', Date.now()); }

  /** The write-ahead log folded into the file and emptied: after a build, it would otherwise stay as big as the build. */
  checkpoint() {
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
  }

  /** The file's size on disk (with its write-ahead log) and when a vector last came. */
  stats() {
    let bytes = 0;
    for (const suffix of ['', '-wal']) {
      try { bytes += statSync(`${this.path}${suffix}`).size; } catch {}
    }
    const updatedAt = Number(this.meta('updatedAt')) || null;
    return {path: this.path, bytes, updatedAt};
  }

  /** One worktree is done with the file; the last one closes it. */
  release() {
    const entry = opened.get(this.path);
    if (entry && --entry.users > 0) return;
    opened.delete(this.path);
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.checkpoint();
    this.db.close();
  }
}

/** Deletes an index file with its write-ahead log; the store must be closed. */
export function removeIndex(path) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, {force: true});
}
