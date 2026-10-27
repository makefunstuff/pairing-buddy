// The ledger: what a session books as Pair works, and today's list as Neovim and the chat show it.
import assert from 'node:assert/strict';
import {realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {Ledger, ledgerDetail, ledgerRows, ledgerText, startOfDay, today} from '../src/ledger.mjs';
import {Pace} from '../src/pace.mjs';
import {PairSession} from '../src/session.mjs';
import {openStore} from '../src/store.mjs';
import {scratch} from './temp.mjs';

const NOON = new Date(2026, 9, 26, 12, 0).getTime();
const MIN = 60_000;

/** A session in a scratch project on a store in memory; its Partner runs `turns` in order. */
function pairSession(turns = [], {editor = async () => null, score = 9} = {}) {
  const root = realpathSync(scratch('pair-ledger-'));
  writeFileSync(join(root, 'queue.go'), 'package queue\n\nfunc New() {}\n');
  writeFileSync(join(root, 'worker.go'), 'package delivery\n\nfunc Run() {\n\treturn\n}\n');
  const store = openStore(':memory:');
  const clock = {now: NOON};
  const sent = [];
  const pair = new PairSession({
    record: store.createSession({root, conversationId: 'c1', goal: 'retries pass', level: 'normal', at: clock.now}),
    store,
    partner: {thinkingOf: () => 'off', ask: async () => turns.shift()?.(pair) ?? 'SILENT', setRole: async () => {}},
    score: async () => ({value: score, reason: 'test'}),
    typingPauseMs: 2000,
    notify: (to, message) => { sent.push({via: to, ...message}); return 1; },
    requestEditor: editor,
    now: () => clock.now,
  });
  return {root, pair, store, clock, sent};
}

const RED = '--- FAIL: TestRetries (0.00s)\n    worker_test.go:35: attempts = 4, want 5\nFAIL\texample.com/delivery\t0.001s';
const failTwice = (pair, at) => {
  for (const when of [at - 6000, at - 5000]) pair.receive({kind: 'command_end', cmd: 'go test ./...', exit: 1, output: RED, at: when});
};

test('a remark is booked as Pair works: reads in a row as one line, then where it pointed and what it said, rated', async () => {
  const {pair, store, clock, sent} = pairSession([async pair => {
    await pair.read({file: 'queue.go'});
    await pair.read({file: 'worker.go', from: 3, to: 5});
    await pair.point({file: 'worker.go', line: 4, note: 'returns too early'});
    return 'Run returns before the last attempt.';
  }]);
  failTwice(pair, clock.now);
  await pair.tick();
  const {rows, summary} = pair.today();
  assert.deepEqual(rows.map(row => [row.time, row.label, row.text]), [
    ['12:00', 'read', 'queue.go 1-4, worker.go 3-5'],
    ['12:00', 'pointed', 'worker.go:4, returns too early'],
    ['12:00', 'said', 'Run returns before the last attempt.'],
  ]);
  const [read, pointed, said] = rows;
  assert.equal(read.place.line, 3, 'a read goes to the last place it read');
  assert.match(pointed.place.file, /worker\.go$/);
  assert.equal(said.place.line, 4, 'what it said goes where it pointed');
  assert.ok(said.remark && said.more);
  assert.equal(summary, '3 things · 1 remark, 0 useful · 0 min');

  pair.feedback({useful: true});
  assert.equal(pair.today().rows[2].verdict, 'useful');
  assert.equal(pair.today().summary, '3 things · 1 remark, 1 useful · 0 min');
  assert.deepEqual(pair.ledgerDetail(said.ids), {title: 'what it said', text: 'Run returns before the last attempt.'});
  assert.ok(sent.some(message => message.via === 'editors' && message.type === 'ledger_changed'), 'an open list follows along');
  assert.ok(store.actions(pair.root, 0).every(action => action.at === NOON));
});

test('a moment the Watcher was not asked about on a slow server is booked as such', async () => {
  const {pair, clock} = pairSession([async () => 'SILENT'], {score: 2});
  pair.pace = new Pace();
  for (let i = 0; i < 3; i++) pair.pace.hear(4000);
  failTwice(pair, clock.now);
  await pair.tick(); // a repeated error is news you cannot see: scored 2, under the bar
  pair.receive({kind: 'edit', file: 'worker.go', from: 4, to: 4, at: clock.now - 1000}); // drift, which a slow server gives up
  clock.now += MIN;
  await pair.tick();
  const [quiet] = pair.today().rows;
  assert.deepEqual([quiet.text, quiet.ids.length], ['2 moments: 1 under the bar, 1 not asked, the server is slow', 2]);
  assert.match(pair.ledgerDetail(quiet.ids).text, /Pair is not asking about drift while the server is this slow/);
});

test('the moments Pair stays quiet are booked with why, and quiet moments in a row are one line', async () => {
  const {pair, clock} = pairSession([async () => 'SILENT'], {score: 2});
  failTwice(pair, clock.now);
  await pair.tick(); // the Watcher scores it 2: under the bar
  pair.budget.spend(clock.now); // the budget is spent now: the next moment is held back by it
  pair.receive({kind: 'command_end', cmd: 'make', exit: 2, output: 'error: x', at: clock.now - 4000});
  clock.now += 10_000;
  await pair.tick();
  const [quiet] = pair.today().rows;
  assert.equal(pair.today().rows.length, 1);
  assert.deepEqual([quiet.label, quiet.text, quiet.ids.length], ['stayed quiet', '2 moments: 1 under the bar, 1 over the budget', 2]);
  const why = pair.ledgerDetail(quiet.ids);
  assert.equal(why.title, 'why it stayed quiet');
  assert.match(why.text, /^12:00 {2}repeated_error: score 2 < 6: test\n12:00 {2}failed_command: spoke too recently$/);
});

test('a SILENT answer to a remark is a quiet moment too', async () => {
  const {pair, clock} = pairSession([async () => 'SILENT']);
  failTwice(pair, clock.now);
  await pair.tick();
  const [quiet] = pair.today().rows;
  assert.deepEqual([quiet.kind, quiet.text], ['quiet', '1 moment under the bar']);
  assert.match(pair.ledgerDetail(quiet.ids).text, /found nothing worth saying/);
});

test('commands: what Scout ran with its output, what it asked and was told, what it was refused', async () => {
  const {pair, sent} = pairSession();
  pair.role = 'scout';
  pair.scout = {run: async command => ({exit: command.startsWith('rg') ? 1 : 0, output: command.startsWith('rg') ? '' : 'ok  example.com/retry'})};
  const confirm = () => {
    const ask = sent.findLast(message => message.type === 'confirm');
    pair.answer(ask.id, false);
  };
  await pair.search({pattern: 'Lease'});
  await pair.run({command: 'go test ./...'});
  await pair.run({command: 'git push'});
  const declined = pair.run({command: 'rm -r internal/tmp'});
  await new Promise(resolve => setImmediate(resolve));
  confirm();
  await declined;
  const rows = pair.today().rows;
  assert.deepEqual(rows.map(row => [row.label, row.text, row.note ?? null, row.answer ?? null]), [
    ['searched', 'Lease', 'no matches', null],
    ['ran', 'go test ./...', null, null],
    ['refused', 'git push', 'git push changes git history; that is yours to do', null],
    ['asked', 'rm -r internal/tmp', null, 'no'],
  ]);
  assert.equal(rows[1].result, 'pass');
  assert.deepEqual(pair.ledgerDetail(rows[1].ids), {title: 'go test ./...', text: 'ok  example.com/retry'});
});

test('the Driver\'s edit is booked with the buffer before and after, and undone later through the editor, or made again', async () => {
  const before = ['package queue', '', 'func New() {}'];
  const after = ['package queue', '', '// New makes a queue.', 'func New() {}'];
  const asked = [];
  let refuse = null;
  const editor = async message => {
    asked.push(message);
    if (message.type === 'edit') return {ok: true, from: 3, to: 3, before, after};
    if (message.type === 'revert') return refuse ? {error: refuse} : {ok: true};
    return null;
  };
  const {pair, root, sent} = pairSession([async pair => {
    await pair.edit({file: 'queue.go', line: 3, endLine: 3, text: '// New makes a queue.\nfunc New() {}'});
    return 'Added the comment.';
  }], {editor});
  pair.notify = (to, message) => { sent.push({via: to, ...message}); return 1; };
  await pair.drive('document New');
  const typed = pair.today().rows.find(row => row.kind === 'typed');
  assert.equal('place' in pair.today().rows.find(row => row.kind === 'said'), false, 'words that point nowhere go nowhere');
  assert.deepEqual([typed.text, typed.note, typed.undo, typed.place.line], ['a line in queue.go', 'one undo step', true, 3]);

  await pair.undo(typed.id);
  assert.deepEqual(asked.at(-1), {type: 'revert', file: join(root, 'queue.go'), base: after, other: before});
  assert.equal(pair.today().rows.find(row => row.id === typed.id).state, 'undone');
  await pair.undo(typed.id);
  assert.deepEqual(asked.at(-1), {type: 'revert', file: join(root, 'queue.go'), base: before, other: after}, 'made again');
  assert.equal(pair.today().rows.find(row => row.id === typed.id).state, undefined);

  refuse = 'you changed those lines since';
  await pair.undo(typed.id);
  assert.equal(pair.today().rows.find(row => row.id === typed.id).state, undefined, 'a clash changes nothing');
  assert.ok(sent.some(message => message.via === 'editor' && message.text === 'Pair\'s change in queue.go was not undone: you changed those lines since.'));
});

test('an accepted suggestion can be undone from the ledger too; another project\'s entry cannot', async () => {
  const {pair, store} = pairSession([async pair => {
    await pair.suggest({file: 'worker.go', line: 4, endLine: 4, text: '\tcontinue', note: 'keep going'});
    return 'SILENT';
  }]);
  await pair.ask('what about line 4?');
  const suggested = pair.today().rows.find(row => row.kind === 'suggested');
  assert.deepEqual([suggested.text, suggested.undo ?? false], ['worker.go:4, keep going', false]);
  pair.applied(suggested.id, ['a'], ['b']);
  const accepted = pair.today().rows.find(row => row.id === suggested.id);
  assert.deepEqual([accepted.state, accepted.undo], ['applied', true]);

  const other = store.createSession({root: '/elsewhere', conversationId: 'c2', level: 'normal', at: NOON});
  const elsewhere = new Ledger({store, sessionId: other.id, now: () => NOON}).add('suggested', 'x.go:1, y');
  pair.applied(elsewhere, ['a'], ['b']);
  assert.equal(store.action(elsewhere).state, null);
  assert.equal(pair.ledgerDetail([elsewhere]), null);
});

test('today starts at local midnight; runs of one command with one result are one line; the chat gets plain lines', () => {
  const store = openStore(':memory:');
  const session = store.createSession({root: '/p', conversationId: 'c', level: 'normal', at: 0});
  let now = startOfDay(NOON) - MIN;
  const ledger = new Ledger({store, sessionId: session.id, now: () => now});
  ledger.add('ran', 'make test', {data: {note: 'exit 2', result: 'fail'}}); // yesterday
  now = NOON;
  for (let i = 0; i < 3; i++) ledger.add('ran', 'make test', {data: {note: '4 tests', result: 'pass'}, detail: {output: `run ${i}`}});
  ledger.add('typed', '6 lines in backoff_test.c', {data: {note: 'one undo step', undo: true}});
  store.updateAction(ledger.last.id, {state: 'undone'});
  store.addActive(NOON, 130 * MIN, '/p');
  const listed = today(store, '/p', NOON);
  assert.deepEqual(listed.rows.map(row => [row.text, row.note, row.ids.length]), [['make test', '4 tests · 3 times', 3], ['6 lines in backoff_test.c', 'one undo step', 1]]);
  assert.equal(ledgerDetail(store, '/p', listed.rows[0].ids).text, 'run 2', 'the output of the last run');
  assert.equal(listed.summary, '2 things · 0 remarks, 0 useful · 2 h 10 min');
  assert.deepEqual(ledgerText(listed), [
    '12:00  ran    make test  · 4 tests · 3 times',
    '12:00  typed  6 lines in backoff_test.c  · one undo step  (undone)',
    '2 things · 0 remarks, 0 useful · 2 h 10 min · :Pair today in Neovim goes there, shows output and undoes edits',
  ]);
  assert.deepEqual(ledgerText(today(store, '/elsewhere', NOON)), ['Pair has done nothing here today.']);
  assert.deepEqual(ledgerRows([]), []);

  store.forgetActionDetails(NOON + 1);
  assert.equal(ledgerDetail(store, '/p', listed.rows[0].ids), null, 'what an old entry opened to is forgotten; the entry stays');
  assert.equal(today(store, '/p', NOON).rows.length, 2);
});
