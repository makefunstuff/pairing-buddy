// The debug lines of a hunt: the print statements the user added in this session to see what the program does
// (a printf, std.debug.print, fmt.println, console.log). A rule, not a model: once the hunt is over, the ones still
// in the code are offered for clean-up. A print that was in the file before the session is the program's own output.
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

// The print calls of each language, at the start of a statement (or behind an if, as in `if (e < 6) printf(...)`).
const C = String.raw`(?:printf|fprintf\s*\(\s*stderr|puts|fputs|std::(?:cout|cerr)|std::print(?:ln)?)\b`;
const PRINTS = [
  {files: /\.(c|h|cc|cpp|cxx|hpp|hh|m)$/, call: C},
  {files: /\.zig$/, call: String.raw`std\.(?:debug\.print|log\.(?:debug|info|warn|err))\b|print\(`},
  {files: /\.odin$/, call: String.raw`fmt\.(?:e?print(?:f|ln|fln)?)\b`},
  {files: /\.c3i?$/, call: String.raw`io::(?:print(?:n|f|fn)?|eprint(?:n|f|fn)?)\b`},
  {files: /\.go$/, call: String.raw`(?:fmt\.(?:Print|Printf|Println|Fprint(?:f|ln)?\(\s*os\.Stderr)|log\.(?:Print|Printf|Println)|println|print)\b`},
  {files: /\.rs$/, call: String.raw`(?:dbg|println|eprintln|print|eprint)!`},
  {files: /\.(js|mjs|cjs|ts|tsx|jsx)$/, call: String.raw`console\.(?:log|error|debug|warn|dir)\b`},
  {files: /\.py$/, call: String.raw`print\(`},
  {files: /\.lua$/, call: String.raw`(?:print|vim\.print)\(`},
];
// What may stand before the call on its line: indentation, and a short condition (`if (e < 6) `, `if x < 6 {`).
const LEAD = String.raw`^\s*(?:(?:if|when)\b[^;{]*?[){]?\s*|\}\s*else\s*)?`;

/** Whether `text`, one line of `file`, is a print statement: a debug line when the user added it. */
export function isDebugLine(file, text) {
  const print = PRINTS.find(({files}) => files.test(file));
  return !!print && new RegExp(`${LEAD}${print.call}`).test(text);
}

// A format's placeholders: C's %d and %.2f, Zig's {} and {d}, Odin's %v, C3's %s.
const PLACEHOLDER = /%[-+ #0]*\d*(?:\.\d+)?(?:hh|h|ll|l|z|j|t|L)?[diouxXfFeEgGaAcspv]|\{[^{}]*\}/g;

/**
 * How many lines of `output` the print statement `text` printed: its format string, the placeholders standing for
 * any word. Null when it has no format string to tell its lines by.
 */
export function printedBy(text, output) {
  const format = /"((?:[^"\\]|\\.)*)"/.exec(text)?.[1].replace(/\\n$/, '').replace(/\\t/g, '\t');
  if (!format || !format.replace(PLACEHOLDER, '').trim()) return null; // "%d\n" alone would match any line
  if (format.includes('\\n')) return null; // several lines in one call
  const pattern = format.split(PLACEHOLDER).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\S+');
  const line = new RegExp(`^${pattern}$`);
  return output.split('\n').filter(printed => line.test(printed.trimEnd())).length;
}

export class DebugLines {
  /**
   * `read(path)` is the text of a file of the project at `root` as the user sees it (the editor's buffer, else the
   * disk). Each file's baseline is read from the disk when the user first edits it: its lines then are not theirs.
   */
  constructor({root, read}) {
    Object.assign(this, {root, read});
    this.baselines = new Map(); // file -> Promise<Set of its trimmed lines before the user's first edit>
    this.added = []; // {file, text, run}: the debug lines the user typed, with the run they came before
  }

  /** The user's edit of `file` (relative to the root) put `text` there, before run number `run`. */
  async edited(file, text, run) {
    if (!this.baselines.has(file)) {
      this.baselines.set(file, readFile(join(this.root, file), 'utf8').then(lines, () => new Set()));
    }
    const before = await this.baselines.get(file);
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!isDebugLine(file, line) || before.has(trimmed) || this.added.some(added => added.file === file && added.text === trimmed)) continue;
      this.added.push({file, text: trimmed, run});
    }
  }

  /** The debug lines still in the code, `{file, line, text, run}`, in the order the user added them. */
  async left() {
    const found = [];
    const texts = new Map();
    for (const added of this.added) {
      if (!texts.has(added.file)) texts.set(added.file, await this.read(join(this.root, added.file)).catch(() => ''));
      const at = texts.get(added.file).split('\n').findIndex(line => line.trim() === added.text);
      if (at >= 0) found.push({...added, line: at + 1});
    }
    // One deleted is gone for good: typing it again is a new debug line, of a later run.
    this.added = this.added.filter(added => found.some(left => left.file === added.file && left.text === added.text));
    return found;
  }
}

const lines = text => new Set(text.split('\n').map(line => line.trim()));
