// The morning pick-up's parts: finding the place again in today's code, "since yesterday", the request and its
// line, and the failing run the last session ended with.
import assert from 'node:assert/strict';
import {utimesSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {codeOn, fallbackLine, pickupInput, pickupLine, relocate, restoredTests, since} from '../src/pickup.mjs';
import {scratch} from './temp.mjs';

test('the place is found again: on its line, moved to the nearest line with its code, or changed', () => {
  const lines = ['package queue', '', 'func New() {', '\treturn &Queue{ttl: cfg.Budget}', '}'];
  assert.deepEqual(relocate(lines, {line: 4, text: '\treturn &Queue{ttl: cfg.Budget}'}), {line: 4, moved: false, changed: false});
  assert.deepEqual(relocate(['// a comment', ...lines], {line: 4, text: '\treturn &Queue{ttl: cfg.Budget}'}), {line: 5, moved: true, changed: false});
  assert.deepEqual(relocate(lines, {line: 4, text: '\treturn &Queue{ttl: cfg.Budget + cfg.AttemptTimeout}'}), {line: 4, moved: false, changed: true});
  assert.deepEqual(relocate(lines, {line: 40, text: ''}), {line: 5, moved: false, changed: false}, 'past the end: the last line');
});

test('since: a time today, yesterday, a weekday, then a date', () => {
  const now = new Date(2026, 9, 27, 9, 12).getTime(); // a Tuesday
  assert.equal(since(new Date(2026, 9, 27, 8, 5).getTime(), now), '08:05');
  assert.equal(since(new Date(2026, 9, 26, 17, 40).getTime(), now), 'yesterday');
  assert.equal(since(new Date(2026, 9, 23, 17, 40).getTime(), now), 'Friday');
  assert.equal(since(new Date(2026, 9, 3, 17, 40).getTime(), now), '3 Oct');
});

test('the request has the debrief, the step and the code as it is now; the answer is one line', () => {
  const input = pickupInput({
    note: '✓ delivery makes all 5 attempts\nTomorrow, first: lease past the last attempt, in queue.go:18.',
    place: {step: 'lease past the last attempt, in queue.go:18.', file: 'internal/queue/queue.go', line: 18},
    code: '18: \treturn &Queue{ttl: cfg.Budget}', moved: 17, changed: false, failing: ['TestNoDoubleDelivery'],
    ended: new Date(2026, 9, 26, 17, 40).getTime(), now: new Date(2026, 9, 27, 9, 12).getTime(),
  });
  assert.match(input, /^\[pickup\] The user is back: it is Tuesday 09:12, and the last session ended yesterday/);
  assert.match(input, /The code there now \(internal\/queue\/queue\.go:18, moved here from line 17\):\n18: /);
  assert.match(input, /Still failing since then: TestNoDoubleDelivery/);
  assert.equal(pickupLine('\nMorning. The lease still ends at 15 s.\nMore words.'), 'Morning. The lease still ends at 15 s.');
  assert.equal(pickupLine('SILENT'), null);
  assert.equal(pickupLine(null), null);
  assert.equal(fallbackLine({step: 'try it on a phone'}, true), 'Where you stopped: try it on a phone (this line changed since)');
  assert.equal(codeOn('the lease ends at `cfg.Budget`, see `Lease`', '\treturn &Queue{ttl: cfg.Budget}'), 'cfg.Budget');
  assert.equal(codeOn('no code here', 'x'), null);
});

test('the failing run comes back "since yesterday", with the signs of files unchanged since', async () => {
  const dir = scratch('pair-pickup-');
  const kept = join(dir, 'queue_test.go');
  const edited = join(dir, 'worker_test.go');
  writeFileSync(kept, '');
  writeFileSync(edited, '');
  const ended = Date.now() - 60_000;
  utimesSync(kept, new Date(ended - 60_000), new Date(ended - 60_000));
  const tests = {
    type: 'tests', state: 'fail', label: 'go test ./...', text: '1 failing · TestNoDoubleDelivery', redSince: ended - 600_000,
    results: [
      {name: 'TestNoDoubleDelivery', file: kept, line: 26, ok: false, failure: {file: kept, line: 34, text: 'attempt 5 starts at 15s'}},
      {name: 'TestDeliver', file: edited, line: 3, ok: true, failure: null},
    ],
  };
  const now = new Date(ended).setHours(24 + 9, 12);
  const restored = await restoredTests(tests, ended, now);
  assert.equal(restored.text, '1 failing since yesterday · TestNoDoubleDelivery');
  assert.deepEqual(restored.results.map(test => test.name), ['TestNoDoubleDelivery'], 'a file edited since keeps no sign');
  assert.equal(restored.redSince, undefined, 'no "red 900 min" in the statusline');
  assert.equal(await restoredTests({...tests, state: 'pass'}, ended, now), null);
  assert.equal(await restoredTests(null, ended, now), null);
});
