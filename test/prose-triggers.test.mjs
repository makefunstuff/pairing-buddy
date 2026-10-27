import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fold, initialState} from '../src/fold.mjs';
import {PROSE_TIMING, proseTriggers} from '../src/prose-triggers.mjs';
import {detectTriggers, TRIGGER_KINDS} from '../src/triggers.mjs';

const NOTE = 'docs/dead-letters.md';
const write = (state, at, text, from = 20, file = NOTE) => fold(state, {kind: 'edit', file, from, to: from + text.split('\n').length - 1, text, at});
const titled = (state, title = 'Dead letters') => fold(state, {kind: 'note', file: NOTE, title, at: 0});

test('the stall in prose: a question you wrote, then no new words for 90 s, asks one question back', () => {
  const state = write(initialState({goal: 'dead letters'}), 1000, 'We park after 6 attempts.\nDoes a receiver that is down a minute reach 6?');
  assert.deepEqual(proseTriggers(state, 1000 + PROSE_TIMING.stallMs - 1), []);
  const [stall] = proseTriggers(state, 1000 + PROSE_TIMING.stallMs);
  assert.equal(stall.kind, 'note_stall');
  assert.equal(stall.line, 21);
  assert.match(stall.detail, /wrote the question "Does a receiver that is down a minute reach 6\?" \(line 21\)/);
  assert.deepEqual(proseTriggers(state, 1000 + PROSE_TIMING.awayMs + 1), []); // away, not stuck
});

test('no stall without a question, nor in a code file', () => {
  assert.deepEqual(proseTriggers(write(initialState(), 1000, 'We park after 6 attempts.'), 100_000), []);
  assert.deepEqual(proseTriggers(write(initialState(), 1000, 'if (x) { return y; } // why?', 3, 'src/main.c'), 100_000), []);
});

test('the drift in prose: a new section that shares no word with the title or goal, a minute after it began', () => {
  let state = titled(write(initialState({goal: 'dead letters'}), 1000, '## Pricing tiers', 30));
  state = write(state, 20_000, 'Customers on the free plan get three seats.', 32);
  assert.deepEqual(proseTriggers(state, 1000 + PROSE_TIMING.sectionMs - 1), []);
  const [drift] = proseTriggers(state, 1000 + PROSE_TIMING.sectionMs);
  assert.equal(drift.kind, 'note_drift');
  assert.equal(drift.key, `note_drift:${NOTE}:## Pricing tiers`);
  assert.ok(drift.lasting);
  assert.match(drift.detail, /In the note "Dead letters" \(docs\/dead-letters\.md\), the user began the section "## Pricing tiers"/);
});

test('a section about the note\'s own subject is no drift, nor one in a note Pair has not read yet', () => {
  let state = titled(write(initialState(), 1000, '## Retention', 30));
  state = write(state, 20_000, 'Dead letters are kept for 30 days.', 32);
  assert.deepEqual(proseTriggers(state, 100_000), []);
  assert.deepEqual(proseTriggers(write(initialState(), 1000, '## Pricing tiers', 30), 100_000), []);
});

test('the prose triggers are among the triggers Pair looks for, and fire once', () => {
  assert.ok(TRIGGER_KINDS.includes('note_stall') && TRIGGER_KINDS.includes('note_drift'));
  const state = write(initialState(), 1000, 'Who replays them?');
  const [stall] = detectTriggers(state, 100_000);
  assert.equal(stall.kind, 'note_stall');
  assert.deepEqual(detectTriggers(state, 100_000, new Set([stall.key])).filter(trigger => trigger.kind === 'note_stall'), []);
});

test('the Watcher is asked about the question or the section itself, not whether something failed', async () => {
  const {createWatcher} = await import('../src/watcher.mjs');
  const asked = [];
  const models = {completeSimple: async (_model, context) => { asked.push(context.messages[0].content); return {content: [{type: 'text', text: '7'}]}; }};
  const score = createWatcher({models, model: {}});
  const stalled = write(initialState(), 1000, 'Who replays them?');
  await score(proseTriggers(stalled, 100_000)[0], stalled);
  assert.match(asked[0], /They wrote the question "Who replays them\?" and have written nothing since, for 99 s\.\nScore how much one question back/);
  let drifted = titled(write(initialState(), 1000, '## Pricing tiers', 30));
  drifted = write(drifted, 2000, 'Three seats.', 32);
  await score(proseTriggers(drifted, 100_000)[0], drifted);
  assert.match(asked[1], /titled "Dead letters"\. They began the section "## Pricing tiers"[\s\S]*0 if it could belong in that note/);
});

test('a stall remark is one question back: its first question alone, once, and no point', async () => {
  const {PairSession} = await import('../src/session.mjs');
  const {oneQuestion} = await import('../src/prose-triggers.mjs');
  const sent = [];
  const told = [];
  let pair;
  const partner = {thinkingOf: () => 'off', ask: async () => {
    told.push(await pair.point({file: 'package.json', line: 1, note: '5 on line 14, 6 here'}));
    pair.say('If replay restarts at 1, what stops endless replays?');
    pair.say('If replay always restarts at attempt 1, what stops it? (Also: line 14 says 5 attempts, line 21 says 6.)');
    return 'Also, line 14 contradicts line 21.';
  }};
  pair = new PairSession({
    record: {id: 1, root: process.cwd(), conversation_id: 7, goal: 'dead letters', level: 'normal'},
    store: {addMessage() {}, addAction: () => 1, updateAction() {}, action: () => null, lastRemark: () => null, addRemark: () => 1, dropRemark() {}},
    partner, score: async () => ({value: 9}), typingPauseMs: 2000,
    notify: (role, message) => sent.push({role, ...message}),
    requestEditor: async () => null,
    now: () => 200_000,
  });
  const state = write(initialState(), 100_000, 'Should replay reset the attempt count?');
  await pair.remark(proseTriggers(state, 200_000)[0], 9);
  assert.deepEqual(told, ['Not in this remark: ask your one question in words.']);
  assert.deepEqual(sent.filter(message => message.type === 'message').map(message => message.text), ['If replay restarts at 1, what stops endless replays?']);
  assert.ok(!sent.some(message => message.type === 'point'));
  assert.equal(sent.find(message => message.type === 'remark' && message.role === 'editor').text, 'If replay restarts at 1, what stops endless replays?');
  // Outside such a remark, nothing is cut.
  assert.equal(pair.voiced('One. Two?'), 'One. Two?');
  assert.equal(oneQuestion('Does `worker.go:36` park it? (Also: line 14 says 5.)'), 'Does `worker.go:36` park it?');
  assert.equal(oneQuestion('Line 14 says 5 attempts and line 20 says 6.'), null);
  assert.equal(oneQuestion(`${'word '.repeat(30)}?`), null);
});
