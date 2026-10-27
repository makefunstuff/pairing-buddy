// The tests' temp dirs: every one under the run's root in $TMPDIR, and a test file that leaves one behind fails,
// named. Also that no test makes a temp dir of its own, past test/temp.mjs.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {scratch} from './temp.mjs';

const TESTS = fileURLToPath(new URL('.', import.meta.url));
const TEMP = new URL('./temp.mjs', import.meta.url).href;
const RUN = fileURLToPath(new URL('./run.mjs', import.meta.url));
// This file runs in a test process, whose NODE_TEST_CONTEXT would make a nested `node --test` report to this one.
const {NODE_TEST_CONTEXT, ...ENV} = process.env;

/** Every .mjs under test/, but for the fixtures. */
function sources(dir = TESTS) {
  return readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'fixtures' ? [] : sources(path);
    return entry.name.endsWith('.mjs') ? [path] : [];
  });
}

/** A test file in a scratch folder: `body` runs in one test, with test/temp.mjs imported as the tests do. */
function testFile(name, body) {
  const path = join(scratch('pair-guard-'), name);
  writeFileSync(path, `import {test} from 'node:test';\nimport {spawn} from 'node:child_process';\nimport {mkdirSync} from 'node:fs';\nimport {tmpdir} from 'node:os';\nimport {join} from 'node:path';\nimport {scratch} from '${TEMP}';\ntest('it', async () => { ${body} });\n`);
  return path;
}

/** Runs `node --test` on `file` as test/run.mjs runs each file, with `root` as the run's root. */
function runFile(file, root) {
  return spawnSync(process.execPath, ['--import', TEMP, '--test', file], {encoding: 'utf8', env: {...ENV, PAIR_TEST_ROOT: root}});
}

test('no test makes a temp dir past test/temp.mjs: no mkdtemp, no tmpdir(), no dir made in /tmp', () => {
  const own = new Set(['temp.mjs', 'run.mjs', 'temp.test.mjs'].map(name => join(TESTS, name)));
  const found = sources().filter(path => !own.has(path)).flatMap(path => readFileSync(path, 'utf8').split('\n')
    .map((line, i) => /mkdtemp|tmpdir\(\)|\(\s*['"`]\/tmp\//.test(line) ? `${relative(TESTS, path)}:${i + 1}: ${line.trim()}` : null)
    .filter(Boolean));
  assert.deepEqual(found, [], 'make temp dirs with scratch() or socketDir() from test/temp.mjs');
});

test('a test file that leaves something in the temp dir fails, named with what it left; the folder goes anyway', () => {
  const root = scratch('pair-root-');
  const file = testFile('leaky.test.mjs', `mkdirSync(join(tmpdir(), 'pair-leak-x')); scratch('pair-kept-');`);
  const result = runFile(file, root);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, new RegExp(`temp dir leak: ${file} left pair-leak-x in ${root}/leaky-`));
  assert.doesNotMatch(result.stdout + result.stderr, /pair-kept-/, 'scratch() dirs are removed, not leaks');
  assert.deepEqual(readdirSync(root), []);
});

test('a file that cleans up passes, its scratch dirs in its own folder of the run\'s root, and a process it left running is stopped first', () => {
  const root = scratch('pair-root-');
  const file = testFile('tidy.test.mjs', `
    const dir = scratch('pair-tidy-');
    if (!dir.startsWith(join(${JSON.stringify(root)}, 'tidy-')) || tmpdir() !== join(dir, '..')) throw new Error(dir + ' ' + tmpdir());
    // A Neovim it forgot to stop, which would write into its folder until it is stopped.
    const child = spawn('sh', ['-c', 'trap "" HUP; while :; do touch "$0/alive"; sleep 0.05; done', dir], {stdio: 'ignore'});
    child.unref();
    console.log('# pid ' + child.pid);
    await new Promise(resolve => setTimeout(resolve, 200));`);
  const result = runFile(file, root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /leak/);
  assert.deepEqual(readdirSync(root), []);
  const pid = Number(result.stdout.match(/# pid (\d+)/)[1]);
  assert.throws(() => process.kill(pid, 0), 'the process was stopped');
});

test('npm test\'s runner keeps the run under one root in $TMPDIR, removes it, and fails the run on a leak', () => {
  const outer = scratch('pair-tmpdir-');
  const run = (...files) => spawnSync(process.execPath, [RUN, ...files], {encoding: 'utf8', env: {...ENV, TMPDIR: outer, PAIR_TEST_ROOT: ''}});
  const tidy = run(testFile('tidy.test.mjs', `scratch('pair-tidy-');`));
  assert.equal(tidy.status, 0, tidy.stdout + tidy.stderr);
  assert.deepEqual(readdirSync(outer), [], 'the root is gone');
  const leaky = testFile('leaky.test.mjs', `mkdirSync(join(tmpdir(), 'pair-leak-y'));`);
  const result = run(leaky);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, new RegExp(`temp dir leak: ${leaky} left pair-leak-y in ${outer}/pair-test-\\w+/leaky-`));
  assert.deepEqual(readdirSync(outer), []);
  assert.equal(existsSync(join(outer, 'pair-leak-y')), false);
});
