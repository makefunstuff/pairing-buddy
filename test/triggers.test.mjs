import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fold, initialState} from '../src/fold.mjs';
import {detectTriggers, TIMING} from '../src/triggers.mjs';

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
