// Session memory and feedback: the note the next session starts from, the user's verdicts on remarks, the
// tuning they lead to, and the active time `pair stats` divides by. With a real store in memory.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
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
      thinkingOf: () => 'off',
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
/** `made` after the user typed in it: a session with no work in it ends without a note. */
const worked = made => { made.pair.receive({kind: 'typing'}); return made; };
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
  worked(first);
  await first.pair.end();
  assert.match(first.asked[0], /^\[end\][\s\S]*Goal: fix reconnect\nUncommitted changes \(git status\): \n\?\? ws\.ts$/);
  assert.match(chatTexts(first.sent).at(-1), /^(Day|Session)'s end: under a minute in pair-memory-\w+\.\nGoal: fix reconnect\. Changed: ws\.ts timeout\. Loose end: test on a phone\.$/);

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
  await worked(pairSession({store, answers: ['Loose end: the flaky test.']})).pair.end();
  const failed = worked(pairSession({store, answers: [() => Promise.reject(new Error('model down'))]}));
  await failed.pair.end();
  assert.equal(chatTexts(failed.sent).at(-1), 'No session note: model down');
  await worked(pairSession({store, answers: ['SILENT']})).pair.end();
  await pairSession({store, answers: ['Loose end: nothing done.']}).pair.end(); // no work in it: no note asked for
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

test('after a daemon restart, + and - still rate the session\'s last remark', async () => {
  const before = pairSession({answers: ['Line 2 is off.']});
  failTwice(before.pair, before.clock.now);
  await before.pair.tick();
  const [{id}] = before.store.remarks(0);
  // The daemon restarts: the same session is loaded again from the store.
  const record = before.store.activeSession('/project');
  const sent = [];
  const after = new PairSession({
    record, store: before.store, partner: {thinkingOf: () => 'off', setRole: async () => {}}, score: async () => ({value: 9}),
    typingPauseMs: 2000, notify: (to, message) => { sent.push({to, ...message}); return 1; }, requestEditor: async () => null,
  });
  // The daemon stopped while Pair was making another remark: its row is stored, but it never reached the user.
  const unseen = before.store.addRemark({sessionId: record.id, trigger: 'stall', score: 8, at: before.clock.now});
  after.feedback({useful: true});
  assert.equal(before.store.remarks(0).find(remark => remark.id === id).verdict, 'useful', 'the remark the user saw');
  assert.equal(before.store.remarks(0).find(remark => remark.id === unseen).verdict, null, 'not the one they never saw');
  assert.deepEqual(chatTexts(sent), ['Noted: useful.']);
  assert.deepEqual(after.remarkList().remarks.map(remark => remark.id), [id], '/remarks lists only remarks that reached the user');
});

test('/remarks lists the last remarks in the project, newest first, with their words; +N and -N rate an older one', async () => {
  const {pair, store, clock, sent} = pairSession({answers: ['The retry count is off by one.', 'The timeout is in seconds, not ms.']});
  failTwice(pair, clock.now);
  await pair.tick();
  clock.now += 10 * MIN;
  for (const offset of [-10_000, -5000]) pair.receive({kind: 'command_end', cmd: 'npm run build', exit: 2, output: 'TypeError: x is undefined', at: clock.now + offset});
  await pair.tick();
  const [newer, older] = store.remarks(0);
  pair.feedback({useful: true}); // the last one, as before

  const {remarks} = pair.remarkList();
  assert.deepEqual(remarks.map(remark => [remark.id, remark.trigger, remark.text, remark.outcome]), [
    [newer.id, newer.trigger, 'The timeout is in seconds, not ms.', 'useful'],
    [older.id, 'repeated_error', 'The retry count is off by one.', 'ignored'],
  ]);
  pair.feedback({useful: false, number: 2});
  assert.equal(store.remarks(0).find(remark => remark.id === older.id).verdict, 'dismissed');
  assert.equal(chatTexts(sent).at(-1), 'Noted: not useful (remark 2).');
  pair.feedback({useful: true, number: 5});
  assert.equal(chatTexts(sent).at(-1), 'There is no remark 5: /remarks lists them.');
});

test('earlier sessions are searchable: recall finds their notes and chat lines, newest and best first, never this session\'s', async () => {
  const store = openStore(':memory:');
  const old = pairSession({store, answers: ['✓ The reconnect waits 30 s now.\n○ open: try it on a real phone.']});
  worked(old);
  old.pair.message('user', 'did raising RECONNECT_TIMEOUT_MS help?');
  old.pair.message('pair', 'No: the socket closes before the timeout. The phone drops it when it sleeps.');
  old.pair.message('user', 'unrelated: rename the logger');
  await old.pair.end();
  const unrelated = pairSession({store, root: '/elsewhere'});
  unrelated.pair.message('user', 'the reconnect timeout in another project');

  const now = pairSession({store});
  now.pair.message('user', 'reconnect timeout, today');
  const found = now.pair.recall({query: 'what did we try for the reconnect timeout?'});
  const lines = found.split('\n');
  assert.equal(lines[0], 'From the earlier sessions of this project, best matches first:');
  assert.match(lines[1], /^- Session of \d{4}-\d\d-\d\d \(goal: fix reconnect\), its note:$/);
  assert.equal(lines[2], '✓ The reconnect waits 30 s now.');
  assert.match(lines[4], /^- \d{4}-\d\d-\d\d \d\d:\d\d \(goal: fix reconnect\), the user: did raising RECONNECT_TIMEOUT_MS help\?$/);
  assert.match(lines[5], /, you: No: the socket closes before the timeout\. The phone drops it when it sleeps\.$/);
  assert.equal(lines.length, 6, 'not the logger, not another project, not this session');
  assert.equal(now.pair.recall({query: 'websocket heartbeat'}), 'Nothing in the earlier sessions of this project mentions websocket, heartbeat.');
  assert.equal(now.pair.recall({query: 'did we?'}), 'Give recall a few words to look for.');
});

test('a question about an earlier session comes with what those sessions kept; any other question does not', async () => {
  const store = openStore(':memory:');
  const old = pairSession({store, answers: ['✓ Retries back off exponentially now.']});
  worked(old);
  await old.pair.end();
  const {pair, asked} = pairSession({store, answers: ['We made the retries back off.', 'Line 3.']});
  pair.goalSkipped = true;
  await pair.ask('What did we do about the retries last week?');
  assert.match(asked[0], /^\[user\] What did we do about the retries last week\?\n\nFrom the earlier sessions of this project, best matches first:\n- Session of .*, its note:\n✓ Retries back off exponentially now\.\n\nNow:/);
  await pair.ask('Where are the retries counted?');
  assert.doesNotMatch(asked[1], /earlier sessions/);
});

test('reading counts as active time: moving the cursor and scrolling, not a cursor that stays put; reading alone is no work to debrief', async () => {
  const {pair, store, clock} = pairSession({answers: ['note']});
  const tickFor = async ms => { for (let t = 0; t < ms; t += 1000) { clock.now += 1000; await pair.tick(); } };
  pair.receive({kind: 'cursor', file: 'src/ws.ts', line: 10, at: clock.now});
  await pair.tick();
  await tickFor(4 * MIN);
  pair.receive({kind: 'scroll', file: 'src/ws.ts', at: clock.now});
  await tickFor(4 * MIN);
  pair.receive({kind: 'cursor', file: 'src/ws.ts', line: 40, at: clock.now});
  await tickFor(4 * MIN);
  pair.receive({kind: 'cursor', file: 'src/ws.ts', line: 40, at: clock.now}); // reported again after a pause: no move
  await tickFor(10 * MIN);
  assert.equal(pair.hasWork(), false, 'reading is no work: no debrief');
  await pair.end();
  assert.equal(store.activeMs(0), 13 * MIN - 1000, 'from the first tick until five minutes after the last move');
  assert.equal(store.projectActiveMs('/project', 0), store.activeMs(0), 'and in the project\'s own time');
  assert.equal(store.projectActiveMs('/elsewhere', 0), 0);
  assert.equal(pairSession({store}).pair.previousNote, null);
});

test('a store from before reading counted: a session with active time had work, so it keeps its debrief after the upgrade', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'pair-store-')), 'sessions.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE sessions (id INTEGER PRIMARY KEY, root TEXT NOT NULL, conversation_id TEXT NOT NULL, goal TEXT,
    level TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, note TEXT, active_ms INTEGER NOT NULL DEFAULT 0)`);
  old.exec(`INSERT INTO sessions (root, conversation_id, level, started_at, active_ms) VALUES ('/a', '"c1"', 'normal', 0, 60000), ('/b', '"c2"', 'normal', 0, 0)`);
  old.close();
  const store = openStore(path);
  assert.equal(store.activeSession('/a').worked, 1);
  assert.equal(store.activeSession('/b').worked, 0);
  store.close();
});

test('remarks stored before the shown mark count as shown when Pair said something in them', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'pair-store-')), 'sessions.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE sessions (id INTEGER PRIMARY KEY, root TEXT NOT NULL, conversation_id TEXT NOT NULL, goal TEXT,
    level TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, note TEXT);
    CREATE TABLE remarks (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, trigger TEXT NOT NULL, score REAL, at INTEGER NOT NULL, verdict TEXT);
    CREATE TABLE actions (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}', detail TEXT, state TEXT);
    INSERT INTO sessions (root, conversation_id, level, started_at) VALUES ('/a', '"c1"', 'normal', 0);
    INSERT INTO remarks (session_id, trigger, at) VALUES (1, 'failed_command', 1), (1, 'stall', 2);
    INSERT INTO actions (session_id, at, kind, text, data) VALUES (1, 1, 'said', 'Line 2 is off.', '{"remark": 1}');`);
  old.close();
  const store = openStore(path);
  assert.equal(store.lastRemark(1), 1);
  assert.deepEqual(store.recentRemarks('/a', 9).map(remark => remark.id), [1]);
  store.close();
});
