import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fold, initialState} from '../src/fold.mjs';
import {onGoal, prefilter, words} from '../src/prefilter.mjs';

const GOAL = 'reconnect should wait 30 s after the phone sleeps';
const failure = (cmd, exit) => ({kind: 'failed_command', key: 'k', detail: '', command: {cmd, exit}});
const edited = (...edits) => edits.reduce((state, [file, text], at) => fold(state, {kind: 'edit', file, from: 1, to: 1, text, at}), initialState({goal: GOAL}));

test('words splits paths, identifiers and camelCase', () => {
  assert.deepEqual(words('src/net/reconnectTimer.ts RECONNECT_TIMEOUT_MS'), ['src', 'net', 'reconnect', 'timer', 'ts', 'reconnect', 'timeout', 'ms']);
});

test('a search that finds nothing, or a command the user stopped, is not a failure worth a remark', () => {
  const state = initialState({goal: GOAL});
  for (const cmd of ['grep -rn SLEEP src', 'rg backoff', 'git diff --exit-code', 'diff a b', 'test -f x']) {
    assert.equal(prefilter(failure(cmd, 1), state)?.value, 0, cmd);
  }
  assert.match(prefilter(failure('npm test', 130), state).reason, /stopped by the user/);
  assert.equal(prefilter(failure('grep -rn x src', 2), state), null, 'exit 2 of grep is an error');
  assert.equal(prefilter(failure('npm test', 1), state), null);
  assert.equal(prefilter({...failure('rg x', 1), kind: 'stall'}, state)?.value, 0, 'also for a stall after it');
});

test('drift into a file that shares words with the goal, by its path or its new text, is noise', () => {
  const state = edited(['src/ws.mjs', 'export const RECONNECT_TIMEOUT_MS = 30000;'], ['src/power/sleepWatch.ts', ''], ['src/billing.mjs', 'export const tax = 0.2;']);
  assert.equal(onGoal(state, 'src/ws.mjs'), true, 'by what was written');
  assert.equal(onGoal(state, 'src/power/sleepWatch.ts'), true, 'by the path, "sleep" for "sleeps"');
  assert.equal(onGoal(state, 'src/billing.mjs'), false);
  assert.match(prefilter({kind: 'drift', key: 'd', detail: '', file: 'src/ws.mjs'}, state).reason, /shares words with the goal/);
  assert.equal(prefilter({kind: 'drift', key: 'd', detail: '', file: 'src/billing.mjs'}, state), null, 'the Watcher judges it');
});

test('common words and short ones do not make a file look on-goal', () => {
  const state = fold(initialState({goal: 'fix the test for the ui after login'}), {kind: 'edit', file: 'test/billing.test.ts', from: 1, to: 1, text: 'build()', at: 0});
  assert.equal(onGoal(state, 'test/billing.test.ts'), false);
});
