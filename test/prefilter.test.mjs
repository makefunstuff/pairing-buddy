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

test('drift into a file whose path shares a word with the goal is noise', () => {
  assert.equal(onGoal(GOAL, 'src/power/sleepWatch.ts'), true, '"sleep" for "sleeps"');
  assert.equal(onGoal('reconnect waits', 'src/net/reconnecting.ts'), true);
  assert.equal(onGoal('update caches', 'src/cache.ts'), true);
  assert.equal(onGoal(GOAL, 'src/ws.mjs'), false, 'no word in common: the Watcher judges it');
  const state = fold(initialState({goal: GOAL}), {kind: 'edit', file: 'src/power/sleepWatch.ts', from: 1, to: 1, text: '', at: 0});
  assert.match(prefilter({kind: 'drift', key: 'd', detail: '', file: 'src/power/sleepWatch.ts'}, state).reason, /shares a word with the goal/);
  assert.equal(prefilter({kind: 'drift', key: 'd', detail: '', file: 'src/billing.mjs'}, state), null);
});

test('what was typed, prefixes and common words do not make an unrelated file look on-goal', () => {
  const typed = 'const formatted = parseFloat(user.total); await wait(10); indexOfLine(a)';
  for (const goal of ['fix the login form validation', 'reconnect waits 30 s after the phone sleeps', 'speed up the search index',
    'add user avatars to the profile page', 'make the parser handle tabs', 'fix the test for the ui after login']) {
    const state = fold(initialState({goal}), {kind: 'edit', file: 'src/billing/invoice.ts', from: 1, to: 1, text: typed, at: 0});
    assert.equal(prefilter({kind: 'drift', key: 'd', detail: '', file: 'src/billing/invoice.ts'}, state), null, goal);
  }
  assert.equal(onGoal('fix the login form validation', 'src/billing/formatted.ts'), false, '"form" is not "formatted"');
  assert.equal(onGoal('fix the test for the ui', 'test/billing.test.ts'), false, '"test" is too common');
});
