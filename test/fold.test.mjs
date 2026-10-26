import assert from 'node:assert/strict';
import {test} from 'node:test';
import {errorSignature, failed, fold, initialState} from '../src/fold.mjs';

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
