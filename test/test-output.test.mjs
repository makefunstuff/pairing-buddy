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
    assert.deepEqual(parseTestOutput(fixture(runner)), {runner, failedCount: expected.failed.length, ...expected});
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
