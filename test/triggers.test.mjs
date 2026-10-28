import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fold, initialState} from '../src/fold.mjs';
import {readRun} from '../src/run-output.mjs';
import {detectTriggers, fileStem, TIMING} from '../src/triggers.mjs';

const foldAll = (events, state = initialState()) => events.reduce(fold, state);
const kinds = (state, now, fired) => detectTriggers(state, now, fired).map(trigger => trigger.kind);
const failure = (at, output = 'Error: timeout of 5000ms exceeded') => ({kind: 'command_end', pane: 'w1:p2', cmd: 'npm test', exit: 1, output, at});

test('a failure the user is not looking at becomes a trigger after the grace period', () => {
  const state = foldAll([{kind: 'focus', target: 'editor', pane: 'w1:p1', at: 0}, failure(1000)]);
  assert.deepEqual(kinds(state, 1000 + TIMING.lookGraceMs - 1), []);
  assert.deepEqual(kinds(state, 1000 + TIMING.lookGraceMs), ['failed_command']);
});

test('no trigger while the user looks at the failing pane, unless they scrolled away', () => {
  const looking = foldAll([{kind: 'focus', target: 'terminal', pane: 'w1:p2', at: 0}, failure(1000)]);
  assert.deepEqual(kinds(looking, 10_000), []);
  const scrolled = fold(looking, {kind: 'focus', target: 'terminal', pane: 'w1:p2', scrolled: true, at: 2000});
  assert.deepEqual(kinds(scrolled, 10_000), ['failed_command']);
});

test('a failure seen when it happened stays seen after the user looks away', () => {
  const state = foldAll([
    {kind: 'focus', target: 'terminal', pane: 'w1:p2', at: 0},
    failure(1000),
    {kind: 'focus', target: 'editor', pane: 'w1:p1', at: 2000},
  ]);
  assert.deepEqual(kinds(state, 10_000), []);
});

test('a failure the user turns to within the grace period counts as seen', () => {
  const state = foldAll([
    {kind: 'focus', target: 'editor', pane: 'w1:p1', at: 0},
    failure(1000),
    {kind: 'focus', target: 'terminal', pane: 'w1:p2', at: 2000},
    {kind: 'focus', target: 'editor', pane: 'w1:p1', at: 3000},
  ]);
  assert.deepEqual(kinds(state, 10_000), []);
});

test('old failures are not news', () => {
  const state = foldAll([failure(1000)]);
  assert.deepEqual(kinds(state, 1000 + TIMING.recentMs + 1), []);
});

test('the same error a second time is a repeated_error, even while looking at it', () => {
  const state = foldAll([{kind: 'focus', target: 'terminal', pane: 'w1:p2', at: 0}, failure(1000), failure(5000)]);
  const [trigger] = detectTriggers(state, 5000);
  assert.equal(trigger.kind, 'repeated_error');
  assert.match(trigger.detail, /2 times/);
});

test('a stall after a failure: nothing typed or run for stallMs', () => {
  const state = foldAll([{kind: 'focus', target: 'terminal', pane: 'w1:p2', at: 0}, failure(1000)]);
  assert.deepEqual(kinds(state, 1000 + TIMING.stallMs), ['stall']);
  const typed = fold(state, {kind: 'typing', at: 2000});
  assert.deepEqual(kinds(typed, 1000 + TIMING.stallMs), []);
});

test('an error diagnostic in code just written counts once the cursor moved on', () => {
  const written = foldAll([
    {kind: 'edit', file: 'a.js', from: 10, to: 12, at: 1000},
    {kind: 'cursor', file: 'a.js', line: 11, at: 1000},
    {kind: 'diagnostics', file: 'a.js', items: [{line: 11, severity: 'error', message: 'x is undefined'}], at: 3000},
  ]);
  assert.deepEqual(kinds(written, 3000), [], 'the cursor is still on it');
  const movedOn = fold(written, {kind: 'cursor', file: 'a.js', line: 40, at: 4000});
  const [trigger] = detectTriggers(movedOn, 4000);
  assert.equal(trigger.kind, 'new_code_diagnostic');
  assert.equal(trigger.line, 11);
});

test('old code, warnings and late diagnostics are not new_code_diagnostic', () => {
  const state = foldAll([
    {kind: 'edit', file: 'a.js', from: 10, to: 12, at: 1000},
    {kind: 'cursor', file: 'b.js', line: 1, at: 1000},
    {kind: 'diagnostics', file: 'a.js', items: [
      {line: 50, severity: 'error', message: 'elsewhere'},
      {line: 11, severity: 'warning', message: 'unused'},
    ], at: 2000},
    {kind: 'diagnostics', file: 'c.js', items: [{line: 1, severity: 'error', message: 'never edited'}], at: 2000},
  ]);
  assert.deepEqual(kinds(state, 3000), []);
});

test('drift is checked once for each file the user moves into, only with a goal and recent edits', () => {
  const edit = (file, at) => ({kind: 'edit', file, from: 1, to: 1, at});
  assert.deepEqual(kinds(foldAll([edit('docs/x.md', 1000)]), 2000), [], 'no goal');
  const state = foldAll([{kind: 'goal', text: 'fix reconnect', at: 0}, edit('src/ws.ts', 500), edit('docs/x.md', 1000)]);
  const [trigger] = detectTriggers(state, 2000);
  assert.equal(trigger.kind, 'drift');
  assert.equal(trigger.file, 'docs/x.md');
  assert.equal(trigger.detail, 'Possible drift from the goal "fix reconnect": the user now edits docs/x.md (recently also src/ws.ts).');
  assert.equal(trigger.lasting, true);
  const fired = new Set([trigger.key]);
  assert.deepEqual(kinds(fold(state, edit('docs/x.md', 3000)), 4000, fired), [], 'more edits in the same file');
  assert.deepEqual(kinds(fold(state, edit('src/billing.ts', 3000)), 4000, fired), ['drift'], 'a new file');
  assert.deepEqual(kinds(state, 1000 + TIMING.driftWindowMs + 1), [], 'no recent edits');
  const newGoal = fold(fold(state, {kind: 'goal', text: 'fix rounding in billing totals', at: 3000}), edit('docs/x.md', 4000));
  assert.deepEqual(kinds(newGoal, 5000, fired), ['drift'], 'a new goal judges the same file again');
});

test('fired keys are not raised again', () => {
  const state = foldAll([failure(1000)]);
  const [trigger] = detectTriggers(state, 10_000);
  assert.deepEqual(detectTriggers(state, 11_000, new Set([trigger.key])), []);
});

test('a failure while the user is in another workspace is missed', () => {
  const state = foldAll([{kind: 'focus', target: 'elsewhere', pane: null, at: 0}, failure(1000)]);
  assert.deepEqual(kinds(state, 1000 + TIMING.lookGraceMs), ['failed_command']);
});

test('a failed test run names the failed tests and the first error in its trigger', () => {
  const output = '--- FAIL: TestReconnect (0.00s)\n    ws_test.go:12: timeout = 5000, want 30000\nFAIL\texample.com/ws\t0.002s';
  const state = foldAll([{kind: 'focus', target: 'editor', pane: 'w1:p1', at: 0}, failure(1000, output)]);
  const [trigger] = detectTriggers(state, 1000 + TIMING.lookGraceMs);
  assert.equal(trigger.kind, 'failed_command');
  assert.equal(trigger.detail, '`npm test` failed (exit 1) and you are not looking at it: 1 failed (TestReconnect): ws_test.go:12: timeout = 5000, want 30000');
});

const RED = '--- FAIL: TestRetries (0.00s)\n    worker_test.go:35: attempts = 4, want 5\nFAIL\texample.com/delivery\t0.001s';
const edit = (file, at) => ({kind: 'edit', file, from: 17, to: 17, at});

test('the wrong turn: editing, while a test is red, a file the failure does not name', () => {
  const red = foldAll([{kind: 'focus', target: 'terminal', pane: 'w1:p2', at: 0}, failure(1000, RED)]);
  assert.deepEqual(kinds(red, 2000), [], 'a red run alone is no wrong turn');
  const [trigger] = detectTriggers(fold(red, edit('internal/retry/backoff.go', 5000)), 6000);
  assert.equal(trigger.kind, 'edit_while_red');
  assert.equal(trigger.line, 17);
  assert.equal(trigger.detail, 'The user edits internal/retry/backoff.go:17-17 while `npm test` is red: 1 failed (TestRetries): '
    + 'worker_test.go:35: attempts = 4, want 5. The failure names worker_test.go, not internal/retry/backoff.go.');
  assert.deepEqual(kinds(fold(red, edit('internal/delivery/worker.go', 5000)), 6000), [], 'the code under the failing test is where it fails');
  assert.deepEqual(kinds(fold(red, edit('internal/delivery/worker_test.go', 5000)), 6000), [], 'and so is the test itself');
  assert.deepEqual(kinds(fold(red, edit('docs/retries.md', 5000)), 6000), [], 'notes are no attempt at a fix');
});

test('a wrong turn needs a red run that names files, an edit after it, and is raised once per run and file', () => {
  const unnamed = foldAll([failure(1000, '--- FAIL: TestRetries (0.00s)\nFAIL\texample.com/delivery\t0.001s'), edit('backoff.go', 5000)]);
  assert.ok(!kinds(unnamed, 6000).includes('edit_while_red'), 'a failure that names no file says nothing about where');
  const before = foldAll([edit('backoff.go', 500), failure(1000, RED)]);
  assert.ok(!kinds(before, 6000).includes('edit_while_red'), 'an edit before the run is not a turn taken after it');
  const green = foldAll([failure(1000, RED), {kind: 'command_end', pane: 'w1:p2', cmd: 'go test ./...', exit: 0, output: 'ok  \texample.com/delivery\t0.002s', at: 2000}, edit('backoff.go', 5000)]);
  assert.ok(!kinds(green, 6000).includes('edit_while_red'), 'a passing run since then: nothing is red');
  const red = foldAll([failure(1000, RED), edit('backoff.go', 5000)]);
  assert.ok(!kinds(red, 1000 + TIMING.redMs + 1).includes('edit_while_red'), 'a run red for longer than redMs is old news');
  const [trigger] = detectTriggers(red, 6000).filter(found => found.kind === 'edit_while_red');
  assert.deepEqual(detectTriggers(fold(red, edit('backoff.go', 7000)), 8000, new Set([trigger.key])).filter(found => found.kind === 'edit_while_red'), []);
  assert.ok(kinds(fold(red, edit('retry.go', 7000)), 8000).includes('edit_while_red'), 'another file is another turn');
});

test('file stems pair a test with its code across runners', () => {
  assert.deepEqual(['worker_test.go', 'src/worker.go', 'test/ws.test.ts', 'test_ws.py', 'WsTest.java', 'ws.spec.js', 'contest.go'].map(fileStem),
    ['worker', 'worker', 'ws', 'ws', 'ws', 'ws', 'contest']);
});

test('a regression: the tests Pair ran on save fail where the run before did not, raised once per run', () => {
  const run = (failed, at) => ({kind: 'test_run', cmd: 'go test ./...', saved: 'internal/delivery/worker.go', files: ['internal/queue/queue_test.go'], at,
    tests: {runner: 'go', failed, passed: 3, failedCount: failed.length, firstError: 'queue_test.go:34: attempt 5 starts at 15s', tests: [], packages: 3}});
  const green = foldAll([run([], 1000)]);
  assert.deepEqual(kinds(green, 2000), []);
  const red = fold(green, run(['TestNoDoubleDelivery'], 3000));
  const [trigger] = detectTriggers(red, 4000);
  assert.equal(trigger.kind, 'regression');
  assert.equal(trigger.file, 'internal/delivery/worker.go');
  assert.match(trigger.detail, /^Pair ran `go test \.\/\.\.\.` when the user saved internal\/delivery\/worker\.go\. Now failing, and not in Pair's run before: TestNoDoubleDelivery\. 1 failed/);
  assert.match(trigger.detail, /names internal\/queue\/queue_test\.go/);
  assert.deepEqual(kinds(red, 4000, new Set([trigger.key])), []);
  assert.deepEqual(kinds(fold(red, run(['TestNoDoubleDelivery'], 5000)), 6000), [], 'red the same way again is no news');
  assert.deepEqual(kinds(red, 3000 + TIMING.recentMs + 1), [], 'old runs are history');
  assert.deepEqual(kinds(foldAll([run(['TestNoDoubleDelivery'], 1000)]), 2000), [], 'the session\'s first run, red already, is no regression');
});

const run = (at, output, {cmd = './probe', exit = null, pane = 'w1:p3'} = {}) => ({kind: 'command_end', pane, cmd, exit, output, at});
const ASAN = '==4242==ERROR: AddressSanitizer: SEGV on unknown address 0x00000000c000\n    #0 0x55 in probe /p/probe.c:10\n    #1 0x55 in main /p/probe.c:17\n    #2 0x7f in __libc_start_main (/usr/lib/libc.so.6+0x278b8)';

test('a crash is a trigger of its own, also while the user looks at it: the terminal says that, not where or why', () => {
  const looking = foldAll([{kind: 'focus', target: 'terminal', pane: 'w1:p3', at: 0}, run(1000, ASAN, {exit: 1})], initialState({root: '/p'}));
  const [trigger, ...rest] = detectTriggers(looking, 1500);
  assert.deepEqual(rest, []);
  assert.equal(trigger.kind, 'crash');
  assert.deepEqual([trigger.file, trigger.line], ['probe.c', 10]);
  assert.equal(trigger.detail, '`./probe` crashed (the user ran it): AddressSanitizer: SEGV at probe.c:10 in probe. '
    + 'Its stack, innermost first: probe.c:10 (probe), probe.c:17 (main).', 'libc\'s frame names no line: it is no place');
  const away = foldAll([{kind: 'focus', target: 'editor', pane: 'w1:p1', at: 0}, run(1000, 'Segmentation fault (core dumped)')]);
  assert.deepEqual(kinds(away, 1000 + TIMING.lookGraceMs), ['crash'], 'a crash, not also a failed command');
  assert.match(detectTriggers(away, 6000)[0].detail, /Segmentation fault\. It printed no stack/);
});

test('the same crash at the same place is raised once; again, it is the same error a second time', () => {
  const first = foldAll([run(1000, 'Segmentation fault (core dumped)')]);
  const [crash] = detectTriggers(first, 1500);
  const again = fold(first, run(2000, 'Segmentation fault (core dumped)'));
  assert.deepEqual(kinds(again, 2500, new Set([crash.key])), ['repeated_error']);
  assert.deepEqual(kinds(again, 2000 + TIMING.recentMs + 1, new Set([crash.key])), [], 'old crashes are history');
});

test('a crash in a run on save is a trigger too', () => {
  const state = fold(initialState({root: '/p'}), {kind: 'test_run', cmd: 'make run', saved: 'probe.c', tests: null, reading: readRun(ASAN, {root: '/p', exit: 1}), at: 1000});
  const [trigger] = detectTriggers(state, 1500);
  assert.equal(trigger.kind, 'crash');
  assert.match(trigger.detail, /^`make run` crashed \(Pair ran it when the user saved\)/);
});

test('a new warning is raised once per build; a warning that was there before is no news', () => {
  const warn = 'probe.c:21:14: warning: comparison of integers of different signs [-Wsign-compare]';
  const baseline = foldAll([{kind: 'edit', file: 'probe.c', from: 21, to: 21, at: 500}, run(1000, 'probe.c:9:7: warning: unused variable \'unused\'', {cmd: 'make', exit: 0})]);
  assert.deepEqual(kinds(baseline, 1500), []);
  const state = fold(baseline, run(2000, `probe.c:9:7: warning: unused variable 'unused'\n${warn}`, {cmd: 'make', exit: 0}));
  const [trigger] = detectTriggers(state, 2500);
  assert.equal(trigger.kind, 'new_warning');
  assert.deepEqual([trigger.file, trigger.line], ['probe.c', 21]);
  assert.equal(trigger.detail, '`make` (the user ran it) printed a new warning, not in the builds before: probe.c:21: comparison of integers of different signs [-Wsign-compare]');
  assert.deepEqual(kinds(state, 2500, new Set([trigger.key])), []);
});

test('a hidden terminal raises no crash or warning from the user\'s runs; Pair\'s run on save still does', () => {
  const mine = foldAll([run(1000, 'Segmentation fault (core dumped)'), {kind: 'hide', source: 'terminal', hidden: true, at: 1100}]);
  assert.deepEqual(kinds(mine, 1500), []);
  const onSave = fold(mine, {kind: 'test_run', cmd: 'make run', saved: 'probe.c', tests: null, reading: readRun('', {exit: 139}), at: 2000});
  assert.deepEqual(kinds(onSave, 2500), ['crash']);
});

// Edits Pair made for the user (the Driver's typing, a suggestion they took, later a /gen request's code) carry
// their origin; the triggers about code the user wrote leave them out.
const byPair = (event, origin = 'pair') => ({...event, origin});

test('an edit keeps its origin; an unknown or missing one is the user\'s, and Pair\'s edits are no keystroke, current file or edited file of the user\'s', () => {
  const state = foldAll([
    {kind: 'edit', file: 'a.js', from: 1, to: 1, at: 1000},
    byPair({kind: 'edit', file: 'b.js', from: 2, to: 3, at: 2000}),
    byPair({kind: 'edit', file: 'c.js', from: 4, to: 4, at: 3000}, 'gen:#3'),
    byPair({kind: 'edit', file: 'd.js', from: 5, to: 5, at: 4000}, 'someone'),
  ]);
  assert.deepEqual(state.edits.map(edit => [edit.file, edit.origin]), [['a.js', 'user'], ['b.js', 'pair'], ['c.js', 'gen:#3'], ['d.js', 'user']]);
  assert.deepEqual([state.file, state.lastKeyAt, state.lastEditAt], ['d.js', 4000, 4000]);
  assert.deepEqual(state.edited, ['a.js', 'd.js']);
  const pairOnly = foldAll([byPair({kind: 'edit', file: 'b.js', from: 2, to: 3, at: 2000})]);
  assert.deepEqual([pairOnly.file, pairOnly.lastKeyAt, pairOnly.lastEditAt, pairOnly.edited], [null, 0, 0, []]);
});

test('a diagnostic in code Pair wrote is no new_code_diagnostic, until the user edits those lines', () => {
  const pair = foldAll([
    byPair({kind: 'edit', file: 'a.js', from: 10, to: 12, at: 1000}),
    {kind: 'cursor', file: 'a.js', line: 40, at: 1500},
    {kind: 'diagnostics', file: 'a.js', items: [{line: 11, severity: 'error', message: 'x is undefined'}], at: 3000},
  ]);
  assert.deepEqual(kinds(pair, 4000), []);
  const elsewhere = fold(pair, {kind: 'edit', file: 'a.js', from: 30, to: 30, at: 3500});
  assert.deepEqual(kinds(elsewhere, 4000), [], 'an edit of the user\'s elsewhere does not make Pair\'s lines theirs');
  const theirs = foldAll([
    {kind: 'edit', file: 'a.js', from: 11, to: 11, at: 3500},
    {kind: 'cursor', file: 'a.js', line: 40, at: 3600},
    {kind: 'diagnostics', file: 'a.js', items: [{line: 11, severity: 'error', message: 'y is undefined'}], at: 4000},
  ], pair);
  assert.deepEqual(kinds(theirs, 4500), ['new_code_diagnostic'], 'the user edited the line: now it is their code');
  const overwritten = foldAll([
    {kind: 'edit', file: 'a.js', from: 11, to: 11, at: 500},
    byPair({kind: 'edit', file: 'a.js', from: 10, to: 12, at: 1000}, 'gen:#2'),
    {kind: 'cursor', file: 'a.js', line: 40, at: 1500},
    {kind: 'diagnostics', file: 'a.js', items: [{line: 11, severity: 'error', message: 'x is undefined'}], at: 3000},
  ]);
  assert.deepEqual(kinds(overwritten, 4000), [], 'the newest edit of the line is Pair\'s');
});

test('Pair\'s edits are no drift and no wrong turn; the user\'s own edit after them is', () => {
  const goal = initialState({goal: 'fix reconnect'});
  const drifted = foldAll([edit('src/ws.ts', 1000), byPair(edit('docs/x.md', 2000))], goal);
  const drift = detectTriggers(drifted, 3000).filter(found => found.kind === 'drift');
  assert.deepEqual(drift.map(found => found.file), ['src/ws.ts'], 'judged on the user\'s own last file');
  assert.doesNotMatch(drift[0].detail, /docs\/x\.md/);
  const red = foldAll([failure(1000, RED), byPair(edit('backoff.go', 5000))]);
  assert.ok(!kinds(red, 6000).includes('edit_while_red'), 'the Driver\'s edit is no wrong turn of the user\'s');
  assert.ok(kinds(fold(red, edit('backoff.go', 7000)), 8000).includes('edit_while_red'));
});

test('a new warning on lines Pair edited last is no news; one on the user\'s lines in the same build is', () => {
  const warn = line => `probe.c:${line}:14: warning: comparison of integers of different signs [-Wsign-compare]`;
  const baseline = foldAll([{kind: 'edit', file: 'probe.c', from: 3, to: 3, at: 500}, run(1000, '', {cmd: 'make', exit: 0})]);
  const pair = foldAll([byPair({kind: 'edit', file: 'probe.c', from: 21, to: 22, at: 1500}), run(2000, warn(21), {cmd: 'make', exit: 0})], baseline);
  assert.deepEqual(kinds(pair, 2500), []);
  const both = foldAll([byPair({kind: 'edit', file: 'probe.c', from: 21, to: 22, at: 1500}), run(2000, `${warn(21)}\n${warn(3)}`, {cmd: 'make', exit: 0})], baseline);
  const [trigger] = detectTriggers(both, 2500);
  assert.equal(trigger.kind, 'new_warning');
  assert.deepEqual(trigger.warnings.map(warning => warning.line), [3]);
  const onlyPair = foldAll([byPair({kind: 'edit', file: 'fresh.c', from: 1, to: 1, at: 1500}), run(2000, 'fresh.c:1:5: warning: unused variable \'n\'', {cmd: 'make', exit: 0})], baseline);
  assert.deepEqual(kinds(onlyPair, 2500), [], 'a file only Pair edited is no file the user edited');
});
