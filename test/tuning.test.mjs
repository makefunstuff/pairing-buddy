import assert from 'node:assert/strict';
import {test} from 'node:test';
import {IGNORED_AFTER_MS, keptShare, outcome, tally, tuning, WINDOW_MS} from '../src/tuning.mjs';

const NOW = 100 * 24 * 60 * 60_000;
const HOUR = 60 * 60_000;

/** Remarks of `trigger` with these verdicts, an hour apart, newest first. */
const remarks = (trigger, verdicts) => verdicts.map((verdict, i) => ({trigger, verdict, at: NOW - (i + 1) * HOUR}));

test('a remark without a verdict is waiting at first, and counts as ignored after ten minutes', () => {
  assert.equal(outcome({verdict: null, at: NOW - 1000}, NOW), 'waiting');
  assert.equal(outcome({verdict: null, at: NOW - IGNORED_AFTER_MS}, NOW), 'ignored');
  assert.equal(outcome({verdict: 'useful', at: NOW - 1000}, NOW), 'useful');
  assert.equal(outcome({verdict: 'dismissed', at: NOW}, NOW), 'dismissed');
});

test('ignored and dismissed remarks both count as not kept', () => {
  const counts = tally([...remarks('stall', ['useful', 'dismissed', null]), {trigger: 'stall', verdict: null, at: NOW}], NOW);
  assert.deepEqual(counts, {remarks: 4, useful: 1, dismissed: 1, seen: 0, ignored: 1, waiting: 1});
  assert.equal(keptShare(counts), 1 / 3);
  assert.equal(keptShare(tally([], NOW)), null);
});

test('mostly noise raises a trigger\'s bar, mostly useful lowers it, and a few verdicts change nothing', () => {
  const {offsets} = tuning([
    ...remarks('drift', ['dismissed', null, null, 'dismissed', 'dismissed']),
    ...remarks('failed_command', ['useful', 'useful', 'useful', 'useful', 'dismissed']),
    ...remarks('stall', ['useful', 'dismissed', 'useful', 'dismissed', null, 'useful']),
    ...remarks('repeated_error', ['dismissed', 'dismissed', 'dismissed', 'dismissed']),
  ], NOW);
  assert.deepEqual(offsets, {drift: 2, failed_command: -1, stall: 0});
});

test('the budget shrinks when most remarks are noise and grows when nearly all are kept', () => {
  const noisy = tuning([...remarks('drift', Array(6).fill('dismissed')), ...remarks('stall', ['useful', null, null, null, null])], NOW);
  assert.equal(noisy.factor, 0.5);
  const kept = tuning([...remarks('failed_command', Array(9).fill('useful')), ...remarks('stall', ['useful', 'useful', 'dismissed'])], NOW);
  assert.equal(kept.factor, 1.5);
  assert.equal(tuning(remarks('drift', Array(9).fill('dismissed')), NOW).factor, 1, 'fewer than ten verdicts leave the budget alone');
});

test('only recent verdicts count: the last twenty per trigger, within the window', () => {
  // Twenty useful remarks after forty dismissed ones: the user's habits changed, and the bar follows.
  const changed = remarks('drift', [...Array(20).fill('useful'), ...Array(40).fill('dismissed')]);
  assert.equal(tuning(changed, NOW).offsets.drift, -1);
  const old = remarks('drift', Array(10).fill('dismissed')).map(remark => ({...remark, at: remark.at - WINDOW_MS}));
  assert.deepEqual(tuning(old, NOW), {offsets: {}, factor: 1});
});
