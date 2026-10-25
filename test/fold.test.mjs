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
  assert.equal(failed({exit: null, output: 'all good'}), false);
  assert.equal(failed({exit: 0, output: 'Error: but exit code wins'}), false);
  assert.equal(failed({exit: 2, output: ''}), true);
});

test('errorSignature prefers the line that names the failure', () => {
  assert.equal(errorSignature('compiling\nsrc/x.rs:12 error[E0308]: mismatched types\nwarning: 3 more'), 'src/x.rs:# error[e#]: mismatched types');
});

test('diagnostics keep the time they first appeared', () => {
  const item = {line: 7, severity: 'error', message: 'x is undefined'};
  const state = foldAll([
    {kind: 'diagnostics', file: 'a.js', items: [item], at: 100},
    {kind: 'diagnostics', file: 'a.js', items: [item, {line: 9, severity: 'warning', message: 'unused'}], at: 300},
  ]);
  assert.deepEqual(state.diagnostics['a.js'].map(d => [d.line, d.at]), [[7, 100], [9, 300]]);
});

test('cursor, focus, goal, branch and chat are folded as given', () => {
  const state = foldAll([
    {kind: 'cursor', file: 'b.js', line: 4, col: 2, selection: {from: 4, to: 6}, at: 1},
    {kind: 'focus', target: 'terminal', pane: 'w1:p2', scrolled: true, at: 2},
    {kind: 'goal', text: 'fix reconnect', at: 3},
    {kind: 'branch', name: 'fix/reconnect', at: 4},
    {kind: 'chat', from: 'user', text: 'hi', at: 5},
  ]);
  assert.equal(state.file, 'b.js');
  assert.deepEqual(state.cursor, {line: 4, col: 2});
  assert.deepEqual(state.selection, {from: 4, to: 6});
  assert.deepEqual(state.focus, {target: 'terminal', pane: 'w1:p2', scrolled: true, at: 2});
  assert.equal(state.goal, 'fix reconnect');
  assert.equal(state.branch, 'fix/reconnect');
  assert.equal(state.chat[0].text, 'hi');
});

test('unknown events leave the state alone', () => {
  const state = initialState();
  assert.equal(fold(state, {kind: 'nonsense', at: 1}), state);
});
