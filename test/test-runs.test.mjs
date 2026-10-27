// The queue of the tests on save: a later save stops a run under way and runs for every file saved since; after the
// baseline, a run covers only what the saves affect; the project's timeout holds.
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {TestRuns} from '../src/test-runs.mjs';

/**
 * Tests on save of `command` in a small Go project, with a stand-in for Pair's pane: each run waits until `finish()`
 * ends it, or until its signal stops it, as Ctrl-C would.
 */
function runs(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pair-test-runs-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  for (const [path, text] of Object.entries({'go.mod': 'module example.com/shop\n', 'cart/cart.go': 'package cart\n', 'tax/tax.go': 'package tax\n'})) {
    mkdirSync(join(root, path, '..'), {recursive: true});
    writeFileSync(join(root, path), text);
  }
  const typed = [];
  const reports = [];
  const waiting = [];
  const pane = {
    run: (line, {timeoutMs, signal}) => new Promise(resolve => {
      typed.push({command: /&& \((.*)\) >/.exec(line)[1], timeoutMs});
      const end = result => { writeFileSync(/> '([^']+)' 2>&1$/.exec(line)[1], ''); resolve(result); };
      const done = () => end({exit: 0, output: '', timedOut: false, cancelled: false});
      waiting.push(done);
      signal.addEventListener('abort', () => {
        waiting.splice(waiting.indexOf(done), 1);
        end({exit: 130, output: '', timedOut: false, cancelled: true});
      });
    }),
  };
  const testRuns = new TestRuns({root, command: 'go test ./...', outputFile: join(root, 'run.out'), pane: () => pane, report: run => reports.push(run), ...options});
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  return {testRuns, typed, reports, settle, finish: async () => { waiting.shift()(); await settle(); }};
}

test('a save during a run stops it; the next run covers the files of both saves', async t => {
  const {testRuns, typed, reports, settle, finish} = runs(t);
  testRuns.saved('cart/cart.go');
  await settle();
  await finish(); // the baseline: the whole run
  testRuns.saved('cart/cart.go');
  await settle();
  testRuns.saved('tax/tax.go'); // the run for cart is stale now
  await settle();
  await finish();
  assert.deepEqual(typed.map(run => run.command), ['go test ./...', 'go test ./cart', 'go test ./cart ./tax']);
  assert.deepEqual(reports.map(run => [run.state, run.label, run.narrowed]), [
    ['run', 'go test ./...', undefined], ['done', 'go test ./...', false],
    ['run', 'go test ./cart', undefined],
    ['run', 'go test ./cart ./tax', undefined], ['done', 'go test ./cart ./tax', true],
  ], 'the stopped run reports nothing more');
  assert.equal(reports.at(-1).saved, 'tax/tax.go');
});

test('a stopped first run is no baseline: the next one runs whole', async t => {
  const {testRuns, typed, settle, finish} = runs(t);
  testRuns.saved('cart/cart.go');
  await settle();
  testRuns.saved('tax/tax.go');
  await settle();
  await finish();
  assert.deepEqual(typed.map(run => run.command), ['go test ./...', 'go test ./...']);
});

test('affected: false runs the whole command on every save; the project\'s timeout goes to the pane', async t => {
  const {testRuns, typed, settle, finish} = runs(t, {affected: false, timeoutMs: 600_000});
  testRuns.saved('cart/cart.go');
  await settle();
  await finish();
  testRuns.saved('cart/cart.go');
  await settle();
  await finish();
  assert.deepEqual(typed, [{command: 'go test ./...', timeoutMs: 600_000}, {command: 'go test ./...', timeoutMs: 600_000}]);
});
