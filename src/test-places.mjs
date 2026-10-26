// Where each test of a JSON report is: the file and line of its function (Go) or its test() call (jest, vitest),
// and the line it failed on. That is where the editor shows a test's result.
import {readdir, readFile} from 'node:fs/promises';
import {isAbsolute, join, sep} from 'node:path';

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The lines of each file, read once per call of placeTests. */
function reader() {
  const files = new Map();
  return file => {
    if (!files.has(file)) files.set(file, readFile(file, 'utf8').then(text => text.split('\n'), () => null));
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

/** The line of the test() or it() call named `title` in `file`: the first line with the title in quotes. */
async function jsCall(file, title, lines) {
  const quoted = ["'", '"', '`'].map(quote => `${quote}${title}${quote}`);
  const index = (await lines(file))?.findIndex(line => quoted.some(text => line.includes(text))) ?? -1;
  return index === -1 ? null : index + 1;
}

const inside = (root, file) => file.startsWith(root + sep);

/**
 * The tests of a JSON report (see test-output.mjs) as the editor shows them: `{name, file, line, ok, failure}`
 * with absolute paths inside `root`, failure `{file, line, text}` or null. Tests that did not run, and tests
 * whose place is not found, are left out.
 */
export async function placeTests(tests, root) {
  const lines = reader();
  const placed = [];
  for (const test of tests.filter(test => test.status !== 'skipped')) {
    let place = null;
    let failure = test.failure;
    if (test.package) {
      const dir = await packageDir(root, test.package, lines);
      place = dir && (await goFunction(dir, test.name, lines));
      // Go names the file of a failed assertion without its directory: it is in the test's package.
      if (dir && failure?.file && !isAbsolute(failure.file)) failure = {...failure, file: join(dir, failure.file)};
    } else {
      const line = test.line ?? (await jsCall(test.file, test.title, lines));
      place = line && {file: test.file, line};
    }
    if (!place || !inside(root, place.file)) continue;
    if (failure && !(failure.file && failure.line && inside(root, failure.file))) failure = {file: null, line: null, text: failure.text};
    placed.push({name: test.name, file: place.file, line: place.line, ok: test.status === 'passed', failure});
  }
  return placed;
}
