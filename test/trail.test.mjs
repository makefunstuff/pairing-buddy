// The search trail: your picker searches since the last edit, when they look lost, what the Watcher and the
// Partner are told about them (with what fails now, and what the project has for your words), and :Pair trail.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fold, initialState} from '../src/fold.mjs';
import {PairSession} from '../src/session.mjs';
import {openStore} from '../src/store.mjs';
import {stillTrue} from '../src/held.mjs';
import {currentTrail, lost, TRAIL, trailMatches, trailSummary} from '../src/trail.mjs';
import {detectTriggers} from '../src/triggers.mjs';
import {createWatcher} from '../src/watcher.mjs';

const hasRg = (() => { try { execFileSync('rg', ['--version']); return true; } catch { return false; } })();
const foldAll = (events, state = initialState()) => events.reduce(fold, state);
const search = (query, at, {picker = 'Live Grep', results = 0, file = null} = {}) => ({kind: 'search', picker, query, results, file, at});
const trails = (state, now) => detectTriggers(state, now).filter(trigger => trigger.kind === 'search_trail');

// The research's trail: two greps in the user's words find nothing they open, then a file search opens backoff.go.
const LOST = [
  search('give up', 10_000),
  search('dead letter', 13_000, {results: 1}),
  search('retry', 17_000, {picker: 'Find Files', results: 2, file: 'internal/retry/backoff.go'}),
];
const RED = '--- FAIL: TestDeliverRetriesUntilDeadLetter (0.00s)\n    worker_test.go:31: attempts = 4, want 5\nFAIL\texample.com/hookd/internal/delivery\t0.002s';

test('three searches since the last edit, one closed with nothing opened, are a lost trail', () => {
  const state = foldAll(LOST);
  assert.equal(currentTrail(state, 18_000).length, 3);
  assert.ok(lost(currentTrail(state, 18_000)));
  assert.ok(!lost(currentTrail(foldAll(LOST.slice(0, 2)), 18_000)), 'two searches are not yet a trail');
  const found = foldAll(['worker', 'queue', 'backoff'].map((query, i) => search(query, 10_000 + i * 2000, {picker: 'Find Files', results: 1, file: `${query}.go`})));
  assert.ok(!lost(currentTrail(found, 18_000)), 'three searches that each opened a file: finding the way, not losing it');
  const back = foldAll(['init', 'init', 'Init'].map((query, i) => search(query, 10_000 + i * 2000, {results: 2, file: 'init.lua'})));
  assert.ok(!lost(currentTrail(back, 18_000)), 'the same words opening the same file each time: a way back, not a hunt');
  const again = foldAll([['retry', 'worker.go'], ['backoff', 'backoff.go'], ['Retry', 'queue.go']].map(([query, file], i) => search(query, 10_000 + i * 2000, {results: 2, file})));
  assert.ok(lost(currentTrail(again, 18_000)), 'the same words again, landing elsewhere, count, whatever their case');
});

test('an edit ends a trail, and so does the window', () => {
  const edited = foldAll([...LOST.slice(0, 2), {kind: 'edit', file: 'worker.go', from: 3, to: 3, at: 14_000}, LOST[2]]);
  assert.deepEqual(currentTrail(edited, 18_000).map(found => found.query), ['retry'], 'what you searched before an edit, you found');
  assert.deepEqual(currentTrail(foldAll(LOST), 10_000 + TRAIL.windowMs + 1).map(found => found.query), ['dead letter', 'retry']);
  assert.deepEqual(currentTrail(fold(foldAll(LOST), {kind: 'forget_searches', at: 18_000}), 18_000), [], ':Pair trail\'s x forgets it');
});

test('the trail trigger waits for a pause after the last search, carries what fails now, and each new search is a new look', () => {
  const state = foldAll([{kind: 'command_end', pane: 'w1:p2', cmd: 'go test ./internal/delivery/', exit: 1, output: RED, at: 5000}, ...LOST]);
  assert.deepEqual(trails(state, 17_000 + TRAIL.settleMs - 1), [], 'not while the user may still be searching');
  const [trigger] = trails(state, 17_000 + TRAIL.settleMs);
  assert.equal(trigger.file, 'internal/retry/backoff.go');
  assert.equal(trigger.detail, [
    'The user searched 3 times in 7 s for what looks like one thing, and has not edited since:',
    '- Live Grep "give up": 0 results, closed with nothing opened',
    '- Live Grep "dead letter": 1 result, closed with nothing opened',
    '- Find Files "retry": 2 results, opened internal/retry/backoff.go',
    'Failing now: `go test ./internal/delivery/`: 1 failed (TestDeliverRetriesUntilDeadLetter): worker_test.go:31: attempts = 4, want 5',
  ].join('\n'));
  assert.deepEqual(detectTriggers(state, 21_000, new Set([trigger.key])).filter(found => found.kind === 'search_trail'), [], 'fired once');
  const more = fold(state, search('budget', 22_000));
  assert.equal(trails(more, 26_000)[0].searches.length, 4, 'a fourth search is looked at again');
  assert.match(trails(foldAll(LOST), 21_000)[0].detail, /\nNothing is failing now\.$/);
});

test('the Watcher is asked whether the user goes in circles, with the trail and what fails', async () => {
  let asked;
  const models = {completeSimple: async (_model, context) => { asked = context.messages[0].content; return {content: [{type: 'text', text: '6'}]}; }};
  const score = createWatcher({models, model: {id: 'w'}, now: () => 21_000});
  const state = foldAll([{kind: 'command_end', cmd: 'go test ./...', exit: 1, output: RED, at: 5000}, ...LOST]);
  const [trigger] = trails(state, 21_000);
  assert.deepEqual(await score(trigger, state), {value: 6, reason: ''});
  assert.match(asked, /What just happened \(search_trail\): The user searched 3 times for one thing/);
  assert.match(asked, /- Live Grep "give up": 0 results, closed with nothing opened\n/);
  assert.match(asked, /Failing now: `go test \.\/\.\.\.`: 1 failed \(TestDeliverRetriesUntilDeadLetter\)/);
  assert.match(asked, /0 if the last search plainly found it, 10 if their words are not the code's/);
});

test('what the project has for each query: the words the code lacks are news too', {skip: hasRg ? false : 'rg not installed'}, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pair-trail-')));
  mkdirSync(join(root, 'retry'));
  writeFileSync(join(root, 'retry', 'backoff.go'), 'package backoff\n');
  writeFileSync(join(root, 'worker.go'), '// Deliver gives up after the budget: a dead letter.\nvar ErrBudget = 1\n');
  const searches = foldAll(LOST).searches;
  assert.equal(await trailMatches(root, searches), [
    'What the project has for those words (ripgrep, any case):',
    '"give up": nothing in the project',
    '"dead letter":',
    '  worker.go:1:// Deliver gives up after the budget: a dead letter.',
    '"retry": files retry/backoff.go',
  ].join('\n'));
});

test('a trail remark gets the trail, what fails and the matches; :Pair trail shows the same searches and the Watcher\'s score', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pair-trail-')));
  writeFileSync(join(root, 'worker.go'), 'package delivery\n');
  const store = openStore(':memory:');
  const clock = {now: 30_000};
  const asked = [];
  const pair = new PairSession({
    record: store.createSession({root, conversationId: 'c1', goal: null, level: 'normal', at: 0}),
    store,
    partner: {thinkingOf: () => 'off', ask: async (_id, input) => { asked.push(input); return 'SILENT'; }, setRole: async () => {}},
    score: async () => ({value: 6, reason: ''}),
    typingPauseMs: 2000,
    notify: () => 1,
    requestEditor: async () => null,
    now: () => clock.now,
  });
  pair.receive({kind: 'focus', target: 'terminal', pane: 'w1:p2', at: 4000}); // the user saw it fail
  pair.receive({kind: 'command_end', pane: 'w1:p2', cmd: 'go test ./...', exit: 1, output: RED, at: 5000});
  for (const event of LOST) pair.receive({...event, file: event.file && join(root, event.file)});
  await pair.tick();

  assert.equal(asked.length, 1);
  assert.match(asked[0], /^\[watch\] search_trail: The user searched 3 times in 7 s/);
  assert.match(asked[0], /opened internal\/retry\/backoff\.go\nFailing now: `go test \.\/\.\.\.`: 1 failed/);
  if (hasRg) assert.match(asked[0], /What the project has for those words \(ripgrep, any case\):\n"give up": nothing in the project/);
  assert.match(asked[0], /say in one sentence where it is, in the code's own word/);

  assert.deepEqual(pair.trail(), {
    type: 'trail',
    searches: [
      {picker: 'Live Grep', query: 'give up', results: 0, file: null, line: null, after: 0},
      {picker: 'Live Grep', query: 'dead letter', results: 1, file: null, line: null, after: 3000},
      {picker: 'Find Files', query: 'retry', results: 2, file: 'internal/retry/backoff.go', line: null, after: 7000},
    ],
    summary: '3 searches in 7 s since your last edit; 2 closed with nothing opened.',
    verdict: 'The Watcher scored it 6/10; the bar at normal is 6, so Pair looked for it.',
  });
  pair.forgetTrail();
  assert.deepEqual(pair.trail(), {type: 'trail', searches: [], summary: 'No searches since your last edit.', verdict: null});
});

test('the summary names repeats', () => {
  const state = foldAll(['retry', 'backoff', 'retry'].map((query, i) => search(query, 1000 * (i + 1), {results: 2, file: 'b.go'})));
  assert.equal(trailSummary(currentTrail(state, 4000)), '3 searches in 2 s since your last edit; "retry" more than once.');
});

test('a trail remark held for your next break is dropped once you edit: you found it', () => {
  const state = foldAll(LOST);
  const [trigger] = trails(state, 21_000);
  assert.ok(stillTrue(trigger, state));
  assert.ok(!stillTrue(trigger, fold(state, {kind: 'edit', file: 'worker.go', from: 35, to: 35, at: 22_000})));
});
