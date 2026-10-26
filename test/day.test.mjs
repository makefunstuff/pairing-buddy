// A day with Pair, end to end in the session with a real store: the debrief at the day's end, kept as the note and
// a place, and the next morning's pick-up landing there, reading it again and saying one line. Also /first, and a
// break hint at a natural end.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {PairSession} from '../src/session.mjs';
import {openStore} from '../src/store.mjs';

const MIN = 60_000;
const EVENING = new Date(2026, 9, 26, 17, 40).getTime();

/** A Go-ish project in git: worker.go with send() on line 4. */
function project() {
  const root = mkdtempSync(join(tmpdir(), 'pair-day-'));
  mkdirSync(join(root, 'internal/delivery'), {recursive: true});
  writeFileSync(join(root, 'internal/delivery/worker.go'), 'package delivery\n\nfunc Deliver() {\n\terr := send()\n\treturn err\n}\n');
  writeFileSync(join(root, 'internal/delivery/worker_test.go'), 'package delivery\n\nfunc TestNoDoubleDelivery(t *testing.T) {\n\tt.Fatal("twice")\n}\n');
  execFileSync('git', ['init', '-q'], {cwd: root});
  execFileSync('git', ['add', '-A'], {cwd: root});
  execFileSync('git', ['-c', 'user.name=dev', '-c', 'user.email=dev@example.com', 'commit', '-qm', 'start'], {cwd: root});
  return root;
}

/** A session of `root` on `store` at `clock`, whose Partner answers from `answers` in turn. */
function pairSession({store, root, clock, answers = [], autoTune = true}) {
  const record = store.activeSession(root) ?? store.createSession({root, conversationId: 'c', goal: 'retries reach the budget', level: 'normal', at: clock.now});
  const sent = [];
  const asked = [];
  const pair = new PairSession({
    record, store, autoTune,
    previousNote: store.previousNote(root, record.id),
    lastSession: store.lastSession(root, record.id),
    partner: {
      thinkingOf: () => 'off',
      ask: async (_id, input) => { asked.push(input); return answers.shift() ?? 'SILENT'; },
      setRole: async () => {},
    },
    score: async () => ({value: 9, reason: 'test'}),
    typingPauseMs: 2000,
    notify: (target, message) => { sent.push({target, ...message}); return 1; },
    requestEditor: async () => null,
    now: () => clock.now,
  });
  return {pair, sent, asked};
}

const DEBRIEF = '✓ delivery makes all 5 attempts\n○ open: AttemptTimeout is set, but nothing enforces it yet\nTomorrow, first: give `send()` a context with that timeout, in worker.go:4.';

test('the day\'s end: a debrief from the wins, kept as the note and a place; the next morning lands there', async () => {
  const root = project();
  const store = openStore(':memory:');
  const clock = {now: EVENING - 185 * MIN};
  const day = pairSession({store, root, clock, answers: [DEBRIEF]});
  day.pair.receive({kind: 'cursor', file: join(root, 'internal/delivery/worker.go'), line: 4, col: 1});
  // Three hours at work: a test goes red and green again, one remark is noise.
  for (let t = 0; t < 185 * 12; t++) {
    clock.now += 5000; // a tick every five seconds counts as active time
    day.pair.receive({kind: 'typing'});
    await day.pair.tick();
  }
  day.pair.wins.tests(['TestDeliver']);
  day.pair.wins.tests([]);
  store.rateRemark(store.addRemark({sessionId: day.pair.id, trigger: 'drift', score: 7, at: clock.now - MIN}), 'dismissed');
  store.rateRemark(store.addRemark({sessionId: day.pair.id, trigger: 'drift', score: 7, at: clock.now - MIN}), 'dismissed');
  store.rateRemark(store.addRemark({sessionId: day.pair.id, trigger: 'regression', score: 9, at: clock.now - MIN}), 'useful');
  day.pair.testsShown = {type: 'tests', state: 'fail', label: 'go test ./...', text: '1 failing · TestNoDoubleDelivery', results: [
    {name: 'TestNoDoubleDelivery', file: join(root, 'internal/delivery/worker_test.go'), line: 3, ok: false, failure: {file: join(root, 'internal/delivery/worker_test.go'), line: 4, text: 'twice'}},
  ]};
  clock.now = EVENING;
  await day.pair.end();

  const [input] = day.asked;
  assert.match(input, /Tests that failed during the session and pass now: TestDeliver/);
  assert.match(input, /Where the user stopped: internal\/delivery\/worker\.go:4: err := send\(\)/);
  const debrief = day.sent.find(message => message.type === 'message' && message.sender === 'pair').text;
  assert.equal(debrief, `Day's end: 3 h 05 min in ${root.split('/').at(-1)}.\n${DEBRIEF}\n2 of my 3 remarks were noise, both about drift: I'll keep quieter there.`);
  assert.deepEqual(day.sent.find(message => message.type === 'first'), {target: 'chat', type: 'first', step: 'give `send()` a context with that timeout, in worker.go:4.'});
  assert.ok(day.sent.some(message => message.target === 'editors' && message.type === 'debrief' && message.text === debrief), ':Pair end shows it in Neovim too');
  const last = store.lastSession(root, Infinity);
  assert.equal(last.note, DEBRIEF, 'the note the next session starts from');
  assert.deepEqual(last.pickup.first, {step: 'give `send()` a context with that timeout, in worker.go:4.', file: 'internal/delivery/worker.go', line: 4, text: '\terr := send()'});

  const before = new Date(EVENING - 200 * MIN);
  utimesSync(join(root, 'internal/delivery/worker_test.go'), before, before); // the test file is as it was when the day ended
  // Overnight a line goes in above it; the next morning, an editor connects.
  writeFileSync(join(root, 'internal/delivery/worker.go'), 'package delivery\n\n// Deliver sends a webhook.\nfunc Deliver() {\n\terr := send()\n\treturn err\n}\n');
  clock.now = new Date(2026, 9, 27, 9, 12).getTime();
  const morning = pairSession({store, root, clock, answers: ['Morning. `send()` still has no context: give it the AttemptTimeout first.']});
  morning.pair.greet();
  assert.match(morning.sent[0].text, /^Last time:\n✓ delivery/, 'the chat shows the note after a night');
  await morning.pair.pickUp();
  const file = join(root, 'internal/delivery/worker.go');
  const editor = morning.sent.filter(message => message.target.startsWith('editor') && message.type !== 'ledger_changed').map(({target, ...message}) => message);
  assert.deepEqual(editor.map(message => message.type), ['tests', 'land', 'look', 'pickup']);
  assert.equal(editor[0].text, '1 failing since yesterday · TestNoDoubleDelivery');
  assert.deepEqual(editor[1], {type: 'land', file, line: 5}, 'the place moved down with its code');
  assert.deepEqual(editor[2], {type: 'look', file, from: 1, to: 8}, 'the gaze reads the code around it');
  assert.deepEqual(editor[3], {
    type: 'pickup', file, line: 5, text: 'Morning. `send()` still has no context: give it the AttemptTimeout first.', code: 'send()',
    jump: {file: join(root, 'internal/delivery/worker_test.go'), line: 4, what: 'the failing test'},
  });
  assert.match(morning.asked[0], /^\[pickup\] The user is back: it is Tuesday 09:12, and the last session ended yesterday/);
  assert.match(morning.asked[0], /moved here from line 4\):\n1: package delivery/);
  assert.match(morning.asked[0], /Still failing since then: TestNoDoubleDelivery/);
  assert.ok(morning.sent.some(message => message.type === 'message' && message.sender === 'pair' && message.text.startsWith('Morning.')));
  const read = store.actions(root, clock.now - MIN).find(action => action.kind === 'read');
  assert.equal(read.text, 'internal/delivery/worker.go 1-8', 'the ledger has what it read');

  // A second Neovim, or the same after a daemon restart once the session was used, does not pick up again.
  const shown = morning.sent.length;
  await morning.pair.pickUp();
  assert.equal(morning.sent.length, shown);
});

test('no pick-up right after the last session ended, nor once the user is at work; the chat skips the note it just showed', async () => {
  const root = project();
  const store = openStore(':memory:');
  const clock = {now: EVENING};
  const day = pairSession({store, root, clock, answers: [DEBRIEF]});
  day.pair.receive({kind: 'typing'});
  await day.pair.end();

  clock.now += 2 * MIN; // /end, and the chat starts the next session at once
  const next = pairSession({store, root, clock});
  next.pair.greet();
  assert.ok(!next.sent.some(message => message.text?.startsWith('Last time')), 'the debrief is still on screen');
  await next.pair.pickUp();
  assert.ok(!next.sent.some(message => message.type === 'land'));

  clock.now += 60 * MIN;
  const used = pairSession({store, root, clock});
  used.pair.receive({kind: 'typing'});
  await used.pair.pickUp();
  assert.ok(!used.sent.some(message => message.type === 'land'), 'the user already works');
});

test('without the model, the pick-up says the first step; /first replaces it, with a place of its own', async () => {
  const root = project();
  writeFileSync(join(root, 'notes.md'), '# hookd\n\n- lease past the last attempt\n');
  const store = openStore(':memory:');
  const clock = {now: EVENING};
  const day = pairSession({store, root, clock, answers: [DEBRIEF]});
  day.pair.receive({kind: 'typing'});
  await day.pair.end();

  clock.now += 2 * MIN;
  const next = pairSession({store, root, clock});
  await next.pair.setFirst('read the notes first, notes.md:3');
  const last = store.lastSession(root, Infinity);
  assert.match(last.note, /\nTomorrow, first: read the notes first, notes\.md:3$/);
  assert.deepEqual(last.pickup.first, {step: 'read the notes first, notes.md:3', file: 'notes.md', line: 3, text: '- lease past the last attempt'});

  clock.now += 12 * 60 * MIN;
  const morning = pairSession({store, root, clock});
  morning.pair.health = {ok: () => false};
  await morning.pair.pickUp();
  const pickup = morning.sent.find(message => message.type === 'pickup');
  assert.equal(pickup.text, 'Where you stopped: read the notes first, notes.md:3');
  assert.equal(pickup.jump, null);
  assert.deepEqual(morning.asked, [], 'no model asked while it is down');
});

test('a break hint at a natural end after long focus: in the chat, and with the green\'s line in Neovim', async () => {
  const root = project();
  const store = openStore(':memory:');
  const clock = {now: EVENING - 60 * MIN};
  const {pair, sent} = pairSession({store, root, clock});
  for (let t = 0; t < 55; t++) {
    clock.now += MIN;
    pair.receive({kind: 'typing'});
    await pair.tick();
  }
  pair.delighted({sound: 'green', text: '`TestDeliver` passes again, after 12 min of red.'});
  const delight = sent.find(message => message.type === 'delight');
  assert.equal(delight.text, '`TestDeliver` passes again, after 12 min of red. 54 min of focus, and green: a good moment for a short break.');
  assert.ok(sent.some(message => message.type === 'message' && message.text === '54 min of focus, and green: a good moment for a short break.'));
});
