// Session memory and feedback: the note the next session starts from, the user's verdicts on remarks, the
// tuning they lead to, and the active time `pair stats` divides by. With a real store in memory.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {BUDGETS} from '../src/budget.mjs';
import {cleanNote, PairSession} from '../src/session.mjs';
import {openStore} from '../src/store.mjs';

const MIN = 60_000;

/** A session on a fresh store whose Partner answers from `answers` in turn; `clock.now` drives it. */
function pairSession({store = openStore(':memory:'), root = '/project', answers = [], score = 9, autoTune = false} = {}) {
  const clock = {now: 100 * MIN};
  const record = store.createSession({root, conversationId: 'c1', goal: 'fix reconnect', level: 'normal', at: clock.now});
  const sent = [];
  const asked = [];
  const pair = new PairSession({
    record, store, autoTune,
    previousNote: store.previousNote(root, record.id),
    partner: {
      ask: async (_id, input) => { asked.push(input); const answer = answers.shift(); return typeof answer === 'function' ? answer() : answer; },
      setRole: async () => {},
    },
    score: async () => ({value: score, reason: 'test'}),
    typingPauseMs: 2000,
    notify: (to, message) => { sent.push({to, ...message}); return 1; },
    requestEditor: async () => null,
    now: () => clock.now,
  });
  return {pair, store, clock, sent, asked};
}

const failTwice = (pair, at) => {
  for (const offset of [-10_000, -5000]) pair.receive({kind: 'command_end', cmd: 'npm test', exit: 1, output: 'Error: boom', at: at + offset});
};
const chatTexts = sent => sent.filter(message => message.type === 'message').map(message => message.text);

test('a remark that reaches the user is stored with its trigger and score; the chat learns its id, the editor also its words', async () => {
  const {pair, store, clock, sent} = pairSession({answers: ['Line 2 is off.']});
  failTwice(pair, clock.now);
  await pair.tick();
  const [remark] = store.remarks(0);
  assert.deepEqual({trigger: remark.trigger, score: remark.score, verdict: remark.verdict}, {trigger: 'repeated_error', score: 9, verdict: null});
  assert.deepEqual(sent.filter(message => message.type === 'remark').map(message => [message.to, message.id]), [['chat', remark.id], ['editor', remark.id]]);
});

test('a SILENT remark is not stored, so it cannot count as ignored', async () => {
  const {pair, store, clock, sent} = pairSession({answers: ['SILENT']});
  failTwice(pair, clock.now);
  await pair.tick();
  assert.deepEqual(store.remarks(0), []);
  assert.ok(!sent.some(message => message.type === 'remark'));
});

test('feedback rates the last remark, or the one named; implicit feedback is not confirmed in the chat', async () => {
  const {pair, store, clock, sent} = pairSession({answers: ['Line 2 is off.']});
  pair.feedback({useful: true});
  assert.deepEqual(chatTexts(sent), ['There is no remark of Pair to rate yet.']);

  failTwice(pair, clock.now);
  await pair.tick();
  const [{id}] = store.remarks(0);
  pair.feedback({useful: false});
  assert.equal(store.remarks(0)[0].verdict, 'dismissed');
  assert.equal(chatTexts(sent).at(-1), 'Noted: not useful.');
  const shown = sent.length;
  pair.feedback({useful: true, id, implicit: true}); // the user accepted the remark's suggestion after all
  assert.equal(store.remarks(0)[0].verdict, 'useful');
  assert.equal(sent.length, shown);
});

test('a suggestion in a remark carries the remark\'s id; one in an answer to the user carries none', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pair-memory-'));
  writeFileSync(join(root, 'a.js'), 'const x = 1\n');
  let pair;
  const suggestAndSay = async () => { await pair.suggest({file: 'a.js', line: 1, endLine: 1, text: 'const x = 2', note: 'two'}); return 'Make it two.'; };
  const made = pairSession({root, answers: [suggestAndSay, suggestAndSay]});
  pair = made.pair;
  failTwice(pair, made.clock.now);
  await pair.tick();
  await pair.ask('and now?');
  const suggestions = made.sent.filter(message => message.type === 'suggest');
  assert.deepEqual(suggestions.map(message => message.remark), [made.store.remarks(0)[0].id, null]);
});

test('a suggestion held while the user types keeps its remark\'s id', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pair-memory-'));
  writeFileSync(join(root, 'a.js'), 'const x = 1\n');
  let made;
  const typeThenSuggest = async () => {
    made.pair.receive({kind: 'typing', at: made.clock.now});
    await made.pair.suggest({file: 'a.js', line: 1, endLine: 1, text: 'const x = 2', note: 'two'});
    return 'Make it two.';
  };
  made = pairSession({root, answers: [typeThenSuggest]});
  failTwice(made.pair, made.clock.now - 5000);
  await made.pair.tick();
  assert.deepEqual(made.sent.filter(message => message.type === 'suggest'), [], 'held while the user types');
  made.clock.now += 3000;
  await made.pair.tick();
  const [suggestion] = made.sent.filter(message => message.type === 'suggest');
  assert.equal(suggestion.remark, made.store.remarks(0)[0].id);
});

test('with autoTune, dismissed remarks of a trigger raise its bar before the next one is scored', async () => {
  const store = openStore(':memory:');
  const old = store.createSession({root: '/project', conversationId: 'c0', level: 'normal', at: 0});
  for (let i = 0; i < 6; i++) store.rateRemark(store.addRemark({sessionId: old.id, trigger: 'repeated_error', score: 7, at: 90 * MIN + i}), 'dismissed');

  const tuned = pairSession({store, answers: ['Line 2 is off.'], score: 7, autoTune: true});
  failTwice(tuned.pair, tuned.clock.now);
  await tuned.pair.tick();
  assert.equal(tuned.pair.budget.barFor('repeated_error'), BUDGETS.normal.bar + 2);
  assert.deepEqual(tuned.asked, [], 'a 7 no longer clears the bar of a trigger that was mostly noise');

  const untuned = pairSession({store, answers: ['Line 2 is off.'], score: 7});
  failTwice(untuned.pair, untuned.clock.now);
  await untuned.pair.tick();
  assert.equal(untuned.asked.length, 1, 'without autoTune the level\'s bar holds');
});

test('the session note is written from the goal and the uncommitted changes, and the next session in the repo starts from it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pair-memory-'));
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, 'ws.ts'), 'export const TIMEOUT = 30;\n');
  const store = openStore(':memory:');

  const first = pairSession({store, root, answers: ['Goal: fix reconnect. Changed: ws.ts timeout. Loose end: test on a phone.']});
  await first.pair.end();
  assert.match(first.asked[0], /^\[end\][\s\S]*Goal: fix reconnect\nUncommitted changes \(git status\): \n\?\? ws\.ts$/);
  assert.equal(chatTexts(first.sent).at(-1), 'Session note:\nGoal: fix reconnect. Changed: ws.ts timeout. Loose end: test on a phone.');

  const other = pairSession({store, root: '/elsewhere'});
  assert.equal(other.pair.previousNote, null, 'another project has its own memory');

  const next = pairSession({store, root});
  assert.equal(next.pair.previousNote, 'Goal: fix reconnect. Changed: ws.ts timeout. Loose end: test on a phone.');
  next.pair.greet();
  assert.deepEqual(chatTexts(next.sent), ['Last time:\nGoal: fix reconnect. Changed: ws.ts timeout. Loose end: test on a phone.', 'Goal: fix reconnect']);
});

test('a note loses a heading of its own, and SILENT or nothing is no note', () => {
  assert.equal(cleanNote('Session note:\nGoal: fix it.\nLoose end: tests.'), 'Goal: fix it.\nLoose end: tests.');
  assert.equal(cleanNote('**Session note**\nGoal: fix it.'), 'Goal: fix it.');
  assert.equal(cleanNote('Session note: Goal: fix it.'), 'Goal: fix it.');
  assert.equal(cleanNote('# Session Notes\nGoal: fix it.'), 'Goal: fix it.');
  assert.equal(cleanNote('**Session note:** Goal: fix it.'), 'Goal: fix it.');
  assert.equal(cleanNote('Session notes are now kept per repo.'), 'Session notes are now kept per repo.');
  assert.equal(cleanNote('Goal: the session note format.'), 'Goal: the session note format.');
  assert.equal(cleanNote('SILENT'), null);
  assert.equal(cleanNote(''), null);
  assert.equal(cleanNote('Session note:'), null);
});

test('a session whose note failed leaves no memory: the next one starts from the last good note', async () => {
  const store = openStore(':memory:');
  await pairSession({store, answers: ['Loose end: the flaky test.']}).pair.end();
  const failed = pairSession({store, answers: [() => Promise.reject(new Error('model down'))]});
  await failed.pair.end();
  assert.equal(chatTexts(failed.sent).at(-1), 'No session note: model down');
  await pairSession({store, answers: ['SILENT']}).pair.end();
  assert.equal(pairSession({store}).pair.previousNote, 'Loose end: the flaky test.');
});

test('active time counts while the user works, not while they are away, and is stored at the end', async () => {
  const {pair, store, clock} = pairSession({answers: ['note']});
  const tickFor = async ms => { for (let t = 0; t < ms; t += 1000) { clock.now += 1000; await pair.tick(); } };
  pair.receive({kind: 'typing', at: clock.now});
  await pair.tick();
  await tickFor(2 * MIN);
  await tickFor(10 * MIN); // up to five minutes after the last key count: then the user is away
  clock.now += 60 * MIN; // a suspended laptop: one long gap between ticks
  pair.receive({kind: 'typing', at: clock.now});
  await pair.tick();
  await pair.end();
  assert.equal(store.activeMs(0), (5 * MIN - 1000) + 5000, 'the five minutes after the key, and at most 5 s of the gap');
  assert.equal(store.activeMs(clock.now - 30 * MIN), 5000, 'counted in the hour it happened: only the end is this hour');
});
