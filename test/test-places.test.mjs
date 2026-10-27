// Where each test of a JSON report is, from the project's files.
import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {parseTestOutput} from '../src/test-output.mjs';
import {placeTests} from '../src/test-places.mjs';
import {scratch} from './temp.mjs';

const fixture = name => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');

/** A project with `files` ({path: text}), and its root as the daemon names it. */
function project(files) {
  const root = realpathSync(scratch('pair-places-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), {recursive: true});
    writeFileSync(join(root, path), text);
  }
  return root;
}

test('go: the line of each test function in its package, and the failure in the same package or at the panic', async () => {
  const root = project({
    'go.mod': 'module example.com/shop\n\ngo 1.22\n',
    'cart/cart_test.go': 'package cart\n\nimport "testing"\n\nfunc TestTotal(t *testing.T) {\n}\n\nfunc TestEmptyCart(t *testing.T) {\n}\n',
    'tax/tax_test.go': 'package tax\n\nimport "testing"\n\nfunc TestRate(t *testing.T) {\n}\n',
  });
  const {tests} = parseTestOutput(fixture('go-test').replaceAll('/home/you/shop', root));
  assert.deepEqual(await placeTests(tests, root), [
    {name: 'TestTotal', file: join(root, 'cart/cart_test.go'), line: 5, ok: false, failure: {file: join(root, 'cart/cart_test.go'), line: 17, text: 'Total([250 100]) = 100, want 350'}},
    {name: 'TestRate', file: join(root, 'tax/tax_test.go'), line: 5, ok: false, failure: {file: join(root, 'tax/tax_test.go'), line: 7, text: 'panic: assignment to entry in nil map'}},
    {name: 'TestEmptyCart', file: join(root, 'cart/cart_test.go'), line: 8, ok: true, failure: null},
  ]);
});

test('jest and vitest: the line of the test() call by its title; skipped tests and files outside the project are left out', async () => {
  const root = project({'test/ws.test.ts': "describe('reconnect', () => {\n  test('waits up to 30 s after sleep', () => {\n  });\n  test(\"backs off\", () => {});\n});\n"});
  const {tests} = parseTestOutput(fixture('vitest').replaceAll('/home/you/project', root));
  assert.deepEqual(await placeTests(tests, root), [
    {name: 'reconnect › waits up to 30 s after sleep', file: join(root, 'test/ws.test.ts'), line: 2, ok: false, failure: {file: join(root, 'test/ws.test.ts'), line: 7, text: 'AssertionError: expected 5000 to be 30000 // Object.is equality'}},
    {name: 'reconnect › backs off', file: join(root, 'test/ws.test.ts'), line: 4, ok: true, failure: null},
  ]);
  assert.deepEqual(await placeTests(tests, project({})), [], 'the files are not in this project');
});
