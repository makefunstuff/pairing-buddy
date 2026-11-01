// Search by meaning's pieces of a file: its functions, classes and methods, each with its doc comment, found by
// Neovim's tree-sitter in a headless Neovim (pieces.lua) where Neovim has a parser for the file's language; the lines
// between them, and whole files without a parser, in blocks cut at blank lines. A piece is at most PIECE.lines lines
// and PIECE.chars characters, about 400 tokens: under the embedder's 512.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readMessages} from './protocol.mjs';

export const PIECE = {lines: 60, chars: 1500};
const HELPER = fileURLToPath(new URL('./pieces.lua', import.meta.url));
const FILE_MS = 5000; // one file's parse; past this the helper is stuck and the rest goes by blank lines

/**
 * Cuts lines `from`..`to` of `lines` (counted from 1) into chunks of at most PIECE.lines lines and PIECE.chars
 * characters: `{from, to}`. A chunk ends at a blank line when one is in its second half, so a function stays whole
 * where it can; a line longer than a chunk is a chunk of its own.
 */
export function cut(lines, from = 1, to = lines.length) {
  const chunks = [];
  let start = from - 1;
  while (start < to) {
    let end = start;
    let chars = 0;
    while (end < to && end - start < PIECE.lines && chars + lines[end].length + 1 <= PIECE.chars) chars += lines[end++].length + 1;
    if (end === start) end = start + 1;
    else if (end < to) {
      for (let i = end - 1; i > start + (end - start) / 2; i--) {
        if (!lines[i].trim()) { end = i + 1; break; }
      }
    }
    chunks.push({from: start + 1, to: end});
    start = end;
  }
  return chunks;
}

/**
 * Lines `from`..`to` in blocks: the runs of lines between blank lines, small neighbours together up to a piece's
 * size, a long one cut (see `cut`). Blocks with nothing but punctuation in them (a lone `}`) are left out.
 */
export function blocks(lines, from = 1, to = lines.length) {
  const out = [];
  let block = null;
  const close = () => {
    if (block) out.push(...cut(lines, block.from, block.to));
    block = null;
  };
  for (let i = from - 1; i < to; i++) {
    if (!lines[i].trim()) continue;
    let end = i;
    while (end + 1 < to && lines[end + 1].trim()) end++;
    const size = lines.slice(i, end + 1).reduce((sum, line) => sum + line.length + 1, 0);
    if (block && end + 1 - block.from + 1 <= PIECE.lines && block.chars + size <= PIECE.chars) {
      block.to = end + 1;
      block.chars += size;
    } else {
      close();
      block = {from: i + 1, to: end + 1, chars: size};
    }
    i = end;
  }
  close();
  return out.filter(piece => /[\p{L}\p{N}]/u.test(lines.slice(piece.from - 1, piece.to).join('\n')));
}

/**
 * The pieces of `text`: `{from, to, kind, name, text}`, in order. `found` is tree-sitter's (see pieces.lua), or null
 * without a parser: then the whole file goes in blocks. A piece too big is cut, each part keeping its name.
 */
export function piecesOf(text, found = null) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const out = [];
  const add = (from, to, kind, name) => {
    const body = lines.slice(from - 1, to).join('\n');
    if (body.trim()) out.push({from, to, kind, name: name ?? null, text: body});
  };
  const gap = (from, to) => { for (const block of blocks(lines, from, to)) add(block.from, block.to, 'block', null); };
  let next = 1;
  for (const piece of (Array.isArray(found) ? found : []).toSorted((a, b) => a.from - b.from)) {
    const from = Math.max(piece.from, next);
    const to = Math.min(piece.to, lines.length);
    if (to < from) continue;
    if (from > next) gap(next, from - 1);
    const kind = piece.kind ?? 'definition';
    const size = lines.slice(from - 1, to).reduce((sum, line) => sum + line.length + 1, 0);
    if (to - from + 1 <= PIECE.lines && size <= PIECE.chars) add(from, to, kind, piece.name);
    else for (const part of cut(lines, from, to)) add(part.from, part.to, kind, piece.name);
    next = to + 1;
  }
  if (next <= lines.length) gap(next, lines.length);
  return out;
}

/**
 * The headless Neovim that finds pieces with tree-sitter. `definitions(paths)` answers a Map of each absolute path to
 * its pieces, or to null where no parser reads it (or Neovim is not there): those files go by blank lines. One
 * Neovim per call, for all its files; `parsers()` lists the parser files the user's Neovim has (see pair/init.lua).
 */
export class TreeSitter {
  constructor({nvim = 'nvim', parsers = () => [], log = () => {}} = {}) {
    Object.assign(this, {nvim, parsers, log});
    this.missing = false; // no Neovim to run: every file goes by blank lines, without trying again
    this.helper = HELPER;
  }

  definitions(paths) {
    const found = new Map(paths.map(path => [path, null]));
    if (this.missing || !paths.length) return Promise.resolve(found);
    return new Promise(resolve => {
      let child;
      try {
        child = spawn(this.nvim, ['--headless', '-u', 'NONE', '-i', 'NONE', '-n', '-l', this.helper], {stdio: ['pipe', 'pipe', 'ignore']});
      } catch {
        this.missing = true;
        return resolve(found);
      }
      let answered = 0;
      let timer;
      const done = () => {
        clearTimeout(timer);
        if (child.exitCode === null) child.kill('SIGKILL');
        resolve(found);
      };
      const wait = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          this.log(`pieces: tree-sitter took over ${FILE_MS / 1000} s for one file; the rest go by blank lines`);
          done();
        }, FILE_MS);
      };
      child.on('error', error => {
        if (error.code === 'ENOENT') this.missing = true;
        done();
      });
      child.on('exit', done);
      child.stdin.on('error', () => {});
      readMessages(child.stdout, message => {
        const path = paths[message.id];
        if (path !== undefined) found.set(path, Array.isArray(message.pieces) ? message.pieces : message.lang ? [] : null);
        if (++answered === paths.length) done();
        else wait();
      });
      wait();
      const parsers = this.parsers();
      if (parsers.length) child.stdin.write(`${JSON.stringify({parsers})}\n`);
      paths.forEach((path, id) => child.stdin.write(`${JSON.stringify({id, path})}\n`));
      child.stdin.end();
    });
  }
}
