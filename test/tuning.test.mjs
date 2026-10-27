import assert from 'node:assert/strict';
import {test} from 'node:test';
import {IGNORED_AFTER_MS, keptShare, NO_TUNING, outcome, tally, tuning, WINDOW_MS} from '../src/tuning.mjs';

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
  assert.deepEqual(tuning(old, NOW), NO_TUNING);
});

test('a project with verdicts enough tunes on its own, per trigger and for the budget; the rest follows all projects', () => {
  const at = root => remark => ({...remark, root});
  const noisyDrift = remarks('drift', Array(5).fill('dismissed')).map(at('/docs'));
  const usefulDrift = remarks('drift', Array(5).fill('useful')).map(at('/app'));
  const stalls = remarks('stall', ['useful', 'useful', 'useful', 'useful', 'dismissed']).map(at('/app'));
  const all = [...noisyDrift, ...usefulDrift, ...stalls];

  assert.deepEqual(tuning(all, NOW).offsets, {drift: 0, stall: -1}, 'all projects pooled: drift half kept');
  const docs = tuning(all, NOW, '/docs');
  assert.deepEqual(docs.offsets, {drift: 2, stall: -1}, 'its own drift bar; stall from all projects');
  assert.deepEqual(docs.project, {triggers: ['drift'], budget: false});
  assert.equal(docs.factor, 1, 'five verdicts are too few for its own budget: that of all projects, 60% kept');
  const app = tuning(all, NOW, '/app');
  assert.deepEqual(app.offsets, {drift: -1, stall: -1});
  assert.deepEqual(app.project, {triggers: ['drift', 'stall'], budget: true});
  assert.equal(app.factor, 1.5, 'its own budget: 90% kept');
  assert.deepEqual(tuning(all, NOW, '/new').offsets, tuning(all, NOW).offsets, 'a project without verdicts follows all of them');
});
