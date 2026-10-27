// The runners beyond go test, jest and vitest JSON, against their real output (test/fixtures) and the projects
// that printed it (test/fixtures/projects): which tests ran, how each ended, and where the editor shows it.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {parseTestOutput} from '../src/test-output.mjs';
import {placeTests} from '../src/test-places.mjs';

const projects = fileURLToPath(new URL('./fixtures/projects', import.meta.url));
/** A fixture, with the project's absolute paths as they are here. */
const fixture = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').replaceAll('/home/you/', `${projects}/`);
const project = name => join(projects, name);
const shown = placed => placed.map(({name, file, line, ok, failure}) => [name, `${file.split('/').at(-1)}:${line}`, ok, failure && (failure.line ? `${failure.file.split('/').at(-1)}:${failure.line} ${failure.text}` : failure.text)]);

test('cargo test: each test at its fn, a failure where it panicked', async () => {
  const tests = parseTestOutput(fixture('cargo-tests.txt'));
  assert.deepEqual(tests.failed, ['tests::subtracts']);
  assert.deepEqual(shown(await placeTests(tests.tests, project('crab'))), [
    ['tests::adds', 'lib.rs:8', true, null],
    ['tests::subtracts', 'lib.rs:13', false, 'lib.rs:14 assertion `left == right` failed'],
  ]);
});

test('pytest -v and -rA: each test at its def, also a method and a parametrized one, a failure at its line', async () => {
  for (const name of ['pytest-v.txt', 'pytest-ra.txt']) {
    const tests = parseTestOutput(fixture(name));
    assert.equal(tests.runner, 'pytest');
    assert.deepEqual(tests.failed, ['tests/test_calc.py::test_wrong', 'tests/test_calc.py::test_param[2-3-6]']);
    const placed = shown(await placeTests(tests.tests, project('py')));
    assert.deepEqual(placed.map(([name, ...rest]) => [name.replace('tests/test_calc.py::', ''), ...rest]).sort(), [
      ['TestCalc::test_method', 'test_calc.py:19', true, null],
      ['test_adds', 'test_calc.py:5', true, null],
      ['test_param[1-1-2]', 'test_calc.py:14', true, null],
      ['test_param[2-3-6]', 'test_calc.py:14', false, 'test_calc.py:15 assert 5 == 6'],
      ['test_wrong', 'test_calc.py:9', false, 'test_calc.py:10 assert 4 == 5'],
    ]);
  }
});

test('pytest without -v names only its failures', async () => {
  const tests = parseTestOutput(fixture('pytest-failed.txt'));
  assert.deepEqual(tests.tests.map(test => [test.name, test.status]), [['test_ws.py::test_waits_long', 'failed'], ['test_ws.py::test_raises', 'failed']]);
});

test('a JUnit XML report file: pytest --junitxml, its tests found by the module in the classname', async () => {
  const tests = parseTestOutput(fixture('pytest-ra.txt'), fixture('pytest-junit.xml'));
  assert.equal(tests.runner, 'pytest');
  assert.equal(tests.failedCount, 2);
  const placed = shown(await placeTests(tests.tests, project('py')));
  assert.deepEqual(placed.find(([name]) => name === 'test_wrong'), ['test_wrong', 'test_calc.py:9', false, 'test_calc.py:10 assert 4 == 5']);
  assert.deepEqual(placed.find(([name]) => name === 'test_method'), ['test_method', 'test_calc.py:19', true, null]);
});

test('zig test: each test at its test block, a failure at its frame', async () => {
  const tests = parseTestOutput(fixture('zig-test.txt'));
  assert.equal(tests.runner, 'zig');
  assert.equal(tests.firstError, 'expected 5, found 4 at main.zig:12');
  assert.deepEqual(shown(await placeTests(tests.tests, project('zz'))), [
    ['add', 'main.zig:7', true, null],
    ['add wrong', 'main.zig:11', false, 'main.zig:12 expected 5, found 4'],
  ]);
});

test('zig build test: only its failures', async () => {
  const tests = parseTestOutput(fixture('zig-build-test.txt'));
  assert.equal(tests.runner, 'zig');
  assert.deepEqual(shown(await placeTests(tests.tests, project('zz'))), [['add wrong', 'main.zig:11', false, 'main.zig:12 expected 5, found 4']]);
  assert.equal(parseTestOutput('\nBuild Summary: 3/3 steps succeeded; 2/2 tests passed\ntest success\n').failedCount, 0);
});

test('ctest: each test at its add_test, a failure with the first line it printed', async () => {
  const tests = parseTestOutput(fixture('ctest.txt'));
  assert.equal(tests.runner, 'ctest');
  assert.deepEqual(shown(await placeTests(tests.tests, project('cm'))), [
    ['passes', 'CMakeLists.txt:5', true, null],
    ['fails', 'CMakeLists.txt:6', false, 't.c:3 t.c:3: expected 1, got 2'],
  ]);
});

test('TAP: a test at its location, or by its title, also one made at run time', async () => {
  const tests = parseTestOutput(fixture('node-tap.txt'));
  assert.equal(tests.runner, 'tap');
  assert.deepEqual([tests.passed, tests.failedCount, tests.firstError], [2, 1, 'Expected values to be strictly equal: 4 !== 5 at math.test.mjs:10']);
  assert.deepEqual(shown(await placeTests(tests.tests, project('nt'))), [
    ['adds', 'math.test.mjs:4', true, null],
    ['sums 1 and 1', 'math.test.mjs:9', true, null],
    ['sums 2 and 2', 'math.test.mjs:9', false, 'math.test.mjs:10 Expected values to be strictly equal: 4 !== 5'],
  ]);
});

test('JUnit XML in the output: node --test-reporter=junit', async () => {
  const tests = parseTestOutput(fixture('node-junit.xml'));
  assert.equal(tests.runner, 'junit');
  assert.deepEqual(shown(await placeTests(tests.tests, project('nt'))), [
    ['adds', 'math.test.mjs:4', true, null],
    ['sums 1 and 1', 'math.test.mjs:9', true, null],
    ['sums 2 and 2', 'math.test.mjs:9', false, 'math.test.mjs:10 Expected values to be strictly equal:4 !== 5'],
  ]);
});

test('a jest or vitest title filled in at run time is found by its pattern: test.each and template strings', async () => {
  const file = '/p/each.test.js';
  const text = [
    "describe('math', () => {",
    "  test.each([[1, 1, 2]])('adds %i + %i', (a, b, sum) => {});",
    '  test.each`a | b`(\'subtracts $a - $b\', () => {});',
    '  for (const n of [1, 2]) it(`doubles ${n}`, () => {});',
    '});',
  ].join('\n');
  const tests = ['adds 1 + 1', 'subtracts 3 - 1', 'doubles 2', 'missing'].map(title => ({name: title, title, file, line: null, status: 'passed', failure: null}));
  const placed = await placeTests(tests, '/p', new Map([[file, text]]));
  assert.deepEqual(placed.map(test => [test.name, test.line]), [['adds 1 + 1', 2], ['subtracts 3 - 1', 3], ['doubles 2', 4]]);
});
