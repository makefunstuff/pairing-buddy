// The parsers against real output of each runner (test/fixtures), each with two failed tests and one passed.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {parseTestOutput, testSummary} from '../src/test-output.mjs';

const fixture = name => readFileSync(new URL(`./fixtures/${name}-failed.txt`, import.meta.url), 'utf8');

const EXPECTED = {
  cargo: {failed: ['tests::other', 'tests::waits_long'], passed: 1, firstError: 'boom here at src/lib.rs:7:26'},
  go: {failed: ['TestTimeout', 'TestSub/inner'], passed: null, firstError: 'a_test.go:3: timeout = 5000, want 30000'},
  jest: {
    failed: ['reconnect › waits up to 30 s after sleep', 'reconnect › throws nothing'],
    passed: 1,
    firstError: 'expect(received).toBe(expected) // Object.is equality (Expected: 30000, Received: 5000) at ws.test.js:3:64',
  },
  vitest: {
    failed: ['ws2.test.mjs > reconnect > waits up to 30 s after sleep', 'ws2.test.mjs > reconnect > throws nothing'],
    passed: 1,
    firstError: 'AssertionError: expected 5000 to be 30000 // Object.is equality at ws2.test.mjs:4:64',
  },
  pytest: {failed: ['test_ws.py::test_waits_long', 'test_ws.py::test_raises'], passed: 1, firstError: 'assert 5000 == 30000'},
  node: {failed: ['waits long'], passed: 1, firstError: 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 5000 !== 30000'},
};

for (const [runner, expected] of Object.entries(EXPECTED)) {
  test(`${runner}: the failed tests and the first error line`, () => {
    const {tests: _tests, ...result} = parseTestOutput(fixture(runner));
    assert.deepEqual(result, {runner, failedCount: expected.failed.length, ...expected});
  });
}

test('passing runs have no failures', () => {
  assert.deepEqual(parseTestOutput('test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s'),
    {runner: 'cargo', failed: [], passed: 12, failedCount: 0, firstError: null});
  assert.equal(parseTestOutput('Tests:       3 passed, 3 total\nTime: 1 s').failedCount, 0);
  assert.equal(parseTestOutput(' Test Files  2 passed (2)\n      Tests  9 passed (9)').runner, 'vitest');
  assert.equal(parseTestOutput('============ 4 passed in 0.03s ============').passed, 4);
  assert.equal(parseTestOutput('ok  \texample.com/ws\t0.004s').failedCount, 0);
  assert.equal(parseTestOutput('ℹ tests 5\nℹ pass 5\nℹ fail 0').passed, 5);
});

test('a go build failure counts as failed, with the compiler error', () => {
  const output = '# example.com/ws\n./ws.go:3:2: undefined: timeoutMs\nFAIL\texample.com/ws [build failed]\nFAIL';
  assert.deepEqual(parseTestOutput(output), {runner: 'go', failed: [], passed: null, failedCount: 1, firstError: './ws.go:3:2: undefined: timeoutMs'});
});

test('output that is not a test run is null', () => {
  assert.equal(parseTestOutput('src/ws.ts:1:export const TIMEOUT = 5000;'), null);
  assert.equal(parseTestOutput('Error: Cannot find module x'), null);
  assert.equal(parseTestOutput(''), null);
});

test('testSummary is one line for the models', () => {
  assert.equal(testSummary(parseTestOutput(fixture('pytest'))), '2 failed (test_ws.py::test_waits_long, test_ws.py::test_raises): assert 5000 == 30000');
  assert.equal(testSummary({failed: [], failedCount: 0, passed: 7}), '7 passed');
});

// JSON reports, also real output (test/fixtures/*.json): each test, its status and where it failed.
const report = name => parseTestOutput(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

test('go test -json: each test function, a failed subtest named, and the failure from t.Errorf or a panic', () => {
  const tests = report('go-test');
  assert.deepEqual(tests.failed, ['TestRate', 'TestTotal/two_items']);
  assert.equal(tests.passed, 1);
  assert.equal(tests.packages, 2, 'packages without test files are not counted');
  assert.equal(tests.firstError, 'cart_test.go:17: Total([250 100]) = 100, want 350');
  assert.deepEqual(tests.tests, [
    {name: 'TestTotal', package: 'example.com/shop/cart', status: 'failed', failure: {file: 'cart_test.go', line: 17, text: 'Total([250 100]) = 100, want 350'}},
    {name: 'TestRate', package: 'example.com/shop/tax', status: 'failed', failure: {file: '/home/you/shop/tax/tax_test.go', line: 7, text: 'panic: assignment to entry in nil map'}},
    {name: 'TestEmptyCart', package: 'example.com/shop/cart', status: 'passed', failure: null},
  ]);
});

test('go test -json: a build failure fails with the compiler error', () => {
  const tests = report('go-test-build');
  assert.deepEqual({failed: tests.failed, failedCount: tests.failedCount, tests: tests.tests}, {failed: [], failedCount: 1, tests: []});
  assert.equal(tests.firstError, 'internal/retry/backoff.go:31:17: undefined: x');
});

test('jest --json and vitest --reporter=json: each test with its file, and the line it failed on from the stack', () => {
  const jest = report('jest');
  assert.equal(jest.runner, 'jest');
  assert.deepEqual(jest.failed, ['reconnect › waits up to 30 s after sleep', 'reconnect › throws nothing']);
  assert.equal(jest.firstError, 'Error: expect(received).toBe(expected) // Object.is equality (Expected: 30000, Received: 5000) at ws.test.js:3');
  assert.deepEqual(jest.tests[2], {
    name: 'reconnect › throws nothing', title: 'throws nothing', file: '/home/you/project/test/ws.test.js', line: null, status: 'failed',
    failure: {file: '/home/you/project/test/ws.test.js', line: 5, text: 'TypeError: socket is undefined'},
  });

  const vitest = report('vitest');
  assert.equal(vitest.runner, 'vitest');
  assert.deepEqual(vitest.tests.map(test => test.status), ['failed', 'passed', 'skipped']);
  assert.deepEqual(vitest.tests[0].failure, {file: '/home/you/project/test/ws.test.ts', line: 7, text: 'AssertionError: expected 5000 to be 30000 // Object.is equality'});
  assert.equal(vitest.files, 1);
});

test('a JSON report among other lines (npm\'s header, a runner\'s own output) is still found', () => {
  const text = `> project@1.0.0 test\n> jest --json\n\n${readFileSync(new URL('./fixtures/jest.json', import.meta.url), 'utf8')}\nTest Suites: 1 failed, 1 total\n`;
  assert.equal(parseTestOutput(text).tests.length, 3);
});

test('a test file that fails to load is one failed test, marked on its first line', () => {
  const tests = report('vitest-broken');
  assert.deepEqual(tests.tests, [{
    name: 'broken.test.js', file: '/home/you/project/test/broken.test.js', line: 1, status: 'failed',
    failure: {file: '/home/you/project/test/broken.test.js', line: 1, text: 'Cannot find module \'./missing.js\' imported from \'/home/you/project/test/broken.test.js\''},
  }]);
});
