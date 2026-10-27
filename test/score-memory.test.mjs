import assert from 'node:assert/strict';
import {test} from 'node:test';
import {rememberScores} from '../src/score-memory.mjs';

const momentOf = trigger => trigger.detail;

test('the same moment gets the score it got last time, without asking; another moment is asked', async () => {
  let clock = 0;
  const asked = [];
  const score = rememberScores(async trigger => { asked.push(trigger.detail); return {value: 7, reason: ''}; }, {momentOf, now: () => clock});
  const state = {goal: 'fix reconnect'};
  const failure = {kind: 'failed_command', detail: '`npm test` failed: Expected 30000'};
  assert.deepEqual(await score(failure, state), {value: 7, reason: ''});
  assert.deepEqual(await score(failure, state), {value: 7, reason: '', remembered: true});
  await score({...failure, detail: '`npm test` failed: Expected 5000'}, state);
  await score(failure, {goal: 'another goal'});
  assert.equal(asked.length, 3, 'another failure, or the same under another goal, is asked');
  clock += 31 * 60_000;
  await score(failure, state);
  assert.equal(asked.length, 4, 'after half an hour it is asked again');
});

test('a score that failed, was not given or had to wait is not remembered', async () => {
  const answers = [{deferred: true}, {value: 0, error: 'timeout'}, {value: 0, unscored: true}, {value: 4, reason: ''}];
  let asked = 0;
  const score = rememberScores(async () => answers[asked++], {momentOf});
  const drift = {kind: 'drift', detail: 'src/x.ts'};
  for (const answer of answers) assert.deepEqual(await score(drift, {}), answer);
  assert.deepEqual(await score(drift, {}), {value: 4, reason: '', remembered: true});
  assert.equal(asked, 4);
});
