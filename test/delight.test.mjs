import assert from 'node:assert/strict';
import {test} from 'node:test';
import {betterWay, Delight, LONG_RED_MS, numbersOf} from '../src/delight.mjs';

const MIN = 60_000;

test('a green after a long red says what passes again and for how long it was red; a short one only glows', () => {
  const delight = new Delight();
  assert.equal(delight.testRun({red: true, failed: ['TestNoDoubleDelivery']}, 0), null, 'the session\'s first run is the baseline: no regression sound');
  assert.equal(delight.redSince, 0);
  assert.equal(delight.testRun({red: true, failed: ['TestNoDoubleDelivery']}, 10 * MIN), null, 'red the same way is no news');
  assert.deepEqual(delight.testRun({red: false}, 23 * MIN), {sound: 'green', text: '`TestNoDoubleDelivery` passes again, after 23 min of red.', lasted: 23 * MIN});
  assert.equal(delight.redSince, null);
  assert.equal(delight.testRun({red: false}, 24 * MIN), null, 'green after green is no news');

  const short = new Delight();
  short.testRun({red: true, failed: ['TestA', 'TestB', 'TestC']}, 0);
  assert.deepEqual(short.testRun({red: false}, 2 * MIN), {sound: 'green', text: null, lasted: 2 * MIN}, 'a short red that was no regression: the glow alone');
  const many = new Delight();
  many.testRun({red: true, failed: ['TestA', 'TestB', 'TestC']}, 0);
  assert.equal(many.testRun({red: false}, 12 * MIN).text, '`TestA`, `TestB` and 1 more pass again, after 12 min of red.');
});

test('a regression sounds once, and its fix is worth a line however short the red', () => {
  const delight = new Delight();
  delight.testRun({red: false}, 0);
  assert.deepEqual(delight.testRun({red: true, failed: ['TestRate'], newly: ['TestRate']}, MIN), {sound: 'red'});
  assert.equal(delight.testRun({red: true, failed: ['TestRate']}, 2 * MIN), null);
  assert.deepEqual(delight.testRun({red: true, failed: ['TestRate', 'TestTotal'], newly: ['TestTotal']}, 3 * MIN), {sound: 'red'}, 'one more test broke');
  assert.deepEqual(delight.testRun({red: false}, 4 * MIN), {sound: 'green', text: '`TestRate` and `TestTotal` pass again: the regression is fixed.', lasted: 3 * MIN});
  // Without a test report there are no names: a run that turns red after a green is the regression.
  assert.deepEqual(delight.testRun({red: true}, 5 * MIN), {sound: 'red'});
  assert.equal(delight.testRun({red: false}, 6 * MIN).text, null);
  delight.testRun({red: true}, 7 * MIN);
  assert.equal(delight.testRun({red: false}, 7 * MIN + LONG_RED_MS).text, 'The tests pass again, after 10 min of red.');
});

test('a command that failed for long and passes again is a moment; one that failed briefly is not', () => {
  const delight = new Delight();
  assert.equal(delight.command({cmd: 'make', failed: true, output: 'error: x'}, 0), null);
  assert.equal(delight.command({cmd: 'make', failed: true, output: 'error: x'}, 15 * MIN), null);
  assert.deepEqual(delight.command({cmd: 'make ', failed: false, output: ''}, 23 * MIN), {sound: 'green', text: '`make` passes again, after 23 min of red.'});
  delight.command({cmd: 'make', failed: true, output: 'error: y'}, 30 * MIN);
  assert.equal(delight.command({cmd: 'make', failed: false, output: ''}, 31 * MIN), null);
});

const bench = probe => `building\nlookup: n=1000 avg probe ${probe} (max 40)\nbench took 1.2 s\n`;

test('a number that held still over the runs before and then moved the right way is a moment, once', () => {
  const delight = new Delight();
  const run = (output, at = 0) => delight.command({cmd: './probe', failed: false, output}, at);
  assert.equal(run(bench('23.7')), null);
  assert.equal(run(bench('23.9')), null);
  assert.equal(run(bench('23.7')), null);
  assert.deepEqual(run(bench('1.1')), {sound: 'green', text: 'avg probe 23.7 → 1.1, after 3 runs at 23.7.', moved: true});
  assert.equal(run(bench('1.1')), null, 'it holds from its new value');
  assert.equal(run(bench('1.0')), null);
});

test('a number that moved the wrong way, jitters, or says nothing about which way is better is no moment', () => {
  const delight = new Delight();
  const run = output => delight.numbers('make bench', output);
  for (const probe of ['2.0', '2.0', '9.5']) assert.equal(run(bench(probe)), null, 'a longer probe is worse');

  const jitter = new Delight();
  for (const ms of ['10', '14', '9', '13', '6']) assert.equal(jitter.numbers('./bench', `latency ${ms} ms`), null, 'it never held still');

  const unknown = new Delight();
  for (const count of ['12', '12', '3']) assert.equal(unknown.numbers('make', `Compiling ${count} files`), null);

  const faster = new Delight();
  for (const rate of ['120.5', '121']) faster.numbers('./bench', `throughput: ${rate} MB/s`);
  assert.equal(faster.numbers('./bench', 'throughput: 240 MB/s').text, 'throughput 121 → 240 MB/s, after 2 runs at 121.');
});

test('a failure count after a comma is a count of failures: more of them is worse, and fewer is better', () => {
  const found = [...numbersOf('5 passed, 2 failed').values()].map(({label, way}) => [label, way]);
  assert.deepEqual(found, [['passed', 1], ['failed', -1]]);
  const more = new Delight();
  for (const failing of ['2', '2', '4']) assert.equal(more.command({cmd: 'make -s run', failed: false, output: `5 passed, ${failing} failed`}, 0), null);
  const fewer = new Delight();
  for (const failing of ['4', '4']) fewer.command({cmd: 'make -s run', failed: false, output: `5 passed, ${failing} failed`}, 0);
  assert.equal(fewer.command({cmd: 'make -s run', failed: false, output: '7 passed, 2 failed'}, 0).text, 'failed 4 → 2, after 2 runs at 4.');
});

test('numbers are read with their label and unit; times of day and unlabelled numbers are left out', () => {
  const found = [...numbersOf([
    'lookup: n=1000 avg probe 23.7 (max 40)',
    '[ 50%] Building C object',
    '12:30:01 cache 3ms',
    'BenchmarkLookup-8   1000000   1043 ns/op',
    'speedup 2.5x',
    'miss rate 12%',
  ].join('\n')).values()].map(({label, text, unit, way}) => [label, text, unit, way]);
  // n=1000 and max 40 say nothing about which way is better.
  assert.deepEqual(found, [
    ['avg probe', '23.7', '', -1],
    ['BenchmarkLookup-8', '1043', 'ns/op', -1],
    ['speedup', '2.5', 'x', 1],
    ['miss rate', '12', '%', -1],
  ]);
  assert.equal(betterWay('cache', 'hits'), 1);
  assert.equal(betterWay('build', 'warnings'), -1);
});
