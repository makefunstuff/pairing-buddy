// Tests on unsaved text: go test reads it through -overlay, other runners in a copy of the project.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {parseTestOutput} from '../src/test-output.mjs';
import {placeTests} from '../src/test-places.mjs';
import {overlaid, prepareUnsaved} from '../src/unsaved.mjs';

const has = command => { try { execFileSync(command, ['version']); return true; } catch { return false; } };

const scratch = () => mkdtempSync(join(tmpdir(), 'pair-unsaved-run-'));

function git(root) {
  execFileSync('git', ['init', '-q'], {cwd: root});
  execFileSync('git', ['add', '.'], {cwd: root});
}

function project(files) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pair-unsaved-')));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), {recursive: true});
    writeFileSync(join(root, path), text);
  }
  return root;
}

test('go test reads the overlay wherever the command runs it; other commands have none', () => {
  assert.equal(overlaid('go test -json ./...', '/d/o.json'), "go test -overlay '/d/o.json' -json ./...");
  assert.equal(overlaid('cd api && go test -json ./...', '/d/o.json'), "cd api && go test -overlay '/d/o.json' -json ./...");
  assert.equal(overlaid('npx vitest run --reporter=json', '/d/o.json'), null);
  assert.equal(overlaid('mygo test', '/d/o.json'), null);
});

test('go test on the unsaved buffer: the buffer\'s fix passes while the file on disk still fails, and tests are placed at the buffer\'s lines', {skip: has('go') ? false : 'go not installed'}, async () => {
  const broken = 'package cart\n\nfunc Total(prices []int) int {\n\tsum := 0\n\tfor i := 1; i < len(prices); i++ {\n\t\tsum += prices[i]\n\t}\n\treturn sum\n}\n';
  const root = project({
    'go.mod': 'module example.com/shop\n\ngo 1.22\n',
    'cart/cart.go': broken,
    'cart/cart_test.go': 'package cart\n\nimport "testing"\n\nfunc TestTotal(t *testing.T) {\n\tif got := Total([]int{1, 2}); got != 3 {\n\t\tt.Errorf("Total = %d, want 3", got)\n\t}\n}\n',
  });
  const file = join(root, 'cart/cart.go');
  const goTest = command => { try { return execFileSync('bash', ['-c', command], {cwd: root, encoding: 'utf8'}); } catch (error) { return error.stdout; } };
  assert.equal(parseTestOutput(goTest('go test -json ./...')).failedCount, 1, 'the file on disk fails');
  const run = await prepareUnsaved({root, command: 'go test -json ./...', file, text: broken.replace('i := 1', 'i := 0'), dir: mkdtempSync(join(tmpdir(), 'pair-overlay-'))});
  assert.equal(run.root, root);
  const output = goTest(run.command);
  const tests = parseTestOutput(output);
  assert.deepEqual([tests.failedCount, tests.passed], [0, 1], output);
  assert.equal(readFileSync(file, 'utf8'), broken, 'nothing was saved');

  // A test file edited in the buffer: its tests are placed where the buffer has them, not the disk.
  const testFile = join(root, 'cart/cart_test.go');
  const moved = `package cart\n\nimport "testing"\n\n// a comment the buffer added\n${readFileSync(testFile, 'utf8').split('\n').slice(4).join('\n')}`;
  const placed = await placeTests([{package: 'example.com/shop/cart', name: 'TestTotal', status: 'passed'}], root, new Map([[testFile, moved]]));
  assert.deepEqual(placed.map(test => [test.file, test.line]), [[testFile, 6]]);
});

test('other runners run in a copy of the project: git\'s files and ignored files copied, the buffer\'s text in it, .git left out', async t => {
  if (!has('git')) return t.skip('git not installed');
  const root = project({
    '.gitignore': 'node_modules/\n.env\n',
    'src/total.js': 'export const total = xs => xs.slice(1).reduce((a, b) => a + b, 0)\n',
    'test/total.test.js': 'untracked, not ignored\n',
    '.env': 'API=local\n',
  });
  git(root);
  const file = join(root, 'src/total.js');
  const run = await prepareUnsaved({root, command: 'npx vitest run --reporter=json', file, text: 'fixed\n', dir: scratch()});
  assert.equal(run.command, 'npx vitest run --reporter=json');
  assert.equal(readFileSync(join(run.root, 'src/total.js'), 'utf8'), 'fixed\n');
  assert.equal(readFileSync(file, 'utf8'), 'export const total = xs => xs.slice(1).reduce((a, b) => a + b, 0)\n', 'the project is untouched');
  assert.equal(readFileSync(join(run.root, 'test/total.test.js'), 'utf8'), 'untracked, not ignored\n');
  assert.equal(readFileSync(join(run.root, '.env'), 'utf8'), 'API=local\n', 'an ignored file a test may read');
  assert.throws(() => lstatSync(join(run.root, '.git')));
  assert.equal(run.toProject(join(run.root, 'test/total.test.js')), join(root, 'test/total.test.js'));
  assert.equal(run.toProject(null), null);
});

test('in the copy, dependency folders at any depth are linked, without their caches; what a run builds stays in the copy', async t => {
  if (!has('git')) return t.skip('git not installed');
  const root = project({
    '.gitignore': 'node_modules/\ndist/\ncoverage/\n',
    'src/a.js': 'saved\n',
    'node_modules/dep/index.js': 'module.exports = 1\n',
    'node_modules/.bin/dep': '#!/bin/sh\n',
    'node_modules/.cache/babel/x.json': '{}\n',
    'packages/a/package.json': '{}\n',
    'packages/a/node_modules/inner/index.js': 'module.exports = 2\n',
    'dist/a.js': 'built from the saved file\n',
  });
  git(root);
  const run = await prepareUnsaved({root, command: 'npm test', file: join(root, 'src/a.js'), text: 'UNSAVED BUFFER TEXT\n', dir: scratch()});
  // A workspace package's own dependencies are there, as in the project.
  assert.equal(readFileSync(join(run.root, 'packages/a/node_modules/inner/index.js'), 'utf8'), 'module.exports = 2\n');
  assert.equal(readFileSync(join(run.root, 'node_modules/dep/index.js'), 'utf8'), 'module.exports = 1\n');
  assert.ok(lstatSync(join(run.root, 'node_modules/dep')).isSymbolicLink());
  assert.ok(!lstatSync(join(run.root, 'node_modules')).isSymbolicLink(), 'node_modules itself is the copy\'s, so caches made in it stay there');
  assert.ok(lstatSync(join(run.root, 'node_modules/.bin')).isSymbolicLink());
  assert.throws(() => lstatSync(join(run.root, 'node_modules/.cache')), 'the caches are left out');
  // A build into an ignored folder writes into the copy, not the project.
  assert.throws(() => lstatSync(join(run.root, 'dist')), 'built output is left out');
  execFileSync('bash', ['-c', 'mkdir -p dist coverage node_modules/.cache && cp src/a.js dist/a.js && cp src/a.js coverage/a.js && cp src/a.js node_modules/.cache/a.js'], {cwd: run.root});
  assert.equal(readFileSync(join(root, 'dist/a.js'), 'utf8'), 'built from the saved file\n');
  assert.throws(() => lstatSync(join(root, 'coverage')));
  assert.throws(() => lstatSync(join(root, 'node_modules/.cache/a.js')));
  assert.equal(readFileSync(join(root, 'src/a.js'), 'utf8'), 'saved\n');

  // A file in a linked dependency folder would be written through the link, into the project: refused.
  await assert.rejects(prepareUnsaved({root, command: 'npm test', file: join(root, 'packages/a/node_modules/inner/index.js'), text: 'x', dir: scratch()}), /packages\/a\/node_modules\/inner\/index\.js is in a dependency folder/);
  assert.equal(readFileSync(join(root, 'packages/a/node_modules/inner/index.js'), 'utf8'), 'module.exports = 2\n');
});
