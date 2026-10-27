// Where each test of a run is: the file and line of its function (Go, Python, Rust), its test() call (jest, vitest,
// node), its `test "name"` block (Zig) or its add_test() (CMake), and the line it failed on. That is where the
// editor shows a test's result. How a runner says where a test is: see test-reports.mjs.
import {readdir, readFile} from 'node:fs/promises';
import {isAbsolute, join, sep} from 'node:path';

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The lines of each file, read once per call of placeTests; from `texts` (file -> text) where it has the file. */
function reader(texts) {
  const files = new Map();
  return file => {
    if (!files.has(file)) files.set(file, texts.has(file) ? Promise.resolve(texts.get(file).split('\n')) : readFile(file, 'utf8').then(text => text.split('\n'), () => null));
    return files.get(file);
  };
}

/** The directory of Go package `name` in the module at `root`, or null when it is another module's. */
async function packageDir(root, name, lines) {
  const module = /^module\s+(\S+)/m.exec((await lines(join(root, 'go.mod')))?.join('\n') ?? '')?.[1];
  if (name === module) return root;
  return module && name.startsWith(`${module}/`) ? join(root, name.slice(module.length + 1)) : null;
}

/** The file and line of `func Name(` among the _test.go files of `dir`. */
async function goFunction(dir, name, lines) {
  const files = (await readdir(dir).catch(() => [])).filter(file => file.endsWith('_test.go')).sort();
  const declaration = new RegExp(`^func ${escape(name)}\\(`);
  for (const file of files) {
    const index = (await lines(join(dir, file)))?.findIndex(line => declaration.test(line)) ?? -1;
    if (index !== -1) return {file: join(dir, file), line: index + 1};
  }
  return null;
}

/**
 * A pattern for a title in quotes that is filled in at run time: test.each's `%s`, `%i`, `$name` and `%#`, or a
 * template string's `${...}`. Null for a title with none of them.
 */
function titlePattern(written) {
  const parts = written.split(/(%[sdifjoOp#]|\$\{[^}]*\}|\$[\w.]+)/);
  if (parts.length === 1) return null;
  return new RegExp(`^${parts.map((part, i) => (i % 2 ? '.+?' : escape(part))).join('')}$`, 's');
}

const QUOTED = /(['"`])((?:\\.|(?!\1).)*)\1/g;

/**
 * The line of the test() or it() call named `title` in `file`: the first line with the title in quotes, else the
 * first whose title in quotes is filled in at run time to give it (test.each, a template string).
 */
async function jsCall(file, title, lines) {
  const text = await lines(file);
  if (!text) return null;
  const quoted = ["'", '"', '`'].map(quote => `${quote}${title}${quote}`);
  let index = text.findIndex(line => quoted.some(written => line.includes(written)));
  if (index === -1) index = text.findIndex(line => [...line.matchAll(QUOTED)].some(([, , written]) => titlePattern(written)?.test(title)));
  return index === -1 ? null : index + 1;
}

// How each kind of declaration is written, and the files to look in.
const DECLARATIONS = {
  python: {files: /\.py$/, line: name => new RegExp(`^\\s*(?:async\\s+)?def ${escape(name)}\\(`)},
  rust: {files: /\.rs$/, line: name => new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?fn ${escape(name)}\\s*[<(]`)},
  zig: {files: /\.zig$/, line: name => new RegExp(`^\\s*test\\s+(?:"${escape(name)}"|${escape(name)})\\s*\\{`)},
  ctest: {files: /(^|\/)CMakeLists\.txt$/, line: name => new RegExp(`\\badd_test\\s*\\(\\s*(?:NAME\\s+)?"?${escape(name)}"?[\\s)]`)},
};

// Folders no test is declared in: dependencies and build output.
const SKIPPED = new Set(['.git', 'node_modules', 'target', 'build', 'dist', '.venv', 'venv', '__pycache__', '.zig-cache', 'zig-cache', 'zig-out', '.pytest_cache']);
const MAX_LISTED = 20_000;

/** The files of the project at `root`, relative to it, without the SKIPPED folders; listed once per placeTests. */
function lister(root) {
  let files = null;
  const walk = async (dir, found) => {
    for (const entry of await readdir(join(root, dir), {withFileTypes: true}).catch(() => [])) {
      if (found.length >= MAX_LISTED) return;
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !SKIPPED.has(entry.name)) await walk(path, found);
      else if (entry.isFile()) found.push(path);
    }
    return found;
  };
  return () => (files ??= walk('', []));
}

/** Whether line `index` of `text` is inside `mod <module>`: the nearest `mod` above it is that one. */
const inModule = (text, index, module) => {
  const above = text.slice(0, index).reverse().map(line => /^\s*(?:pub(?:\([^)]*\))?\s+)?mod (\w+)/.exec(line)).find(Boolean);
  return above?.[1] === module;
};

/**
 * The place of declaration `find` ({kind, name, files, module}) in the project: in the files ending with one of
 * `files` first. A Rust test's `module` (tests in tests::inner::adds) picks among fns of the same name.
 */
async function declaration(root, {kind, name, files: hints = [], module}, lines, list) {
  const {files, line} = DECLARATIONS[kind];
  const pattern = line(name);
  const all = (await list()).filter(file => files.test(file));
  const hinted = hints.flatMap(hint => all.filter(file => file === hint || file.endsWith(`/${hint}`) || join(root, file) === hint));
  const rest = hints.length && kind !== 'rust' ? [] : all; // a Rust unit test may be in any file of its crate
  let first = null;
  for (const file of [...new Set([...hinted, ...rest])]) {
    const text = (await lines(join(root, file))) ?? [];
    for (let index = 0; index < text.length; index++) {
      if (!pattern.test(text[index])) continue;
      const place = {file: join(root, file), line: index + 1};
      if (!module || inModule(text, index, module)) return place;
      first ??= place;
    }
  }
  return first;
}

const inside = (root, file) => file.startsWith(root + sep);
const absolute = (root, file) => (!file || isAbsolute(file) ? file : join(root, file));

/**
 * The tests of a run (see test-output.mjs) as the editor shows them: `{name, file, line, ok, failure}`
 * with absolute paths inside `root`, failure `{file, line, text}` or null. Tests that did not run, and tests
 * whose place is not found, are left out. `texts` maps files to their text where the run saw another than the disk's.
 */
export async function placeTests(tests, root, texts = new Map()) {
  const lines = reader(texts);
  const list = lister(root);
  const placed = [];
  for (const test of tests.filter(test => test.status !== 'skipped')) {
    let place = null;
    let failure = test.failure;
    if (test.package) {
      const dir = await packageDir(root, test.package, lines);
      place = dir && (await goFunction(dir, test.name, lines));
      // Go names the file of a failed assertion without its directory: it is in the test's package.
      if (dir && failure?.file && !isAbsolute(failure.file)) failure = {...failure, file: join(dir, failure.file)};
    } else if (test.find) {
      place = await declaration(root, test.find, lines, list);
    } else if (test.line) {
      place = {file: absolute(root, test.file), line: test.line};
    } else {
      for (const file of (test.file ? [test.file] : test.files ?? []).map(file => absolute(root, file))) {
        const line = await jsCall(file, test.title, lines);
        if (line) { place = {file, line}; break; }
      }
    }
    if (!place || !inside(root, place.file)) continue;
    if (failure) failure = {...failure, file: absolute(root, failure.file)};
    if (failure && !(failure.file && failure.line && inside(root, failure.file))) failure = {file: null, line: null, text: failure.text};
    placed.push({name: test.name, file: place.file, line: place.line, ok: test.status === 'passed', failure});
  }
  return placed;
}
