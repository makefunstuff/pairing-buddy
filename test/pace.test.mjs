// The Watcher's pace: while its calls take long, Pair asks about fewer kinds of moment, the ones you can see first.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Budget} from '../src/budget.mjs';
import {paceCheck} from '../src/doctor.mjs';
import {initialState} from '../src/fold.mjs';
import {decide} from '../src/gate.mjs';
import {FAST_MS, GIVE_UP, giveUp, KEPT, Pace, SLOW_MS, VERY_SLOW_MS} from '../src/pace.mjs';
import {PairSession} from '../src/session.mjs';
import {TRIGGER_KINDS} from '../src/triggers.mjs';

const hearAll = (pace, ...calls) => calls.forEach(ms => pace.hear(ms));

test('a fast server keeps every kind; a slow one gives half the kinds up, a very slow one all but the news you cannot see', () => {
  const logged = [];
  const pace = new Pace({log: line => logged.push(line)});
  hearAll(pace, 600, 900, 1000);
  assert.equal(pace.level, 'fast');
  assert.equal(pace.skips('note_drift'), null);
  hearAll(pace, SLOW_MS, SLOW_MS + 200, SLOW_MS + 400);
  assert.equal(pace.level, 'slow');
  assert.deepEqual(pace.given(), GIVE_UP.slice(0, GIVE_UP.length / 2));
  assert.match(pace.skips('drift').reason, /^the Watcher takes 1\.5 s a call: Pair is not asking about drift/);
  assert.equal(pace.skips('stall'), null, 'the second half is still asked about');
  hearAll(pace, ...Array(12).fill(VERY_SLOW_MS));
  assert.equal(pace.level, 'very-slow');
  assert.deepEqual(pace.given(), GIVE_UP);
  for (const kind of KEPT) assert.equal(pace.skips(kind), null, `${kind} is news you cannot see`);
  assert.deepEqual(logged.length, 2, logged.join('\n'));
  assert.match(logged[1], /takes 3\.0 s a call: Pair is not asking about note_drift, .*stall while the server is this slow/);
});

test('every kind is ranked: the kinds given up and the kinds kept are all the trigger kinds', () => {
  assert.deepEqual([...GIVE_UP, ...KEPT].sort(), [...TRIGGER_KINDS].sort());
  assert.ok(KEPT.includes('crash') && KEPT.includes('failed_command') && KEPT.includes('regression'));
});

test('coming back needs a median under FAST_MS: a server at the border keeps the pace it has', () => {
  const logged = [];
  const pace = new Pace({log: line => logged.push(line)});
  hearAll(pace, 2000, 2000, 2000);
  assert.equal(pace.level, 'slow');
  hearAll(pace, ...Array(12).fill(FAST_MS + 200));
  assert.equal(pace.level, 'slow', 'between FAST_MS and SLOW_MS nothing changes');
  hearAll(pace, ...Array(7).fill(FAST_MS));
  assert.equal(pace.level, 'fast');
  assert.match(logged.at(-1), /answers in 1\.0 s again: Pair asks about every kind of moment/);
  assert.equal(pace.snapshot().changes, 2);
});

test('fewer than three calls say nothing, and one slow call among fast ones changes nothing', () => {
  const pace = new Pace();
  hearAll(pace, 9000, 9000);
  assert.equal(pace.level, 'fast');
  const steady = new Pace();
  hearAll(steady, 500, 500, 9000, 500, 500);
  assert.equal(steady.level, 'fast');
});

test('with watcherPace off every kind is asked about, however slow', () => {
  const pace = new Pace({on: false});
  hearAll(pace, 5000, 5000, 5000);
  assert.equal(pace.level, 'off');
  assert.equal(pace.skips('note_drift'), null);
  assert.equal(pace.snapshot().medianMs, 5000, 'it still measures');
  pace.on = true;
  pace.hear(5000);
  assert.equal(pace.level, 'very-slow');
});

test('the user\'s own verdicts rank what goes first: a kind they dismiss before one they keep', () => {
  const keptOf = {
    note_drift: {share: 1, judged: 6}, // kept every time: no longer first to go
    stall: {share: 0, judged: 5}, // dismissed every time: first to go
    drift: {share: 0, judged: 2}, // too few verdicts to say
  };
  const given = giveUp('slow', keptOf);
  assert.equal(given[0], 'stall');
  assert.ok(!given.includes('note_drift'));
  assert.ok(given.includes('drift'), 'two verdicts do not move a kind');
  assert.deepEqual(giveUp('very-slow', keptOf).sort(), [...GIVE_UP].sort(), 'very slow gives every one up, whatever the verdicts');
  assert.deepEqual(giveUp('fast', keptOf), []);
});

test('the gate asks the Watcher nothing about a kind the pace gives up, after typing, budget and prefilter', async () => {
  const pace = new Pace();
  hearAll(pace, 4000, 4000, 4000);
  const asked = [];
  const score = async trigger => { asked.push(trigger.kind); return {value: 9, reason: 'worth it'}; };
  const gate = (kind, extra = {}) => decide({trigger: {kind, key: kind, detail: kind, ...extra}, state: initialState(), now: 600_000, budget: new Budget('normal'), score, typingPauseMs: 2000, pace});
  const drift = await gate('drift');
  assert.deepEqual([drift.verdict, drift.skipped], ['drop', true]);
  assert.match(drift.reason, /4\.0 s a call/);
  assert.equal((await gate('crash')).verdict, 'speak');
  const answered = await gate('failed_command', {command: {cmd: 'grep x', exit: 1}});
  assert.match(answered.reason, /is an answer/, 'the prefilter comes first');
  assert.deepEqual(asked, ['crash']);
});

test('a session books a kind it did not ask about as not asked, not as over the budget', async () => {
  const pace = new Pace();
  hearAll(pace, 4000, 4000, 4000);
  const scored = [];
  const quiet = [];
  const pair = new PairSession({
    record: {id: 1, root: '/project', conversation_id: 7, goal: 'fix it', level: 'normal'},
    store: {addMessage() {}, addAction: () => 1, updateAction() {}, lastRemark: () => null, showRemark() {}, addRemark: () => 1, dropRemark() {}},
    partner: {thinkingOf: () => 'off', ask: async () => 'SILENT'},
    score: async trigger => { scored.push(trigger.kind); return {value: 0, reason: 'no'}; },
    pace,
    typingPauseMs: 2000,
    notify: () => {},
    requestEditor: async () => null,
    now: () => 100_000,
  });
  pair.ledger.quiet = (kind, reason, flags) => quiet.push({kind, reason, ...flags});
  const warn = 'probe.c:21:14: warning: comparison of integers of different signs [-Wsign-compare]';
  pair.receive({kind: 'command_end', pane: 'w1:p3', cmd: 'make', exit: 0, output: 'probe.c:9:7: warning: unused variable', at: 90_000});
  pair.receive({kind: 'edit', file: 'probe.c', from: 21, to: 21, at: 92_000}); // a warning is new in a file you edited
  pair.receive({kind: 'command_end', pane: 'w1:p3', cmd: 'make', exit: 0, output: `probe.c:9:7: warning: unused variable\n${warn}`, at: 95_000});
  await pair.tick();
  assert.deepEqual(scored, [], 'the Watcher was not asked');
  assert.deepEqual(quiet.map(({kind, budget, slow}) => [kind, budget, slow]), [['new_warning', false, true], ['drift', false, true]], 'the edit raised drift, given up too');
});

test('pair doctor\'s pace line says what the Watcher costs and what Pair is not asking about', () => {
  assert.deepEqual(paceCheck({level: 'fast', medianMs: null, calls: 0, givenUp: []}), {level: 'ok', name: 'pace', text: 'no Watcher call yet since the daemon started'});
  assert.equal(paceCheck({level: 'fast', medianMs: 640, calls: 9, givenUp: []}).text, 'the Watcher took 0.6 s a call (median of the last 9 calls): Pair asks about every kind of moment');
  const slow = paceCheck({level: 'slow', medianMs: 1800, calls: 12, givenUp: ['note_drift', 'drift']});
  assert.equal(slow.level, 'warn');
  assert.match(slow.text, /^the Watcher took 1\.8 s a call .*, so Pair is not asking about note_drift, drift until it is 1\.0 s or less/);
  assert.match(paceCheck({level: 'off', medianMs: 5000, calls: 3, givenUp: []}).text, /"watcherPace" is false/);
});
