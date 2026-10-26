import assert from 'node:assert/strict';
import {test} from 'node:test';
import {errorSignature, failed, failureLine, fold, initialState} from '../src/fold.mjs';
import {readRun} from '../src/run-output.mjs';

const foldAll = (events, state = initialState()) => events.reduce(fold, state);

test('an edit moves the current file and counts as a keystroke', () => {
  const state = foldAll([{kind: 'edit', file: 'src/a.js', from: 3, to: 4, text: 'x', at: 1000}]);
  assert.equal(state.file, 'src/a.js');
  assert.equal(state.lastEditAt, 1000);
  assert.equal(state.lastKeyAt, 1000);
  assert.deepEqual(state.edits.map(edit => [edit.from, edit.to]), [[3, 4]]);
});

test('typing heartbeats move lastKeyAt without adding edits', () => {
  const state = foldAll([{kind: 'typing', at: 500}, {kind: 'typing', at: 900}]);
  assert.equal(state.lastKeyAt, 900);
  assert.equal(state.edits.length, 0);
});

test('only the most recent edits and commands are kept', () => {
  const edits = Array.from({length: 30}, (_, i) => ({kind: 'edit', file: 'a', from: i, to: i, at: i}));
  const commands = Array.from({length: 15}, (_, i) => ({kind: 'command_end', cmd: `c${i}`, exit: 0, at: i}));
  const state = foldAll([...edits, ...commands]);
  assert.equal(state.edits.length, 20);
  assert.equal(state.edits[0].from, 10);
  assert.equal(state.commands.length, 10);
  assert.equal(state.commands.at(-1).cmd, 'c14');
});

test('a failed command is counted under its error signature', () => {
  const run = at => ({kind: 'command_end', cmd: 'npm test', exit: 1, output: `running\nError: expected 30 to equal 5 (at ${at} ms)\n`, at});
  const state = foldAll([run(100), run(200)]);
  const [signature, error] = Object.entries(state.errors)[0];
  assert.equal(Object.keys(state.errors).length, 1, 'numbers in the output do not split the signature');
  assert.match(signature, /^error: expected # to equal #/);
  assert.equal(error.count, 2);
  assert.equal(error.lastAt, 200);
});

test('successful commands add no error', () => {
  const state = foldAll([{kind: 'command_end', cmd: 'ls', exit: 0, output: 'error.log', at: 1}]);
  assert.deepEqual(state.errors, {});
});

test('without an exit code the output decides whether a command failed', () => {
  assert.equal(failed({exit: null, output: 'FAILED tests/a.py::test_x'}), true);
  assert.equal(failed({exit: null, output: 'AssertionError: expected 30000, got 5000'}), true);
  assert.equal(failed({exit: null, output: 'thread main panicked at src/lib.rs:3'}), true);
  assert.equal(failed({exit: null, output: 'all good'}), false);
  assert.equal(failed({exit: 0, output: 'Error: but exit code wins'}), false);
  assert.equal(failed({exit: 2, output: ''}), true);
});

test('errorSignature prefers the line that names the failure', () => {
  assert.equal(errorSignature({output: 'compiling\nsrc/x.rs:12 error[E0308]: mismatched types\nwarning: 3 more'}), 'src/x.rs:# error[e#]: mismatched types');
});

test('diagnostics keep the time they first appeared', () => {
  const item = {line: 7, severity: 'error', message: 'x is undefined'};
  const state = foldAll([
    {kind: 'diagnostics', file: 'a.js', items: [item], at: 100},
    {kind: 'diagnostics', file: 'a.js', items: [item, {line: 9, severity: 'warning', message: 'unused'}], at: 300},
  ]);
  assert.deepEqual(state.diagnostics['a.js'].map(d => [d.line, d.at]), [[7, 100], [9, 300]]);
});

test('cursor, focus, goal and branch are folded as given', () => {
  const state = foldAll([
    {kind: 'cursor', file: 'b.js', line: 4, col: 2, selection: {from: 4, to: 6}, at: 1},
    {kind: 'focus', target: 'terminal', pane: 'w1:p2', scrolled: true, at: 2},
    {kind: 'goal', text: 'fix reconnect', at: 3},
    {kind: 'branch', name: 'fix/reconnect', at: 4},
  ]);
  assert.equal(state.file, 'b.js');
  assert.deepEqual(state.cursor, {line: 4, col: 2});
  assert.deepEqual(state.selection, {from: 4, to: 6});
  assert.deepEqual(state.focus, {target: 'terminal', pane: 'w1:p2', scrolled: true, at: 2});
  assert.equal(state.goal, 'fix reconnect');
  assert.equal(state.branch, 'fix/reconnect');
});

test('unknown events leave the state alone', () => {
  const state = initialState();
  assert.equal(fold(state, {kind: 'nonsense', at: 1}), state);
});

const JEST_FAILED = duration => `FAIL src/ws.test.js
  ● reconnect › waits up to 30 s

    expect(received).toBe(expected) // Object.is equality

    Expected: 30000
    Received: 5000

Tests:       1 failed, 2 passed, 3 total
Time:        ${duration} s`;

test('test output is parsed into the command and the session\'s last test run', () => {
  const state = foldAll([{kind: 'command_end', cmd: 'npm test', exit: null, output: JEST_FAILED('0.4'), at: 100}]);
  assert.equal(failed(state.commands[0]), true, 'a failed test fails the command, also without an exit code');
  assert.deepEqual(state.tests, {
    runner: 'jest', failed: ['reconnect › waits up to 30 s'], passed: 2, failedCount: 1,
    firstError: 'expect(received).toBe(expected) // Object.is equality (Expected: 30000, Received: 5000)',
    cmd: 'npm test', by: 'you', at: 100, files: ['src/ws.test.js'],
  });
});

test('a passing test run is not a failure, whatever words its test names use', () => {
  const state = foldAll([{kind: 'command_end', cmd: 'npm test', exit: null, output: '  ✓ reports an error on timeout\nTests:       3 passed, 3 total', at: 1}]);
  assert.equal(failed(state.commands[0]), false);
  assert.deepEqual(state.errors, {});
  assert.equal(state.tests.failedCount, 0);
});

test('the same failing test twice is one error, counted twice, though the runs differ', () => {
  const state = foldAll([
    {kind: 'command_end', cmd: 'npm test', exit: 1, output: JEST_FAILED('0.4'), at: 100},
    {kind: 'command_end', cmd: 'npx jest', exit: 1, output: `PASS src/a.test.js\n${JEST_FAILED('1.7')}`, at: 200},
  ]);
  const errors = Object.values(state.errors);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].count, 2);
  assert.match(errors[0].text, /^1 failed \(reconnect › waits up to 30 s\): expect/);
});

test('Scout\'s own runs update the last test run, not the user\'s commands or errors', () => {
  const state = foldAll([{kind: 'scout_run', cmd: 'cargo test', exit: 101, output: 'test result: FAILED. 3 passed; 1 failed; 0 ignored', at: 5}]);
  assert.deepEqual(state.commands, []);
  assert.deepEqual(state.errors, {});
  assert.deepEqual([state.tests.runner, state.tests.by, state.tests.failedCount], ['cargo', 'pair', 1]);
});

test('the user\'s terminal pane is the one they last looked at or ran a command in, never Pair\'s', () => {
  const at = 1000;
  let state = foldAll([{kind: 'focus', target: 'terminal', pane: 'w1:p1', at}]);
  assert.equal(state.terminalPane, 'w1:p1');
  state = foldAll([{kind: 'focus', target: 'chat', pane: 'w1:p2', at}, {kind: 'focus', target: 'editor', pane: 'w1:p4', at}], state);
  assert.equal(state.terminalPane, 'w1:p1');
  state = foldAll([{kind: 'command_end', pane: 'w1:p5', cmd: 'ls', exit: 0, output: '', at}, {kind: 'command_end', pane: null, cmd: 'ls', exit: 0, output: '', at}], state);
  assert.equal(state.terminalPane, 'w1:p5');
  state = foldAll([{kind: 'scout_run', cmd: 'ls', output: '', at}], state);
  assert.equal(state.terminalPane, 'w1:p5');
});

test('a test run on save is the last test run, with the tests that fail now and did not in Pair\'s run on save before', () => {
  const run = (failed, at) => ({kind: 'test_run', cmd: 'go test ./...', saved: 'worker.go', files: ['queue_test.go'], at,
    tests: {runner: 'go', failed, passed: 3, failedCount: failed.length, firstError: null, tests: [], packages: 3}});
  // The user's own narrower run says nothing about the tests it did not run: the first run on save is the baseline.
  const first = foldAll([{kind: 'command_end', cmd: 'go test ./internal/delivery/', exit: 0, output: 'ok  \texample.com/x/delivery\t0.1s', at: 1}, run(['TestDeliver', 'TestNoDouble'], 5)]);
  assert.deepEqual(first.commands.length, 1, 'Pair\'s run is not one of the user\'s commands');
  assert.deepEqual(first.tests.newly, [], 'the first run has nothing to compare with: what fails in it failed already');
  assert.deepEqual([first.tests.by, first.tests.saved, first.tests.files, first.tests.tests], ['pair', 'worker.go', ['queue_test.go'], undefined]);
  const second = fold(first, run(['TestNoDouble', 'TestLease'], 9));
  assert.deepEqual(second.tests.newly, ['TestLease'], 'compared with the run on save before it');
  assert.deepEqual(fold(second, run(['TestNoDouble', 'TestLease'], 12)).tests.newly, [], 'still red the same way: nothing new');
  assert.equal(fold(first, {kind: 'test_run', cmd: 'make', saved: 'a.go', tests: null, at: 9}), first, 'output that is no test run changes nothing');
});

test('a crash or a compiler error is a failure without an exit code, and its line names it', () => {
  const segfault = {exit: null, output: './probe\nmake: *** [Makefile:2: run] Segmentation fault (core dumped)'};
  segfault.reading = readRun(segfault.output);
  assert.equal(failed(segfault), true, 'Segmentation fault says none of the words a failure is found by');
  assert.equal(failureLine(segfault), 'Segmentation fault');
  const build = {exit: null, output: 'probe.c:10:5: error: expected \u2018;\u2019 before \u2018return\u2019'};
  build.reading = readRun(build.output);
  assert.equal(failed(build), true);
  assert.equal(failureLine(build), '1 error: probe.c:10: expected \u2018;\u2019 before \u2018return\u2019');
  const warned = {exit: null, output: 'probe.c:9:7: warning: unused variable \u2018unused\u2019'};
  warned.reading = readRun(warned.output);
  assert.equal(failed(warned), false, 'a warning is no failure');
});

const build = (at, output, {cmd = 'make', exit = 0} = {}) => ({kind: 'command_end', pane: 'w1:p3', cmd, exit, output, at});
const WARN = {unused: 'probe.c:9:7: warning: unused variable \'unused\' [-Wunused-variable]', sign: 'probe.c:21:14: warning: comparison of integers of different signs [-Wsign-compare]'};

test('the last build or run that crashed or printed diagnostics is the state\'s run, until the same command runs clean', () => {
  const crashed = foldAll([build(1, 'avg probe 23.7\nSegmentation fault (core dumped)', {cmd: './probe', exit: 139})], initialState({root: '/p'}));
  assert.deepEqual([crashed.run.cmd, crashed.run.by, crashed.run.crash.signal], ['./probe', 'you', 'SIGSEGV']);
  assert.equal(crashed.commands[0].reading.crash.text, 'Segmentation fault');
  const other = fold(crashed, build(2, 'M probe.c', {cmd: 'git status'}));
  assert.equal(other.run, crashed.run, 'another command that printed nothing of the kind leaves it');
  const clean = fold(other, build(3, 'avg probe 1.3', {cmd: './probe'}));
  assert.deepEqual([clean.run.cmd, clean.run.crash, clean.run.errors], ['./probe', null, []], 'the same command, clean now: nothing to show');
});

test('compiler paths are relative to where the command ran: the run keeps them relative to the project', () => {
  const state = fold(initialState({root: '/p'}), {...build(1, 'probe.c:3:11: error: use of undeclared identifier \'x\'', {exit: 1}), cwd: '/p/src'});
  assert.equal(state.run.errors[0].file, 'src/probe.c');
});

const editing = (file, at) => ({kind: 'edit', file, from: 1, to: 1, at});

test('a new warning: in a file the user edited, and no build in the session printed it before; each command\'s first run is its baseline', () => {
  let state = foldAll([editing('probe.c', 0), build(1, WARN.unused)]);
  assert.deepEqual(state.run.newWarnings, [], 'there when the session started: no news');
  state = fold(state, build(2, `${WARN.unused}\n${WARN.sign}`));
  assert.deepEqual(state.run.newWarnings.map(warning => warning.line), [21]);
  state = fold(state, build(3, WARN.unused.replace(':9:', ':12:')));
  assert.deepEqual(state.run.newWarnings, [], 'a warning that moved with an edit above it is the same one');
  state = fold(state, build(4, '', {cmd: 'make run'}));
  state = fold(state, build(5, WARN.sign, {cmd: 'make run'}));
  assert.deepEqual(state.run.newWarnings, [], 'make rebuilt only some files: a warning another build printed is still old');
  const clean = foldAll([build(1, 'cc -o probe probe.c'), editing('probe.c', 2), build(3, WARN.unused)]);
  assert.equal(clean.run.newWarnings.length, 1, 'after a clean first build, the first warning is news');
});

test('incremental make: a warning in a file the user did not edit is no news when a header change compiles it again', () => {
  // The first build compiles only a.c; then common.h changes, and make compiles both.
  const a = 'cc -Wall -c a.c\na.c:2:19: warning: unused variable ‘unused_a’ [-Wunused-variable]';
  const b = 'cc -Wall -c b.c\nb.c:3:22: warning: unused variable ‘unused_b’ [-Wunused-variable]';
  let state = foldAll([build(1, `${a}\ncc -o app a.o b.o`, {cmd: 'make'}), editing('common.h', 2)]);
  state = fold(state, build(3, `${a}\n${b}\ncc -o app a.o b.o`, {cmd: 'make'}));
  assert.deepEqual(state.run.newWarnings, []);
  state = fold(fold(state, editing('b.c', 4)), build(5, `${a}\n${b}\nb.c:4:7: warning: unused variable ‘spare’ [-Wunused-variable]`, {cmd: 'make'}));
  assert.deepEqual(state.run.newWarnings.map(warning => warning.message), ['unused variable ‘spare’ [-Wunused-variable]'], 'a warning the user\'s edit brought is news');
});

test('a build on save is read like the user\'s: Pair\'s run is the state\'s run', () => {
  const state = fold(initialState(), {kind: 'test_run', cmd: 'make run', saved: 'probe.c', tests: null, reading: readRun('', {exit: 139}), at: 4});
  assert.deepEqual([state.run.cmd, state.run.by, state.run.crash.signal, state.tests], ['make run', 'pair', 'SIGSEGV', null]);
});
